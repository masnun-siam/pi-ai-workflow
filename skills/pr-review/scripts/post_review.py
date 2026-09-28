#!/usr/bin/env python3
"""Post a findings file as ONE GitHub pull request review with inline comments.

Why a script instead of raw `gh api` calls: GitHub rejects the entire review with
a 422 if any single comment points at a line that isn't part of the diff, and the
error doesn't say which comment was at fault. This script parses the diff, checks
every position up front, relocates the unplaceable ones into the summary body, and
retries narrowing on failure — so a review always lands even if a position is off.

Usage:
  python3 post_review.py --pr <pr-ref> --findings findings.json [--dry-run]

See references/posting.md for the findings schema.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict

SEV_ORDER = {"critical": 0, "blocker": 1, "should-fix": 2, "nit": 3}
SEV_LABEL = {
    "critical": "**CRITICAL — needs human review**",
    "blocker": "**blocker**",
    "should-fix": "**should-fix**",
    "nit": "_nit_",
}

# Who gets pulled in when a finding is too consequential for an automated review
# to be the last word. Override with --reviewers or PR_REVIEW_ESCALATION_HANDLES.
DEFAULT_ESCALATION_HANDLES = ["kazi-shahin", "amims71"]


def sh(args, check=True, stdin=None):
    try:
        p = subprocess.run(args, capture_output=True, text=True, input=stdin)
    except FileNotFoundError:
        sys.exit(f"error: {args[0]!r} not found on PATH. "
                 "This skill requires an authenticated gh CLI — run 'gh auth login'.")
    if check and p.returncode != 0:
        sys.exit(f"error: {' '.join(args[:3])}... failed:\n{p.stderr.strip()}")
    return p


def resolve_pr(ref):
    """Accept 482 | URL | owner/repo#482 -> (slug, number)."""
    m = re.match(r"^https?://[^/]+/([^/]+)/([^/]+)/pull/(\d+)", ref)
    if m:
        return f"{m.group(1)}/{m.group(2)}", int(m.group(3))
    m = re.match(r"^([^/]+)/([^#]+)#(\d+)$", ref)
    if m:
        return f"{m.group(1)}/{m.group(2)}", int(m.group(3))
    m = re.match(r"^#?(\d+)$", ref)
    if m:
        p = sh(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
        return p.stdout.strip(), int(m.group(1))
    sys.exit(f"error: cannot parse PR reference {ref!r}")


def is_self_authored(slug, number):
    """True when the authenticated user opened this PR.

    GitHub refuses REQUEST_CHANGES and APPROVE on your own pull request, so an
    auto-triggered review right after `gh pr create` must post as COMMENT or the
    whole submission fails with a 422. Only the verdict is restricted — inline
    comments on your own PR are fine.
    """
    me = sh(["gh", "api", "user", "-q", ".login"], check=False).stdout.strip()
    author = sh(["gh", "api", f"repos/{slug}/pulls/{number}",
                 "-q", ".user.login"], check=False).stdout.strip()
    return bool(me) and me == author, me


def already_reviewed(slug, number, head, me):
    """Has this user already reviewed this exact head SHA?

    Auto-triggering re-fires on every push, and re-posting the same findings on an
    unchanged commit is how a useful bot becomes a muted one.
    """
    p = sh(["gh", "api", f"repos/{slug}/pulls/{number}/reviews", "--paginate"], check=False)
    if p.returncode != 0:
        return False
    try:
        return any(r.get("commit_id") == head
                   and (r.get("user") or {}).get("login") == me
                   for r in json.loads(p.stdout))
    except Exception:
        return False


def commentable_lines(patch):
    """Map path -> {'RIGHT': set(new_lines), 'LEFT': set(old_lines)}.

    GitHub permits an inline comment only on a line inside a diff hunk. Added and
    context lines are addressable on RIGHT; removed and context lines on LEFT.
    """
    files = defaultdict(lambda: {"RIGHT": set(), "LEFT": set()})
    path = None
    old_n = new_n = 0
    hunk = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")

    for line in patch.splitlines():
        if line.startswith("diff --git "):
            path = None
            continue
        if line.startswith("+++ "):
            p = line[4:].strip()
            path = None if p == "/dev/null" else re.sub(r"^b/", "", p)
            continue
        if line.startswith("--- "):
            continue
        m = hunk.match(line)
        if m:
            old_n, new_n = int(m.group(1)), int(m.group(2))
            continue
        if path is None:
            continue
        if line.startswith("+"):
            files[path]["RIGHT"].add(new_n); new_n += 1
        elif line.startswith("-"):
            files[path]["LEFT"].add(old_n); old_n += 1
        elif line.startswith("\\"):
            continue
        else:  # context line: addressable on both sides
            files[path]["RIGHT"].add(new_n); files[path]["LEFT"].add(old_n)
            new_n += 1; old_n += 1
    return files


def render(body, severity, category):
    tag = SEV_LABEL.get(severity, severity or "note")
    cat = f" · {category}" if category else ""
    return f"{tag}{cat}\n\n{body.strip()}"


def normalize_handles(raw):
    """Accept 'a,@b' or ['a','@b'] -> ['a','b'], deduped, order preserved."""
    if isinstance(raw, str):
        raw = raw.split(",")
    out = []
    for h in raw or []:
        h = (h or "").strip().lstrip("@")
        if h and h not in out:
            out.append(h)
    return out


def escalation_banner(findings, handles):
    """Build the top-of-review call for human attention, or None.

    Escalation is deliberately not narrowed by cleverness — every configured
    handle is mentioned, even if one of them authored the PR. An escalation
    signal that silently drops a recipient is worse than a redundant ping.
    """
    triggers = [c for c in findings.get("comments", [])
                if c.get("severity") == "critical" or c.get("escalate")]
    reasons = list(findings.get("escalation_reasons") or [])
    if findings.get("escalate") and not triggers and not reasons:
        reasons.append("Flagged as needing human judgment.")
    if not triggers and not reasons:
        return None
    if not handles:
        return None

    mentions = " ".join(f"@{h}" for h in handles)
    out = ["> [!CAUTION]",
           f"> **Human review needed** — {mentions}",
           ">",
           "> This PR changes something an automated review shouldn't be the last word on:"]
    for c in triggers:
        loc = c.get("path") or "general"
        if c.get("line"):
            loc += f":{c['line']}"
        cat = f"{c['category']}: " if c.get("category") else ""
        first = " ".join((c.get("body") or "").split())
        if len(first) > 220:
            first = first[:217].rstrip() + "..."
        out.append(f"> - {cat}`{loc}` — {first}")
    for r in reasons:
        out.append(f"> - {' '.join(str(r).split())}")
    out += [">", "> Please confirm this is intended before merging."]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pr", required=True)
    ap.add_argument("--findings", required=True)
    ap.add_argument("--reviewers", default=None,
                    help="Comma-separated handles to mention on critical findings. "
                         f"Default: {','.join(DEFAULT_ESCALATION_HANDLES)}")
    ap.add_argument("--escalation-comment", action="store_true",
                    help="Also post the escalation as a standalone PR comment (second notification).")
    ap.add_argument("--no-approve", action="store_true",
                    help="Never APPROVE; post a clean review as COMMENT instead. Use where "
                         "a bot approval would satisfy a branch-protection rule.")
    ap.add_argument("--force", action="store_true",
                    help="Review again even if this commit was already reviewed.")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    slug, number = resolve_pr(args.pr)
    findings = json.load(open(args.findings))
    comments_in = findings.get("comments", [])

    handles = normalize_handles(
        args.reviewers
        or os.environ.get("PR_REVIEW_ESCALATION_HANDLES")
        or findings.get("escalation_handles")
        or DEFAULT_ESCALATION_HANDLES
    )
    banner = escalation_banner(findings, handles)
    no_approve = args.no_approve or os.environ.get("PR_REVIEW_NO_APPROVE") == "1"

    head = sh(["gh", "api", f"repos/{slug}/pulls/{number}", "-q", ".head.sha"]).stdout.strip()
    patch = sh(["gh", "pr", "diff", str(number), "--repo", slug]).stdout
    allowed = commentable_lines(patch)

    inline, relocated = [], []
    for c in sorted(comments_in, key=lambda x: SEV_ORDER.get(x.get("severity"), 3)):
        path, line = c.get("path"), c.get("line")
        side = (c.get("side") or "RIGHT").upper()
        body = render(c.get("body", ""), c.get("severity"), c.get("category"))

        ok = path in allowed and isinstance(line, int) and line in allowed[path][side]
        start = c.get("start_line")
        if ok and isinstance(start, int):
            # Multi-line comments need both ends inside the hunk, start before end.
            if not (start < line and start in allowed[path][side]):
                start = None

        if not ok:
            relocated.append(c)
            continue

        item = {"path": path, "line": line, "side": side, "body": body}
        if isinstance(start, int):
            item.update({"start_line": start, "start_side": side})
        inline.append(item)

    # Findings that couldn't be pinned to a diff line still need to be said.
    summary = (findings.get("summary") or "").strip()
    if banner:
        summary = banner + "\n\n" + summary if summary else banner
    if relocated:
        lines = ["", "", "---", "", "### Findings outside the diff", ""]
        for c in sorted(relocated, key=lambda x: SEV_ORDER.get(x.get("severity"), 3)):
            loc = c.get("path") or "general"
            if c.get("line"):
                loc += f":{c['line']}"
            tag = SEV_LABEL.get(c.get("severity"), c.get("severity") or "note")
            cat = f" · {c['category']}" if c.get("category") else ""
            # Collapse to one line: newlines inside a list item break the list.
            text = " ".join((c.get("body") or "").split())
            lines.append(f"- `{loc}` — {tag}{cat} — {text}")
        summary += "\n".join(lines)

    self_authored, me = is_self_authored(slug, number)

    # Verdict policy:
    #   self-authored          -> COMMENT (GitHub forbids anything else from the author)
    #   critical/blocker/escalated -> REQUEST_CHANGES
    #   otherwise              -> APPROVE
    blocking = any(c.get("severity") in ("critical", "blocker") for c in comments_in)
    verdict = findings.get("verdict")
    if verdict not in ("REQUEST_CHANGES", "COMMENT", "APPROVE"):
        if blocking or banner:
            verdict = "REQUEST_CHANGES"
        else:
            verdict = "COMMENT" if no_approve else "APPROVE"

    # An escalation asks a human to confirm before merge. Approving would remove the
    # very gate the banner exists to create, so the two can never coexist.
    if banner and verdict == "APPROVE":
        verdict = "REQUEST_CHANGES"
    if no_approve and verdict == "APPROVE":
        verdict = "COMMENT"

    if self_authored and verdict != "COMMENT":
        # GitHub rejects APPROVE and REQUEST_CHANGES from the PR author; only plain
        # comments are allowed. Downgrade, and make the body carry the weight the
        # verdict no longer can.
        was = verdict
        verdict = "COMMENT"
        if was == "REQUEST_CHANGES":
            sev = "blocker" if any(c.get("severity") == "blocker" for c in comments_in) else None
            sev = "critical" if any(c.get("severity") == "critical" for c in comments_in) else sev
            note = ("> [!WARNING]\n> Self-review: GitHub won't let a PR's author request "
                    "changes, so this is posted as a comment."
                    + (f" It contains **{sev}** findings — treat it as blocking anyway."
                       if sev else " Human review was requested above."))
            summary = note + "\n\n" + summary if summary else note

    if not args.force and already_reviewed(slug, number, head, me):
        print(f"{slug}#{number} @ {head[:8]} already reviewed by @{me} at this commit; "
              "skipping. Pass --force to review again.")
        return

    payload = {"commit_id": head, "body": summary or "Automated review.",
               "event": verdict, "comments": inline}

    counts = defaultdict(int)
    for c in comments_in:
        counts[c.get("severity", "unspecified")] += 1
    print(f"{slug}#{number} @ {head[:8]}  verdict={verdict}"
          + ("  (self-authored)" if self_authored else ""))
    print(f"  inline: {len(inline)}   relocated to summary: {len(relocated)}")
    print("  severities: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "  none")
    if banner:
        print("  ESCALATED to: " + ", ".join(f"@{h}" for h in handles))
    else:
        print("  no escalation (nothing critical)")

    if args.dry_run:
        print(json.dumps(payload, indent=2)[:4000])
        return

    def post(pl):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(pl, f)
            tmp = f.name
        return sh(["gh", "api", "--method", "POST",
                   f"repos/{slug}/pulls/{number}/reviews", "--input", tmp], check=False)

    r = post(payload)
    if r.returncode != 0 and payload["event"] in ("REQUEST_CHANGES", "APPROVE"):
        # Some repos and permission setups reject a verdict (self-authored PRs most
        # commonly, but also orgs that restrict who may approve). The findings matter
        # more than the verdict, so fall back rather than lose the whole review.
        print(f"  {payload['event']} rejected; retrying as COMMENT", file=sys.stderr)
        payload["event"] = "COMMENT"
        r = post(payload)
    if r.returncode != 0 and payload["comments"]:
        # A position slipped through validation. Don't lose the review: fold every
        # inline comment into the body and post that instead.
        print("  inline positions rejected by GitHub; falling back to summary-only", file=sys.stderr)
        extra = ["", "---", "", "### Inline findings"]
        for c in payload["comments"]:
            extra.append(f"- `{c['path']}:{c['line']}` — {c['body']}")
        payload["body"] += "\n".join(extra)
        payload["comments"] = []
        r = post(payload)

    if r.returncode != 0:
        sys.exit(f"error: posting review failed:\n{r.stderr.strip()}")

    try:
        print("posted: " + json.loads(r.stdout)["html_url"])
    except Exception:
        print(f"posted: https://github.com/{slug}/pull/{number}")

    # The banner already notifies via the review body. This is for teams who want
    # a distinct, harder-to-miss ping in the conversation timeline as well.
    if banner and args.escalation_comment:
        c = sh(["gh", "pr", "comment", str(number), "--repo", slug, "--body", banner],
               check=False)
        if c.returncode == 0:
            print("escalation comment posted")
        else:
            print("warning: escalation comment failed; the review body still has "
                  "the mentions", file=sys.stderr)


if __name__ == "__main__":
    main()

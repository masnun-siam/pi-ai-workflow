# Posting the review

## Findings file schema

Write this to `<bundle>/findings.json`, then hand it to `scripts/post_review.py`.

```json
{
  "verdict": "REQUEST_CHANGES",
  "summary": "Markdown for the review body.",
  "escalation_reasons": [
    "Migration drops `users.legacy_id` with no backfill — irreversible once run in prod."
  ],
  "comments": [
    {
      "path": "src/handlers/orders.py",
      "line": 88,
      "start_line": 84,
      "side": "RIGHT",
      "severity": "critical",
      "category": "security",
      "body": "This removes the `@require_role('admin')` guard added in #310, so any authenticated user can cancel any order. If that's intentional, worth saying so in the PR description."
    }
  ]
}
```

Field notes:

- `verdict` — `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`. Usually omit it and let the script decide: `REQUEST_CHANGES` when anything is critical or blocker or escalation fired, otherwise `APPROVE`. On a self-authored PR any verdict becomes `COMMENT`, because GitHub permits nothing else from the author. `--no-approve` / `PR_REVIEW_NO_APPROVE=1` turns a would-be `APPROVE` into `COMMENT`, for repos where a bot approval would satisfy branch protection and let code merge unreviewed. If a verdict is rejected by the API, the script retries as `COMMENT` rather than losing the review.
- `severity` — `critical` | `blocker` | `should-fix` | `nit`. Drives the verdict, the ordering, the label on each comment, and whether escalation fires. See §8 of the review checklist for what earns `critical`.
- `escalation_reasons` — optional list of strings for concerns that trigger escalation but have no diff line to attach to (a risky migration, a deploy-ordering hazard). Each becomes a bullet in the banner.
- `escalation_handles` — optional list overriding who gets mentioned. `--reviewers` and `PR_REVIEW_ESCALATION_HANDLES` take precedence over it, in that order.
- `escalate` — optional boolean on an individual comment, to escalate something you've deliberately left at a lower severity. Rarely needed; `severity: critical` is clearer.
- `line` — the line number **in the file as it exists on the head commit** when `side` is `RIGHT`, or in the base version when `side` is `LEFT`. Not a diff offset, not a hunk position.
- `start_line` — optional; makes the comment span `start_line`..`line`. Both ends must be inside the same hunk and `start_line < line`, or the script drops the range and comments on the single line.
- `side` — `RIGHT` for added and context lines (nearly always what you want). `LEFT` only to comment on a line the PR deleted.
- `category` — free text shown after the severity, e.g. `security`, `DRY`, `SOLID`, `comments`, `intent`, `tests`.
- `body` — Markdown. Reference other files as `` `path/to/file.py:31` ``; GitHub does not autolink these but reviewers can still navigate them.

## Escalation

When any comment is `critical` (or carries `escalate: true`), or `escalation_reasons` is non-empty, the script prepends a `> [!CAUTION]` block to the review body mentioning the configured handles — **kazi-shahin** and **amims71** unless overridden:

```markdown
> [!CAUTION]
> **Human review needed** — @kazi-shahin @amims71
>
> This PR changes something an automated review shouldn't be the last word on:
> - security: `src/handlers/orders.py:88` — removes the `@require_role('admin')` guard added in #310
> - Migration drops `users.legacy_id` with no backfill — irreversible once run in prod.
>
> Please confirm this is intended before merging.
```

Design choices worth knowing about:

- **The mentions go in the review body only.** Inline critical comments are labelled `**CRITICAL — needs human review**` but carry no `@` handles, because each review comment is its own notification thread — repeating the mention would fire one ping per comment and train people to filter them out.
- **Every configured handle is mentioned, even the PR author.** No clever narrowing. An escalation path that silently drops a recipient because of a heuristic is a worse failure than a redundant ping.
- **Escalation forces `REQUEST_CHANGES`.** A banner asking for human confirmation alongside a neutral `COMMENT` verdict sends mixed signals, and the PR can still be merged past a comment.
- `--escalation-comment` additionally posts the banner as a standalone PR comment. That's a second notification, so use it only if the team finds review-body mentions easy to miss. If it fails, the script warns but doesn't fail the run — the review body already carries the mentions.

To change the reviewers permanently for a repo or machine, export the env var rather than editing the script:

```bash
export PR_REVIEW_ESCALATION_HANDLES="kazi-shahin,amims71,someone-else"
```

## The summary body

This is the part everyone reads. Structure it like this:

```markdown
## Review of #482 — per-account rate limiting

**Verdict: changes requested** — 1 blocker, 3 should-fix, 2 nits.

### Intent
Issue #204 asks for limits per account; the implementation keys on client IP
(`limiter.py:22`), so accounts sharing a NAT get one shared budget and a single
account across two IPs gets double. This is the blocker.

Acceptance criteria #2 (429 response includes `Retry-After`) is met.
Criterion #4 (metrics emitted per rejection) has no corresponding code.

### Commits
Six commits, three of them `fix lint` / `address comments` — worth squashing.
The substantive messages are good and reference #204.

### Notes
- `parse_window` duplicates `utils/time.py:31` (see inline).
- No regression test for the reproduction steps in #204.
```

Keep the commit-hygiene and history findings here — they have no diff line to attach to.

## Inline positions: the one hard constraint

GitHub accepts an inline comment only on a line that appears inside a diff hunk. Comment on line 400 of a file whose only hunk covers 10–25 and the API returns `422 Unprocessable Entity` — and it rejects **the entire review**, so one bad position loses all fifteen comments and the summary too.

`post_review.py` handles this: it parses the diff, computes the addressable line set per file per side, and moves anything unplaceable into a "Findings outside the diff" section in the body. If a position still gets rejected, it retries with every inline comment folded into the body so the review lands regardless. You'll see a note on stderr when this happens.

This matters for the DRY pass in particular: the *duplicate* you found in `utils/time.py` is usually not in the diff at all. Attach that comment to the **new** code's line (which is in the diff) and reference the existing file in the body. Don't try to comment on the file outside the diff.

## Verifying afterwards

```bash
gh pr view <number> --repo <slug> --json reviewDecision,reviews
gh api "repos/<slug>/pulls/<number>/comments" -q '.[] | "\(.path):\(.line)"'
```

## Deleting a review posted by mistake

Individual review comments can be removed; a submitted review's verdict cannot be retracted, only superseded by a later review. So if the user asks you to undo:

```bash
# list this session's comments, then delete by id
gh api "repos/<slug>/pulls/<number>/comments" -q '.[] | "\(.id) \(.path):\(.line)"'
gh api --method DELETE "repos/<slug>/pulls/comments/<comment-id>"
```

Tell the user plainly that the `REQUEST_CHANGES` state itself has to be cleared by submitting a new review — that's a GitHub constraint, not something to paper over.

## Rate limits and large PRs

A review with many comments is one API call, so rate limiting is rarely an issue. Very large PRs are a different problem: if the diff exceeds a few thousand lines, review the highest-risk files rather than everything, and say in the summary which paths you covered and which you didn't. A review that silently skipped half the diff while implying full coverage is worse than one that admits its scope.

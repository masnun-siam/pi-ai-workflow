---
name: pr-review
description: Rigorous, evidence-based review of a GitHub pull request via the gh CLI. Reads the PR description, every commit and commit message, the linked GitHub Issues, and the full diff; cross-checks the implementation against the business intent recorded in the issues; audits comments (WHY not WHAT), DRY against the whole codebase rather than just the diff, SOLID design, and security; then posts the findings as inline review comments on the PR, escalating to human reviewers when a change is too consequential to sign off automatically. Use this skill whenever the user asks to review, audit, critique, sanity-check, or "take a look at" a pull request — including when they just paste a PR number, a PR URL, or say things like "is #482 good to merge", "any feedback on Sam's changes", "leave comments on the auth PR", or "review this before I merge" — even if they never say the word "review". Also use it immediately and without asking whenever a pull request has just been opened in this session, whether the user ran `gh pr create` themselves or the agent did, or when a hook or system reminder reports that a PR was created. Requires an authenticated gh CLI; this is a hard prerequisite.
---

# PR Review

Review a GitHub pull request the way a senior engineer who knows the codebase would: read the intent, read the history, read the whole repo — not only the diff — and leave a small number of specific, actionable comments directly on the lines that need them.

The output lands on someone else's pull request under the user's name. That raises the bar. A reviewer who leaves ten obvious nits is worse than useless; a reviewer who catches the one duplicated helper and the one missing authorization check earns trust. Optimize for precision over coverage.

If a hook or system reminder says a PR was just created, treat that as the trigger and start at Step 0 without asking for confirmation. For how the automatic triggering is wired and how to roll it out across an organization, see `references/auto-trigger.md`.

## Step 0 — Preflight (hard gate)

Run this first, always:

```bash
bash scripts/preflight.sh <pr-ref>
```

It verifies `gh` is installed and authenticated, resolves the PR reference, and confirms write access. If `gh auth status` fails, stop and tell the user to run `gh auth login` — do not attempt to work around it with unauthenticated API calls, git remotes, or scraping. Authentication is a hard requirement because the review has to be posted as the user, and a review the user cannot post is wasted work.

`<pr-ref>` may be a bare number (`482`), a URL (`https://github.com/acme/api/pull/482`), or `owner/repo#482`. The script normalizes all three and prints the resolved `owner`, `repo`, `number`, and head SHA. If the user gave no PR reference at all, ask for one before doing anything else.

## Step 1 — Gather everything

```bash
bash scripts/gather_context.sh <pr-ref> /tmp/pr-review-<number>
```

This writes a context bundle: `pr.json` (title, body, author, base/head, labels, state), `commits.json` (SHA, message, author per commit), `diff.patch` (the full unified diff), `files.json` (per-file additions/deletions/status), `issues/*.json` (every linked GitHub Issue: title, body, labels, comments), and `existing_comments.json` (review comments already on the PR).

Read the bundle before forming any opinion. Specifically read the issue bodies — they carry the acceptance criteria you will judge the code against, and skipping them turns this into a generic lint pass.

Linked issues are discovered from three places, because teams are inconsistent about where they put the reference: GitHub's own linked-issues field, closing keywords in the PR body (`Fixes #12`, `Closes #12`), and issue references in individual commit messages (`#12`, `GH-12`). If a commit references an issue number that doesn't resolve, note it rather than guessing — a dangling reference is itself a finding worth a comment.

If the PR has no linked issue anywhere, say so in the summary and review against the PR description instead. Don't invent requirements.

**Ensure a local checkout.** The DRY and SOLID passes need the whole repository, not the patch. If the current directory is the right repo, fetch the PR head (`git fetch origin pull/<number>/head`). If not, clone into a temp dir. Working from `diff.patch` alone is the single biggest cause of shallow reviews — you cannot tell that a new function duplicates an existing one if you never look outside the diff.

## Step 2 — The review passes

Run all six passes. Read `references/review-checklist.md` for the detailed criteria, heuristics, and worked examples for each one; the summaries below are only a map.

1. **Intent vs. implementation.** Take each acceptance criterion from the linked issues and locate the code that satisfies it. Criteria with no corresponding code are the most valuable finding this skill can produce. Also look for the reverse: code in the diff that no issue or PR description asked for — unrequested scope is a review comment, not a bonus.

2. **Commit hygiene.** Do the messages explain *why* the change was made, or do they restate the diff (`update user.py`, `fix`, `wip`)? Is there a `Fixes #N` where the PR closes an issue? Do the commits tell a readable story, or is history full of `address review comments` noise that should have been squashed? Comment on commit hygiene in the summary body, not inline — inline comments attach to lines, and this is a property of the history.

3. **Comments: WHY, not WHAT.** Flag comments that narrate code the reader can already see (`// increment counter` above `counter++`), commented-out code, redundant docstrings that repeat the signature, and TODOs with no owner or issue link. Also flag long-form rationale essays parked in the source file — design history, alternatives considered, and migration narratives belong in the commit message, the PR description, or a doc; in the source they rot and drift. What earns its place inline: a non-obvious constraint, a workaround with a link to the upstream bug, a warning about an ordering dependency, a citation for a magic number.

4. **DRY — against the whole codebase.** For every new function, method, class, constant, or type in the diff, search the repository for something that already does it. The bar is not "this diff repeats itself" but "this repo already had one of these." See the checklist for the search strategy — this pass is the reason the skill insists on a local checkout, and it is where a reviewer who knows the codebase most clearly outperforms one who only reads the patch.

5. **SOLID and design.** Single responsibility, dependency direction, substitutability, interface bloat, open/closed. Report concrete consequences ("this class now writes HTTP responses *and* computes pricing, so pricing can't be unit-tested without a request object"), not principle names as accusations.

6. **Security.** Injection, authentication and authorization gaps, secrets in code, unsafe deserialization, missing validation on untrusted input, dependency risk, and — for anything touching an existing security control — whether the change weakens it. Security findings are the one category where a lower confidence threshold is justified: phrase uncertainty as a question rather than staying silent.

## Step 3 — Triage before posting

Assign every finding a severity:

- **critical** — too consequential for an automated review to be the last word. Escalates to human reviewers (see below). Read `references/review-checklist.md` §8 for the criteria; the short version is: irreversible damage, a weakened security control, money, or personal data.
- **blocker** — correctness bug, security hole, or an acceptance criterion that is not met. Reasonable to hold a merge for.
- **should-fix** — real problem, not urgent: a DRY violation, a design smell with a concrete cost.
- **nit** — style, naming, a WHAT-comment.

### Escalating to a human

Findings marked `critical` add a banner at the top of the review that @-mentions **kazi-shahin** and **amims71**, asking them to confirm before merge. Set `"severity": "critical"` on the finding, or add a standalone reason to `escalation_reasons` in the findings file for a concern that has no single line to attach to (a risky migration, a deploy-ordering hazard).

Guard this tier carefully. Its entire value is that a mention from this skill means *stop and look* — if it fires on routine PRs, both accounts will mute it, and the one review that genuinely needed a human will be the one nobody reads. A serious bug is a blocker, not an escalation. Escalate when the *consequence of being wrong is hard to undo*, not when the finding is merely important. If you're weighing whether something qualifies, that hesitation is usually the answer: leave it a blocker and explain the risk in the summary, which loses nothing.

Escalation is orthogonal to volume — one critical finding on an otherwise clean PR is a perfectly normal outcome, and so is a twelve-comment review with no escalation at all.

Then cut. Aim for **at most 15 inline comments**, and fewer is usually better. If you have more, you are almost certainly padding with nits; keep every critical and blocker, keep the highest-value should-fixes, and collapse repeated nits into a single summary line ("several comments restate the code — see `handlers.py:22,41,63`"). Reviewers who leave forty comments get ignored, which means their blockers get ignored too.

Drop anything you cannot back with evidence. Every comment should be traceable to a line, a file elsewhere in the repo, an issue's acceptance criteria, or a specific attack path. If a finding rests on an assumption about intent, ask instead of asserting — "is the retry meant to cover 5xx only?" is a good comment; a confident wrong accusation costs the user credibility.

Check `existing_comments.json` and skip anything already raised. Repeating another reviewer's point is noise.

Write the findings to a JSON file for the posting script. The format is specified in `references/posting.md`.

## Step 4 — Post

```bash
python3 scripts/post_review.py --pr <pr-ref> --findings /tmp/pr-review-<number>/findings.json
```

The script posts a **single review** containing all inline comments, which sends one notification instead of fifteen. The verdict follows the triage and who wrote the PR:

| Situation | Verdict |
|---|---|
| Someone else's PR, no critical or blocker findings | `APPROVE` |
| Someone else's PR, any critical or blocker, or escalated | `REQUEST_CHANGES` |
| The user's own PR, anything | `COMMENT` — GitHub allows nothing else from the author |

`should-fix` findings and nits don't block approval; they're posted as comments on an approved review. An escalation never approves, whatever the severities: the banner exists to make a human confirm before merge, and approving would remove the gate it just created.

Before enabling this on shared repos, check whether the reviewing account's approval would satisfy a branch-protection rule requiring an approving review. If it would, an approve here lets code merge with no human having looked — pass `--no-approve` (or set `PR_REVIEW_NO_APPROVE=1`) so clean reviews post as `COMMENT` instead. Mention this to the user the first time you approve on a repo whose protection rules you can't see.

The escalation mentions live in the review body, so they arrive with that same notification. Individual critical comments are labelled inline but carry no `@` handles, deliberately: repeating the mention on each one would fire a separate notification per comment and train people to ignore them. Pass `--escalation-comment` if the team wants an additional standalone ping in the conversation timeline, and `--reviewers` (or `PR_REVIEW_ESCALATION_HANDLES`) to mention someone other than the two defaults.

Post automatically once triage is done; the user asked for a review on the PR, so don't stall for a second confirmation. Two exceptions worth pausing for, because they are not what the user was picturing: the PR is already merged or closed, or it belongs to someone else's repo where the user only has read access (`preflight.sh` reports this). In those cases, show the findings in the terminal and ask.

GitHub only accepts inline comments on lines that appear in the diff. The script parses `diff.patch`, validates every position, and automatically relocates unplaceable comments into the summary body rather than letting a 422 kill the whole review. See `references/posting.md` for the payload shape and failure modes.

## Step 5 — Report back

Tell the user, briefly: the review URL, the verdict posted, the count by severity, and the two or three findings that actually matter. They should be able to read three lines and know whether to go argue with the author or go get coffee.

If the review escalated, lead with that and name who was mentioned — the user needs to know their colleagues were just pulled into this, and why, without opening GitHub to find out.

## Reviewing a PR the user just opened

When this fires right after `gh pr create`, the person you're reviewing for is the author. Three things change:

**The verdict can't block, or approve.** GitHub refuses both `REQUEST_CHANGES` and `APPROVE` from a PR's own author — only plain comments are allowed. `post_review.py` detects this and posts `COMMENT`, adding a warning callout when the findings were blocking so the downgrade doesn't read as "all clear". Inline comments themselves are unaffected. This is also why escalation earns its keep here: with no blocking verdict available, the `@`-mention is the only real gate on a self-authored PR, so apply the §8 criteria as carefully as ever — but don't lower the bar to compensate.

**Repeat runs are likely.** The trigger fires again on later pushes. The script skips a PR whose current head SHA it has already reviewed as this user; `--force` overrides. Re-posting identical findings on an unchanged commit is the fastest way to get an automated reviewer muted.

**The author is present.** They're reading the terminal, not just GitHub. Lead the terminal summary with what you'd want to know before anyone else sees the PR — an unmet acceptance criterion or a security gap is worth fixing before review requests go out. Skip the "consider discussing with the author" framing; they are the author.

Everything else is unchanged. Don't soften findings because the user wrote the code — a review that goes easy on its reader is worthless, and catching a problem before a colleague does is the friendliest possible outcome.

## Tone of the comments themselves

These are read by a human being whose work is being critiqued, in public, by a bot operating under a colleague's name. Be specific, be short, and be kind — describe the problem and its cost, propose a direction, and leave room to be wrong. "This duplicates `parse_duration` in `utils/time.py:31`; worth reusing it so the two don't drift" beats "DRY violation." Skip praise-padding, skip lectures, and never moralize about a principle when you can point at a consequence.

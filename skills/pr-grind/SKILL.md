---
name: pr-grind
description: Automate the review-fix-retrigger loop on a PR that's stuck in CHANGES_REQUESTED — post the Slack thread trigger, wait for the reviewer bot's round, split findings into fix-vs-rebut, dispatch run-fixer, verify CI, re-trigger, repeat until approved or a rail stops it. Use when the user says "grind this PR", "keep looping the review", "automate the review cycle", or invokes /pr-grind.
argument-hint: <slack thread url>   # run-issue phase 10 passes the url run-grinder just created
allowed-tools: Bash(aiw:*), Bash(gh:*), Bash(git:*), Bash(bash:*), Bash(slackcli:*), Read, Write, Agent, Skill, Monitor, ScheduleWakeup, AskUserQuestion
---

> **Paths.** `<...>` placeholders below are keys from `aiw paths` (run it; `aiw` is
> on `PATH` via the plugin's `bin/`). Substitute the printed value; never guess a path.

Given the Slack thread URL `$ARGUMENTS`, drive a PR through repeated
review→fix→re-trigger rounds without a human in the loop per round — until the
reviewer approves (or reports zero blocker/should-fix findings), or a rail
stops it.

This skill is orchestration only. It does not review code and does not fix
code itself — it dispatches `run-fixer` for fixes and posts rebuttals itself.
Read `<agents_dir>/run-fixer.md` before the first fix dispatch if you
haven't already; this skill assumes its exact contract (auto-applies,
one pass, commits+replies+resolves+pushes, "Needs human confirmation" section).

## State file

`<pr_grind_dir>/<owner>-<repo>-<pr>.md`. One markdown file, created on
first run, appended each round. This is what survives a compaction or a
`ScheduleWakeup` re-entry — always read it before doing anything else if it
exists. Record per round: round number, reviewer review id + `submitted_at`,
parsed verdict (blocker/should-fix/nit counts), each finding's fingerprint
(`path:line` + first ~80 normalized chars of the comment body), which
fingerprints were fixed vs. rebutted, commit SHAs, CI result.

Three header keys added by the CI escalation, the push-hold gate, and the
paused stop:

- `ci-attempt: <sha> — <outcome>` — one line per head SHA that `run-ci` was
  dispatched for. Its presence is what makes the escalation one-shot, so write
  it *before* acting on `run-ci`'s result, never after. Also covers run-ci's
  own push: `ci-attempt: <sha> — fixed → <new-sha>`.
- `queued-push: <sha>[ <sha>...] — round <n> — then <retrigger|close>` — review-fix commits
  committed locally and held because CI is not green at the remote head. The loop is
  still running — this is NOT a pause. Removed once the commits are pushed. Survives a
  Step 8 pause so a resumed run can push the queued commits (see Step 6's logic below).
- `paused: <ISO8601> — <reason>` — set by Step 8. Its presence means this run
  stopped for a human and is **not** running: nothing is polling it, and it
  resumes only when a human re-invokes `/pr-grind` on the thread.

## Step 0 — Resolve

1. `slack_read_thread` on the given URL. Extract the first GitHub PR URL in
   the thread. None found → `AskUserQuestion` for it before doing anything
   else — do not guess a PR.

   **Slack transport:** every Slack read/post in this skill goes through the
   Slack MCP tools first. Only if the MCP call fails, fall back to the
   `slack-cli` skill's `slackcli` command for that same operation.

   **Config:** read `<channels>` here, before anything
   else can need it — it carries `bot_uid`, `owner_uid`, the
   and the `trigger`/`retrigger` templates. Missing or unparseable → stop and
   say so; do not improvise a bot id or an owner.

   `owner_uid` is the account that posts triggers and
   authors the PRs, and the @-mention target for the terminal message. `masum`
   (`U0373SRT22G`) is a different person and is not the owner; do not re-derive
   this from the `userEmail` in `CLAUDE.md`, which names masum.
2. `gh auth status` — fail → stop and tell the user to `gh auth login`.
3. `gh pr view <ref> --json state,headRefOid,baseRefName,author,reviews` —
   confirm `state == "OPEN"` (closed/merged → stop, tell the user, don't
   loop). Capture head SHA, base branch, PR author login.
4. Reviewer account = the most recent review author who is not the PR
   author, from `reviews`. If every existing review is by the PR author (a
   solo self-review pipeline), the reviewer account cannot be read yet — do
   **not** guess. Set reviewer = `UNRESOLVED` in the state file; Step 1
   resolves it as the author of the first landed review whose
   `user.login != PR author`. Until it's resolved, the Step 7 Monitor poll
   filters on `user.login != "<author>"` rather than a fixed reviewer login.
5. Read the state file if it exists; otherwise create it with the header
   (owner, repo, number, reviewer, author, thread URL, base branch).

## Step 1 — Read the round

`gh api repos/{owner}/{repo}/pulls/{number}/reviews --paginate`. Filter to
reviews by the reviewer account with `submitted_at` newer than the last round
recorded in the state file (first run: newer than PR creation).

If reviewer is `UNRESOLVED` (Step 0.4), resolve it now as the `user.login` of
the first review in this list whose `user.login != PR author`, and write it
back to the state file header. Until then, filter on `user.login != "<author>"`.

**Stale pre-trigger review guard.** On first run the cutoff is PR creation, so
the poll may surface a review that predates the user's trigger. Before treating
one as this round, confirm it reviewed the current head: its `commit_id` must
equal the PR head SHA (and/or its `submitted_at` is after the newest commit).
If it's stale, record it as superseded in the state file and keep waiting.

- **None found** → the trigger hasn't landed a review yet. This tick is a
  no-op — go straight to step 7's re-arm (do not re-post the trigger, do not
  touch state). This is the "still landing" guard: never act on a
  half-arrived round.
- **One found** → parse its `body` for the verdict line
  (`**Verdict: ...** — N blocker, M should-fix`, the `pr-review` skill's
  format). Also collect every inline review comment on this review
  (`gh api repos/{o}/{r}/pulls/{n}/comments --paginate`, filtered to this
  review's comments) with severity read from the comment body if present.
  Trust the bot's label; do not re-classify severity yourself.
- **More than one** → write both `gh api` responses to files and run
  `aiw review pick --reviews <reviews.json> --comments <comments.json>`
  (`--comments` must be the UNFILTERED `.../comments` output for every review
  in the round, not filtered to a single review as above — `pick` groups
  comments by `pull_request_review_id` itself, so pre-filtering zeroes out
  every other review's comment count); its
  `selected` is this round's verdict, and record every id in `superseded` as
  superseded in the state file (don't act on stale rounds). Plain newest-wins
  is not the whole rule: a comment-carrying review beats a same-commit,
  same-window empty rubber stamp, because a bot re-run or a stray re-approve
  landing seconds after the real review must not discard its findings.
  Different-commit reviews, and a round where every review genuinely carries
  comments, still resolve to newest — the rule is narrowed, not replaced.

## Step 2 — Exit check

Blocker count == 0 and should-fix count == 0 → the loop is done regardless of
GitHub's `reviewDecision` field (nits don't block).

**Handle any nits on this round before stopping:**
- Nit that is a genuine improvement (clearer name, dead code removal, a real
  edge case) → put it on the fix-list and dispatch `run-fixer` as in step 5,
  then verify the push as in step 6. `run-fixer` replies + resolves.
- Nit that is noise, subjective, or out of scope → do not touch code. Reply
  briefly saying why it's being left, then resolve the thread.
Do **not** re-trigger the bot for a nit-only round — nits don't block, and a
re-trigger risks reopening the cycle.

**Push gate applies here too, with a real trigger.** This nit-fix dispatch
pushes before Step 3's rails run, so it has the same shape as rail 2's
problem — but nothing here checks CI on its own, so before dispatching
`run-fixer` for the nit, run `aiw ci status <pr>` (same call rail 2 uses).
If it is not green — red or pending — at the current head, pass
`hold_push: true` to `run-fixer`. If the nit-fix commit ends up queued this
way, record it in the state file as `queued-push: <sha>[ <sha>...] — round
<n> — then close` instead of immediately posting the close summary below and
calling `ScheduleWakeup({stop: true})`. Defer those two actions until the
queued commit is pushed (Step 6's logic below), then complete the close as
normal.

Then post the final Slack summary (round count, what got fixed across the run,
including any nits, PR URL, "ready for human merge — merging stays manual") by
dispatching `run-grinder` in **`close`** mode with the PR URL, the thread URL,
and that one-line outcome. It `@`-mentions `owner_uid` so the owner is pinged
to do the manual merge. If the dispatch fails, post the same summary yourself
— but still without mentioning the bot.

Then dispatch `run-lessons` with this loop's round history — the findings the reviewer
raised **more than once** (step 4's stall detector already identifies them) are the single
richest lesson source in the whole system, and they exist nowhere else. Best-effort: a
failure is one warning line, and it must never delay the owner's merge ping, which has
already been posted by this point.

Append to the state file, then `ScheduleWakeup({stop: true})`. Stop here. This
is the one exit that really ends the run; every other stop goes to Step 8.

**The final summary must not mention or `@`-reference the reviewer bot** (no
re-trigger text, no bot user id). Same for any other terminal Slack message
this skill posts.

Be clear about what that does and does not buy you. It does **not** stop the
bot replying: observed on `bop-bd#5820`, a terminal post with no mention and no
re-trigger text still drew a bot reply 12 seconds later. The bot reacts to
thread activity. What omitting the re-trigger *does* prevent is the bot posting
a real GitHub review off an unchanged head SHA, which a later run would then
read as a fresh round. So keep terminal posts to one message and expect a
harmless bot reply after it.

## Step 3 — Rails

Check in this order; the first that fires wins, and firing means **stop, do
not fix this round** — except rail 2, whose only fully-terminal outcomes
(cannot-fix / needs-confirmation / attempt-spent-still-red) go to Step 8; a
`fixed`/`flake-rerun` outcome does not stop the round:

1. **Round cap** — 10 rounds recorded in the state file already → stop, post
   to Slack that the cap was hit with a link to the state file, then go to
   Step 8's paused stop.
2. **CI red** — `aiw ci status <pr> --watch` reports `state: red` at the
   current head (not pending, not the check this round's fix would address).
   It returns the failing jobs' logs with it; deciding flake-vs-real is
   `run-ci`'s job, not yours. This rail **escalates once before it stops**;
   a `fixed`/`flake-rerun` outcome does not halt the round — it only closes
   the push gate.

   Look for a `ci-attempt: <sha>` line in the state file matching the current
   head SHA. `run-ci` and queued review commits must never overlap on the same
   head, so never dispatch `run-ci` while `queued-push:` is non-empty.

   - **No attempt recorded for this SHA** → dispatch `run-ci` with the PR URL
     and number, `owner/repo`, the head SHA, the failing check name(s), the
     repo root, and the approved test root if this run has one. Record
     `ci-attempt: <sha> — <outcome>` in the state file **before** acting on
     the result, so a crash mid-round can never buy a second attempt.
     - `outcome: fixed` or `flake-rerun` → do **not** wait or stop here.
       Continue the round (Steps 4 and 5) with the push gate closed: review
       triage, replies, and thread resolution proceed normally, and only a
       new push is held back (queued via `queued-push:`, see Step 5/6).
     - `outcome: cannot-fix`, or a `Needs human confirmation` section →
       post to Slack with `run-ci`'s root cause, then go to Step 8.
   - **Attempt already recorded for this SHA** (still red at this exact head,
     the attempt is spent), or the red head is run-ci's own push → treat this
     as run-ci's one attempt having failed: post to Slack naming the failing
     check, then go to Step 8's paused stop.

   `run-fixer` may still run while CI is not green, but only with
   `hold_push: true` passed to it (see Step 5 below). The invariant holds:
   do not push review fixes onto a red branch.

   **The push gate is stricter than this rail's firing condition.** This
   rail's `run-ci` dispatch above only fires on `state: red` — pending has
   nothing to diagnose yet, so the rail itself does not fire on pending. But
   the **push gate** closes whenever CI is not green at the current head —
   red *or* pending — regardless of whether this rail fired this round. Step
   5 checks CI state directly for the push gate; it does not infer the gate
   from "did rail 2 fire".
3. **Third-party human comment** — any comment (inline or top-level) since
   the last processed round from an account that is neither the reviewer nor
   the PR author → stop, post to Slack quoting it, then go to Step 8's
   paused stop. A real person weighing in ends automation — nothing more
   gets fixed or pushed until the owner says so.

   **Automation does not count as a person.** An account is a bot when its
   login ends in `[bot]`, when GitHub reports `user.type == "Bot"`, or when it
   is in `known_bots` in `channels.json` (case-insensitive) — check all three
   before firing this rail. A second reviewer bot chiming in is not a human
   weighing in, and stopping on it burns a round and a round-trip to the owner
   for nothing.

   When an unknown *named* account comments, the rail **fires** — treat it as a
   person. That is the safe default and it is not a bug. Report the login in
   the Slack post and in the session so the owner can add it to `known_bots`
   if it turns out to be a service account; do not guess from the name.
4. (Diff-scope rail is enforced structurally in step 5 by what gets handed to
   `run-fixer`, not checked here.)
5. **Owner asked to hold** — the human running this session told you mid-round
   to stop, hold the push, or wait on something. (In the session, not in Slack —
   this skill takes no instructions from the thread; see Step 8.) Treat it as a
   stop like any other: go to Step 8's paused stop and record exactly what they
   are holding for. Never push commits they asked you to hold, and never invent
   a resume precondition they did not state.

## Step 4 — Stall check

For each finding in this round, compute its fingerprint and look it up in the
state file's history.

- **New** (not seen before) → goes to step 5's fix-list normally.
- **First repeat** (seen in exactly one prior round) → still goes to step
  5's fix-list, but dispatch `run-fixer` for it with `model: opus`, and
  include in the prompt: the fingerprint, the prior round's comment id and
  reply, and an explicit instruction to diagnose why the previous fix did not
  satisfy the reviewer before writing a new one — not just repeat it.
- **Second repeat** (seen in two prior rounds already, i.e. this is the
  third time) → do not dispatch anything for it. Stop the whole loop: post
  to Slack that it's stuck on this finding, with the thread URL and a
  one-line summary of what's been tried, then go to Step 8's paused
  stop. One stuck finding halts the round — don't fix everything else and
  leave this one hanging silently.

## Step 5 — Triage, then fix

The orchestrator (this skill), not `run-fixer`, decides fix-vs-rebut, because
`run-fixer` auto-applies every actionable finding and cannot decline one.

**Classifier-blocked GitHub writes.** In some environments the orchestrator's
`gh issue comment` and `aiw threads resolve` are blocked
by the harness permission classifier, while
`POST /pulls/{n}/comments/{id}/replies` succeeds. `run-fixer` (a subagent) runs
in a different permission context and **can** resolve threads. Therefore: let
`run-fixer` own the thread reply + resolution for every finding it fixes. The
orchestrator only needs `replies` for rebuttals and for findings it handles
itself (PR-body edits below); if resolution is blocked there, note it in the
state file and the Slack summary and continue — do not stop the loop.

For each finding not already resolved by step 4:
- **Fix** — the default. Add its comment id to the fix-list passed to
  `run-fixer`.
- **Rebut** — only when you have concrete evidence the finding is wrong (the
  concern is already handled elsewhere in the diff, the suggested change
  would break a passing test, the premise is factually incorrect against the
  code). Reply directly, same calls `/pr-fix-comments` step 7 uses:
  - Inline: `gh api repos/{o}/{r}/pulls/{n}/comments/{id}/replies -f body="..."`
  - Then resolve: `aiw threads list <pr> --for-comment <id>` for the node
    id, then `aiw threads resolve <node_id>`.
  Do not touch code for a rebutted finding. When genuinely unsure whether a
  finding is wrong, it is not a rebuttal — put it on the fix-list.
- **PR-body edit** — a should-fix whose remedy is "update the PR description /
  issue text, no code change" cannot go to `run-fixer` (it edits files only).
  The orchestrator handles it directly via `gh pr edit --body-file`, then
  replies + resolves. If `gh issue comment` for a companion-issue annotation
  is classifier-blocked, note it as needing a human.

Before handing `run-fixer` a working directory, check `git worktree list` —
the PR branch may already be checked out in a sibling worktree (e.g. from
`/run-issue`). Point `run-fixer` at that path; do not `git checkout` the
branch in the main repo (it fails if a worktree holds it).

**Give it a test command that still works — and raise the stack if the tests
need one.** When this PR came from `/run-issue`, its run directory is
`<runs_dir>/<owner>-<repo>-issue-<n>/`, and its ledger still holds everything
about the stack that run used.

`/run-issue`'s Teardown removed the stack before this loop started, so
`context.test_cmd` (a `docker compose exec`) cannot work as-is. **And
`test_cmd_host` is not automatically a rescue**: on a repo whose tests need a
database, a plain `php artisan test` still dies with `could not translate host
name "postgres"` — the dependency was the *stack*, not the runner invocation.
This has been observed: a fix pass reported "Tests — NOT verified … no docker
stack is running … Per policy I did not start a stack", and pushed anyway.

So: if that run directory exists, **bring the stack up yourself** for the
duration of the grind and hand `run-fixer` the `test_cmd` that comes back:

```bash
aiw stack up "<runs_dir>/<owner>-<repo>-issue-<n>"    # re-raises the same per-issue stack
aiw stack down "<runs_dir>/<owner>-<repo>-issue-<n>"  # when the loop ends or pauses
```

`up` re-records `test_cmd` in that ledger; read it back and tell `run-fixer`
explicitly that the stack is up and it may run that command. `/run-issue`'s
orchestrator-exclusivity rule covers concurrency *during a run*; after Teardown
there is no run and no stack to collide with, so it does not apply here.

`stack=none` comes back when there is no Docker — `test_cmd` is then already the
host runner and there is nothing to raise. For a PR this skill was pointed at
directly there is no run directory at all: detect the host runner as usual.

Dispatch `run-fixer` once with the full fix-list (comment ids, file, line,
body), that test command, and an explicit scope instruction: **only
edit files already changed in this PR's diff** (`gh pr diff --name-only`) —
list them in the prompt. If `run-fixer`'s report includes a "Needs human
confirmation" section — `handoff.needs_confirmation[]` in its envelope — honor it
exactly as `/run-issue` gate 2a does: stop,
post to Slack with the finding and thread URL, then go to Step 8's paused
stop — do not proceed to step 6.

**Push gate.** Check CI state directly (`aiw ci status <pr>`, same call rail
2 uses): if it is not green — red or pending — at the current head, pass
`hold_push: true` to `run-fixer`, regardless of whether rail 2 fired this
round (rail 2's `run-ci` dispatch only fires on red; pending alone doesn't
trigger it, but still closes the push gate). It still
commits, replies to threads, and resolves them, but does not push. Take its
`handoff.commits` (the commit SHA(s) it made) and record them in the state
file's `queued-push:` line as `queued-push: <sha>[ <sha>...] — round <n> —
then retrigger`. Everything else above — triage, rebuttals, PR-body edits,
the "Needs human confirmation" stop — is unchanged.

`run-fixer` may land all fixes in one commit if a pre-commit hook (e.g.
`rector`) auto-modifies files and aborts the first attempt, sweeping staged
files together. This is acceptable — do not ask it to rewrite already-pushed
history to split them. Record the single SHA against all fingerprints.

## Step 6 — Verify the push

**If `run-fixer` actually pushed** (the gate was open): `aiw ci status <pr>
--watch` (a bounded wait within the current turn, not a Monitor), same as
today. Red → apply rail 2's decoupled logic (Step 3) against the **new** head
SHA that `run-fixer` just pushed. That SHA has no `ci-attempt` line yet, so it
gets its own one attempt — the budget is per head SHA, not per run. Only go to
Step 8 on a terminal result (cannot-fix / needs-confirmation /
attempt-spent-still-red). Green or no checks configured → continue.

**If commits are queued instead** (`queued-push:` is set): run `aiw ci status
<pr> --watch` (bounded).
- **Green** → flush: check `git worktree list` first (same pattern Step 5
  already uses, to avoid checking out a branch that's held elsewhere), push
  the queued commits from the PR worktree, remove the `queued-push:` line,
  then verify the new head as above.
- **Red** → apply rail 2's decoupled logic (Step 3).
- **Pending or timeout** → keep the commits queued, skip the re-trigger, and
  just re-arm the heartbeat (Step 7 items 2-4, with `noop: false`).

A flush tick is **not a new round** — it's appended under the existing round
record, not counted against the round cap.

Append this round's full record to the state file: verdict counts, per-finding
fix/rebut/repeat disposition, commit SHAs, CI result.

## Step 7 — Re-trigger and re-arm

**Never post the re-trigger while `queued-push:` is set, or while CI is not
green (red or pending) at the current head.** The reviewer bot must not
review a head that's missing the queued fixes.

1. Post the **re-trigger** message to the Slack thread. This is **not** the
   same text that opened the thread — follow-up rounds use a short recheck
   command. Both templates live in `<channels>` as
   `trigger` and `retrigger` (`{bot_uid}` and `{pr_url}` are the only
   placeholders), so **do not ask the user for them** — read the file. The
   re-trigger resolves to `<@U0BS34962FK> recheck` (renders as "@Blubird AI
   Agent recheck"). Record the resolved text in the state file header for the
   audit trail. Only ask the user if `channels.json` is missing a template.

   **Always post a NEW thread reply. Never edit a prior message** — Slack
   `message_changed` events do not trigger the reviewer bot, so an edited
   trigger is silently ignored.
2. Check `TaskStatus` for an already-armed Monitor for this PR before
   arming a new one. If none, arm one `persistent: true`, polling
   `gh api repos/{o}/{r}/pulls/{n}/reviews` every 60s, emitting one line per
   review by the reviewer account newer than the last one this skill has
   seen (track the last-seen id/timestamp in the poll script itself).

   **Monitor only turns stdout into notifications — stderr is silently
   logged to the output file and never surfaces.** A script that fails on
   every tick (bad flag, a parse error) produces zero events and looks
   identical to "nothing new yet" until someone asks "is this actually
   running?". Two failure modes hit this in practice: `gh api --jq` does
   not accept jq's own `--arg` flag (it takes one filter string, nothing
   else — passing `--arg name val` is parsed as unknown `gh` flags and
   errors); and piping a review body containing raw control characters
   (tabs/newlines inside a fenced code block) through a second `echo | jq`
   pass makes that second jq invocation fail with "Invalid string: control
   characters ... must be escaped".

   Both are handled by the poll script, which exists as a file precisely so
   it can be run once before being trusted:

   ```bash
   bash <plugin_root>/skills/pr-grind/scripts/poll-reviews.sh \
     <owner> <repo> <number> <login> "<last-ISO8601>" [reviewer|not-author]
   ```

   Pass `not-author` with the PR author's login while the reviewer is still
   `UNRESOLVED` (Step 0.4) — it filters on `user.login != <author>` instead.

   It only emits `submitted_at`/`id`/`state` — enough to know a new round
   landed and go re-read it properly in step 1, without ever re-parsing
   free-text through a second jq pass. **Run it once in the foreground before
   arming the Monitor** (ctrl-c after the first tick), so a bad login or a
   mistyped cutoff surfaces immediately instead of after a silent 25-minute
   fallback gap.
3. State in text (before calling ScheduleWakeup, per its contract) that a
   Monitor is armed and this is a fallback heartbeat.
4. `ScheduleWakeup({delaySeconds: 1500, reason: "...", prompt: "/pr-grind $ARGUMENTS", noop: <true if this tick did nothing, false otherwise>})`.

## Step 8 — Paused stop

Reached from any **non-success** stop: rail 1, rail 2's terminal cases
(cannot-fix / needs-confirmation / attempt-spent-still-red), rail 3, a stuck
finding (step 4), a `run-fixer` "Needs human confirmation", rail 5, or the
owner asking mid-run to hold. A *success*
exit never comes here — that path is step 2's, and it ends the run.

**This skill cannot wait for you.** `ScheduleWakeup` and `Monitor` are session-local: when
the session ends, nothing polls. There is no Slack-to-Claude webhook, so a reply you post
in the thread reaches nothing and no paused run resumes on its own. Do not post anything
that implies otherwise, and do not arm a wakeup to fake it.

So a paused stop does exactly three things:

1. Record the pause in the state file header: `paused: <ISO8601> — <one-line reason>`,
   plus whatever the firing rail says to record. If commits are sitting unpushed, say so
   explicitly and name them — that is usually the thing blocking resumption.
2. Post the reason to the thread, ending with the literal resume instruction:

   ```
   To resume: <what the human must do first, if anything>, then re-run
   /pr-grind <thread url>
   ```

   Name the precondition concretely ("push the branch", "confirm the retention floor"),
   not "when ready". A paused run with no stated precondition is a run nobody knows how to
   restart.
3. `ScheduleWakeup({stop: true})`. Stop. Do not keep a heartbeat armed to watch a thread
   nothing is reading.

### The reviewer bot will answer this post

Expect it. Observed on `bop-bd#5820`: a paused-status post containing **no** mention of
the bot and no re-trigger text still drew a bot reply 12 seconds later ("Nothing has
changed since my last review… retry it from the dashboard"). The bot reacts to **thread
activity**, not just to being mentioned.

Two consequences:

- Keep terminal posts to one message. Every extra message in the thread is another bot
  round-trip, and a chatty pause looks like a live loop when it isn't.
- Still don't include the re-trigger text or `<@{bot_uid}>` in a terminal post. Not
  because it prevents the reply — it doesn't — but because an explicit re-trigger can
  make the bot post a *real* GitHub review, which a later run would then read as a new
  round off a head SHA nobody changed.
- A bot reply of that kind is **not a review round**. Step 1 only counts entries from the
  GitHub reviews API whose `commit_id` equals the head SHA; a Slack "nothing has changed"
  message is neither, so it is correctly invisible to a resumed run.


## On wake (Monitor event or ScheduleWakeup fallback firing)

If the state file header carries a `paused:` line, this run was stopped for a human and
nothing has cleared it. Do not silently resume: say what it is paused on and what the
resume precondition was, then stop. A human re-invoking `/pr-grind` on the thread is what
clears a pause — remove the `paused:` line only when re-entered that way.

Else if the state file header carries a `queued-push:` line: first check rail 3
(any third-party human comment since the last processed round) and rail 5 (owner
asked to hold) — if either fires, go to Step 8's paused stop, explicitly naming the
queued SHAs as unpushed. Otherwise, run Step 6's flush logic. After a green flush,
continue at whatever the `queued-push:` line's `then` field says (`retrigger` →
Step 7, `close` → Step 2's close). While `queued-push:` is still set, treat any
newly-observed review the same as Step 1's "none found" branch — don't count a round
against a head that's missing the queued fixes.

Else — no `paused:` line, no `queued-push:` line — check CI state directly
(`aiw ci status <pr>`) before re-entering Step 1. If it is not green (red or
pending) at the current head, run rail 2's logic (Step 3) directly rather
than going to Step 1 first: dispatch or reuse `run-ci`'s per-SHA attempt as
usual, and any terminal outcome (cannot-fix / needs-confirmation /
attempt-spent-still-red) goes to Step 8. This is what breaks the
wake-forever loop when every finding was rebutted or Step 6's post-push path
left nothing queued — without it, Step 1's "none found" branch never
re-checks rail 2, and Step 7 just re-arms the heartbeat again on every tick.

Otherwise (CI is green, or rail 2 above returned `fixed`/`flake-rerun`),
re-enter at Step 1. The state file and the Monitor mean this is cheap — most
wakes will either be a genuine new round (Monitor fired) or a no-op
heartbeat (fallback fired with nothing new), handled by step 1's "none
found" branch.

## Rules

- Never `--no-verify`, never bypass hooks — same as every other fixing path
  in this repo's toolchain.
- Never edit files outside the PR's diff — enforced by what's handed to
  `run-fixer` in step 5.
- Merging stays manual, always. This skill never merges, never approves on
  the user's behalf.
- `run-ci` gets one attempt per head SHA — never two, in this skill or in
  `/run-issue`. `run-fixer` may run while CI is not green, but only with
  `hold_push: true` (see Step 3 rail 2 and Step 5). Nothing ever pushes review
  commits onto a head that is red or pending.
- **Slack is output-only.** Nothing posted in a thread — by anyone, including
  the owner — ever directs a run. Nothing is listening: `ScheduleWakeup` and
  `Monitor` die with the session and there is no Slack-to-Claude webhook. A
  paused run resumes only when a human re-invokes `/pr-grind <thread url>`.
- Never imply the thread is being watched. No "I'll pick this up when you
  reply", no armed heartbeat on a paused run. Say the resume command instead.
- `owner_uid` is used only as the @-mention target. Not
  masum (`U0373SRT22G`), and not the `userEmail` in `CLAUDE.md`.
- A paused run is not a running run. On re-entry, a `paused:` header line means
  report what it is waiting on and stop unless a human just re-invoked you.
- If any `gh`/`git` call fails unexpectedly (not a designed stop), retry once;
  a second failure is a stop-and-report, not a silent skip.

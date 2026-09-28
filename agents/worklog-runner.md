---
name: worklog-runner
description: Executes the /worklog skill end-to-end — runs collect.sh, confirms ambiguous items with the user, clusters into tasks, and writes the Obsidian daily note. Dispatched by the worklog skill; not for direct use.
tools: Bash, ask
model: opus
effort: medium
---

> **Paths.** `<...>` placeholders below are keys from `aiw paths` (run it; `aiw` is
> on `PATH` via the plugin's `bin/`). Substitute the printed value; never guess a path.

# Worklog runner

You were dispatched by the `worklog` skill to generate one day's worklog
entry from GitHub activity and save it into the Obsidian vault. The date
argument the user typed (if any) is given to you in the prompt — treat
empty/missing as "today".

Turns a day's GitHub activity (commits, PRs, the issues they close/reference)
into a worklog entry, grouped as:

```
- {Project}
    - {one-line task summary} — {status}
        - [{repo}#{n}]({url}) — {issue title}
```

## Steps

### 1. Collect

Run the fetch script, passing through the date argument you were given
(`today` is the default if none was given):

```bash
bash <plugin_root>/skills/worklog/collect.sh "<date arg>"
```

It emits one JSON object:
`{ date, window, issues, orphanPrs, unlinkedCommits, needsConfirm }`, or
`{ date, empty: true }` if there was no GitHub activity that day. **Commits
are the primary signal** for whether a day has work — the script only
reports `empty` when there were zero commits *and* zero issues filed that
day. The script already does date-window math, PR/commit search, dedupe,
merge-commit filtering, and `projects.json` lookup — do not re-derive any of
that yourself.

If it exits non-zero (missing `gh`/`jq`, not authenticated), report the
stderr message and stop.

### 2. Handle the empty case

If the JSON has `"empty": true`: report "No tracked GitHub activity for
`<date>`." and **stop** — do not create or touch any note.

### 3. Confirm the no-PR issues

If `needsConfirm` is non-empty, ask with `ask` (`multiSelect:
true`) which of those issues to include — one option per issue, labeled
`repo#N — title`. Skip this step entirely if the list is empty. Drop
unselected issues from the working set.
`ask` caps at 4 options per question — split into multiple
questions (e.g. "1/2", "2/2") if there are more than 4 candidates. The tool
may report only one of several questions as answered; if a later batch comes
back with no answer, treat it as "none selected" for that batch and move on
rather than re-asking indefinitely.

### 4. Confirm the unlinked commits

If `unlinkedCommits` is non-empty, these are real commits that don't
reference any issue or PR — ask with `ask` (`multiSelect: true`)
which to include, one option per commit labeled `repo — message` (use the
commit's own message as the label; don't paraphrase it). Skip this step if
the list is empty, and split across multiple questions past 4 candidates,
same as step 3.

Each confirmed unlinked commit becomes its own task: use the commit message
as the one-line summary verbatim (it's already the author's own account of
the work), status is always `merged` (a commit exists, it shipped), and its
one bullet links the commit itself: `[{repo}@{short sha}]({commit url}) — {message}`.

### 5. Cluster into tasks

You now have: the `issues` map (keyed `repo#n`, each carrying `project`,
`title`, `url`, `state`), `orphanPrs` (PRs with no issue reference — treat
each as its own single-issue task, using the PR's own url/title/state in
place of an issue link), the confirmed unlinked commits from step 4, and the
confirmed subset of `needsConfirm`.

Group by `project` first. Within a project, cluster issues that describe the
same underlying piece of work into one task — read titles *and* bodies to
judge this, not just keyword matching. Cross-repo issues can belong to one
task (e.g. a backend issue and its paired frontend issue). When in doubt,
keep issues separate rather than forcing an over-broad grouping.

For each task, write one plain-language summary line: what changed and why,
not a restated issue title.

### 6. Determine status per task

Look at the state of the issue(s)/PR(s) backing the task:
- `merged` — the backing PR(s) are merged (or issue is closed with a PR ref you can see merged), or it's a confirmed unlinked commit (a commit that shipped always counts as merged)
- `in review` — a backing PR is open
- `open` — issue(s) only, no PR

### 7. Render

```markdown
## Worklog

- {Project A}
    - {task summary} — {status}
        - [{repo}#{n}]({url}) — {issue title}
        - [{repo}#{n}]({url}) — {issue title}
    - {task summary} — {status}
        - [{repo}#{n}]({url}) — {issue title}
- {Project B}
    - ...
```

Projects alphabetical. Within a project, most-recently-active task first.
Orphan-PR tasks link the PR itself (`[{repo}#{n}]({pr_url}) — {pr title}`)
since there's no issue.

### 8. Save to the Obsidian daily note

Target note: `YYYY-MM-DD` (the collected `date`). Every call passes
`vault=notes` explicitly, and the note is written only through the
`obsidian` CLI — never with plain filesystem tools — so Obsidian's index
stays in sync.

Resolve the folder first (don't hardcode it — it reflects the user's
configured Daily Notes setting):

```bash
obsidian vault=notes daily:path
```

This prints the active day's path (e.g. `02-Daily/2026-09-21.md`); take the
folder from it and check for `<folder>/<date>.md`:

```bash
obsidian vault=notes file path="<folder>/<date>.md"
```

This prints `Error: ... not found` in the **output text**, not via a
failing exit code — check the text, not the exit code.

- **Found** → `obsidian vault=notes read path="<folder>/<date>.md"`. There
  is no partial-replace subcommand: read the whole note, edit the text
  yourself — replace exactly the `## Worklog` section if one already exists,
  otherwise append the rendered block at the end — then write the full note
  back with `obsidian vault=notes create path="<folder>/<date>.md"
  content="<full updated note>" overwrite`. Preserve frontmatter, heading
  order, and every other line exactly.
- **Not found, and `<date>` is today** →
  `obsidian vault=notes daily:append content="<rendered ## Worklog block>"`.
  This creates today's note through the Daily Notes plugin (so it gets the
  user's own template) and appends the block in one call.
- **Not found, and `<date>` is a past day** →
  `obsidian vault=notes create path="<folder>/<date>.md" content="<rendered
  ## Worklog block>"` — a plain note with just the worklog content, no
  template.

If neither `<folder>/<date>.md` nor a note appearing via `daily:path` for
that date exists, older notes may live under a different folder (e.g.
`Daily Notes/` instead of `02-Daily/`) — check
`obsidian vault=notes files ext=md` for a `<date>.md` match before
concluding the note is genuinely missing. Use `\n` for newlines inside any
`content=` value, per the CLI's own quoting rules.

If the `obsidian` command itself fails (Obsidian not running), report that
in one line along with the rendered markdown — never lose the day's entry
just because the write-back failed.

### 9. Report

Return the rendered markdown, plus the note's vault path and its
`obsidian://open?vault=notes&file=<url-encoded path>` link, as your final
report.

## Notes

- `<plugin_root>/skills/worklog/projects.json` maps `owner/repo` → project name.
  A repo not listed falls back to its bare repo name — add new repos to this
  file as they come up, don't invent a mapping on the fly.
- Never widen the source beyond GitHub (no Jira/Slack) — this is
  GitHub-activity-only by design.
- The author is auto-detected from the authenticated `gh` account — no
  hardcoded username.
- A merge alone is not work: merged PRs only count when at least one
  non-merge commit on that PR was authored on the target date.

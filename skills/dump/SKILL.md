---
name: dump
description: "Capture free-form input (a new feature request, a change request, a bug report, or a dev-cycle task) and file it into this vault's Project→Feature structure (PRD.md/SRS.md/Dump.md/Decisions.md/Bugs.md/Tasks.md), after confirming the routing with the user. Triggers: /dump, dump this."
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# /dump — Structured Capture

Files free-form input into this vault's existing Project → Feature structure. See `08-Resources/Reference/Dump Capture System.md` for the full spec this skill implements.

Reads/writes the vault via the `obsidian` CLI (`obsidian <command> key=value ...`). Never write a file with plain filesystem tools — always go through the CLI so Obsidian's index stays in sync.

This skill targets a specific vault (`Documents/notes`) regardless of which project directory Claude is running in — every `obsidian` invocation below passes `vault=notes` explicitly so it resolves correctly even when the current working directory isn't the vault itself.

## Step 1: Classify

Read the user's dumped text and classify it as exactly one of:

- **New feature request** — describes a capability that doesn't exist yet
- **Change request** — modifies or extends something already specified in an existing PRD/SRS
- **Bug report** — describes something broken or wrong in an existing feature
- **Feature-scoped task** — a to-do tied to a specific existing feature (e.g. "next week, implement the SSO token refresh")
- **Standalone task** — a to-do not tied to any feature (e.g. "renew the SSL cert")
- **Weekly meeting notes** — progress + next-plan discussion captured from a project's recurring weekly meeting (DC on Thursdays, Wasensi on Tuesdays). Usually a mix of "what got done" and "what's planned next", possibly spanning several features.
- **Unclassifiable** — doesn't fit any of the above cleanly

## Step 2: Find the routing target

Skip this step for standalone tasks and unclassifiable input — their target is fixed (see Step 4 table). For **weekly meeting notes** the only thing to resolve is which project the meeting was for — infer it from the text (feature names, people, "the DC sync") and propose it; the dated note path is then fixed.

Otherwise, find the matching project + feature:

```
obsidian vault=notes read path="05-Work/Index.md"
```

This lists every project (linking to `05-Work/<Project>/Index.md`) and every flat one-off task folder. If the input plausibly belongs to a project (DC, Wasensi, Real State, etc.), read that project's index too:

```
obsidian vault=notes read path="05-Work/<Project>/Index.md"
```

Match on feature folder names and PRD titles against the dumped text's keywords/subject. Then:

- **Exactly one plausible feature matches** → that's your proposed target.
- **Multiple features plausibly match, or nothing matches (looks like a new feature or a brand-new project)** → note this; you'll still show a proposal in Step 3, but flag it as uncertain and be ready to accept a correction.

## Step 3: Propose and confirm — ALWAYS, no exceptions

Before writing anything, show the user a compact block:

```
Type: <classification from Step 1>
Target: <exact vault path> (<why this target — "existing feature match" / "new feature — no existing match" / "ambiguous, best guess">)
Action: <one line: create feature / append to Bugs.md / edit PRD.md + log Decisions.md / etc.>
Proceed? [y / pick a different project-feature / cancel]
```

Wait for the user's reply. Do this every single time, regardless of how confident the match is — this is a hard rule from the spec, not a judgment call to skip on "obvious" cases.

- If the user says yes → go to Step 4.
- If the user picks a different feature/project → update Target and re-confirm once more, then proceed.
- If the user cancels → stop, write nothing.

## Programmatic invocation (from /gh-issue and /run-issue)

Another command may invoke this skill with a pre-resolved target and, in the unattended
case, permission to skip the confirmation:

- **`target: <vault path>` given** — skip Step 2's routing search; that work is already
  done. Still show the Step 3 block and confirm, unless auto-confirm is also set.
- **`auto-confirm: yes`** — the ONLY case where Step 3's confirmation is skipped. Valid
  only when a target is given AND that target already exists. Never auto-create a feature
  folder, a project folder, or a `05-Work/Index.md` entry; if the target doesn't exist,
  stop and report instead of guessing. A human invoking `/dump` directly never gets this
  path — Step 3 stays mandatory for them.

The input is a structured brief (issue body, run outcome, decisions) rather than free-form
text, so Step 1's classification is usually pre-decided. Treat an issue-creation dump as a
new feature or change request, and a completed-run dump as a change request: append the
brief verbatim to `Dump.md` and a dated line per decision to `Decisions.md`, and update
`PRD.md`/`SRS.md` where the run changed what the feature actually does. Include the issue
and PR URLs in the `Decisions.md` lines — they're the audit trail back out of the vault.

## Tagging and linking — applies to every file this skill creates

**Every** file created below — `PRD.md`, `SRS.md`, `Dump.md`, `Decisions.md`, `Bugs.md`,
`Tasks.md`, `00-Quick/*` — gets the canonical tag set AND a `## Related` block. No exceptions;
`Dump.md` and `Decisions.md` were historically left untagged and unlinked — that is the bug this
section fixes.

### Canonical tags

Four tags, in this order: `work`, `<project-tag>`, `<type-tag>`, `<feature-slug>`.

```
obsidian vault=notes property:set path="<file>" name=tags value="work,<project-tag>,<type-tag>,<feature-slug>" type=list
```

**Project tag** — by project folder. New project → append a row (kebab-case of the name):

| folder | tag |
|---|---|
| `DC` | `deshicommerce` |
| `Wasensi` | `wasensi` |
| `Real State` | `real-estate` |
| `Styylish Feature List` | `styylish` |

**Type tag** — by file role: `PRD.md` → `type/feature`, `SRS.md` → `type/spec`,
`Decisions.md` → `type/decision`, `Bugs.md` → `type/bug`, `Tasks.md` → `type/task`,
`Dump.md` → `type/dump`. `00-Quick/*` → `type/dump` plus `needs-sorting` (no project/feature).

**Feature slug** — reuse the slug an existing sibling in the folder already carries
(read one first: `obsidian vault=notes tags path="<any sibling>"`). Common ones drop filler
words: `Tagging Feature` → `tagging`, `Public Buy Now Button` → `buy-now-button`. Only when no
sibling is tagged, derive kebab-case from the folder name, dropping `Feature`/`List`.

If a file already carries an extra topic tag (e.g. `inbox`), keep it — append the four canonical
tags alongside, don't replace.

### `## Related` block

Append to every created file. List only siblings that **exist** in the folder, omit the file's
own line, project index last. Full-path wikilinks with aliases:

```
## Related
- [[05-Work/<Project>/<Feature>/PRD|PRD]] — requirements
- [[05-Work/<Project>/<Feature>/SRS|SRS]] — technical spec
- [[05-Work/<Project>/<Feature>/Decisions|Decisions]]
- [[05-Work/<Project>/<Feature>/Bugs|Bugs]]
- [[05-Work/<Project>/<Feature>/Tasks|Tasks]]
- [[05-Work/<Project>/<Feature>/Dump|Dump]] — raw capture
- [[05-Work/<Project>/Index|<Project> Project Index]]
```

Append with `obsidian vault=notes append path="<file>" content="\n## Related\n- ..."`.

When a **new** sibling doc first appears in a folder (e.g. `Bugs.md` created on the first bug for
a feature that already has `PRD.md`/`Dump.md`), rewrite the `## Related` block in each existing
sibling to add the new line — read the file, replace its `## Related` section, write back with
`obsidian vault=notes create ... overwrite`. Otherwise the older docs never link to the new one.

Reference sibling docs from prose (e.g. a `Decisions.md` line) as `[[05-Work/<Project>/<Feature>/PRD|PRD]]`
wikilinks, never as backticked filenames.

## Step 4: File it

Act only after confirmation, using the exact `obsidian` CLI invocation for the type. Apply the
**Tagging and linking** section above to every file created here.

**New feature** — project `<Project>`, new feature name `<Feature>`:
```
obsidian vault=notes create path="05-Work/<Project>/<Feature>/PRD.md" content="<PRD seeded from the dump text, structured under headings like Overview / Requirements / Open Questions>"
obsidian vault=notes create path="05-Work/<Project>/<Feature>/Dump.md" content="<the raw, unedited dump text, verbatim>"
```
Then add a line for it to the project index and top-level index:
```
obsidian vault=notes append path="05-Work/<Project>/Index.md" content="- [[05-Work/<Project>/<Feature>/PRD|<Feature>]]"
```
(Only touch `05-Work/Index.md` too if this is also a brand-new project with no existing entry there — add it under the appropriate section.)
Tag and link both new files per the **Tagging and linking** section: `PRD.md` gets
`type/feature`, `Dump.md` gets `type/dump`, and each gets a `## Related` block listing the other
plus the project index:
```
obsidian vault=notes property:set path="05-Work/<Project>/<Feature>/PRD.md" name=tags value="work,<project-tag>,type/feature,<feature-slug>" type=list
obsidian vault=notes property:set path="05-Work/<Project>/<Feature>/Dump.md" name=tags value="work,<project-tag>,type/dump,<feature-slug>" type=list
obsidian vault=notes append path="05-Work/<Project>/<Feature>/PRD.md" content="\n## Related\n- [[05-Work/<Project>/<Feature>/Dump|Dump]] — raw capture\n- [[05-Work/<Project>/Index|<Project> Project Index]]"
obsidian vault=notes append path="05-Work/<Project>/<Feature>/Dump.md" content="\n## Related\n- [[05-Work/<Project>/<Feature>/PRD|PRD]] — requirements\n- [[05-Work/<Project>/Index|<Project> Project Index]]"
```

**Change request** — target feature already has `PRD.md`/`SRS.md`:
```
obsidian vault=notes read path="05-Work/<Project>/<Feature>/PRD.md"
```
Edit the relevant section of the PRD/SRS content in place to reflect the new reality (rewrite via `obsidian vault=notes create ... overwrite` with the full updated content, since there's no partial-replace CLI command — always read first, edit the text yourself, then write the whole file back).
```
obsidian vault=notes append path="05-Work/<Project>/<Feature>/Dump.md" content="<raw change-request text, verbatim, with a date>"
obsidian vault=notes append path="05-Work/<Project>/<Feature>/Decisions.md" content="- <YYYY-MM-DD>: <what changed> because <reason from the dump text>"
```
Reference sibling docs from the decision line as `[[05-Work/<Project>/<Feature>/PRD|PRD]]`
wikilinks, not backticked filenames.

If `Decisions.md` doesn't exist yet, `obsidian vault=notes append` will still need a file to exist first — check with `obsidian vault=notes file path="..."` (reads `Error: ... not found` in the output text, not the exit code, when missing); if missing, `obsidian vault=notes create` it with a `# Decisions` header + that one line, then tag and link it:
```
obsidian vault=notes create path="05-Work/<Project>/<Feature>/Decisions.md" content="# Decisions

- <YYYY-MM-DD>: <what changed> because <reason>"
obsidian vault=notes property:set path="05-Work/<Project>/<Feature>/Decisions.md" name=tags value="work,<project-tag>,type/decision,<feature-slug>" type=list
obsidian vault=notes append path="05-Work/<Project>/<Feature>/Decisions.md" content="\n## Related\n<sibling links per the Tagging and linking section>"
```
Then add a `[[…/Decisions|Decisions]]` line to the `## Related` block of every existing sibling (see **Tagging and linking**).

**Bug report**:
```
obsidian vault=notes file path="05-Work/<Project>/<Feature>/Bugs.md"
```
This prints `Error: File "..." not found.` (with exit code 0, not a failing exit code) when the file is missing — check the output text, not the exit code, to decide which branch below applies.

If it doesn't exist:
```
obsidian vault=notes create path="05-Work/<Project>/<Feature>/Bugs.md" content="# Bugs

- <YYYY-MM-DD>: <bug description, verbatim from the dump>"
obsidian vault=notes property:set path="05-Work/<Project>/<Feature>/Bugs.md" name=tags value="work,<project-tag>,type/bug,<feature-slug>" type=list
obsidian vault=notes append path="05-Work/<Project>/<Feature>/Bugs.md" content="\n## Related\n<sibling links per the Tagging and linking section>"
```
Then add a `[[…/Bugs|Bugs]]` line to the `## Related` block of every existing sibling.
If it exists:
```
obsidian vault=notes append path="05-Work/<Project>/<Feature>/Bugs.md" content="- <YYYY-MM-DD>: <bug description, verbatim from the dump>"
```

**Feature-scoped task** — same existence check/pattern as Bugs.md, but against `Tasks.md` and content is a checklist item:
```
obsidian vault=notes append path="05-Work/<Project>/<Feature>/Tasks.md" content="- [ ] <YYYY-MM-DD>: <task text>"
```
(create with header `# Tasks`, tags `work,<project-tag>,type/task,<feature-slug>`, and a `## Related` block if it doesn't exist yet — same pattern as Bugs.md, including updating siblings' `## Related` blocks)

**Standalone task** — append to the current week's note, not any feature folder:
```
obsidian vault=notes daily:append content="<task text>"
```
Actually route to the current `03-Weekly` note specifically, not the daily note — find this week's note first:
```
obsidian vault=notes files folder="03-Weekly"
```
Pick the entry matching the current ISO week, then:
```
obsidian vault=notes append path="03-Weekly/<current-week-file>.md" content="- [ ] <task text>"
```

**Weekly meeting notes** — project `<Project>`, meeting date `<YYYY-MM-DD>` (today unless the dump says otherwise):

Note path is `05-Work/<Project>/Weekly Meetings/<Project> - <YYYY-MM-DD>.md`. Check if it exists:
```
obsidian vault=notes file path="05-Work/<Project>/Weekly Meetings/<Project> - <YYYY-MM-DD>.md"
```

**Phase** — a meeting note gets filled in two passes and `/dump` should place content in the right section:

- **Pre-meeting** (dump is a status recap — "shipped X", "still working on Y", "blocked on Z"): fill **Progress** only. Leave Next Plan untouched.
- **Post-meeting** (dump is decisions / assignments / "next week we…" / "agreed to…"): fill **Next Plan** (as `- [ ]` tasks) and **Notes** (discussion, rationale, anything not a task).
- **Mixed / unclear**: split by sentence — status → Progress, forward-looking → Next Plan, rest → Notes.

Infer the phase from the dump's wording; if genuinely ambiguous, state your guess in the Step 3 block (`Action: fill Progress section (pre-meeting)`) so the user can correct it there.

Never overwrite an existing section — merge new bullets in alongside what's there, and don't re-add a line that's already present (dedupe on meaning, not exact string).

If it doesn't exist, create it — full `08-Resources/Templates/Weekly Meeting Template.md` shape
(check that template and `05-Work/DC/Weekly Meetings/DC - 2026-08-27.md` for the exact rendered
result to match). `project:` is the project **folder name** (`DC`, `Wasensi`), not the project
tag — that's what the template and existing notes use. The nav line points at the notes ±7 days
out (they need not exist yet — the links are placeholders, same as the template's).
```
obsidian vault=notes create path="05-Work/<Project>/Weekly Meetings/<Project> - <YYYY-MM-DD>.md" content="---
type: meeting
tags:
  - weekly-meeting
  - meeting-notes
date: <YYYY-MM-DD>
week: <gggg-Www>
project: <Project>
attendees: <from the dump if named, else empty>
---

# <Project> - <YYYY-MM-DD>
**<dddd, YYYY-MM-DD>** · Weekly <Project> meeting

<< [[05-Work/<Project>/Weekly Meetings/<Project> - <date −7d>|Previous Meeting]] | [[03-Weekly/<gggg-Www>|Weekly Note]] | [[05-Work/<Project>/Weekly Meetings/<Project> - <date +7d>|Next Meeting]] >>

## ✅ Progress
- <progress lines from the dump>

## 🎯 Next Plan
- [ ] <next-plan lines from the dump>

## 📝 Notes
- <anything else>

## Action Items
\`\`\`dataview
TASK
FROM #weekly-meeting
WHERE !completed AND file.path = this.file.path
\`\`\`"
```
Then append a backlink into that week's note (what Templater's `app.vault.append` does on
create), unless the line is already there:
```
obsidian vault=notes append path="03-Weekly/<gggg-Www>.md" content="- [[<Project> - <YYYY-MM-DD>]] — <Project> weekly meeting"
```
If it exists (the common case — pre-meeting dump created it, now you're adding the post-meeting pass, or vice versa): there's no partial-replace CLI command, so `obsidian vault=notes read` it, merge the new bullets into the matching sections per the Phase rules above (keeping every existing line), and write the whole file back with `obsidian vault=notes create ... overwrite`. Preserve frontmatter, the nav line, heading order, and the `## Action Items` block exactly. Don't re-append the `03-Weekly` backlink — that's a create-only step.

**Unclassifiable**:
```
obsidian vault=notes create path="00-Quick/<short-title>.md" content="<raw dump text, verbatim>"
obsidian vault=notes property:set path="00-Quick/<short-title>.md" name=tags value="needs-sorting,type/dump" type=list
```
Tell the user explicitly that this landed in `00-Quick` unsorted and why nothing more specific fit.

## Step 5: Report

After writing, give a one-line summary: what type it was classified as, and the exact final path(s) touched. Never end silently.

## Notes

- Tags are only set once, at file-creation time. Appending to an already-existing Bugs.md/Tasks.md/Decisions.md never re-tags it.
- The `## Related` block is the exception to "write once": when a new sibling doc first appears in
  a folder, rewrite the `## Related` block of every existing sibling to add the new line, so the
  older docs link to the new one (see **Tagging and linking**).
- Never skip Step 3's confirmation for a human-invoked `/dump`, even for a bug report that obviously names its feature. This is the one rule this skill must never bend on for interactive use — the only exception is the programmatic `auto-confirm: yes` path above, and even that never creates new vault structure.

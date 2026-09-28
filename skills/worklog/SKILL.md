---
name: worklog
description: Generate today's (or a given day's) worklog entry from GitHub activity — PRs, commits, and their linked issues — grouped by project and task, and save it into the Obsidian daily note. Use when the user asks for a worklog, daily log, standup entry, or "what did I do today/yesterday".
---

# Worklog

Dispatch to the `worklog-runner` agent, which does the actual work (fetching,
confirming ambiguous items with the user, clustering, and saving to the
Obsidian vault) on Opus at medium effort — this task is bounded judgment over
data `collect.sh` already fetched, not something that needs a larger model.

Invoke the `Agent` tool with `subagent_type: worklog-runner`. The subagent
starts fresh with no memory of this conversation, so the prompt must be
self-contained: pass along the raw date argument exactly as the user typed
it (`$ARGUMENTS`), or state plainly that none was given (defaults to today).
Nothing else needs to be included — `worklog-runner`'s own instructions
cover collection, confirmation, clustering, rendering, and saving.

After the subagent returns, relay its report (the rendered markdown and the
Obsidian link) to the user.

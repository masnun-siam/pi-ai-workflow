# Migration Notes: ai-workflow → pi-ai-workflow

What changed when porting from the Claude Code plugin to the Pi coding agent extension.

## Package Structure

| ai-workflow | pi-ai-workflow |
|---|---|
| `.claude-plugin/plugin.json` | `package.json` with `pi` key |
| `bin/aiw` (Python CLI) | `piw` tool (registered in extension) |
| `run-engine/*.py` | `src/engine/` + `src/mechanical/` (TypeScript) |
| `commands/*.md` | `skills/*/SKILL.md` + registered commands |
| `agents/*.md` | `agents/*.md` (same format, adapted tool refs) |

## Language

- **Python → TypeScript** — full rewrite, no Python dependency
- Engine is pure TS (no I/O), mechanical modules handle I/O
- Tests: `pytest` → `vitest` (50 tests)

## CLI

- `aiw` (standalone Python CLI on PATH) → `piw` (Pi tool, called via `piw` tool)
- Same subcommands: paths, init, route, classify, set, stack, worktree, pr, ci, threads, gitnexus, project-status, kanban
- Same exit code vocabulary

## State Directory

- `$CLAUDE_PLUGIN_DATA` (default `~/.claude/plugins/data/ai-workflow/`)
- → `~/.pi/agent/data/pi-ai-workflow/` (Pi convention)
- Set via `PI_AW_DATA` env var

## Agent Dispatch

- Claude Code: `Agent` tool with agent name
- Pi: `subagent` tool (spawns separate `pi` process)
- Agent prompts adapted: `Bash(aiw:*)` → `piw` tool, `AskUserQuestion` → `ask`

## Commands

- Claude Code: `commands/*.md` with frontmatter
- Pi: registered via `pi.registerCommand()`, delegate to skills
- Skills: `skills/*/SKILL.md` (same Agent Skills spec)

## Tool References in Agent Prompts

| Claude Code | Pi |
|---|---|
| `Bash(aiw:*)` | `piw` tool |
| `Bash(gh:*)` | `bash` (gh CLI) |
| `Bash(git:*)` | `bash` (git CLI) |
| `AskUserQuestion` | `ask` tool |
| `Agent` | `subagent` tool |
| `Read`, `Write`, `Edit` | `read`, `write`, `edit` |
| `Grep`, `Glob` | `grep`, `find` |

## Installation

```bash
# Claude Code
claude plugin install ./ai-workflow

# Pi
pi install ./pi-ai-workflow
# or
pi install npm:pi-ai-workflow
```

## What's the Same

- Engine logic (routing, bounce caps, classification, review panel)
- Mechanical modules (Docker stack, worktree, PR, CI, threads, checks)
- Config overlay mechanism (`.run-issue.json` deep-merge)
- 3 human gates (plan approval, escalated review, final handback)
- All 15 agent prompts (adapted for Pi tool refs)
- All 12 skills (run-issue orchestrator + 11 others)
- Exit code vocabulary
- State directory structure (just different base path)

## What's Different

- Language (Python → TypeScript)
- Package system (Claude Code plugin → Pi package)
- CLI (standalone binary → registered tool)
- Agent dispatch (Agent tool → subagent tool)
- Test framework (pytest → vitest)
- State directory base path

## Breaking Changes

None for end users. The pipeline behavior is identical.

## Known Limitations

- Command handlers are thin wrappers that delegate to skills (no imperative orchestrator logic in TS)
- Integration testing not automated (manual `/run-issue` against test issue)
- `obsidian` CLI must be on PATH for researcher agent (same as before)
- GitNexus MCP server must be configured (same as before)

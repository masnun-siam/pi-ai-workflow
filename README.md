# pi-ai-workflow

Deterministic routing engine that drives GitHub issues through an automated pipeline to reviewed PRs — ported from [ai-workflow](https://github.com/masnun-siam/ai-workflow) (Claude Code plugin) to a **Pi coding agent extension**.

## What it does

Run `/run-issue 42` and the pipeline handles: readiness → plan → tests → implement → verify → PR → review → fix → sync → CI. Stops for a human exactly **three times**: plan approval, escalated review finding, and final ready-to-merge handback.

## Install

```bash
pi install npm:pi-ai-workflow
```

Or from a local checkout:

```bash
pi install ./pi-ai-workflow
```

## Architecture

```
src/
├── extension.ts          # Pi extension entry — registers tools + commands
├── engine/               # Pure routing logic (no I/O)
│   ├── types.ts          # Ledger, Envelope, RouteAction
│   ├── globs.ts          # Path glob matching (*, **, {})
│   ├── engine.ts         # Router, validate_envelope, classify, resolve_review_panel
│   └── config.ts         # Config loading + deep-merge overlay
├── mechanical/           # I/O modules (Docker, git, gh, GraphQL)
│   ├── shared.ts         # run, shell, gh_json, ledger I/O
│   ├── stack.ts          # Docker compose stack (up/down/rebuild/status)
│   ├── worktree.ts       # git worktree management
│   ├── pr.ts             # PR creation + branch linking
│   ├── ci.ts             # CI polling
│   ├── threads.ts        # PR review threads (GraphQL)
│   ├── checks.ts         # Station post-checks
│   ├── kanban.ts         # Live kanban board server
│   ├── epic.ts           # Epic decomposition DAG
│   ├── dispatch.ts       # Roster resolution, DoR screening
│   ├── gitnexus.ts       # GitNexus index sync
│   ├── project.ts        # GitHub Projects integration
│   └── review.ts         # Review round selection
└── tools/
    ├── piw.ts            # Unified CLI tool (replaces aiw)
    └── run-status.ts     # Active run status query
```

## Tools

| Tool | Description |
|------|-------------|
| `piw` | Unified CLI — subcommands: paths, init, route, classify, set, stack, worktree, pr, ci, threads, gitnexus, project-status, kanban |
| `run-status` | Query active run state (station, status, trace, bounce counts) |

## Commands

| Command | Description |
|---------|-------------|
| `/run-issue` | Drive a GitHub issue through the full pipeline |
| `/intake` | Intake a task from various sources |
| `/gh-issue` | Create a GitHub issue from template |
| `/jira-to-gh` | Convert Jira ticket to GitHub issue |
| `/pr-fix-comments` | Fix review comments on a PR |
| `/issue-to-pr` | Simplified issue-to-PR flow |

## Skills

12 skills ship with the package:

- **run-issue** — the orchestrator (1400-line skill)
- **pr-review** — evidence-based PR review
- **pr-grind** — automate review-fix-retrigger loop
- **dump** — capture feature requests into Obsidian
- **worklog** — generate daily worklog from GitHub activity
- **api-hardening-patterns** — Laravel API review
- **data-migration-strategy** — safe migration planning
- **deployment-readiness** — deployment blocker review
- **frontend-performance-review** — Lighthouse review
- **migration-index-reviewer** — missing/redundant index review
- **resilient-check** — retry/timeout/idempotency review
- **upgrade-assistant** — Laravel/PHP upgrade planning

## Agents

15 agent prompts ship in `agents/`:

`run-researcher`, `run-planner`, `run-sdet`, `run-dev`, `run-verifier`, `run-reviewer`, `run-fixer`, `run-specialist`, `run-ci`, `run-grinder`, `run-lessons`, `run-laravel-review`, `gh-issue-factchecker`, `ship`, `worklog-runner`

## Modes

- **Full** (default): researcher → planner → sdet → dev → verifier → reviewer → fixer
- **Lean** (`--lean`): researcher → planner → dev → reviewer → fixer — faster but weaker

## State

All state lives in `~/.pi/agent/data/pi-ai-workflow/`, outside the plugin install directory so it survives upgrades.

## Development

```bash
npm install
npm test          # 50 tests (23 engine + 27 mechanical)
npx tsc --noEmit  # typecheck
```

## Migration from ai-workflow

| ai-workflow (Claude Code) | pi-ai-workflow (Pi) |
|---|---|
| `aiw` CLI | `piw` tool |
| `$CLAUDE_PLUGIN_DATA` | `~/.pi/agent/data/pi-ai-workflow/` |
| `claude plugin install` | `pi install npm:pi-ai-workflow` |
| Python engine | TypeScript engine |
| `commands/*.md` | `skills/*/SKILL.md` |
| `agents/*.md` (Claude frontmatter) | `agents/*.md` (Pi frontmatter) |

## License

MIT

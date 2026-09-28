# How It Works — pi-ai-workflow

Ported from the original `ai-workflow` Claude Code plugin. This document describes the Pi extension architecture.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Pi Extension (src/extension.ts)                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ piw tool     │  │ run-status   │  │ /run-issue etc   │  │
│  │ (CLI)        │  │ tool         │  │ commands         │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                  │                    │            │
│  ┌──────┴──────────────────┴────────────────────┴─────────┐ │
│  │              Engine (pure, no I/O)                      │ │
│  │  types.ts  globs.ts  engine.ts  config.ts              │ │
│  └──────────────────────┬──────────────────────────────────┘ │
│                         │                                    │
│  ┌──────────────────────┴──────────────────────────────────┐ │
│  │              Mechanical (I/O)                            │ │
│  │  shared  stack  worktree  pr  ci  threads  checks       │ │
│  │  kanban  epic  dispatch  gitnexus  project  review      │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## The Engine

The engine is pure TypeScript — no I/O, no network, no filesystem. Every function is deterministic and directly testable.

**Core types** (`types.ts`):
- `Ledger` — the run's state: roster, current station, bounce counts, trace, context
- `Envelope` — a station's typed handoff: issue, station, status, attempt, summary, evidence
- `RouteAction` — the router's decision: advance, bounce, escalate, or done

**Routing** (`engine.ts`):
- `Router.next(ledger, envelope)` — given the ledger and a station's envelope, decide the next action
- `validate_envelope(envelope, ledger, config)` — enforce the handoff contract
- `classify(changed_files, meta, config)` — score a diff into ticket_type, risk_score, risk_band, blast_radius, signals
- `resolve_review_panel(classification, policy)` — map classification onto the minimum specialist set

**Globs** (`globs.ts`):
- `glob_match(path, pattern)` — `*` never crosses `/`; `**` does
- Case-insensitive, cached (Map, max 512)

**Config** (`config.ts`):
- `load_config(plugin_root, repo?)` — load `config/default.json`, overlay `<repo>/.run-issue.json`
- Dicts merge recursively, lists replace

## The Mechanical Modules

These do I/O — Docker, git, gh, GraphQL. Each is independently testable.

**shared.ts** — foundation:
- `run(argv, opts)` — spawn a command, no shell
- `shell(cmd, opts)` — spawn through shell (for verbatim ledger strings)
- `gh_json(args, opts)` — `gh <args>`, returns `[value, proc]`
- `data_dir()` — `~/.pi/agent/data/pi-ai-workflow/`
- `load_ledger(run_dir)`, `save_ledger(run_dir, ledger)` — ledger I/O
- `record(run_dir, ledger, pairs)` — write context keys and persist

**stack.ts** — Docker compose stack:
- `stack_up(opts)` — detect runner, find compose file, acquire lock, start stack, record URLs
- `stack_down(opts)` — teardown, release lock
- `stack_rebuild(opts)` — rebuild app image when source not mounted
- `stack_status(opts)` — report app service health
- File-based locking with break sentinels for atomic mutations

**worktree.ts** — git worktree management:
- `worktree_create(opts)` — create worktree, copy gitignored secrets, install deps
- `slugify(title)` — branch name from issue title
- `is_secret(path)` — `.env`, `.key`, `.pem`, etc.

**pr.ts** — PR creation:
- `pr_open(opts)` — link branch, push, create PR, verify links
- `link_branch(repo_dir, issue, branch)` — GraphQL `createLinkedBranch`

**ci.ts** — CI polling:
- `ci_status(pr, opts)` — `gh pr checks`, returns `{state, head_sha, failing}`
- `snapshot(owner, repo, number)` — pure polling logic

**threads.ts** — PR review threads:
- `threads_list(opts)` — GraphQL `reviewThreads` query
- `threads_resolve(node_ids, cwd)` — GraphQL `resolveReviewThread` mutation

**checks.ts** — station post-checks:
- `check_sdet_post` — suite really is red, test files exist
- `check_dev_post` — commit resolves, no undeclared files, suite really is green
- `check_verifier_post` — verdict agrees with criteria, artifacts exist
- `check_reviewer_post` — review exists on PR, panel matches policy
- `check_fixer_post` — push happened, no open threads

**kanban.ts** — live kanban board:
- `build_board(records, projects, fetch_title)` — pure core
- `serve_board(port)` — HTTP server, `/board.json` endpoint

**epic.ts** — epic decomposition:
- `parse_depends(body)` — extract `Depends on: #12, #13`
- `build_dag(deps)` — topological sort, cycle detection
- `ready(dag, states, max_stacks)` — which children may advance

**dispatch.ts** — roster resolution:
- `parse_issue_list(raw)` — comma-separated issue numbers
- `dedupe(issue_numbers)` — drop repeats
- `dor_gaps(body)` — Definition of Ready screen

**gitnexus.ts** — GitNexus index:
- `gitnexus_op(op, repo, run_dir?)` — sync, index, clean (best-effort)

**project.ts** — GitHub Projects:
- `project_set_status(slug, issue, status)` — update project board

**review.ts** — review round selection:
- `pick(reviews, comments, window)` — newest comment-carrying beats rubber stamp

## The Tools

**piw** — unified CLI:
- `paths` — print state directory paths
- `init` — initialize a run
- `route` — route an envelope, return next action
- `classify` — classify the diff
- `set` — write context keys
- `stack up|down|rebuild|status` — Docker stack
- `worktree create` — git worktree
- `pr open` — create PR
- `ci status` — CI polling
- `threads list|resolve` — review threads
- `gitnexus sync|index|clean` — GitNexus
- `project-status` — GitHub Projects
- `kanban serve` — kanban server

**run-status** — query active runs:
- Returns current station, status, trace, bounce counts

## The Commands

All commands delegate to skills:
- `/run-issue <args>` → run-issue skill (orchestrator)
- `/intake <args>` → dump skill
- `/gh-issue <args>` → gh CLI
- `/jira-to-gh <args>` → fetch Jira, create GitHub issue
- `/pr-fix-comments <args>` → pr-grind skill
- `/issue-to-pr <args>` → run-issue skill (lean mode)

## The Skills

12 skills ship with the package:
- **run-issue** — the orchestrator (1402 lines)
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

## The Agents

15 agent prompts in `agents/`:
- `run-researcher` — read-only context research
- `run-planner` — implementation plan
- `run-sdet` — RED tests
- `run-dev` — implementation
- `run-verifier` — runtime verification
- `run-reviewer` — code review
- `run-fixer` — fix review findings
- `run-specialist` — specialist lens review
- `run-ci` — CI monitoring
- `run-grinder` — review round automation
- `run-lessons` — lessons learned
- `run-laravel-review` — Laravel-specific review
- `gh-issue-factchecker` — issue fact-checking
- `ship` — shipping checklist
- `worklog-runner` — worklog generation

## State

All state lives in `~/.pi/agent/data/pi-ai-workflow/`:
- `runs/<owner>-<repo>-issue-<n>/run.json` — ledger
- `runs/<owner>-<repo>-issue-<n>/<NN-station.json>` — station envelopes
- `locks/<project>.lock` — stack lock files
- `pr-grind/` — PR grind state

Outside the plugin install directory so it survives upgrades.

## Exit Codes

**piw route**:
- 0 — ok
- 2 — usage
- 3 — unreadable
- 4 — not JSON
- 5 — contract violation
- 6 — test-root ownership violation
- 7 — post-check refuted

**Mechanical subcommands** (stack, worktree, etc.):
- 0 — ok
- 1 — operation failed
- 2 — usage

**Best-effort** (gitnexus, project-status, stack down):
- Always exit 0

## Testing

```bash
npm test  # 50 tests (23 engine + 27 mechanical)
```

Engine tests cover: bounce cap, roster bounce, advance/done, unknown status, counter isolation, envelope validation, globs, classifier, review panel, ledger persistence.

Mechanical tests cover: runner detection, worker caps, limits override, app service selection, container ports, source mount, api/web split, compose project name, thread matching, CI state, project matching, worktree helpers, epic DAG, epic readiness, dispatch helpers, review pick, extractJsonObject, deepMerge.

# Auto-triggering and org-wide rollout

Three independent layers make the review fire without anyone asking. They stack; you don't have to pick one.

| Layer | Fires when | Covers |
|---|---|---|
| Skill description | The model notices a PR was opened in-session | Anyone with the skill available |
| Hooks | `gh pr create` or the GitHub MCP tool succeeds | Anyone with the plugin active |
| GitHub Actions | The PR is opened, server-side | Every PR, no local session needed |

For layers 1 and 2, "available" doesn't have to mean each person installed something — see [does everyone have to install it?](#layer-2b-does-everyone-have-to-install-it) for the two ways to push it to people instead.

## What "the agent knows a PR was created" can and can't mean

Worth being clear about a boundary, because it determines what layers 1 and 2 can promise: a Claude Code hook cannot invoke a skill. Command hooks talk to Claude only through stdout, stderr, and exit codes — they can't call tools or run slash commands. So the hook's job is detection plus a nudge; the model still does the work.

That makes layers 1 and 2 reliable *when someone is working in Claude Code*, and irrelevant otherwise. A PR opened from the GitHub web UI, from a teammate's editor, or by Dependabot never touches them. If the requirement is genuinely "every PR in the org gets reviewed," layer 3 is the one that delivers it, and layers 1 and 2 become a fast local pre-check that catches problems before anyone else looks.

## Layer 1: the skill description

Already done — the `description` frontmatter tells the model to use the skill unprompted when a PR has just been opened in the session, including when the agent opened it. Description text is the primary triggering mechanism, so this alone gets you most of the way in practice.

Worth knowing: Claude tends to *under*-trigger skills for tasks it thinks it can handle directly. Review is complex enough that this is rarely a problem, but it's a reason to add layer 2 rather than relying on description text alone.

## Layer 2: hooks (deterministic detection)

Two hooks in `hooks/hooks.json`:

**`detect-pr.sh`** — a `PostToolUse` hook on `Bash`, narrowed with `"if": "Bash(gh pr create*)"` so the process only spawns for PR creation rather than every shell command. A second entry matches `mcp__github__create_pull_request` for teams using the GitHub MCP server instead of the CLI. It scrapes the PR URL from the tool output, writes a marker file keyed by session id, and exits 0. It does nothing else deliberately: interrupting the turn the moment a PR opens cuts across whatever the agent was mid-way through.

**`request-review.sh`** — a `Stop` hook. When Claude finishes the turn, if this session has an unconsumed marker, it returns `{"decision": "block", "reason": "..."}`, which feeds the reason back to Claude and continues the turn. That's the documented behaviour of a blocking `Stop` hook, and it's what makes "now go review it" work without the hook needing to call anything.

Three safety properties, each of which exists because the failure mode is worse than a missed review:

- **Loop guard.** Claude Code overrides a `Stop` hook after it blocks eight consecutive times. The script checks `stop_hook_active` and exits 0 when set, and it consumes the marker *before* blocking — so a review that fails is requested once, not forever.
- **Session isolation.** The marker is keyed by `session_id`, with a regex fallback for when tool output contains raw newlines and the JSON won't parse. If no session id can be determined, the script writes no marker at all. Missing a review is a much better failure than reviewing an unrelated PR because a stale marker leaked between sessions.
- **Never breaks the user's work.** Both scripts exit 0 on every path except the intentional block. A detection bug must not be able to interrupt someone's session.

### Installing hooks without the plugin

For a single repo, commit `hooks/` to `.claude/hooks/` and merge the `hooks` object into `.claude/settings.json` — the format is identical. The path expression `${CLAUDE_PLUGIN_ROOT:-$CLAUDE_PROJECT_DIR/.claude}` resolves correctly in both plugin and project-settings layouts, so the same file works either way.

Verify with `/hooks` in Claude Code, which lists hooks grouped by event. If one doesn't fire, `claude --debug-file /tmp/claude.log` shows which hooks matched and their exit codes.

## Layer 2b: does everyone have to install it?

No — not if you use one of the two push mechanisms. Three options, in ascending order of admin effort:

### Option 1: commit it into the repo (zero install, zero infrastructure)

Any folder under a skills directory that contains `.claude-plugin/plugin.json` loads as a plugin with **no marketplace and no install step**. So commit this whole directory to `.claude/skills/pr-review/` in the repo, and everyone who clones gets it on their next session as `pr-review@skills-dir`. Nothing to publish, nothing to install, and it versions with the code.

Two constraints to know before choosing this:

- **It loads only after the workspace trust prompt**, the same gate that governs `.claude/settings.json`. That's one click per person per repo, not per session. Because the content comes from the repository rather than from the user, code-running components are restricted — but hooks do load once the workspace is trusted, which is what this needs.
- **Project-scope skills-dir plugins don't walk up to the repository root.** They load from the `.claude/skills/` of the directory Claude Code was started in. Someone launching from a subdirectory won't get it. Tell people to launch from the repo root, or run `/reload-plugins` after changing directory.

Best for: making this standard in a handful of repos, fast, without touching org settings.

### Option 2: project-scope install committed to the repo

Publish the plugin to an internal marketplace repo once, then have one person run:

```bash
claude plugin install pr-review@internal-tools --scope project
```

`--scope project` writes to `enabledPlugins` in `.claude/settings.json`. Commit that file (along with `extraKnownMarketplaces` so the marketplace resolves) and **everyone who clones the repo gets the plugin** — Claude Code fetches it from the marketplace itself. No one else runs an install command.

Note that `enabledPlugins` honours project and local settings, which is what makes this work. (`pluginConfigs` deliberately does not, so don't try to ship `userConfig` values through a committed project settings file — they're ignored by design, since a cloned repo shouldn't be able to feed values into hook commands.)

Best for: the same plugin across several repos, with real versioning and updates.

### Option 3: managed settings (admin-controlled, users can't remove it)

Managed settings sit at the highest precedence and can't be overridden by user or project settings. The config is two keys:

```json
{
  "extraKnownMarketplaces": {
    "internal-tools": {
      "source": { "source": "github", "repo": "YOUR-ORG/claude-plugins" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "pr-review@internal-tools": true }
}
```

`extraKnownMarketplaces` supplies the `@marketplace` half of the identifier — a plugin can only be enabled if Claude Code knows the marketplace that provides it. `autoUpdate` in a managed entry turns on background updates for the whole org without each person toggling it.

Deliver it through the claude.ai admin console (server-managed settings, fetched at sign-in — no machine access needed), through MDM, or as a file drop. Paths and the `allowManagedHooksOnly` trap are in `deploy/README.md`.

**The catch, and it matters here.** Managed settings force-enable the plugin and stop users disabling it. They do not reliably *install* it for terminal CLI users: org-managed plugins auto-install in the desktop and web apps, but CLI users have historically still needed one `/plugin marketplace add` plus `/plugin install`. That's an open enhancement request rather than settled behaviour, so verify on a test machine before promising a hands-free rollout:

```bash
claude plugin list --json | grep -A3 pr-review   # after managed settings land
```

If it isn't installed, you have two ways to close the gap, and neither needs users to think about it:

- **Commit the plugin into each repo as well** (Option 1). Nothing gets installed, so nothing can fail to install — but read the `allowManagedHooksOnly` warning in `deploy/README.md`, because that setting blocks hooks from project sources and would quietly kill the auto-trigger.
- **Seed it in your images.** If people work in containers or standardized dev environments, `CLAUDE_CODE_PLUGIN_SEED_DIR` puts the plugin in place at build time.

Either way, keep the managed settings: they're what stops someone disabling the reviewer on a repo where you want it.

Admins can also restrict where plugins may come from at all, with `strictKnownMarketplaces` or `blockedMarketplaces`, and reject `--plugin-dir`-style sideloading with `disableSideloadFlags`. Worth adding once the base rollout works — not before, since they make debugging a failed install harder.

### Option 4: manual, per person

`/plugin marketplace add <org>/<repo>` then `/plugin install pr-review`. Fine for a pilot with three volunteers; doesn't scale, and someone will always be the one person who didn't do it.

### Publishing and testing

Whichever you pick, test locally first — `claude --plugin-dir /path/to/pr-review-plugin` loads it for one session and shadows an installed copy of the same name, which is convenient for hot-fixing.

Validate before publishing:

```bash
claude plugin validate ./pr-review-plugin --strict
```

One versioning gotcha: `plugin.json` here sets `"version": "1.0.0"`, and **users only receive updates when that field is bumped** — pushing new commits alone does nothing, because Claude Code sees the same version string and keeps the cached copy. While you're iterating on the review criteria, either bump the version each time or delete the field entirely so the git commit SHA is used instead and every push ships.

## Layer 3: GitHub Actions (the only layer with real coverage)

If the goal is that no PR merges unreviewed regardless of how it was opened, run the review server-side on `pull_request` events. Sketch:

```yaml
name: pr-review
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write   # required to post the review
  issues: read           # required to read linked issues
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # the DRY pass needs full history, not a shallow clone
      - run: gh auth status
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      # then run Claude Code headless with this skill available
```

Notes specific to running in CI:

- **`fetch-depth: 0` is not optional.** The default shallow checkout defeats the DRY pass, which is the skill's main advantage over a linter. A shallow clone silently produces a shallower review.
- **The bot is not the author**, so both `APPROVE` and `REQUEST_CHANGES` work here — and this is exactly where the approve verdict needs a decision from you. If the branch protection rule requires one approving review and the bot's approval counts toward it, PRs can merge with no human having read them. Either exclude the bot account from the approval count, or run the workflow with `PR_REVIEW_NO_APPROVE=1` so clean reviews post as comments and a human still has to approve.
- **Escalation mentions work the same**, but the token must be able to see the mentioned users. `GITHUB_TOKEN` is fine for same-org handles.
- **Forked PRs get a read-only token.** `pull_request` from a fork can't post reviews. Use `pull_request_target` if you need that, and read its security warnings first — it runs with repository write access against untrusted code.
- Hooks in `.claude/settings.json` apply when Claude Code runs inside a workflow, so the same guardrails travel to CI.

## Rollout advice

Turn this on gradually, and specifically not with auto-posting enabled everywhere on day one. An automated reviewer's credibility is spent once: if the first week produces noisy comments on twenty PRs, people learn to skim past it, and the blockers go unread along with the nits.

A sequence that works:

1. **One repo, terminal output only.** Have a few engineers run the review manually and read the findings without posting. You're calibrating the comment budget and the `critical` bar against a real codebase.
2. **One repo, posting on self-authored PRs.** Low stakes: the only person reading is the author who asked for it. This is where you'll find out whether the DRY pass is finding real duplicates or pattern-matching noise.
3. **Widen to the team, then the org**, with the escalation handles set to people who have actually agreed to be paged.

Check in with the escalation reviewers after the first couple of weeks. If they've started ignoring the mentions, the `critical` bar is too low — tighten §8 of the review checklist with the specific cases that shouldn't have fired. That feedback loop matters more than any other tuning you can do here.

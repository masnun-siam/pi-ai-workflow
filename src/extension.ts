/**
 * pi-ai-workflow — Pi coding agent extension.
 *
 * Registers tools and commands for the /run-issue pipeline.
 * Tools: piw (unified CLI), run-status (query active runs).
 * Commands: /run-issue, /intake, /gh-issue, /jira-to-gh, /pr-fix-comments, /issue-to-pr.
 */

import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPaths, cmdInit, cmdRoute, cmdClassify, cmdSet } from "./tools/piw.ts";
import { getRunStatus, listActiveRuns } from "./tools/run-status.ts";
import { stackUp, stackDown, stackRebuild, stackStatus } from "./mechanical/stack.ts";
import { worktreeCreate } from "./mechanical/worktree.ts";
import { prOpen } from "./mechanical/pr.ts";
import { ciStatus } from "./mechanical/ci.ts";
import { threadsList, threadsResolve } from "./mechanical/threads.ts";
import { gitnexusOp } from "./mechanical/gitnexus.ts";
import { projectSetStatus } from "./mechanical/project.ts";
import { serveBoard } from "./mechanical/kanban.ts";
import { run as runProc } from "./mechanical/shared.ts";

function textResult(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export default function (pi: ExtensionAPI) {
	const pluginRoot = path.dirname(new URL(import.meta.url).pathname);
	const paths = getPaths(pluginRoot);

	// --------------------------------------------------------------------------- piw tool

	const piwTool = defineTool({
		name: "piw",
		label: "piw",
		description:
			"Unified CLI for the /run-issue pipeline. Subcommands: paths, init, route, classify, set, stack, worktree, pr, ci, threads, gitnexus, project-status, kanban.",
		parameters: Type.Object({
			subcommand: Type.String({ description: "Subcommand to run" }),
			args: Type.Optional(Type.Array(Type.String({ description: "Argument" }), { description: "Arguments for the subcommand" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = params.args || [];
			const cwd = ctx.cwd;
			try {
				switch (params.subcommand) {
					case "paths":
						return textResult(JSON.stringify(paths, null, 2), paths);

					case "init": {
						const runDir = args[0];
						const issueArg = args.find((a: string) => a.startsWith("--issue=")) || "";
						const issueIdx = args.indexOf("--issue");
						const issue = Number(issueArg.split("=")[1] || (issueIdx >= 0 ? args[issueIdx + 1] : "0"));
						const repoArg = args.find((a: string) => a.startsWith("--repo="));
						const repoIdx = args.indexOf("--repo");
						const repo = repoArg?.split("=")[1] || (repoIdx >= 0 ? args[repoIdx + 1] : undefined) || cwd;
						const modeArg = args.find((a: string) => a.startsWith("--mode="));
						const modeIdx = args.indexOf("--mode");
						const mode = modeArg?.split("=")[1] || (modeIdx >= 0 ? args[modeIdx + 1] : undefined);
						cmdInit(runDir, { issue, repo, mode, pluginRoot });
						return textResult(`Initialized run in ${runDir}`, { runDir });
					}

					case "route": {
						const runDir = args[0];
						const envelopeFile = args[1];
						const repoArg = args.find((a: string) => a.startsWith("--repo="));
						const repoIdx = args.indexOf("--repo");
						const repo = repoArg?.split("=")[1] || (repoIdx >= 0 ? args[repoIdx + 1] : undefined) || cwd;
						const result = cmdRoute(runDir, envelopeFile, { repo, pluginRoot });
						return textResult(result, { action: result });
					}

					case "classify": {
						const runDir = args[0];
						const repoArg = args.find((a: string) => a.startsWith("--repo="));
						const repoIdx = args.indexOf("--repo");
						const repo = repoArg?.split("=")[1] || (repoIdx >= 0 ? args[repoIdx + 1] : undefined) || cwd;
						cmdClassify(runDir, { repo, pluginRoot });
						return textResult("Classification complete", {});
					}

					case "set": {
						const runDir = args[0];
						const pairs = args.slice(1);
						cmdSet(runDir, pairs);
						return textResult("Context updated", {});
					}

					case "stack": {
						const op = args[0];
						const runDir = args[1];
						const repoArg = args.find((a: string) => a.startsWith("--repo="));
						const repo = repoArg?.split("=")[1];
						if (op === "up") {
							const result = stackUp({ runDir, repo });
							return textResult(JSON.stringify(result, null, 2), result as Record<string, unknown>);
						}
						if (op === "down") {
							stackDown({ runDir, repo });
							return textResult("Stack torn down", {});
						}
						if (op === "rebuild") {
							stackRebuild({ runDir, repo });
							return textResult("Stack rebuilt", {});
						}
						if (op === "status") {
							stackStatus({ runDir, repo });
							return textResult("Status checked", {});
						}
						throw new Error(`Unknown stack op: ${op}`);
					}

					case "worktree": {
						const op = args[0];
						if (op === "create") {
							const runDir = args[1];
							const titleArg = args.find((a: string) => a.startsWith("--title="));
							const title = titleArg?.split("=")[1] || "issue";
							const repoArg = args.find((a: string) => a.startsWith("--repo="));
							const repo = repoArg?.split("=")[1];
							const baseArg = args.find((a: string) => a.startsWith("--base="));
							const base = baseArg?.split("=")[1];
							const result = worktreeCreate({ runDir, title, repo, base });
							return textResult(JSON.stringify(result, null, 2), result as Record<string, unknown>);
						}
						throw new Error(`Unknown worktree op: ${op}`);
					}

					case "pr": {
						const op = args[0];
						if (op === "open") {
							const runDir = args[1];
							const bodyFileArg = args.find((a: string) => a.startsWith("--body-file="));
							const bodyFile = bodyFileArg?.split("=")[1];
							const titleArg = args.find((a: string) => a.startsWith("--title="));
							const title = titleArg?.split("=")[1];
							const baseArg = args.find((a: string) => a.startsWith("--base="));
							const base = baseArg?.split("=")[1];
							const draft = args.includes("--draft");
							const repoArg = args.find((a: string) => a.startsWith("--repo="));
							const repo = repoArg?.split("=")[1];
							const result = prOpen({ runDir, bodyFile: bodyFile!, title, base, draft, repo });
							return textResult(JSON.stringify(result, null, 2), result as Record<string, unknown>);
						}
						throw new Error(`Unknown pr op: ${op}`);
					}

					case "ci": {
						const op = args[0];
						if (op === "status") {
							const pr = args[1];
							const watch = args.includes("--watch");
							const timeoutArg = args.find((a: string) => a.startsWith("--timeout="));
							const timeout = Number(timeoutArg?.split("=")[1] || 1200);
							const result = ciStatus(pr, { watch, timeout, cwd });
							return textResult(JSON.stringify(result, null, 2), result as unknown as Record<string, unknown>);
						}
						throw new Error(`Unknown ci op: ${op}`);
					}

					case "threads": {
						const op = args[0];
						if (op === "list") {
							const pr = args[1];
							const openOnly = args.includes("--open-only");
							const forCommentArg = args.find((a: string) => a.startsWith("--for-comment="));
							const forComment = forCommentArg?.split("=")[1];
							const result = threadsList({
								pr,
								openOnly,
								forComment: forComment ? Number(forComment) : undefined,
								cwd,
							});
							return textResult(JSON.stringify(result, null, 2), { threads: result });
						}
						if (op === "resolve") {
							const nodeIds = args.slice(1);
							threadsResolve(nodeIds, cwd);
							return textResult("Threads resolved", {});
						}
						throw new Error(`Unknown threads op: ${op}`);
					}

					case "gitnexus": {
						const op = args[0] as "sync" | "index" | "clean";
						const repo = args[1];
						const runDirArg = args.find((a: string) => a.startsWith("--run-dir="));
						const runDir = runDirArg?.split("=")[1];
						const result = gitnexusOp(op, repo, runDir);
						return textResult(result, { result });
					}

					case "project-status": {
						const slug = args[0];
						const issue = Number(args[1]);
						const status = args[2];
						projectSetStatus(slug, issue, status);
						return textResult("Project status updated", {});
					}

					case "kanban": {
						const op = args[0];
						if (op === "serve") {
							const port = Number(args[1] || 8787);
							serveBoard(port);
							return textResult(`Kanban server started on port ${port}`, { port });
						}
						throw new Error(`Unknown kanban op: ${op}`);
					}

					default:
						throw new Error(`Unknown subcommand: ${params.subcommand}`);
				}
			} catch (e) {
				return textResult(`Error: ${e instanceof Error ? e.message : String(e)}`, { error: true });
			}
		},
	});

	pi.registerTool(piwTool);

	// --------------------------------------------------------------------------- run-status tool

	const runStatusTool = defineTool({
		name: "run-status",
		label: "Run Status",
		description:
			"Query the status of active /run-issue runs. Returns current station, status, trace, and bounce counts.",
		parameters: Type.Object({
			runDir: Type.Optional(Type.String({ description: "Specific run directory to query. If omitted, lists all active runs." })),
		}),
		async execute(_toolCallId, params) {
			if (params.runDir) {
				const status = getRunStatus(params.runDir);
				if (!status) return textResult("Run not found", { found: false });
				return textResult(JSON.stringify(status, null, 2), status as unknown as Record<string, unknown>);
			}
			const runs = listActiveRuns();
			return textResult(JSON.stringify(runs, null, 2), { count: runs.length });
		},
	});

	pi.registerTool(runStatusTool);

	// --------------------------------------------------------------------------- commands

	pi.registerCommand("run-issue", {
		description: "Drive a GitHub issue through the automated pipeline to a reviewed PR",
		handler: async (args, ctx) => {
			ctx.ui.notify("Starting /run-issue pipeline...", "info");
			ctx.ui.notify("The orchestrator logic is in the run-issue skill. Use: /run-issue <issue-number>", "info");
			ctx.ui.notify(`Arguments: ${args}`, "info");
			// The skill system will load run-issue/SKILL.md when the model needs it
		},
	});

	pi.registerCommand("intake", {
		description: "Intake a task from various sources (URL, text, etc.)",
		handler: async (args, ctx) => {
			ctx.ui.notify("Starting /intake...", "info");
			ctx.ui.notify(`Arguments: ${args}`, "info");
			// The skill system will load dump/SKILL.md when the model needs it
		},
	});

	pi.registerCommand("gh-issue", {
		description: "Create a GitHub issue from a structured template",
		handler: async (args, ctx) => {
			ctx.ui.notify("Creating GitHub issue...", "info");
			ctx.ui.notify(`Arguments: ${args}`, "info");
			// Use gh CLI directly
		},
	});

	pi.registerCommand("jira-to-gh", {
		description: "Convert a Jira ticket to a GitHub issue",
		handler: async (args, ctx) => {
			ctx.ui.notify("Converting Jira ticket to GitHub issue...", "info");
			ctx.ui.notify(`Arguments: ${args}`, "info");
		},
	});

	pi.registerCommand("pr-fix-comments", {
		description: "Fix review comments on a PR",
		handler: async (args, ctx) => {
			ctx.ui.notify("Starting /pr-fix-comments...", "info");
			ctx.ui.notify(`Arguments: ${args}`, "info");
			// The skill system will load pr-grind/SKILL.md when the model needs it
		},
	});

	pi.registerCommand("issue-to-pr", {
		description: "Convert an issue directly to a PR (simplified flow)",
		handler: async (args, ctx) => {
			ctx.ui.notify("Starting simplified issue-to-PR flow...", "info");
			ctx.ui.notify(`Arguments: ${args}`, "info");
			// Use run-issue skill in lean mode
		},
	});

	// --------------------------------------------------------------------------- lifecycle

	pi.on("session_start", async () => {
		const auth = runProc(["gh", "auth", "status"]);
		if (auth.status !== 0) {
			// Best-effort warning — no ctx.ui available in session_start
			process.stderr.write("warning: GitHub CLI not authenticated. Run `gh auth login` first.\n");
		}
	});
}

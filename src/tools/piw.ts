/**
 * piw — the unified tool for the /run-issue pipeline.
 *
 * Replaces the `aiw` CLI. Subcommand dispatch: paths, init, route, classify,
 * set, stack, worktree, threads, pr, ci, gitnexus, project-status, epic,
 * precheck, resolve-review.
 *
 * Exit code vocabulary matches aiw: 0 ok · 2 usage · 3 missing file · 4 bad JSON
 * · 5 bad envelope · 6 test-root violation · 7 post-check refuted.
 */

import * as path from "node:path";
import { Type } from "typebox";
import {
	type Envelope,
	Ledger,
	Router,
	classify,
	resolveReviewPanel,
	validateEnvelope,
} from "../engine/engine.ts";
import { loadConfig } from "../engine/config.ts";
import {
	dataDir,
	die,
	FAILED,
	loadLedger,
	printWritten,
	readJson,
	record,
	saveLedger,
	USAGE,
	writeJson,
} from "../mechanical/shared.ts";
import { acquireLock, composeProject, detectHostRunner, findComposeFile, lockPath, readTestCmdOverride, releaseLock, stackDown, stackRebuild, stackStatus, stackUp } from "../mechanical/stack.ts";
import { worktreeCreate } from "../mechanical/worktree.ts";
import { prOpen } from "../mechanical/pr.ts";
import { ciStatus } from "../mechanical/ci.ts";
import { threadsList, threadsResolve } from "../mechanical/threads.ts";
import { gitnexusOp } from "../mechanical/gitnexus.ts";
import { projectSetStatus } from "../mechanical/project.ts";
import { buildDag, parseDepends, ready as epicReady, renderTasksSection, upsertTasksSection } from "../mechanical/epic.ts";
import { parseIssueList, dedupe, dorGaps } from "../mechanical/dispatch.ts";
import { CHECKS } from "../mechanical/checks.ts";
import * as fs from "node:fs";

// --------------------------------------------------------------------------- paths

export function getPaths(pluginRoot: string) {
	const dd = dataDir();
	return {
		plugin_root: pluginRoot,
		runs_dir: path.join(dd, "runs"),
		pr_grind_dir: path.join(dd, "pr-grind"),
		channels: path.join(dd, "channels.json"),
		config: path.join(pluginRoot, "config", "default.json"),
		agents_dir: path.join(pluginRoot, "agents"),
	};
}

// --------------------------------------------------------------------------- init

export function cmdInit(
	runDir: string,
	opts: { issue: number; repo: string; mode?: string; pluginRoot: string },
): void {
	const config = loadConfig(opts.pluginRoot, opts.repo);
	const modes = config.modes as Record<string, Record<string, unknown>>;
	const mode = opts.mode || (config.default_mode as string) || "full";
	const stations = (modes[mode]?.stations as string[]) || (config.stations as string[]);

	if (!stations?.length) die(USAGE, `unknown mode: ${mode}`);

	const ledger = new Ledger(opts.issue, stations);
	ledger.context.repo = opts.repo;
	ledger.context.mode = mode;

	fs.mkdirSync(runDir, { recursive: true });
	saveLedger(runDir, ledger);
	console.log(`init: issue=${opts.issue} mode=${mode} stations=${stations.join(" -> ")}`);
}

// --------------------------------------------------------------------------- route

export function cmdRoute(
	runDir: string,
	envelopeFile: string,
	opts: { repo: string; pluginRoot: string },
): string {
	const ledger = loadLedger(runDir);
	const config = loadConfig(opts.pluginRoot, opts.repo);
	const envelope = readJson(envelopeFile) as Record<string, unknown>;

	// Validate
	const errors = validateEnvelope(envelope, ledger, config);
	if (errors.length) {
		die(5, "envelope validation failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
	}

	const station = envelope.station as string;

	// Post-checks
	const check = CHECKS[station];
	if (check?.post) {
		const result = check.post(ledger, envelope, opts.repo, config);
		if (!result.ok) {
			// Self-bounce
			const checkBounceCap = (config.check_bounce_cap as number) ?? 1;
			const selfKey = `${station}->${station}`;
			const count = ledger.bounceCounts[selfKey] ?? 0;
			if (count < checkBounceCap) {
				ledger.recordBounce(station, station);
				saveLedger(runDir, ledger);
				die(7, `post-check refuted ${station}: ${result.reason}`);
			}
			// Cap exhausted — record and advance
			const failures = ((ledger.context.check_failures as Record<string, unknown>[]) || []);
			failures.push({ station, reason: result.reason });
			ledger.context.check_failures = failures;
			// Fall through to normal routing
		} else if (result.unrunnable) {
			// Unrunnable checks escalate for fixer/reviewer
			if (station === "fixer" || station === "reviewer") {
				const action = `escalate: post-check could not run: ${result.reason}`;
				console.log(action);
				return action;
			}
		}
	}

	// Route
	const router = new Router((config.bounce_cap as number) ?? 2);
	const action = router.next(ledger, envelope as unknown as Envelope);

	if (action.kind === "advance") {
		ledger.advanceTo(action.target!);
		saveLedger(runDir, ledger);
		console.log(`advance(${action.target})`);
		return `advance(${action.target})`;
	}
	if (action.kind === "bounce") {
		ledger.recordBounce(station, action.target!);
		saveLedger(runDir, ledger);
		console.log(`bounce(${action.target})`);
		return `bounce(${action.target})`;
	}
	if (action.kind === "done") {
		ledger.markDone();
		saveLedger(runDir, ledger);
		console.log("done");
		return "done";
	}
	if (action.kind === "escalate") {
		ledger.markEscalated(action.reason);
		saveLedger(runDir, ledger);
		console.log(`escalate: ${action.reason}`);
		return `escalate: ${action.reason}`;
	}

	die(1, `unknown action: ${action.kind}`);
}

// --------------------------------------------------------------------------- classify

export function cmdClassify(
	runDir: string,
	opts: { repo: string; pluginRoot: string },
): void {
	const ledger = loadLedger(runDir);
	const config = loadConfig(opts.pluginRoot, opts.repo);

	// Get changed files from git
	const { run } = require("../mechanical/shared.ts");
	const base = (ledger.context.base_branch as string) || "main";
	const diff = run(["git", "diff", "--name-only", `origin/${base}...HEAD`], { cwd: opts.repo });
	const files = (diff.stdout || "").trim().split("\n").filter(Boolean);

	const locDiff = run(["git", "diff", "--stat", `origin/${base}...HEAD`], { cwd: opts.repo });
	const statLine = (locDiff.stdout || "").trim().split("\n").pop() || "";
	const locMatch = statLine.match(/(\d+) insertion.*?(\d+) deletion/);
	const locChanged = locMatch ? Number(locMatch[1]) + Number(locMatch[2]) : 0;

	const classification = classify(files, { loc_changed: locChanged }, config);
	ledger.recordClassification(classification);

	const panel = resolveReviewPanel(classification, (config.review_policy as Record<string, unknown>) || {});
	ledger.recordSpecialists(panel);

	saveLedger(runDir, ledger);
	console.log(JSON.stringify(classification, null, 2));
	if (panel.length) console.log(`specialists: ${panel.join(", ")}`);
}

// --------------------------------------------------------------------------- set

export function cmdSet(runDir: string, pairs: string[]): void {
	const ledger = loadLedger(runDir);
	const record_pairs: Record<string, unknown> = {};
	for (const pair of pairs) {
		const eq = pair.indexOf("=");
		if (eq === -1) die(USAGE, `expected key=value: ${pair}`);
		const key = pair.slice(0, eq);
		const value = pair.slice(eq + 1);
		record_pairs[key] = value;
	}
	const written = record(runDir, ledger, record_pairs);
	printWritten(written);
}

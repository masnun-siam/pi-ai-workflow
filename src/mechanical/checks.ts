/**
 * Station post-checks: compute the verdict instead of believing it.
 *
 * Port of checks.py. Every check answers its station's central claim from something
 * with no incentive to pass: an exit code, a git object, a GitHub API response.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Ledger } from "../engine/types.ts";
import { ghJson, run, shell, warn } from "./shared.ts";

const SUITE_TIMEOUT = 900;

export function suiteTimeout(config: Record<string, unknown> | null): number {
	const checksCfg = (config || {}).checks as Record<string, unknown> | undefined;
	const value = checksCfg?.suite_timeout ?? SUITE_TIMEOUT;
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	warn(`checks.suite_timeout=${value} is invalid, falling back to ${SUITE_TIMEOUT}`);
	return SUITE_TIMEOUT;
}

export class CheckResult {
	readonly ok: boolean;
	readonly reason: string;
	readonly unrunnable: boolean;

	constructor(ok: boolean, reason: string = "", unrunnable: boolean = false) {
		this.ok = ok;
		this.reason = reason;
		this.unrunnable = unrunnable;
	}

	static passed(reason: string = ""): CheckResult {
		return new CheckResult(true, reason);
	}
	static failed(reason: string): CheckResult {
		return new CheckResult(false, reason);
	}
	static unrunnable(reason: string): CheckResult {
		return new CheckResult(true, reason, true);
	}
}

function handoff(envelope: Record<string, unknown>): Record<string, unknown> {
	const h = envelope.handoff;
	return typeof h === "object" && h !== null ? (h as Record<string, unknown>) : {};
}

function git(repo: string, ...argv: string[]) {
	return run(["git", ...argv], { cwd: repo });
}

export function runSuite(
	ledger: Ledger,
	repo: string,
	config: Record<string, unknown> | null,
): [number | null, string] {
	const timeout = suiteTimeout(config);
	const state = ledger.context.stack as string | undefined;
	const cmd = ledger.context.test_cmd as string | undefined;

	if (state === "failed") return [null, `no runner (stack=${state})`];
	if (state === "none" && !cmd) return [null, `no runner (stack=${state})`];
	if (!cmd) return [null, "no test_cmd recorded"];

	const proc = shell(cmd, { cwd: repo, timeout });
	if (proc.status === 124) return [null, `suite timed out after ${timeout}s`];
	const lines = (proc.stdout || proc.stderr || "").trim().split("\n");
	return [proc.status, lines[lines.length - 1]?.slice(0, 200) || ""];
}

// --------------------------------------------------------------------------- checks

export function checkSdetPost(
	ledger: Ledger,
	envelope: Record<string, unknown>,
	repo: string,
	config: Record<string, unknown> | null,
): CheckResult {
	const h = handoff(envelope);
	const testRoot = ((ledger.context.test_root as string) || "").replace(/\/$/, "");

	const files = (h.test_files as string[]) || [];
	if (!files.length) {
		return CheckResult.failed("no handoff.test_files[] — the SDET reported passing with no tests named");
	}
	for (const rel of files) {
		if (!fs.existsSync(path.join(repo, rel))) {
			return CheckResult.failed(`handoff names a test file that does not exist on disk: ${rel}`);
		}
		if (testRoot && !path.normalize(rel).startsWith(path.normalize(testRoot))) {
			return CheckResult.failed(`test file outside the approved test root ${testRoot}: ${rel}`);
		}
	}

	const [code, detail] = runSuite(ledger, repo, config);
	if (code === null) return CheckResult.unrunnable(`could not verify RED: ${detail}`);
	if (code === 0) return CheckResult.failed("the suite is GREEN — there is no red to prove");
	return CheckResult.passed();
}

export function checkDevPost(
	ledger: Ledger,
	envelope: Record<string, unknown>,
	repo: string,
	config: Record<string, unknown> | null,
): CheckResult {
	const h = handoff(envelope);
	const sha = h.commit as string | undefined;
	if (sha) {
		if (git(repo, "cat-file", "-e", `${sha}^{commit}`).status !== 0) {
			return CheckResult.failed(`handoff.commit does not resolve to a commit in this repo: ${sha}`);
		}
	}

	let base = ledger.context.sdet_sha as string | undefined;
	if (!base) {
		const mergeBase = git(repo, "merge-base", `origin/${ledger.context.base_branch}`, "HEAD");
		base = mergeBase.status === 0 ? mergeBase.stdout.trim() : undefined;
	}
	if (base) {
		const diff = git(repo, "diff", "--name-only", `${base}..HEAD`);
		if (diff.status === 0) {
			const testRoot = ((ledger.context.test_root as string) || "").replace(/\/$/, "");
			const claimed = new Set((h.files_changed as string[] || []).map((f) => path.normalize(f)));
			let actual = new Set(
				diff.stdout
					.split(/\s+/)
					.filter(Boolean)
					.map((f) => path.normalize(f)),
			);
			if (testRoot) {
				actual = new Set([...actual].filter((f) => !f.startsWith(path.normalize(testRoot))));
			}
			const undeclared = [...actual].filter((f) => !claimed.has(f)).sort();
			if (undeclared.length) {
				return CheckResult.failed(
					"changed files missing from handoff.files_changed[]: " + undeclared.slice(0, 8).join(", "),
				);
			}
		}
	}

	const [code, detail] = runSuite(ledger, repo, config);
	if (code === null) return CheckResult.unrunnable(`could not verify the suite: ${detail}`);
	if (code !== 0) return CheckResult.failed(`dev reported passed but the suite exits ${code}: ${detail}`);
	return CheckResult.passed();
}

const PATH_RE = /[\w./-]+\.(?:png|jpg|jpeg|gif|webp|mp4|webm|har|json|txt|log|zip|trace)/g;
const VERDICT_RANK: Record<string, number> = { fail: 3, pass: 2, unverifiable: 1, skipped: 0 };

function modeVerdictOk(modeBlock: Record<string, unknown>): CheckResult {
	const verdict = ((modeBlock.verdict as string) || "").toLowerCase();
	if (verdict === "unverifiable" || verdict === "skipped") return CheckResult.passed();
	const criteria = (modeBlock.criteria as Record<string, unknown>[]) || [];
	if (verdict === "pass") {
		const unmet = criteria
			.filter((c) => c.met === false)
			.map((c) => c.criterion)
			.slice(0, 5);
		if (unmet.length) {
			return CheckResult.failed("mode verdict is pass but these criteria are not met: " + unmet.map(String).slice(0, 60).join("; "));
		}
		if (!criteria.length) {
			return CheckResult.failed("mode verdict is pass with no criteria[] — nothing was actually checked");
		}
	}
	return CheckResult.passed();
}

export function checkVerifierPost(
	ledger: Ledger,
	envelope: Record<string, unknown>,
	repo: string,
	_config: Record<string, unknown> | null,
): CheckResult {
	const h = handoff(envelope);
	const verdict = ((h.verdict as string) || "").toLowerCase();
	if (verdict === "unverifiable" || verdict === "skipped" || (envelope.evidence as Record<string, unknown>)?.skipped) {
		return CheckResult.passed("unverifiable/skipped is a designed pass");
	}

	const modes = envelope.modes as Record<string, Record<string, unknown>> | undefined;
	if (modes && typeof modes === "object") {
		for (const [name, block] of Object.entries(modes)) {
			if (typeof block !== "object" || block === null) {
				return CheckResult.failed(`modes.${name} is not an object`);
			}
			const result = modeVerdictOk(block);
			if (!result.ok) return CheckResult.failed(`modes.${name}: ${result.reason}`);
		}
		const modeVerdicts = Object.values(modes)
			.filter((m) => typeof m === "object")
			.map((m) => ((m as Record<string, unknown>).verdict as string || "").toLowerCase());
		const worst = modeVerdicts.reduce((a, b) => (VERDICT_RANK[b] ?? 0) > (VERDICT_RANK[a] ?? 0) ? b : a, "");
		const rollup = ((envelope.verdict as string) || "").toLowerCase();
		if (rollup && (VERDICT_RANK[rollup] ?? -1) !== (VERDICT_RANK[worst] ?? -1)) {
			return CheckResult.failed(`envelope.verdict '${rollup}' does not match worst-of-modes '${worst}'`);
		}
	} else {
		const result = modeVerdictOk(h);
		if (!result.ok) return result;
	}

	// Check artifact paths
	let text = ((envelope.evidence as Record<string, unknown>)?.commands as Record<string, unknown>[] || [])
		.map((c) => String(c.excerpt || ""))
		.join(" ");
	if (modes) {
		for (const block of Object.values(modes)) {
			if (typeof block === "object") {
				text += " " + ((block.evidence as Record<string, unknown>)?.commands as Record<string, unknown>[] || [])
					.map((c) => String(c.excerpt || ""))
					.join(" ");
			}
		}
	}
	const matches = [...text.matchAll(PATH_RE)].map((m) => m[0]);
	for (const candidate of new Set(matches)) {
		if (!candidate.includes("/")) continue;
		if (!path.isAbsolute(candidate) && !fs.existsSync(path.join(repo, candidate)) && !fs.existsSync(candidate)) {
			return CheckResult.failed(`evidence names an artifact that is not on disk: ${candidate}`);
		}
	}
	return CheckResult.passed();
}

export function checkReviewerPost(
	ledger: Ledger,
	envelope: Record<string, unknown>,
	repo: string,
	config: Record<string, unknown> | null,
): CheckResult {
	const h = handoff(envelope);
	const classification = ledger.classification ?? { artifact: "classification" as const, ticket_type: "feature", risk_score: 0, risk_band: "low" as const, blast_radius: "unknown", signals: [], file_count: 0 };
	const expected = resolveReviewPanel(classification, (config?.review_policy as Record<string, unknown>) || {});
	const claimed = h.panel as string[] | undefined;
	if (claimed !== undefined && [...claimed].sort().join(",") !== [...expected].sort().join(",")) {
		return CheckResult.failed(`handoff.panel ${[...claimed].sort()} is not the policy panel ${[...expected].sort()}`);
	}

	const url = (h.review_url as string) || "";
	const m = url.match(/#pullrequestreview-(\d+)/);
	const pr = ledger.context.pr_number;
	if (!m || !pr) return CheckResult.unrunnable("no review id in handoff.review_url, or no pr_number in the ledger");

	const [slug] = ghJson(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: repo });
	if (typeof slug !== "string" || !slug.includes("/")) {
		return CheckResult.unrunnable("could not resolve repo slug");
	}
	const [owner, , name] = slug.split("/");
	const reviewId = m[1];

	const [data] = ghJson([
		"api", "graphql",
		"-f", `query={repository(owner:"${owner}",name:"${name}"){pullRequest(number:${pr}){reviews(first:5){nodes{databaseId}}}}}`,
	], { cwd: repo });

	const nodes = ((((data as Record<string, unknown>)?.data as Record<string, unknown>)
		?.repository as Record<string, unknown>)?.pullRequest as Record<string, unknown>)
		?.reviews as Record<string, unknown> | undefined;
	const ids = ((nodes?.nodes as Record<string, unknown>[]) || []).map((n) => String(n.databaseId));
	if (!ids.includes(reviewId)) {
		return CheckResult.failed(`review ${reviewId} not found on PR ${pr}`);
	}
	return CheckResult.passed();
}

export function checkFixerPost(
	ledger: Ledger,
	envelope: Record<string, unknown>,
	repo: string,
	_config: Record<string, unknown> | null,
): CheckResult {
	const h = handoff(envelope);
	const commits = (h.commits as string[]) || [];
	if (!commits.length) return CheckResult.failed("fixer reported passed with no commits");

	const proc = git(repo, "log", "--format=%H", "-n", String(commits.length));
	if (proc.status !== 0) return CheckResult.unrunnable("could not read git log");
	const headShas = new Set(proc.stdout.trim().split("\n"));
	const missing = commits.filter((c) => !headShas.has(c));
	if (missing.length) {
		return CheckResult.failed(`commits not found in HEAD history: ${missing.join(", ")}`);
	}

	const pushProc = git(repo, "status", "-sb");
	if (pushProc.status !== 0) return CheckResult.unrunnable("could not check push status");
	if (pushProc.stdout.includes("[ahead")) {
		return CheckResult.failed("fixer reported passed but branch is not pushed");
	}
	return CheckResult.passed();
}

// --------------------------------------------------------------------------- dispatch table

export type CheckFn = (
	ledger: Ledger,
	envelope: Record<string, unknown>,
	repo: string,
	config: Record<string, unknown> | null,
) => CheckResult;

export const CHECKS: Record<string, { pre?: CheckFn; post?: CheckFn }> = {
	sdet: { post: checkSdetPost },
	dev: { post: checkDevPost },
	verifier: { post: checkVerifierPost },
	reviewer: { post: checkReviewerPost },
	fixer: { post: checkFixerPost },
};

// Re-export resolveReviewPanel for checks that need it
import { resolveReviewPanel } from "../engine/engine.ts";

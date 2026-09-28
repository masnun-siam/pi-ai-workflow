/**
 * GitNexus index: sync, index, clean.
 *
 * Port of gitnexus.py. Best-effort — never exits nonzero.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadLedger, record, run, warn } from "./shared.ts";

const TIMEOUT = 900;

function runner(repo: string): string[] | null {
	const p = path.join(repo, ".gitnexus", "run.cjs");
	return fs.existsSync(p) ? ["node", p] : null;
}

export function analyze(repo: string): [boolean, string] {
	const r = runner(repo);
	if (r) {
		const proc = run([...r, "analyze"], { cwd: repo, timeout: TIMEOUT });
		if (proc.status === 0) return [true, path.basename(repo.replace(/\/$/, ""))];
	}
	const proc = run(["npx", "gitnexus", "analyze"], { cwd: repo, timeout: TIMEOUT });
	if (proc.status === 0) return [true, path.basename(repo.replace(/\/$/, ""))];
	const errLine = (proc.stderr || proc.stdout || "gitnexus unavailable")
		.trim()
		.split("\n")
		.pop()
		?.slice(0, 160) || "gitnexus unavailable";
	return [false, errLine];
}

export function gitnexusOp(
	op: "sync" | "index" | "clean",
	repo: string,
	runDir?: string,
): string {
	repo = path.resolve(repo);

	if (op === "clean") {
		const r = runner(repo);
		if (r) run([...r, "clean", "--force"], { cwd: repo, timeout: TIMEOUT });
		return "cleaned";
	}

	if (op === "sync") {
		const r = runner(repo);
		if (r) {
			const status = run([...r, "status"], { cwd: repo, timeout: 300 });
			if (
				status.status === 0 &&
				!status.stdout.toLowerCase().includes("stale") &&
				!status.stdout.toLowerCase().includes("missing")
			) {
				if (runDir) {
					const ledger = loadLedger(runDir);
					record(runDir, ledger, {
						gitnexus: path.basename(repo.replace(/\/$/, "")),
					});
				}
				return "index is current";
			}
		}
	}

	const [ok, detail] = analyze(repo);
	if (ok) {
		if (runDir) {
			const ledger = loadLedger(runDir);
			record(runDir, ledger, { gitnexus: detail });
		}
		return `indexed ${detail}`;
	}
	warn(`gitnexus unavailable — this run continues grep-only: ${detail}`);
	if (runDir) {
		const ledger = loadLedger(runDir);
		record(runDir, ledger, { gitnexus: "none" });
	}
	return "gitnexus unavailable";
}

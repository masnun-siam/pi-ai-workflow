/**
 * run-status — tool for model to query active run state.
 *
 * Reads current ledger, returns station, status, trace, bounce counts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir, loadLedger } from "../mechanical/shared.ts";

export interface RunStatusResult {
	issue: number;
	station: string;
	status: string;
	trace: string[];
	bounceCounts: Record<string, number>;
	classification: Record<string, unknown> | null;
	context: Record<string, unknown>;
}

export function getRunStatus(runDir: string): RunStatusResult | null {
	const ledgerFile = path.join(runDir, "run.json");
	if (!fs.existsSync(ledgerFile)) return null;
	const ledger = loadLedger(runDir);
	return {
		issue: ledger.issue,
		station: ledger.currentStation(),
		status: ledger.status,
		trace: ledger.trace,
		bounceCounts: ledger.bounceCounts,
		classification: ledger.classification as Record<string, unknown> | null,
		context: ledger.context,
	};
}

export function listActiveRuns(): RunStatusResult[] {
	const runsDir = path.join(dataDir(), "runs");
	if (!fs.existsSync(runsDir)) return [];
	const results: RunStatusResult[] = [];
	for (const dir of fs.readdirSync(runsDir)) {
		const runDir = path.join(runsDir, dir);
		const status = getRunStatus(runDir);
		if (status && status.status === "running") results.push(status);
	}
	return results;
}

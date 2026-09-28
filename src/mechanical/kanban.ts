/**
 * Live kanban board: pure core + HTTP server.
 *
 * Port of kanban.py. build_board() is pure; scanRecords/fetchTitle are I/O edges.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { dataDir, run } from "./shared.ts";

const STATIONS = ["researcher", "planner", "sdet", "dev", "verifier", "reviewer", "fixer", "done"];
const GITHUB_URL_RE = /github\.com\/([^/\s]+)\/([^/\s]+)\/(?:pull|issues)\/(\d+)/;

export interface Card {
	owner: string;
	repo: string;
	project: string;
	issue: number;
	title: string;
	escalated: boolean;
	trace: string[];
	bounceCounts: Record<string, number>;
	classification: Record<string, unknown> | null;
	pr: string | null;
	branch: string | null;
	base_branch: string | null;
	ci: unknown;
}

function resolveOwnerRepo(
	ledger: Record<string, unknown>,
	dirName: string,
	projects: Record<string, string>,
): [string, string] {
	const context = (ledger.context as Record<string, unknown>) || {};
	for (const key of ["pr", "plan_comment"]) {
		const url = context[key] as string | undefined;
		if (url) {
			const match = GITHUB_URL_RE.exec(url);
			if (match) return [match[1], match[2]];
		}
	}
	return guessOwnerRepoFromDirName(dirName, ledger.issue as number, projects);
}

function guessOwnerRepoFromDirName(
	dirName: string,
	issue: number,
	projects: Record<string, string>,
): [string, string] {
	const suffix = `-issue-${issue}`;
	const prefix = dirName.endsWith(suffix) ? dirName.slice(0, -suffix.length) : dirName;
	for (const slug of Object.keys(projects)) {
		const [owner, , repo] = slug.split("/");
		if (prefix === `${owner}-${repo}`) return [owner, repo];
	}
	const [owner, , repo] = prefix.split("-");
	return [owner, repo || ""];
}

export function buildBoard(
	records: Array<{ ledger: Record<string, unknown>; mtime: number; dir_name: string }>,
	projects: Record<string, string>,
	fetchTitle: (owner: string, repo: string, issue: number) => string,
): { columns: Array<{ key: string; cards: Card[] }> } {
	const columns: Record<string, Card[]> = Object.fromEntries(STATIONS.map((s) => [s, []]));

	const resolved = records.map((rec) => ({
		...rec,
		resolved: resolveOwnerRepo(rec.ledger, rec.dir_name, projects),
	}));

	const latest = new Map<string, (typeof resolved)[0]>();
	for (const rec of resolved) {
		const [owner, repo] = rec.resolved;
		const key = `${owner}/${repo}/${rec.ledger.issue}`;
		if (!latest.has(key) || rec.mtime > latest.get(key)!.mtime) {
			latest.set(key, rec);
		}
	}

	for (const rec of latest.values()) {
		const [owner, repo] = rec.resolved;
		const ledger = rec.ledger;
		const station =
			ledger.status === "done"
				? "done"
				: (ledger.stations as string[])[ledger.currentIndex as number];
		const context = (ledger.context as Record<string, unknown>) || {};
		const card: Card = {
			owner,
			repo,
			project: projects[`${owner}/${repo}`] || `${owner}/${repo}`,
			issue: ledger.issue as number,
			title: fetchTitle(owner, repo, ledger.issue as number),
			escalated: ledger.status === "escalated",
			trace: (ledger.trace as string[]) || [],
			bounceCounts: (ledger.bounceCounts as Record<string, number>) || {},
			classification: (ledger.classification as Record<string, unknown>) || null,
			pr: (context.pr as string) || null,
			branch: (context.branch as string) || null,
			base_branch: (context.base_branch as string) || null,
			ci: context.ci,
		};
		columns[station].push(card);
	}

	return { columns: STATIONS.map((station) => ({ key: station, cards: columns[station] })) };
}

export function scanRecords(): Array<{
	ledger: Record<string, unknown>;
	mtime: number;
	dir_name: string;
}> {
	const runsDir = path.join(dataDir(), "runs");
	const records: Array<{ ledger: Record<string, unknown>; mtime: number; dir_name: string }> = [];
	if (!fs.existsSync(runsDir)) return records;
	for (const dirName of fs.readdirSync(runsDir)) {
		const runJson = path.join(runsDir, dirName, "run.json");
		if (!fs.existsSync(runJson)) continue;
		const ledger = JSON.parse(fs.readFileSync(runJson, "utf-8"));
		const mtime = fs.statSync(runJson).mtimeMs / 1000;
		records.push({ ledger, mtime, dir_name: dirName });
	}
	return records;
}

export function fetchTitle(owner: string, repo: string, issue: number): string {
	const unavailable = `Issue #${issue} (title unavailable)`;
	try {
		const proc = run(
			["gh", "issue", "view", String(issue), "--repo", `${owner}/${repo}`, "--json", "title", "-q", ".title"],
			{ timeout: 30 },
		);
		if (proc.status !== 0) return unavailable;
		const title = (proc.stdout || "").trim();
		return title || unavailable;
	} catch {
		return unavailable;
	}
}

export function serveBoard(port: number = 8787): void {
	const server = http.createServer((req, res) => {
		if (req.url === "/board.json") {
			const records = scanRecords();
			const board = buildBoard(records, {}, fetchTitle);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(board));
		} else {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end("<html><body><pre>GET /board.json for board data</pre></body></html>");
		}
	});
	server.listen(port, () => {
		console.log(`kanban server listening on http://localhost:${port}`);
	});
}

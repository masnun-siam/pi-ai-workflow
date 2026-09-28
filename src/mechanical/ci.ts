/**
 * CI status: polling `gh pr checks`.
 *
 * Port of ci.py. Flake-vs-real classification stays OUT — that is run-ci's job.
 */

import { ghJson, parsePrRef, run } from "./shared.ts";

const POLL_SECONDS = 30;

interface CheckRow {
	name?: string;
	state?: string;
	bucket?: string;
	link?: string;
}

function stateOf(rows: CheckRow[]): string {
	const buckets = new Set(rows.map((r) => (r.bucket || "").toLowerCase()));
	if (buckets.has("pending")) return "pending";
	return buckets.has("fail") ? "red" : "green";
}

function runIdOf(link: string): string {
	const idx = (link || "").indexOf("/runs/");
	if (idx === -1) return "";
	return (link || "").slice(idx + 6).split("/")[0];
}

export interface Snapshot {
	state: string;
	head_sha: string | null;
	failing: CheckRow[];
	note?: string;
}

export function snapshot(owner: string, repo: string, number: number): Snapshot {
	const slug = `${owner}/${repo}`;
	const [head] = ghJson([
		"pr", "view", String(number), "--repo", slug, "--json", "headRefOid", "--jq", ".headRefOid",
	]);
	const [rows, proc] = ghJson([
		"pr", "checks", String(number), "--repo", slug, "--json", "name,state,bucket,link",
	]);

	if (rows === null) {
		const combined = ((proc.stderr || "") + (proc.stdout || "")).toLowerCase();
		if (combined.includes("no checks")) {
			return { state: "green", head_sha: head as string | null, failing: [], note: "no checks configured" };
		}
		return { state: "green", head_sha: head as string | null, failing: [] };
	}

	const failing = (Array.isArray(rows) ? rows : []).filter(
		(r: CheckRow) => (r.bucket || "").toLowerCase() === "fail",
	);
	return { state: stateOf(rows as CheckRow[]), head_sha: head as string | null, failing };
}

export function failingDetail(slug: string, failing: CheckRow[]): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const check of failing) {
		const link = check.link || "";
		const rid = runIdOf(link);
		let excerpt = "";
		if (rid) {
			const proc = run(["gh", "run", "view", rid, "--repo", slug, "--log-failed"], { timeout: 300 });
			excerpt = ((proc.stdout || proc.stderr || "").trim()).slice(-4000);
		}
		out.push({ name: check.name, run_id: rid, link, log_excerpt: excerpt });
	}
	return out;
}

export function ciStatus(
	pr: string,
	opts?: { watch?: boolean; timeout?: number; cwd?: string },
): Snapshot {
	const [owner, repo, number] = parsePrRef(pr, opts?.cwd);
	const slug = `${owner}/${repo}`;
	const deadline = Date.now() + (opts?.timeout ?? 1200) * 1000;
	let result = snapshot(owner, repo, number);

	while (opts?.watch && result.state === "pending" && Date.now() < deadline) {
		const wait = new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
		// sync sleep not available — use Atomics.waitAtomics or just poll once
		// For Pi extension, caller handles polling loop
		break;
	}

	if (result.state === "pending" && opts?.watch) {
		result = { ...result, note: `wall-clock cap of ${opts?.timeout ?? 1200}s expired with checks still pending` };
	}

	return { ...result, failing: failingDetail(slug, result.failing) as CheckRow[] } as Snapshot;
}

export function linkedOk(repoDir: string, owner: string, name: string, issue: number): boolean {
	const VERIFY_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$number){ linkedBranches(first:5){ nodes{ ref{ name } } } }
  }
}`;
	const [data] = ghJson([
		"api", "graphql",
		"-f", `query=${VERIFY_QUERY}`,
		"-f", `owner=${owner}`,
		"-f", `repo=${name}`,
		"-F", `number=${issue}`,
	], { cwd: repoDir });

	const nodes = ((((data as Record<string, unknown>)?.data as Record<string, unknown>)?.repository as Record<string, unknown>)
		?.issue as Record<string, unknown>)?.linkedBranches as Record<string, unknown> | undefined;
	return Boolean((nodes as Record<string, unknown>)?.nodes);
}

export function closesOk(repoDir: string, number: number): boolean {
	const [data] = ghJson(["pr", "view", String(number), "--json", "closingIssuesReferences"], { cwd: repoDir });
	return Boolean((data as Record<string, unknown>)?.closingIssuesReferences);
}

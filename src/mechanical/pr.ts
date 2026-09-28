/**
 * PR creation and branch linking.
 *
 * Port of pr.py. createLinkedBranch CREATES the ref from an issue — must run
 * BEFORE the push. A null linkedBranch with no errors is a FAILURE.
 */

import { die, ghJson, loadLedger, printWritten, record, repoOf, run, warn } from "./shared.ts";

const LINK_MUTATION = `mutation($i:ID!,$b:String!,$r:ID!,$o:GitObjectID!){
  createLinkedBranch(input:{issueId:$i, name:$b, repositoryId:$r, oid:$o}){ linkedBranch{ id } }
}`;

const VERIFY_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$number){ linkedBranches(first:5){ nodes{ ref{ name } } } }
  }
}`;

export function linkBranch(repoDir: string, issue: number, branch: string): boolean {
	const [issueId] = ghJson(["issue", "view", String(issue), "--json", "id", "--jq", ".id"], { cwd: repoDir });
	const [repoId] = ghJson(["repo", "view", "--json", "id", "--jq", ".id"], { cwd: repoDir });
	const head = run(["git", "rev-parse", "HEAD"], { cwd: repoDir });

	if (!issueId || !repoId || head.status !== 0) {
		warn("could not resolve issue/repo node ids or head oid; skipping branch link");
		return false;
	}

	const [data, proc] = ghJson([
		"api", "graphql",
		"-f", `query=${LINK_MUTATION}`,
		"-f", `i=${issueId}`,
		"-f", `b=${branch}`,
		"-f", `r=${repoId}`,
		"-f", `o=${(head.stdout || "").trim()}`,
	], { cwd: repoDir });

	const linked = ((((data as Record<string, unknown>)?.data as Record<string, unknown>)
		?.createLinkedBranch as Record<string, unknown>)?.linkedBranch as Record<string, unknown>)?.id;

	if (!linked) {
		warn("createLinkedBranch returned no branch: " + (proc.stderr || "").trim().slice(0, 200));
		return false;
	}
	return true;
}

export interface PrOpenOpts {
	runDir: string;
	bodyFile: string;
	title?: string;
	base?: string;
	draft?: boolean;
	repo?: string;
}

export function prOpen(opts: PrOpenOpts): Record<string, unknown> {
	const ledger = loadLedger(opts.runDir);
	const repoDir = repoOf(ledger, opts.repo);
	const branch = ledger.context.branch as string | undefined;
	const base = opts.base || (ledger.context.base_branch as string | undefined);
	const issue = ledger.issue;

	if (!branch || !base) {
		die(2, "need `branch` and `base_branch` in the ledger — run `piw worktree create` first");
	}

	const linked = linkBranch(repoDir, issue, branch);

	const pushProc = run(["git", "push", "-u", "origin", branch], { cwd: repoDir, timeout: 600 });
	if (pushProc.status !== 0) {
		die(1, "push failed:\n" + (pushProc.stderr || pushProc.stdout || "").trim());
	}

	const create = ["pr", "create", "--base", base, "--body-file", opts.bodyFile];
	if (opts.draft) create.push("--draft");
	if (opts.title) {
		create.push("--title", opts.title);
	} else {
		create.push("--fill");
	}

	const created = run(["gh", ...create], { cwd: repoDir, timeout: 300 });
	if (created.status !== 0) {
		die(1, "gh pr create failed: " + (created.stderr || "").trim().slice(0, 400));
	}

	const url = (created.stdout || "").trim().split("\n").pop() || "";
	const [number] = ghJson(["pr", "view", url, "--json", "number", "--jq", ".number"], { cwd: repoDir });
	const [slug] = ghJson(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: repoDir });
	const slugStr = (slug as string) || "/";
	const [owner, , name] = slugStr.split("/");

	let link = "ok";
	const numInt = Number(number) || 0;

	// Verify link
	const verifyLinked = () => {
		const [data] = ghJson([
			"api", "graphql",
			"-f", `query=${VERIFY_QUERY}`,
			"-f", `owner=${owner}`,
			"-f", `repo=${name}`,
			"-F", `number=${numInt}`,
		], { cwd: repoDir });
		const nodes = ((((data as Record<string, unknown>)?.data as Record<string, unknown>)
			?.repository as Record<string, unknown>)?.issue as Record<string, unknown>)
			?.linkedBranches as Record<string, unknown> | undefined;
		return Boolean((nodes as Record<string, unknown>)?.nodes);
	};

	const closesCheck = () => {
		const [d] = ghJson(["pr", "view", String(numInt), "--json", "closingIssuesReferences"], { cwd: repoDir });
		return Boolean((d as Record<string, unknown>)?.closingIssuesReferences);
	};

	if (!linked || !verifyLinked() || !closesCheck()) {
		run(["gh", "pr", "edit", String(numInt), "--body-file", opts.bodyFile], { cwd: repoDir });
		linkBranch(repoDir, issue, branch);
		if (!verifyLinked() || !closesCheck()) {
			warn("issue link could not be established; posting a fallback comment");
			run(["gh", "issue", "comment", String(issue), "--body", `PR: ${url}`], { cwd: repoDir });
			link = "FAILED";
		}
	}

	const written = record(opts.runDir, ledger, {
		pr: url,
		pr_number: String(numInt || ""),
		link,
	});
	printWritten(written);
	return written;
}

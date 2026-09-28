/**
 * PR review threads: list and resolve.
 *
 * Port of threads.py. GraphQL queries for reviewThreads and resolveReviewThread.
 */

import { die, ghJson, parsePrRef, warn } from "./shared.ts";

const LIST_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved isOutdated path line
          comments(first:1){ nodes{ databaseId url body } }
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }`;

export interface Thread {
	node_id: string;
	is_resolved: boolean;
	is_outdated: boolean;
	comment_id: number | null;
	url: string | null;
	path: string | null;
	line: number | null;
}

export function listThreads(
	owner: string,
	repo: string,
	number: number,
	cwd?: string,
): Thread[] {
	const out: Thread[] = [];
	let cursor: string | null = null;

	while (true) {
		const args = [
			"api", "graphql",
			"-f", `query=${LIST_QUERY}`,
			"-f", `owner=${owner}`,
			"-f", `repo=${repo}`,
			"-F", `number=${number}`,
		];
		if (cursor) args.push("-f", `cursor=${cursor}`);

		const [data, proc] = ghJson(args, { cwd });
		if (data === null) {
			die(1, "could not read review threads: " + (proc.stderr || proc.stdout || "").trim().slice(0, 300));
		}

		const block = ((((data as Record<string, unknown>).data as Record<string, unknown>)
			?.repository as Record<string, unknown>)?.pullRequest as Record<string, unknown>)
			?.reviewThreads as Record<string, unknown> | undefined;

		for (const node of ((block?.nodes as Record<string, unknown>[]) || [])) {
			const first = ((node.comments as Record<string, unknown>)?.nodes as Record<string, unknown>[] || [{}])[0] || {};
			out.push({
				node_id: node.id as string,
				is_resolved: Boolean(node.isResolved),
				is_outdated: Boolean(node.isOutdated),
				comment_id: (first.databaseId as number) ?? null,
				url: (first.url as string) ?? null,
				path: (node.path as string) ?? null,
				line: (node.line as number) ?? null,
			});
		}

		const page = (block?.pageInfo as Record<string, unknown>) || {};
		if (!page.hasNextPage) return out;
		cursor = page.endCursor as string;
	}
}

export function threadForComment(threads: Thread[], commentId: unknown): Thread | null {
	const wanted = Number(commentId);
	if (isNaN(wanted)) return null;
	return threads.find((t) => t.comment_id === wanted) || null;
}

export function resolveThread(nodeId: string, cwd?: string): [boolean, string] {
	const [data, proc] = ghJson(
		["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-f", `id=${nodeId}`],
		{ cwd },
	);
	if (data === null || (data as Record<string, unknown>).errors) {
		return [false, (proc.stderr || JSON.stringify(data || {})).slice(0, 200)];
	}
	const thread = (((data as Record<string, unknown>).data as Record<string, unknown>)
		?.resolveReviewThread as Record<string, unknown>)?.thread as Record<string, unknown> | undefined;
	return [Boolean(thread?.isResolved), ""];
}

export interface ThreadsListOpts {
	pr: string;
	openOnly?: boolean;
	forComment?: number;
	cwd?: string;
}

export function threadsList(opts: ThreadsListOpts): Thread[] {
	const [owner, repo, number] = parsePrRef(opts.pr, opts.cwd);
	let threads = listThreads(owner, repo, number, opts.cwd);
	if (opts.openOnly) threads = threads.filter((t) => !t.is_resolved);
	if (opts.forComment !== undefined) {
		const match = threadForComment(threads, opts.forComment);
		threads = match ? [match] : [];
	}
	return threads;
}

export function threadsResolve(nodeIds: string[], cwd?: string): void {
	let failed = 0;
	for (const nodeId of nodeIds) {
		const [ok, err] = resolveThread(nodeId, cwd);
		if (ok) {
			console.log(`resolved ${nodeId}`);
		} else {
			failed++;
			warn(`could not resolve ${nodeId}: ${err}`);
		}
	}
	if (failed && failed === nodeIds.length) {
		process.exit(1);
	}
}

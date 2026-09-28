/**
 * GitHub Projects (v2) status: project-status and project-board.
 *
 * Port of project.py. Best-effort — NEVER exits nonzero.
 */

import { ghJson, warn } from "./shared.ts";

const ITEMS_QUERY = `query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){
  issue(number:$n){ projectItems(first:10){ nodes{ id project{ id title }
    fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } } } } }`;

const FIELD_QUERY = `query($p:ID!){ node(id:$p){ ... on ProjectV2{
  field(name:"Status"){ ... on ProjectV2SingleSelectField{ id options{ id name } } } } } }`;

const SET_MUTATION = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){
  updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,
    value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }`;

const FILLER = new Set(["in", "on", "at", "to", "the", "is", "be", "for"]);

function words(name: string): Set<string> {
	return new Set(
		(name || "")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w && !FILLER.has(w)),
	);
}

export function matchOption(
	options: Array<{ id: string; name: string }>,
	target: string,
): { id: string; name: string } | null {
	for (const opt of options) {
		if (opt.name === target) return opt;
	}
	const wanted = words(target);
	if (!wanted.size) return null;
	let best: { id: string; name: string } | null = null;
	let bestScore = 0;
	for (const opt of options) {
		const score = [...wanted].filter((w) => words(opt.name).has(w)).length;
		if (score > bestScore) {
			best = opt;
			bestScore = score;
		}
	}
	return best;
}

export function projectSetStatus(slug: string, issue: number, status: string): void {
	const [owner, , repo] = slug.split("/");
	const [data, proc] = ghJson([
		"api", "graphql",
		"-f", `query=${ITEMS_QUERY}`,
		"-f", `o=${owner}`,
		"-f", `r=${repo}`,
		"-F", `n=${issue}`,
	]);

	const items = ((((data as Record<string, unknown>)?.data as Record<string, unknown>)
		?.repository as Record<string, unknown>)?.issue as Record<string, unknown>)
		?.projectItems as Record<string, unknown> | undefined;
	const nodes = ((items?.nodes as Record<string, unknown>[]) || []);

	if (!nodes.length) {
		console.log("issue is not on any project — nothing to update");
		return;
	}

	for (const item of nodes) {
		const project = (item.project as Record<string, unknown>) || {};
		const pid = project.id as string;
		const [field] = ghJson(["api", "graphql", "-f", `query=${FIELD_QUERY}`, "-f", `p=${pid}`]);
		const spec = ((((field as Record<string, unknown>)?.data as Record<string, unknown>)
			?.node as Record<string, unknown>)?.field as Record<string, unknown>) || {};
		const option = matchOption((spec.options as Array<{ id: string; name: string }>) || [], status);
		if (!spec.id || !option) {
			warn(`no Status option matching '${status}' on '${project.title}'`);
			continue;
		}
		const [, mproc] = ghJson([
			"api", "graphql",
			"-f", `query=${SET_MUTATION}`,
			"-f", `p=${pid}`,
			"-f", `i=${item.id}`,
			"-f", `f=${spec.id}`,
			"-f", `o=${option.id}`,
		]);
		if (mproc.status !== 0) {
			warn(`could not set status on '${project.title}': ${(mproc.stderr || "").trim().slice(0, 160)}`);
		} else {
			console.log(`${project.title}: Status -> ${option.name}`);
		}
	}
}

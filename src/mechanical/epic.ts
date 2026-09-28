/**
 * Epic decomposition: DAG, readiness, stack budget.
 *
 * Port of epic.py. Pure logic only — the orchestrator asks which children may
 * advance and never eyeballs the DAG itself.
 */

const DEPENDS_RE = /^\s*Depends on:\s*(.+)$/gim;
const TASKS_HEADING_RE = /^## Tasks[ \t]*$/m;
const HEADING_RE = /^#{1,2} /m;

export function parseDepends(body: string | null): number[] {
	const deps = new Set<number>();
	if (!body) return [];
	for (const match of (body || "").matchAll(DEPENDS_RE)) {
		for (const n of match[1].matchAll(/#(\d+)/g)) {
			deps.add(Number(n[1]));
		}
	}
	return [...deps].sort((a, b) => a - b);
}

export function renderTasksSection(order: number[], titles: Record<number, string>): string {
	return "## Tasks\n\n" + order.map((n) => `- [ ] #${n} ${titles[n]}`).join("\n");
}

export function upsertTasksSection(body: string, section: string): string {
	body = (body || "").replace(/\r\n/g, "\n");
	const found = findTasksSection(body);
	if (found) {
		const [start, end] = found;
		return (body.slice(0, start) + section + "\n\n" + body.slice(end)).trimEnd() + "\n";
	}
	return (body.trimEnd() + "\n\n" + section).trimEnd() + "\n";
}

function findTasksSection(body: string): [number, number] | null {
	const lines = body.split("\n");
	const offsets: number[] = [];
	let pos = 0;
	for (const line of lines) {
		offsets.push(pos);
		pos += line.length + 1;
	}

	let inFence = false;
	let startIdx: number | null = null;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (!inFence && TASKS_HEADING_RE.test(lines[i])) {
			startIdx = i;
			break;
		}
	}
	if (startIdx === null) return null;

	inFence = false;
	let endIdx = lines.length;
	for (let i = startIdx; i < lines.length; i++) {
		if (i > startIdx && !inFence && HEADING_RE.test(lines[i])) {
			endIdx = i;
			break;
		}
		if (lines[i].startsWith("```")) inFence = !inFence;
	}

	return [offsets[startIdx], endIdx < lines.length ? offsets[endIdx] : body.length];
}

export function buildDag(deps: Record<number, number[]>): { order: number[]; deps: Record<string, number[]> } {
	const known = new Set(Object.keys(deps).map(Number));
	for (const [child, declared] of Object.entries(deps)) {
		for (const dep of declared) {
			if (dep === Number(child)) throw new Error(`#${child} depends on itself`);
			if (!known.has(dep)) {
				throw new Error(
					`#${child} depends on #${dep}, which is not in this epic — edges may only point at siblings`,
				);
			}
		}
	}

	const indegree: Record<number, number> = {};
	for (const [child, declared] of Object.entries(deps)) {
		indegree[Number(child)] = declared.length;
	}

	const queue: number[] = Object.entries(indegree)
		.filter(([, n]) => n === 0)
		.map(([c]) => Number(c));
	const order: number[] = [];

	while (queue.length) {
		queue.sort();
		const node = queue.shift()!;
		order.push(node);
		for (const [child, declared] of Object.entries(deps)) {
			if (declared.includes(node)) {
				indegree[Number(child)]--;
				if (indegree[Number(child)] === 0) queue.push(Number(child));
			}
		}
	}

	if (order.length !== Object.keys(deps).length) {
		const stuck = [...new Set(Object.keys(deps).map(Number))].filter((c) => !order.includes(c)).sort();
		throw new Error("dependency cycle among: " + stuck.map((c) => `#${c}`).join(", "));
	}

	return { order, deps: Object.fromEntries(Object.entries(deps).map(([k, v]) => [String(k), v])) };
}

export function ready(
	dag: { order: number[]; deps: Record<string, number[]> },
	states: Record<number, Record<string, unknown>>,
	maxStacks: number,
): number[] {
	const deps = Object.fromEntries(Object.entries(dag.deps).map(([k, v]) => [Number(k), v as number[]]));
	let inUse = 0;
	for (const s of Object.values(states)) {
		if (s?.stack_up) inUse++;
	}

	const out: number[] = [];
	for (const child of dag.order) {
		const current = states[child] || {};
		if (current.status !== "running") continue;
		if (!deps[child].every((d) => (states[d] || {}).pr)) continue;
		if (current.needs_stack && !current.stack_up) {
			if (inUse >= maxStacks) continue;
			inUse++;
		}
		out.push(child);
	}
	return out;
}

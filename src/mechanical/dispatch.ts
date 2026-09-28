/**
 * Roster resolution for dispatch plan.
 *
 * Port of dispatch.py. Pure logic only — parsing, DoR screening, lane detection,
 * dedup, skip checks.
 */

// --------------------------------------------------------------------------- roster

/** Parse comma-separated issue numbers, tolerant of `#` prefixes and whitespace. */
export function parseIssueList(raw: string): number[] {
	const tokens = (raw || "")
		.split(",")
		.map((t) => t.trim().replace(/^#/, ""))
		.filter(Boolean);
	if (tokens.length === 0) throw new Error(`no issue numbers found in: ${JSON.stringify(raw)}`);
	const out: number[] = [];
	for (const t of tokens) {
		if (!/^\d+$/.test(t)) throw new Error(`not a valid issue number: ${JSON.stringify(t)}`);
		out.push(Number(t));
	}
	return out;
}

/** Drop repeats, first occurrence wins, order preserved. */
export function dedupe(issueNumbers: number[]): number[] {
	const seen = new Set<number>();
	const out: number[] = [];
	for (const n of issueNumbers) {
		if (!seen.has(n)) {
			seen.add(n);
			out.push(n);
		}
	}
	return out;
}

// --------------------------------------------------------------------------- DoR pre-screen

interface DorItem {
	label: string;
	pattern: RegExp;
}

const DOR_ITEMS: DorItem[] = [
	{ label: "Problem & why", pattern: /problem\s*&?\s*why|problem\s+and\s+why|summary/i },
	{ label: "Scope", pattern: /scope/i },
	{ label: "Acceptance criteria", pattern: /acceptance\s+criteria/i },
	{ label: "Affected surface", pattern: /affected\s+surface|affected\s+code/i },
	{ label: "Non-functional constraints", pattern: /non-?functional\s+constraints/i },
	{ label: "Dependencies / blockers", pattern: /dependencies\s*\/?\s*blockers|dependencies\s+and\s+blockers/i },
];

function sectionBodies(body: string): Record<string, string> {
	const lines = body.split(/\r?\n/);
	const headingRe = /^\s*#{1,6}\s+(.+?)\s*$/;
	const sections: Record<string, string> = {};
	let currentTitle: string | null = null;
	let currentLines: string[] = [];

	function flush() {
		if (currentTitle !== null) {
			const text = currentLines.join("\n").trim();
			sections[currentTitle] = text;
		}
	}

	for (const line of lines) {
		const m = headingRe.exec(line);
		if (m) {
			flush();
			currentTitle = m[1].trim();
			currentLines = [];
		} else if (currentTitle !== null) {
			currentLines.push(line);
		}
	}
	flush();
	return sections;
}

/** Mechanical Definition-of-Ready screen. Returns gap labels for unsatisfied items. */
export function dorGaps(body: string | null): string[] {
	const sections = sectionBodies(body || "");
	const gaps: string[] = [];
	for (const { label, pattern } of DOR_ITEMS) {
		let matched = false;
		for (const [title, text] of Object.entries(sections)) {
			if (pattern.test(title) && text) {
				matched = true;
				break;
			}
		}
		if (!matched) gaps.push(label);
	}
	return gaps;
}

// --------------------------------------------------------------------------- lane detection

/** Detect the lane from issue labels or body content. */
export function detectLane(labels: string[], body: string): string {
	const labelSet = new Set(labels.map((l) => l.toLowerCase()));
	if (labelSet.has("backend") || labelSet.has("api")) return "backend";
	if (labelSet.has("frontend") || labelSet.has("ui")) return "frontend";
	if (labelSet.has("fullstack")) return "fullstack";

	const bodyLower = body.toLowerCase();
	if (bodyLower.includes("migration") || bodyLower.includes("database")) return "backend";
	if (bodyLower.includes("component") || bodyLower.includes("page")) return "frontend";
	return "general";
}

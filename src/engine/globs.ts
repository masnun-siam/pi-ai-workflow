/**
 * Path glob matching.
 *
 * Port of engine.py's glob logic. `*` never crosses `/`; `**` does.
 * Case-insensitive — directory case is a stack convention, not a fact.
 *
 * Python's fnmatch has no FNM_PATHNAME, so the original had to build its own
 * translator. TypeScript gets the same translator, with a Map cache instead
 * of lru_cache.
 */

/** Split on commas at brace-depth 0, so {a,{b,c}} splits into a and {b,c}. */
function splitCommas(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let buf: string[] = [];
	for (const ch of text) {
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		if (ch === "," && depth === 0) {
			parts.push(buf.join(""));
			buf = [];
		} else {
			buf.push(ch);
		}
	}
	parts.push(buf.join(""));
	return parts;
}

/** Translate a glob pattern to a regex source string. */
function translate(pattern: string): string {
	const out: string[] = [];
	let i = 0;
	const n = pattern.length;

	while (i < n) {
		const ch = pattern[i];

		if (pattern.startsWith("**/", i)) {
			// matches zero or more leading directories
			out.push("(?:.*/)?");
			i += 3;
		} else if (pattern.startsWith("**", i)) {
			out.push(".*");
			i += 2;
		} else if (ch === "*") {
			out.push("[^/]*");
			i++;
		} else if (ch === "?") {
			out.push("[^/]");
			i++;
		} else if (ch === "[") {
			let j = i + 1;
			if (j < n && (pattern[j] === "!" || pattern[j] === "^")) j++;
			if (j < n && pattern[j] === "]") j++;
			while (j < n && pattern[j] !== "]") j++;
			if (j >= n) {
				out.push(escapeRegex(ch));
				i++;
			} else {
				let body = pattern.slice(i + 1, j);
				if (body.startsWith("!")) body = "^" + body.slice(1);
				out.push("[" + body + "]");
				i = j + 1;
			}
		} else if (ch === "{") {
			let depth = 1;
			let j = i + 1;
			while (j < n && depth > 0) {
				if (pattern[j] === "{") depth++;
				else if (pattern[j] === "}") depth--;
				j++;
			}
			if (depth > 0) {
				out.push(escapeRegex(ch));
				i++;
			} else {
				const inner = pattern.slice(i + 1, j - 1);
				out.push("(?:" + splitCommas(inner).map((p) => translate(p)).join("|") + ")");
				i = j;
			}
		} else {
			out.push(escapeRegex(ch));
			i++;
		}
	}

	return out.join("");
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Cache compiled patterns — Map instead of lru_cache, capped at 512.
const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
	let re = cache.get(pattern);
	if (!re) {
		if (cache.size >= 512) {
			// Evict oldest entry (first key in insertion order).
			const first = cache.keys().next().value;
			if (first !== undefined) cache.delete(first);
		}
		re = new RegExp("^" + translate(pattern) + "$", "i");
		cache.set(pattern, re);
	}
	return re;
}

/** True when a repo-relative path matches a glob. `*` never crosses `/`; `**` does. */
export function globMatch(path: string, pattern: string): boolean {
	return compiled(pattern).test(path);
}

/** True when a path matches any of the given patterns. */
export function matchesAny(path: string, patterns: string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	return patterns.some((p) => globMatch(path, p));
}

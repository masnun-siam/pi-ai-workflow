/**
 * Round selection for pr-grind's Step 1: review pick.
 *
 * Port of review.py. Pure and stdlib-only — no `gh` call lives here.
 * A "round" resolves to one verdict; a comment-carrying review beats a
 * same-commit rubber stamp.
 */

const VERDICT_RE = /Verdict:.*?\d+\s*blocker.*?\d+\s*should-fix/i;
const EPOCH = new Date(0);

interface Review {
	id: number;
	commit_id?: string;
	submitted_at?: string;
	body?: string;
	[key: string]: unknown;
}

interface Comment {
	pull_request_review_id?: number;
	[key: string]: unknown;
}

function ts(value: unknown): Date | null {
	if (typeof value !== "string" || !value) return null;
	const raw = value.endsWith("Z") ? value.slice(0, -1) + "+00:00" : value;
	try {
		const d = new Date(raw);
		return isNaN(d.getTime()) ? null : d;
	} catch {
		return null;
	}
}

function tsOrEpoch(r: Review): Date {
	return ts(r.submitted_at) || EPOCH;
}

function hasVerdict(body: string | undefined): boolean {
	return VERDICT_RE.test(body || "");
}

function commentCounts(comments: Comment[]): Record<number, number> {
	const counts: Record<number, number> = {};
	for (const c of comments || []) {
		const rid = c.pull_request_review_id;
		if (rid === undefined) continue;
		counts[rid] = (counts[rid] || 0) + 1;
	}
	return counts;
}

export interface PickResult {
	selected: number | null;
	superseded: number[];
	reason: string;
	comment_counts: Record<number, number>;
}

export function pick(
	reviews: Review[],
	comments: Comment[],
	window: number = 60,
): PickResult {
	const cc = commentCounts(comments);
	if (!reviews || reviews.length === 0) {
		return { selected: null, superseded: [], reason: "no reviews", comment_counts: cc };
	}

	const newest = reviews.reduce((a, b) => (tsOrEpoch(a) >= tsOrEpoch(b) ? a : b));
	const newestTs = tsOrEpoch(newest);
	const newestCommit = newest.commit_id;

	const group = reviews.filter((r) => {
		if (r.commit_id !== newestCommit) return false;
		const diff = Math.abs((tsOrEpoch(r).getTime() - newestTs.getTime()) / 1000);
		return diff <= window;
	});

	const withComments = group.filter((r) => (cc[r.id] || 0) > 0);
	let selected: Review;
	let reason: string;

	if (withComments.length > 0) {
		selected = withComments.reduce((a, b) => (tsOrEpoch(a) >= tsOrEpoch(b) ? a : b));
		reason = "newest comment-carrying review in the round beats a same-commit rubber stamp";
	} else {
		const withVerdict = group.filter((r) => hasVerdict(r.body));
		if (withVerdict.length > 0) {
			selected = withVerdict.reduce((a, b) => (tsOrEpoch(a) >= tsOrEpoch(b) ? a : b));
			reason = "newest verdict-carrying review in the round";
		} else {
			selected = group.reduce((a, b) => (tsOrEpoch(a) >= tsOrEpoch(b) ? a : b));
			reason = "newest review in the round";
		}
	}

	const superseded = reviews.filter((r) => r !== selected).map((r) => r.id);
	return { selected: selected.id, superseded, reason, comment_counts: cc };
}

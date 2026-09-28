/**
 * Core types for the routing engine.
 *
 * Port of engine.py's data shapes. No I/O — these are the envelope contract
 * between stations and the router.
 */

/** The three statuses a station envelope may use.
 *  No `blocked` — a station reports success, a defect, or a wall. */
export const STATUSES = ["passed", "bounce", "escalate"] as const;
export type Status = (typeof STATUSES)[number];

/** Fields every envelope must carry. */
export const REQUIRED_FIELDS = ["issue", "station", "status", "attempt", "summary"] as const;

/** A station's handoff envelope — the typed relay between stations. */
export interface Envelope {
	issue: number;
	station: string;
	status: Status;
	attempt: number;
	summary: string;
	/** Bounce target + reason (required when status === "bounce"). */
	bounce?: { to: string; reason: string };
	/** Evidence of work done (required for passed envelopes on configured stations). */
	evidence?: {
		commands?: Array<{ cmd: string; exit: number; excerpt?: string }>;
		skipped?: boolean;
	};
	/** Free-form data for the next station. */
	data?: Record<string, unknown>;
}

/** Route action kinds. */
export const RouteActionKind = {
	ADVANCE: "advance",
	BOUNCE: "bounce",
	ESCALATE: "escalate",
	DONE: "done",
} as const;
export type RouteActionKind = (typeof RouteActionKind)[keyof typeof RouteActionKind];

/** The router's decision after processing an envelope. */
export class RouteAction {
	readonly kind: RouteActionKind;
	readonly target?: string;
	readonly reason: string;

	constructor(kind: RouteActionKind, target?: string, reason: string = "") {
		this.kind = kind;
		this.target = target;
		this.reason = reason;
	}

	toString(): string {
		if (this.kind === RouteActionKind.ADVANCE || this.kind === RouteActionKind.BOUNCE) {
			return `${this.kind}(${this.target})`;
		}
		if (this.kind === RouteActionKind.ESCALATE) {
			return `escalate: ${this.reason}`;
		}
		return this.kind;
	}
}

/** Classification result from the diff classifier. */
export interface Classification {
	artifact: "classification";
	ticket_type: string;
	risk_score: number;
	risk_band: "low" | "medium" | "high";
	blast_radius: string;
	signals: string[];
	file_count: number;
}

/** The run's state — in-memory shape of run.json. */
export class Ledger {
	issue: number;
	stations: string[];
	currentIndex: number;
	bounceCounts: Record<string, number> = {};
	status: string = "running";
	trace: string[] = [];
	context: Record<string, unknown> = {};
	classification: Classification | null = null;
	specialists: string[] = [];

	constructor(issue: number, stations: string[], currentIndex: number = 0) {
		this.issue = issue;
		this.stations = [...stations];
		this.currentIndex = currentIndex;
	}

	// -- baton ---------------------------------------------------------------

	currentStation(): string {
		return this.stations[this.currentIndex];
	}

	indexOf(station: string): number {
		const idx = this.stations.indexOf(station);
		if (idx === -1) throw new Error(`Unknown station: ${station}`);
		return idx;
	}

	advanceTo(station: string): void {
		this.currentIndex = this.indexOf(station);
		this.trace.push(`advance->${station}`);
	}

	bounceKey(frm: string, to: string): string {
		return `${frm}->${to}`;
	}

	bounceCount(frm: string, to: string): number {
		return this.bounceCounts[this.bounceKey(frm, to)] ?? 0;
	}

	recordBounce(frm: string, to: string): void {
		const key = this.bounceKey(frm, to);
		this.bounceCounts[key] = (this.bounceCounts[key] ?? 0) + 1;
		this.currentIndex = this.indexOf(to);
		this.trace.push(`bounce->${key}#${this.bounceCounts[key]}`);
	}

	markDone(): void {
		this.status = "done";
		this.trace.push("done");
	}

	markEscalated(reason: string): void {
		this.status = "escalated";
		this.trace.push(`escalate: ${reason}`);
	}

	// -- side-steps ----------------------------------------------------------

	recordClassification(c: Classification): void {
		this.classification = c;
		this.trace.push(
			`classify: ${c.ticket_type ?? "?"} risk=${c.risk_score ?? "?"}(${c.risk_band ?? "?"}) blast=${c.blast_radius ?? "?"} signals=[${(c.signals ?? []).join(",")}]`,
		);
	}

	recordSpecialists(names: string[]): void {
		this.specialists = names.filter((n) => typeof n === "string");
		this.trace.push("review-panel: [" + this.specialists.join(",") + "]");
	}

	// -- persistence ---------------------------------------------------------

	toDict(): Record<string, unknown> {
		return {
			issue: this.issue,
			stations: this.stations,
			currentIndex: this.currentIndex,
			bounceCounts: this.bounceCounts,
			status: this.status,
			trace: this.trace,
			context: this.context,
			classification: this.classification,
			specialists: this.specialists,
		};
	}

	static fromDict(data: Record<string, unknown>): Ledger {
		const stations = ((data.stations as string[]) ?? []).filter((s) => typeof s === "string");
		const led = new Ledger(
			Number(data.issue ?? 0),
			stations,
			Number(data.currentIndex ?? 0),
		);
		led.status = (data.status as string) ?? "running";
		led.trace = ((data.trace as string[]) ?? []).filter((t) => typeof t === "string");
		led.bounceCounts = Object.fromEntries(
			Object.entries((data.bounceCounts as Record<string, unknown>) ?? {}).filter(
				([, v]) => typeof v === "number",
			),
		) as Record<string, number>;
		led.context = (data.context as Record<string, unknown>) ?? {};
		led.classification = (data.classification as Classification) ?? null;
		led.specialists = ((data.specialists as string[]) ?? []).filter((s) => typeof s === "string");
		return led;
	}
}

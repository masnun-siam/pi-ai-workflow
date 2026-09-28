/**
 * Pure pipeline engine for /run-issue.
 *
 * No I/O, no network, no LLM — every function here is deterministic and directly
 * testable. Port of engine.py.
 */

import { matchesAny } from "./globs.ts";
import {
	type Classification,
	type Envelope,
	Ledger,
	RouteAction,
	RouteActionKind,
	REQUIRED_FIELDS,
	STATUSES,
} from "./types.ts";

export { Ledger, RouteAction, RouteActionKind, type Envelope, type Classification };

// --------------------------------------------------------------------------- router

/** Given the ledger and a station's envelope, decide the next action. */
export class Router {
	private bounceCap: number;

	constructor(bounceCap: number = 2) {
		this.bounceCap = bounceCap;
	}

	next(ledger: Ledger, envelope: Envelope): RouteAction {
		const status = envelope.status;
		if (status === "passed") return this.onPassed(ledger);
		if (status === "bounce") return this.onBounce(ledger, envelope);
		if (status === "escalate") {
			return new RouteAction(RouteActionKind.ESCALATE, undefined, envelope.summary || "station escalated");
		}
		throw new Error(`Unknown status: ${String(status)}`);
	}

	private onPassed(ledger: Ledger): RouteAction {
		if (ledger.currentIndex >= ledger.stations.length - 1) {
			return new RouteAction(RouteActionKind.DONE);
		}
		return new RouteAction(RouteActionKind.ADVANCE, ledger.stations[ledger.currentIndex + 1]);
	}

	private onBounce(ledger: Ledger, envelope: Envelope): RouteAction {
		const bounce = envelope.bounce;
		if (!bounce || typeof bounce.to !== "string") {
			throw new Error("bounce status requires a string bounce.to");
		}

		const frm = envelope.station;
		const target = bounce.to;

		// Bounce to a station outside THIS run's roster is unroutable.
		if (!ledger.stations.includes(target)) {
			return new RouteAction(
				RouteActionKind.ESCALATE,
				target,
				`bounce target '${target}' is not in this run's roster (${ledger.stations.join(" -> ")}) — unroutable`,
			);
		}

		if (ledger.bounceCount(frm, target) + 1 > this.bounceCap) {
			return new RouteAction(
				RouteActionKind.ESCALATE,
				target,
				`bounce cap (${this.bounceCap}) exceeded for ${frm}->${target}`,
			);
		}

		return new RouteAction(RouteActionKind.BOUNCE, target, bounce.reason || "");
	}
}

// --------------------------------------------------------------------------- validator

/** Enforce the handoff contract. Returns human-readable errors; [] means valid. */
export function validateEnvelope(
	envelope: Record<string, unknown>,
	ledger: Ledger,
	config: Record<string, unknown>,
): string[] {
	const errors: string[] = [];

	for (const field of REQUIRED_FIELDS) {
		if (!(field in envelope)) {
			errors.push(`missing required field: ${field}`);
		}
	}

	const status = envelope.status;
	if (status !== undefined && !(STATUSES as readonly string[]).includes(status as string)) {
		errors.push(`invalid status: ${JSON.stringify(status)}`);
	}

	const issue = envelope.issue;
	if (issue !== undefined && (typeof issue !== "number" || !Number.isInteger(issue) || issue < 1)) {
		errors.push("issue must be a positive integer");
	}

	const attempt = envelope.attempt;
	if (attempt !== undefined && (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1)) {
		errors.push("attempt must be a positive integer");
	}

	const station = envelope.station;
	if (typeof station === "string" && ledger.stations.length > 0 && !ledger.stations.includes(station)) {
		errors.push(
			`station ${JSON.stringify(station)} is not in this run's roster (${ledger.stations.join(" -> ")})`,
		);
	}

	if (status === "bounce") {
		const bounce = envelope.bounce;
		if (typeof bounce !== "object" || bounce === null || !("to" in bounce) || !("reason" in bounce)) {
			errors.push('status "bounce" requires bounce.to and bounce.reason');
		} else if (
			typeof (bounce as Record<string, unknown>).to !== "string" ||
			typeof (bounce as Record<string, unknown>).reason !== "string"
		) {
			errors.push("bounce.to and bounce.reason must be strings");
		}
	}

	// Evidence gate
	const required = (config.evidence_required_stations as string[]) ?? [];
	if (status === "passed" && typeof station === "string" && required.includes(station)) {
		const evidence = (envelope.evidence as Record<string, unknown>) ?? {};
		if (!evidence.skipped) {
			const commands = evidence.commands;
			if (!Array.isArray(commands) || commands.length === 0) {
				errors.push(
					`station "${station}" reported passed with no evidence.commands[] — ` +
						"record the real commands you ran (cmd + exit + a one-line excerpt), " +
						"or set evidence.skipped for a station that was never dispatched",
				);
			}
		}
	}

	return errors;
}

// --------------------------------------------------------------------------- classifier

function safeInt(value: unknown, def: number = 0): number {
	return typeof value === "number" && Number.isInteger(value) ? value : def;
}

/** Score a diff into {ticket_type, risk_score, risk_band, blast_radius, signals}. */
export function classify(
	changedFiles: string[],
	meta: Record<string, unknown>,
	config: Record<string, unknown>,
): Classification {
	const cfg = (config.classification as Record<string, unknown>) ?? {};
	const signalGlobs = (cfg.signals as Record<string, string[]>) ?? {};
	const severity = (cfg.signal_severity as Record<string, number>) ?? {};
	const weights = (cfg.risk_weights as Record<string, unknown>) ?? {};
	const bands = (cfg.bands as Record<string, number>) ?? {};
	const labels = ((meta.labels as string[]) ?? []).filter((l) => typeof l === "string");

	const signals = Object.entries(signalGlobs)
		.filter(([, globs]) => changedFiles.some((f) => matchesAny(f, globs)))
		.map(([name]) => name)
		.sort();

	// Blast radius
	const depth = meta.upstream_depth;
	const d1Max = safeInt(((cfg.blast_radius as Record<string, unknown>) ?? {}).d1_max_depth, 1);
	const blast =
		typeof depth !== "number" || !Number.isInteger(depth)
			? "unknown"
			: depth <= d1Max
				? "d1"
				: "d2";

	const brWeights = (weights.blast_radius as Record<string, number>) ?? {};
	let score = brWeights[blast] ?? brWeights.d2 ?? 25;

	const fc = (weights.file_count as Record<string, number>) ?? {};
	score += Math.min(changedFiles.length * (fc.per_file ?? 2), fc.cap ?? 20);

	const locCfg = (weights.loc as Record<string, number>) ?? {};
	score += Math.min(
		(Math.floor(safeInt(meta.loc_changed) / 100)) * (locCfg.per_100 ?? 3),
		locCfg.cap ?? 15,
	);

	const migrationGlobs = (cfg.migration_globs as string[]) ?? [];
	if (changedFiles.some((f) => matchesAny(f, migrationGlobs))) {
		score += safeInt(weights.migration_present, 15);
	}

	score += Math.min(
		signals.reduce((sum, s) => sum + safeInt(severity[s]), 0),
		safeInt(weights.signal_severity_cap, 40),
	);
	score = Math.max(0, Math.min(100, score));

	let band: "low" | "medium" | "high" = "low";
	if (score >= (bands.high ?? 60)) band = "high";
	else if (score >= (bands.medium ?? 30)) band = "medium";

	let ticketType = (cfg.type_default as string) ?? "feature";
	for (const rule of (cfg.type_rules as Record<string, unknown>[]) ?? []) {
		const pathsAll = rule.paths_all as string[] | undefined;
		const pathsAny = rule.paths_any as string[] | undefined;
		const labelsAny = rule.labels_any as string[] | undefined;
		if (pathsAll && changedFiles.length > 0 && changedFiles.every((f) => matchesAny(f, pathsAll))) {
			ticketType = rule.type as string;
			break;
		}
		if (pathsAny && changedFiles.some((f) => matchesAny(f, pathsAny))) {
			ticketType = rule.type as string;
			break;
		}
		if (labelsAny && labels.some((l) => labelsAny.includes(l))) {
			ticketType = rule.type as string;
			break;
		}
	}

	return {
		artifact: "classification",
		ticket_type: ticketType,
		risk_score: score,
		risk_band: band,
		blast_radius: blast,
		signals,
		file_count: changedFiles.length,
	};
}

// --------------------------------------------------------------------------- review policy

/** Map a classification onto the ordered, deduplicated, MINIMUM specialist set. */
export function resolveReviewPanel(
	classification: Classification,
	policy: Record<string, unknown>,
): string[] {
	const fired = new Set<string>();

	function fire(names: unknown) {
		if (Array.isArray(names)) {
			for (const n of names) {
				if (typeof n === "string") fired.add(n);
			}
		}
	}

	const policySignals = (policy.signals as Record<string, string[]>) ?? {};
	for (const signal of classification.signals ?? []) {
		fire(policySignals[signal]);
	}
	fire((policy.risk_band as Record<string, string[]>)?.[classification.risk_band]);
	fire((policy.ticket_type as Record<string, string[]>)?.[classification.ticket_type]);

	const generalist = policy.generalist as string | undefined;
	const order = ((policy.order as string[]) ?? []).filter((s) => typeof s === "string");

	const out: string[] = [];
	for (const s of order) {
		if (fired.has(s) && s !== generalist) {
			out.push(s);
			fired.delete(s);
		}
	}
	// Defensive: fired but unordered
	for (const s of fired) {
		if (s !== generalist) out.push(s);
	}
	return out;
}

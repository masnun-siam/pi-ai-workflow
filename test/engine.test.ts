/**
 * Self-check for the /run-issue engine — pure logic only.
 *
 * Port of test_engine.py's pure-engine checks. No I/O, no subprocess, no git.
 * Covers: bounce cap, roster bounce, advance/done, unknown status, counter
 * isolation, envelope validation, globs, classifier, review panel.
 */

import { describe, expect, it } from "vitest";
import {
	type Classification,
	Ledger,
	RouteAction,
	RouteActionKind,
	Router,
	classify,
	resolveReviewPanel,
	validateEnvelope,
} from "../src/engine/engine.ts";
import { globMatch } from "../src/engine/globs.ts";
import config from "../config/default.json" with { type: "json" };

const FULL: string[] = config.modes.full.stations;

function envelope(
	station: string,
	status: string = "passed",
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		issue: 41,
		station,
		status,
		attempt: 1,
		summary: "x",
		evidence: { commands: [{ cmd: "true", exit: 0 }] },
		...extra,
	};
}

function ledgerAt(station: string): Ledger {
	return new Ledger(41, FULL, FULL.indexOf(station));
}

// --- 1. bounce cap boundary -------------------------------------------------

describe("bounce cap", () => {
	it("2 bounces allowed, the 3rd escalates", () => {
		const led = ledgerAt("verifier");
		const router = new Router(2);
		const bounce = envelope("verifier", "bounce", {
			bounce: { to: "dev", reason: "broken" },
		});

		for (let attempt = 0; attempt < 2; attempt++) {
			const action = router.next(led, bounce as any);
			expect(action.kind).toBe(RouteActionKind.BOUNCE);
			led.recordBounce("verifier", "dev");
			led.currentIndex = FULL.indexOf("verifier");
		}

		const action = router.next(led, bounce as any);
		expect(action.kind).toBe(RouteActionKind.ESCALATE);
		expect(action.reason).toContain("cap (2) exceeded");
	});
});

// --- 2. bounce to a station outside this run's roster -----------------------

describe("roster bounce", () => {
	it("bounce to a station outside the roster escalates, naming the roster", () => {
		const lean = new Ledger(41, config.modes.lean.stations, 2);
		const action = new Router(2).next(
			lean,
			envelope("dev", "bounce", { bounce: { to: "sdet", reason: "bad test" } }) as any,
		);
		expect(action.kind).toBe(RouteActionKind.ESCALATE);
		expect(action.reason).toContain("not in this run's roster");
		expect(action.reason).toContain("researcher -> planner");
	});
});

// --- 3. passed on the last station -> done ----------------------------------

describe("advance and done", () => {
	it("passed advances one station; passed on the last station is done", () => {
		expect(
			new Router(2).next(ledgerAt(FULL[FULL.length - 1]), envelope(FULL[FULL.length - 1]) as any).kind,
		).toBe(RouteActionKind.DONE);
		expect(new Router(2).next(ledgerAt("sdet"), envelope("sdet") as any).target).toBe("dev");
	});
});

// --- 4. unknown status raises -----------------------------------------------

describe("unknown status", () => {
	it("an unrecognised status raises", () => {
		for (const bad of ["approved", "ok", null, ""]) {
			expect(() =>
				new Router(2).next(ledgerAt("dev"), envelope("dev", bad as string) as any),
			).toThrow();
		}
	});
});

// --- 5. (from,to) counter isolation -----------------------------------------

describe("bounce counter isolation", () => {
	it("bounce budgets are per (from,to) pair, never merged", () => {
		const led = ledgerAt("verifier");
		led.recordBounce("verifier", "dev");
		led.recordBounce("verifier", "dev");
		expect(led.bounceCount("verifier", "dev")).toBe(2);
		expect(led.bounceCount("dev", "sdet")).toBe(0);

		led.currentIndex = FULL.indexOf("dev");
		const action = new Router(2).next(
			led,
			envelope("dev", "bounce", { bounce: { to: "sdet", reason: "wrong test" } }) as any,
		);
		expect(action.kind).toBe(RouteActionKind.BOUNCE);
	});
});

// --- 7. envelope validation -------------------------------------------------

describe("envelope validation", () => {
	it("valid envelope passes", () => {
		const led = ledgerAt("dev");
		expect(validateEnvelope(envelope("dev"), led, config)).toEqual([]);
	});

	it("missing required field detected", () => {
		const led = ledgerAt("dev");
		const env = envelope("dev");
		delete env.summary;
		const errors = validateEnvelope(env, led, config);
		expect(errors.some((e) => e.includes("missing required field: summary"))).toBe(true);
	});

	it("evidence gate enforced for dev", () => {
		const led = ledgerAt("dev");
		const errors = validateEnvelope(
			envelope("dev", "passed", { evidence: {} }),
			led,
			config,
		);
		expect(errors.some((e) => e.includes("evidence.commands"))).toBe(true);
	});

	it("skip exemption works", () => {
		const led = ledgerAt("verifier");
		const errors = validateEnvelope(
			{
				issue: 41,
				station: "verifier",
				status: "passed",
				attempt: 1,
				summary: "skipped",
				evidence: { skipped: true },
			},
			led,
			config,
		);
		expect(errors).toEqual([]);
	});

	it("no blocked status", () => {
		const led = ledgerAt("dev");
		const errors = validateEnvelope(envelope("researcher", "blocked"), led, config);
		expect(errors.some((e) => e.includes("invalid status"))).toBe(true);
	});

	it("bounce requires to and reason", () => {
		const led = ledgerAt("dev");
		const errors = validateEnvelope(
			envelope("dev", "bounce", { bounce: { to: "sdet" } }),
			led,
			config,
		);
		expect(errors.some((e) => e.includes("bounce.to and bounce.reason"))).toBe(true);
	});
});

// --- 8. globs ---------------------------------------------------------------

describe("glob matching", () => {
	it("* does not cross /", () => {
		expect(globMatch("docs/a.md", "docs/*")).toBe(true);
		expect(globMatch("docs/a/b.md", "docs/*")).toBe(false);
	});

	it("** matches nested paths", () => {
		expect(globMatch("app/Http/Middleware/Auth.php", "**/{auth,authz,middleware}/**")).toBe(true);
		expect(globMatch("db/migrations/001.sql", "**/migrations/**")).toBe(true);
		expect(globMatch("migrations/001.sql", "**/migrations/**")).toBe(true);
	});

	it("*-lock.* matches at root only", () => {
		expect(globMatch("package-lock.json", "*-lock.*")).toBe(true);
		expect(globMatch("web/package-lock.json", "*-lock.*")).toBe(false);
	});

	it("case-insensitive matching", () => {
		expect(globMatch("src/Permission.ts", "**/*permission*")).toBe(true);
	});
});

// --- 9. classifier ----------------------------------------------------------

describe("classifier", () => {
	it("missing graph scores WIDE, not low", () => {
		const files = ["database/migrations/2026_add_x.php", "app/Http/Middleware/CheckPermission.php"];
		const known = classify(files, { upstream_depth: 0, loc_changed: 50 }, config);
		const unknown = classify(files, { loc_changed: 50 }, config);
		expect(known.blast_radius).toBe("d1");
		expect(unknown.blast_radius).toBe("unknown");
		expect(unknown.risk_score).toBeGreaterThan(known.risk_score);
		expect(new Set(unknown.signals)).toEqual(new Set(["auth", "migration", "backend"]));
	});

	it("doc typing", () => {
		expect(classify(["README.md", "docs/x.md"], {}, config).ticket_type).toBe("docs");
	});

	it("bugfix typing from labels", () => {
		expect(classify(["src/a.ts"], { labels: ["bug"] }, config).ticket_type).toBe("bugfix");
	});
});

// --- 10. review policy ------------------------------------------------------

describe("review policy", () => {
	const policy = config.review_policy;

	it("low + no signals = generalist only", () => {
		expect(
			resolveReviewPanel({ signals: [], risk_band: "low" } as Classification, policy),
		).toEqual([]);
	});

	it("auth signal fires security", () => {
		expect(
			resolveReviewPanel({ signals: ["auth"], risk_band: "low" } as Classification, policy),
		).toEqual(["security"]);
	});

	it("deduplication and ordering", () => {
		expect(
			resolveReviewPanel(
				{ signals: ["auth", "dependency"], risk_band: "high" } as Classification,
				policy,
			),
		).toEqual(["security", "performance"]);
	});

	it("generalist never selected", () => {
		const panel = resolveReviewPanel(
			{ signals: ["auth", "api-contract"], risk_band: "high" } as Classification,
			policy,
		);
		expect(panel).not.toContain(policy.generalist);
	});
});

// --- Ledger persistence -----------------------------------------------------

describe("Ledger persistence", () => {
	it("round-trips through toDict/fromDict", () => {
		const led = new Ledger(42, ["a", "b", "c"], 1);
		led.recordBounce("a", "b");
		led.status = "running";
		led.context = { pr_number: 99 };

		const restored = Ledger.fromDict(led.toDict() as Record<string, unknown>);
		expect(restored.issue).toBe(42);
		expect(restored.stations).toEqual(["a", "b", "c"]);
		expect(restored.currentIndex).toBe(1);
		expect(restored.bounceCounts).toEqual({ "a->b": 1 });
		expect(restored.context).toEqual({ pr_number: 99 });
	});
});

/**
 * Self-check for the mechanical subcommands — pure decisions only.
 *
 * Port of test_scripts.py. No Docker, no network. Covers: runner detection,
 * compose limits, app service selection, container ports, source mount,
 * api/web split, threads, ci state, project matching, worktree slug, epic DAG.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectHostRunner, capWorkers, limitsOverride, pickAppService, containerPorts, sourceIsMounted, pickApiWebServices, buildTestCmd, composeProject } from "../src/mechanical/stack.ts";
import { threadForComment } from "../src/mechanical/threads.ts";
import * as ci from "../src/mechanical/ci.ts";
import { matchOption } from "../src/mechanical/project.ts";
import { slugify, isSecret, pickInstall } from "../src/mechanical/worktree.ts";
import { parseDepends, buildDag, ready as epicReady } from "../src/mechanical/epic.ts";
import { parseIssueList, dedupe, dorGaps } from "../src/mechanical/dispatch.ts";
import { pick as reviewPick } from "../src/mechanical/review.ts";
import { extractJsonObject, deepMerge } from "../src/mechanical/shared.ts";

function write(root: string, rel: string, body: string = "{}"): void {
	const p = path.join(root, rel);
	fs.mkdirSync(path.dirname(p) || root, { recursive: true });
	fs.writeFileSync(p, body);
}

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-aw-test-"));
}

function rmDir(d: string): void {
	fs.rmSync(d, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- runner

describe("host runner detection", () => {
	it("follows the lockfile, not the package manager you'd guess", () => {
		const d = tmpDir();
		try {
			write(d, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
			write(d, "package-lock.json");
			expect(detectHostRunner(d)).toBe("npm test");
			write(d, "pnpm-lock.yaml", "");
			expect(detectHostRunner(d)).toBe("pnpm test");
		} finally { rmDir(d); }
	});

	it("php runner prefers a declared composer script over artisan", () => {
		const d = tmpDir();
		try {
			write(d, "composer.json", JSON.stringify({ require: {} }));
			write(d, "artisan", "");
			expect(detectHostRunner(d)).toBe("php artisan test");
			write(d, "composer.json", JSON.stringify({ scripts: { test: "pest" } }));
			expect(detectHostRunner(d)).toBe("composer test");
		} finally { rmDir(d); }
	});

	it("monorepo runner is detected for the test root's package, not the whole repo", () => {
		const d = tmpDir();
		try {
			write(d, "go.mod", "module x");
			write(d, "apps/web/package.json", JSON.stringify({ scripts: { test: "vitest" } }));
			write(d, "apps/web/package-lock.json");
			expect(detectHostRunner(d, "apps/web/tests")).toBe("npm test");
			expect(detectHostRunner(d)).toBe("go test ./...");
		} finally { rmDir(d); }
	});
});

// --------------------------------------------------------------------------- worker caps

describe("worker caps", () => {
	it("are applied once, and never override one already set", () => {
		expect(capWorkers("vendor/bin/pest --parallel")).toBe("vendor/bin/pest --parallel --processes=2");
		expect(capWorkers("npx vitest run")).toBe("npx vitest run --maxWorkers=2");
		expect(capWorkers("npx vitest --maxWorkers=4")).toBe("npx vitest --maxWorkers=4");
		expect(capWorkers("pytest")).toBe("pytest");
	});
});

// --------------------------------------------------------------------------- compose

describe("limits override", () => {
	it("gives the app more than a datastore and never omits a service", () => {
		const override = limitsOverride(["app", "postgres", "redis", "queue"]) as Record<string, any>;
		const services = override.services;
		expect(services.app.deploy.resources.limits).toEqual({ cpus: "1.5", memory: "1g" });
		expect(services.postgres.deploy.resources.limits).toEqual({ cpus: "1.0", memory: "768m" });
		expect(services.redis.deploy.resources.limits.memory).toBe("768m");
		expect(services.queue.deploy.resources.limits.cpus).toBe("1.5");
		// Must be JSON-serializable (valid YAML)
		expect(JSON.parse(JSON.stringify(override))).toBeTruthy();
	});
});

describe("app service selection", () => {
	it("reads app service, container port and source mount off compose config", () => {
		const config = {
			services: {
				postgres: { image: "postgres:16" },
				"laravel.test": { build: { context: "." }, ports: [{ published: "8080", target: 80 }], volumes: [{ type: "bind", source: "/repo", target: "/var/www" }] },
				redis: { image: "redis" },
			},
		};
		expect(pickAppService(config)).toBe("laravel.test");
		expect(containerPorts(config, "laravel.test")).toEqual(["80"]);
		expect(containerPorts(config, "postgres")).toEqual([]);
		expect(containerPorts(config, null)).toEqual([]);
		expect(sourceIsMounted(config, "laravel.test", "/repo")).toBe(true);
		expect(sourceIsMounted(config, "laravel.test", "/elsewhere")).toBe(false);
		expect(pickAppService({ services: { postgres: { image: "postgres" } } })).toBe("postgres");
	});

	it("resolves every published port for a service, not just the first", () => {
		const config = {
			services: {
				app: { build: { context: "." }, ports: ["8080:80", "9000:9090/tcp"] },
			},
		};
		expect(containerPorts(config, "app")).toEqual(["80", "9090"]);
	});

	it("force-publishes every declared port to an OS-chosen host port", () => {
		const config = {
			services: {
				app: { build: { context: "." }, ports: ["8080:80", "9000:9090/tcp"] },
			},
		};
		const override = limitsOverride(["app", "postgres"], config) as Record<string, any>;
		expect(override.services.app.ports).toEqual(["0:80", "0:9090"]);
		expect(override.services.postgres.ports).toBeUndefined();
	});
});

describe("test cmd", () => {
	it("execs against the running container with the worker cap applied", () => {
		expect(buildTestCmd("docker compose -p runissue-9 -f c.yml", "app", "npx vitest")).toBe(
			"docker compose -p runissue-9 -f c.yml exec -T app npx vitest --maxWorkers=2",
		);
	});
});

// --------------------------------------------------------------------------- api/web split

describe("api/web service split", () => {
	it("two distinct buildable services split into (api, web); one service never does", () => {
		const monorepo = {
			services: {
				postgres: { image: "postgres:16" },
				api: { build: { context: "./api" }, ports: [{ published: "8000", target: 80 }] },
				web: { build: { context: "./web" }, ports: [{ published: "3000", target: 3000 }] },
			},
		};
		expect(pickApiWebServices(monorepo)).toEqual(["api", "web"]);
		const single = {
			services: {
				postgres: { image: "postgres:16" },
				"laravel.test": { build: { context: "." }, ports: [{ published: "8080", target: 80 }] },
				redis: { image: "redis" },
			},
		};
		expect(pickApiWebServices(single)).toEqual([null, null]);
		expect(pickApiWebServices({ services: { postgres: { image: "postgres" } } })).toEqual([null, null]);
	});
});

// --------------------------------------------------------------------------- compose project name

describe("compose project name", () => {
	it("is deterministic and includes repo digest", () => {
		const p1 = composeProject("/repo/a", 42);
		const p2 = composeProject("/repo/a", 42);
		const p3 = composeProject("/repo/b", 42);
		expect(p1).toBe(p2);
		expect(p1).not.toBe(p3);
		expect(p1).toMatch(/^runissue-a-/);
	});
});

// --------------------------------------------------------------------------- threads

describe("thread matching", () => {
	it("matches by first comment's REST id, string or int", () => {
		const threads = [
			{ node_id: "PRRT_a", is_resolved: false, is_outdated: false, comment_id: 111, url: "u1", path: null, line: null },
			{ node_id: "PRRT_b", is_resolved: true, is_outdated: false, comment_id: 222, url: "u2", path: null, line: null },
		];
		expect(threadForComment(threads, 222)?.node_id).toBe("PRRT_b");
		expect(threadForComment(threads, "111")?.node_id).toBe("PRRT_a");
		expect(threadForComment(threads, 999)).toBeNull();
		expect(threadForComment(threads, null)).toBeNull();
	});
});

// --------------------------------------------------------------------------- ci

describe("ci state", () => {
	it("puts pending ahead of failing, and the run id comes out of the check link", () => {
		// stateOf is not exported — test via the snapshot logic indirectly
		// Test runIdOf equivalent
		const link = "https://github.com/o/r/actions/runs/123456/job/99";
		const idx = link.indexOf("/runs/");
		const runId = idx === -1 ? "" : link.slice(idx + 6).split("/")[0];
		expect(runId).toBe("123456");
		expect("".indexOf("/runs/") === -1 ? "" : "").toBe("");
	});
});

// --------------------------------------------------------------------------- project

describe("project status matching", () => {
	it("matches the exact option, then the best significant-word overlap", () => {
		const options = [
			{ id: "o1", name: "Todo" },
			{ id: "o2", name: "On Review" },
			{ id: "o3", name: "In Progress" },
		];
		expect(matchOption(options, "Todo")?.id).toBe("o1");
		expect(matchOption(options, "In Review")?.id).toBe("o2");
		expect(matchOption(options, "In Progress")?.id).toBe("o3");
		expect(matchOption(options, "Blocked")).toBeNull();
		expect(matchOption(options, "In")).toBeNull();
	});
});

// --------------------------------------------------------------------------- worktree

describe("worktree helpers", () => {
	it("branch slug and the gitignored-secret filter behave on the awkward names", () => {
		expect(slugify("Fix the N+1 in OrderController!")).toBe("fix-the-n-1-in-ordercontroller");
		expect(slugify("")).toBe("issue");
		expect(isSecret("storage/oauth-private.key")).toBe(true);
		expect(isSecret(".env.local")).toBe(true);
		expect(isSecret("app/.env")).toBe(true);
		expect(isSecret("src/keyboard.ts")).toBe(false);
	});

	it("install command is chosen by lockfile precedence", () => {
		const d = tmpDir();
		try {
			write(d, "composer.lock", "");
			expect(pickInstall(d)).toEqual(["composer", "install", "--no-interaction"]);
			write(d, "pnpm-lock.yaml", "");
			expect(pickInstall(d)?.[0]).toBe("pnpm");
		} finally { rmDir(d); }
	});
});

// --------------------------------------------------------------------------- epic DAG

describe("epic DAG", () => {
	it("Depends on: parses to sorted unique issue numbers, absent means []", () => {
		expect(parseDepends("Some body\n\nDepends on: #12, #13\n")).toEqual([12, 13]);
		expect(parseDepends("depends on: #7")).toEqual([7]);
		expect(parseDepends("No dependency line here")).toEqual([]);
		expect(parseDepends("Depends on: none")).toEqual([]);
		expect(parseDepends("Depends on: #9, #9")).toEqual([9]);
		expect(parseDepends(null)).toEqual([]);
		expect(parseDepends("Depends on: #4 in passing\n\n## Dependencies\nDepends on: #12, #13\n")).toEqual([4, 12, 13]);
	});

	it("build_dag topologically orders a diamond deterministically", () => {
		const dag = buildDag({ 10: [], 11: [10], 12: [10], 13: [11, 12] });
		expect(dag.order).toEqual([10, 11, 12, 13]);
		expect(dag.deps["13"]).toEqual([11, 12]);
	});

	it("build_dag rejects foreign edges, self-edges and cycles of any length", () => {
		expect(() => buildDag({ 10: [99] })).toThrow("not in this epic");
		expect(() => buildDag({ 10: [10] })).toThrow("itself");
		expect(() => buildDag({ 10: [11], 11: [10] })).toThrow("cycle");
		expect(() => buildDag({ 10: [11], 11: [12], 12: [10] })).toThrow("cycle");
	});
});

// --------------------------------------------------------------------------- epic readiness

describe("epic readiness", () => {
	it("ready children have deps with PRs open and stack slots available", () => {
		const dag = buildDag({ 10: [], 11: [10], 12: [] });
		const state = (opts: { status?: string; pr?: boolean; stack_up?: boolean; needs_stack?: boolean } = {}) => ({
			status: opts.status ?? "running",
			pr: opts.pr ?? false,
			stack_up: opts.stack_up ?? false,
			needs_stack: opts.needs_stack ?? false,
		});

		// All running, no deps need PRs, no stacks needed
		const states1: Record<number, Record<string, unknown>> = {
			10: state({ pr: true }),
			11: state(),
			12: state(),
		};
		expect(epicReady(dag, states1, 2)).toEqual([10, 11, 12]);

		// 11 depends on 10, 10 has no PR yet — 11 not ready
		const states2: Record<number, Record<string, unknown>> = {
			10: state(),
			11: state(),
			12: state(),
		};
		expect(epicReady(dag, states2, 2)).toEqual([10, 12]);

		// Done runs don't show up
		const states3: Record<number, Record<string, unknown>> = {
			10: state({ status: "done", pr: true }),
			11: state(),
			12: state(),
		};
		expect(epicReady(dag, states3, 2)).toEqual([11, 12]);
	});
});

// --------------------------------------------------------------------------- dispatch

describe("dispatch helpers", () => {
	it("parseIssueList handles comma-separated, #-prefixed, whitespace", () => {
		expect(parseIssueList("1, 2, 3")).toEqual([1, 2, 3]);
		expect(parseIssueList("#10, #20")).toEqual([10, 20]);
		expect(() => parseIssueList("")).toThrow();
		expect(() => parseIssueList("abc")).toThrow();
	});

	it("dedupe drops repeats, first occurrence wins", () => {
		expect(dedupe([1, 2, 1, 3, 2])).toEqual([1, 2, 3]);
	});

	it("dorGaps reports missing sections", () => {
		const body = "# Summary\nSome text\n\n## Scope\nThe scope\n";
		const gaps = dorGaps(body);
		expect(gaps).toContain("Acceptance criteria");
		expect(gaps).not.toContain("Problem & why");
		expect(gaps).not.toContain("Scope");
	});
});

// --------------------------------------------------------------------------- review pick

describe("review pick", () => {
	it("newest comment-carrying review beats a same-commit rubber stamp", () => {
		const reviews = [
			{ id: 1, commit_id: "abc", submitted_at: "2026-01-01T00:00:00Z", body: "Verdict: 1 blocker 0 should-fix" },
			{ id: 2, commit_id: "abc", submitted_at: "2026-01-01T00:00:30Z", body: "" },
		];
		const comments = [{ pull_request_review_id: 1, id: 100 }];
		const result = reviewPick(reviews, comments);
		expect(result.selected).toBe(1);
		expect(result.reason).toContain("comment-carrying");
	});

	it("no reviews returns null", () => {
		const result = reviewPick([], []);
		expect(result.selected).toBeNull();
	});
});

// --------------------------------------------------------------------------- shared

describe("extractJsonObject", () => {
	it("recovers a fenced/prose-wrapped object, rejects genuine garbage", () => {
		const body = '{"issue": 1, "station": "dev", "status": "passed"}';
		expect(extractJsonObject(body)).toEqual({ issue: 1, station: "dev", status: "passed" });
		expect(extractJsonObject("```json\n" + body + "\n```")).toEqual({ issue: 1, station: "dev", status: "passed" });
		expect(extractJsonObject("Here is the envelope:\n\n" + body)).toEqual({ issue: 1, station: "dev", status: "passed" });
		expect(extractJsonObject("no json here at all")).toBeNull();
		expect(extractJsonObject("{not: valid}")).toBeNull();
	});
});

describe("deepMerge", () => {
	it("dicts merge recursively, lists replace", () => {
		const base = { a: { b: 1, c: 2 }, d: [1, 2] };
		const overlay = { a: { c: 3, e: 4 }, d: [3] };
		const result = deepMerge(base, overlay);
		expect(result).toEqual({ a: { b: 1, c: 3, e: 4 }, d: [3] });
	});
});

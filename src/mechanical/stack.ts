/**
 * Per-issue test stack: up, down, rebuild, status.
 *
 * Port of stack.py. The ONLY owner of the container contract.
 * File-based locking with break sentinels for atomic mutations.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../engine/types.ts";
import {
	dataDir,
	die,
	loadConfig,
	loadLedger,
	printWritten,
	record,
	repoOf,
	run,
	shell,
	warn,
} from "./shared.ts";

const UP_TIMEOUT = 600;
const LOCK_TIMEOUT = 900;
const LOCK_POLL = 5;
const LOCK_GRACE = 2 * UP_TIMEOUT;
const BREAK_SENTINEL_STALE = 30;
const RELEASE_SENTINEL_RETRIES = 3;
const RELEASE_SENTINEL_BACKOFF = 0.05;

const COMPOSE_CANDIDATES = [
	"docker-compose.test.yml",
	"docker-compose.test.yaml",
	"compose.test.yml",
	"compose.test.yaml",
	"docker/docker-compose.test.yml",
	"docker/docker-compose.test.yaml",
];

const DATASTORE_HINTS = [
	"postgres", "pgsql", "mysql", "mariadb", "redis", "mongo", "elastic",
	"rabbit", "memcach", "minio", "mailhog", "mailpit", "meilisearch",
	"clickhouse", "kafka", "zookeeper", "selenium", "chrome",
];
const APP_HINTS = ["app", "web", "php", "api", "laravel", "node", "server", "backend", "frontend"];
const API_HINTS = ["api", "php", "laravel", "backend", "server"];
const WEB_HINTS = ["web", "node", "frontend", "next", "react", "vite"];

export function composeProject(repo: string, issue: number): string {
	const norm = path.normalize(repo);
	const base = path.basename(norm) || "repo";
	const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
	const digest = crypto.createHash("sha1").update(norm).digest("hex").slice(0, 8);
	return `runissue-${slug}-${digest}-${issue}`;
}

export function lockPath(project: string): string {
	return path.join(dataDir(), "locks", `${project}.lock`);
}

function readHolder(filePath: string): Record<string, unknown> | null {
	try {
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return typeof data === "object" && data !== null ? data : null;
	} catch {
		return null;
	}
}

export function lockStale(holder: Record<string, unknown>, now: number): boolean {
	const runDir = holder.run_dir as string | undefined;
	const acquiredAt = holder.acquired_at as number | undefined;
	if (!runDir || typeof acquiredAt !== "number") return true;
	const ledgerFile = path.join(runDir, "run.json");
	try {
		const raw = fs.readFileSync(ledgerFile, "utf-8");
		const data = JSON.parse(raw);
		const status = typeof data === "object" && data !== null ? data.status : null;
		if (status === "done" || status === "escalated") return true;
	} catch {
		warn(`stack lock holder ${runDir} has no run.json; reclaiming`);
		return true;
	}
	return now - acquiredAt > LOCK_GRACE;
}

function breakSentinelPath(filePath: string): string {
	return `${filePath}.break`;
}

function reclaimStaleBreakSentinel(breakPath: string): void {
	try {
		const st = fs.statSync(breakPath);
		if (Date.now() / 1000 - st.mtimeMs / 1000 <= BREAK_SENTINEL_STALE) return;
		try {
			const st2 = fs.statSync(breakPath);
			if (st2.mtimeMs !== st.mtimeMs) return;
			fs.unlinkSync(breakPath);
		} catch { /* someone else cleared it */ }
	} catch { /* already gone */ }
}

function withBreakSentinel<T>(filePath: string, action: () => T): T | null {
	const breakPath = breakSentinelPath(filePath);
	try {
		const fd = fs.openSync(breakPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
		fs.closeSync(fd);
	} catch {
		reclaimStaleBreakSentinel(breakPath);
		return null;
	}
	try {
		return action();
	} finally {
		try { fs.unlinkSync(breakPath); } catch { /* ignore */ }
	}
}

function writeHolder(filePath: string, holder: Record<string, unknown>): void {
	const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
	fs.writeFileSync(tmpPath, JSON.stringify(holder));
	fs.renameSync(tmpPath, filePath);
}

export function acquireLock(
	runDir: string,
	issue: number,
	repo: string,
	timeout: number = LOCK_TIMEOUT,
): boolean {
	const filePath = lockPath(composeProject(repo, issue));
	const deadline = Date.now() / 1000 + Math.max(timeout, 0);

	while (true) {
		const current = readHolder(filePath);
		if (current !== null && current.run_dir === runDir) return true;

		const holder = { run_dir: runDir, issue, repo, acquired_at: Date.now() / 1000 };

		const decideAndPublish = (): boolean => {
			const current = readHolder(filePath);
			if (current !== null && current.run_dir === runDir) return true;
			if (current !== null && !lockStale(current, Date.now() / 1000)) return false;
			try {
				writeHolder(filePath, holder);
			} catch {
				warn("stack lock file is not writable; proceeding unlocked");
			}
			return true;
		};

		const outcome = withBreakSentinel(filePath, decideAndPublish);
		if (outcome) return true;
		if (Date.now() / 1000 >= deadline) return false;
		const sleepMs = Math.min(LOCK_POLL, Math.max(deadline - Date.now() / 1000, 0)) * 1000;
		// sync sleep via SharedArrayBuffer + Atomics.wait
		const sab = new SharedArrayBuffer(4);
		Atomics.wait(new Int32Array(sab), 0, 0, sleepMs);
	}
}

export function releaseLock(runDir: string, issue: number, repo: string): void {
	const filePath = lockPath(composeProject(repo, issue));
	const release = (): boolean => {
		const holder = readHolder(filePath);
		if (holder !== null && holder.run_dir === runDir) {
			try { fs.unlinkSync(filePath); } catch { /* ignore */ }
		}
		return true;
	};

	for (let attempt = 0; attempt < RELEASE_SENTINEL_RETRIES; attempt++) {
		if (withBreakSentinel(filePath, release) === true) return;
		if (attempt < RELEASE_SENTINEL_RETRIES - 1) {
			const sleepMs = RELEASE_SENTINEL_BACKOFF * 1000;
			const sab = new SharedArrayBuffer(4);
			Atomics.wait(new Int32Array(sab), 0, 0, sleepMs);
		}
	}
}

// --------------------------------------------------------------------------- pure

export function packageDirs(repo: string, testRoot?: string): string[] {
	const dirs: string[] = [];
	if (testRoot) {
		let cur = path.dirname(path.join(repo, testRoot.replace(/\/$/, "")));
		while (cur.startsWith(repo) && cur.length > repo.length) {
			dirs.push(cur);
			cur = path.dirname(cur);
		}
	}
	dirs.push(repo);
	const seen = new Set<string>();
	return dirs.filter((d) => (seen.has(d) ? false : (seen.add(d), true)));
}

function jsonFile(filePath: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

export function detectHostRunner(repo: string, testRoot?: string): string | null {
	for (const d of packageDirs(repo, testRoot)) {
		const has = (...p: string[]) => fs.existsSync(path.join(d, ...p));

		const pkg = jsonFile(path.join(d, "package.json"));
		if (pkg && (pkg.scripts as Record<string, unknown>)?.test) {
			if (has("pnpm-lock.yaml")) return "pnpm test";
			if (has("yarn.lock")) return "yarn test";
			if (has("bun.lockb")) return "bun test";
			return "npm test";
		}

		const composer = jsonFile(path.join(d, "composer.json"));
		if (composer) {
			if ((composer.scripts as Record<string, unknown>)?.test) return "composer test";
			if (has("artisan")) return "php artisan test";
			if (has("vendor", "bin", "pest")) return "vendor/bin/pest";
			if (has("phpunit.xml") || has("phpunit.xml.dist")) return "vendor/bin/phpunit";
		}

		if (has("pytest.ini") || has("tox.ini") || has("pyproject.toml") || has("setup.cfg")) {
			return "pytest";
		}
		if (has("go.mod")) return "go test ./...";
		if (has("pubspec.yaml")) {
			try {
				const pub = fs.readFileSync(path.join(d, "pubspec.yaml"), "utf-8");
				return pub.includes("flutter:") ? "flutter test" : "dart test";
			} catch { /* ignore */ }
		}
	}
	return null;
}

export function capWorkers(cmd: string): string {
	const low = cmd.toLowerCase();
	if (low.includes("--parallel") && !low.includes("--processes")) return cmd + " --processes=2";
	if ((low.includes("vitest") || low.includes("jest")) && !low.includes("--maxworkers")) {
		return cmd + " --maxWorkers=2";
	}
	return cmd;
}

export function findComposeFile(repo: string, testRoot?: string): string | null {
	for (const d of packageDirs(repo, testRoot)) {
		for (const name of COMPOSE_CANDIDATES) {
			const p = path.join(d, name);
			if (fs.existsSync(p)) return path.relative(repo, p);
		}
	}
	return null;
}

export function isDatastore(name: string): boolean {
	const low = name.toLowerCase();
	return DATASTORE_HINTS.some((hint) => low.includes(hint));
}

export function limitsOverride(
	services: string[],
	config: Record<string, unknown> | null = null,
): Record<string, unknown> {
	config = config || {};
	const out: Record<string, unknown> = {};
	for (const name of services) {
		const small = isDatastore(name);
		const entry: Record<string, unknown> = {
			deploy: {
				resources: {
					limits: {
						cpus: small ? "1.0" : "1.5",
						memory: small ? "768m" : "1g",
					},
				},
			},
		};
		const ports = containerPorts(config, name);
		if (ports.length) entry.ports = ports.map((p) => `0:${p}`);
		out[name] = entry;
	}
	return { services: out };
}

export function pickAppService(config: Record<string, unknown>): string | null {
	const services = (config.services as Record<string, Record<string, unknown>>) || {};
	if (!Object.keys(services).length) return null;
	const buildable = Object.entries(services)
		.filter(([n, s]) => s.build && !isDatastore(n))
		.map(([n]) => n);
	const pool = buildable.length ? buildable : Object.keys(services).filter((n) => !isDatastore(n));
	const all = pool.length ? pool : Object.keys(services);
	for (const hint of APP_HINTS) {
		for (const name of all) {
			if (name.toLowerCase().includes(hint)) return name;
		}
	}
	return all[0] || null;
}

export function pickApiWebServices(
	config: Record<string, unknown>,
): [string | null, string | null] {
	const services = (config.services as Record<string, Record<string, unknown>>) || {};
	const buildable = Object.entries(services)
		.filter(([n, s]) => s.build && !isDatastore(n))
		.map(([n]) => n);
	if (buildable.length < 2) return [null, null];

	const firstMatch = (hints: string[]) => {
		for (const hint of hints) {
			for (const name of buildable) {
				if (name.toLowerCase().includes(hint)) return name;
			}
		}
		return null;
	};

	const api = firstMatch(API_HINTS);
	const web = firstMatch(WEB_HINTS);
	if (api && web && api !== web) return [api, web];
	return [null, null];
}

export function sourceIsMounted(
	config: Record<string, unknown>,
	app: string,
	repo: string,
): boolean {
	const realRepo = path.resolve(repo);
	const volumes = ((config.services as Record<string, Record<string, unknown>>)?.[app]?.volumes as unknown[]) || [];
	for (const vol of volumes) {
		let src = "";
		if (typeof vol === "string") {
			src = vol.split(":")[0];
		} else if (typeof vol === "object" && vol !== null && (vol as Record<string, unknown>).type === "bind") {
			src = ((vol as Record<string, unknown>).source as string) || "";
		}
		if (!src) continue;
		const realSrc = path.isAbsolute(src)
			? path.resolve(src)
			: path.resolve(path.join(repo, src.replace(/^~/, os.homedir())));
		if (realSrc === realRepo || realSrc.startsWith(realRepo + path.sep)) return true;
	}
	return false;
}

export function containerPorts(config: Record<string, unknown>, service: string | null): string[] {
	if (!service) return [];
	const out: string[] = [];
	const ports = ((config.services as Record<string, Record<string, unknown>>)?.[service]?.ports as unknown[]) || [];
	for (const port of ports) {
		if (typeof port === "string") {
			const target = port.split(":").pop()?.split("/")[0];
			if (target) out.push(target);
		} else if (typeof port === "object" && port !== null && (port as Record<string, unknown>).target !== undefined) {
			out.push(String((port as Record<string, unknown>).target));
		}
	}
	return out;
}

export function resolvePort(
	composePrefix: string,
	repo: string,
	service: string,
	containerPort: string,
): string | null {
	const proc = shell(`${composePrefix} port ${service} ${containerPort}`, { cwd: repo, timeout: 30 });
	if (proc.status !== 0) return null;
	const out = (proc.stdout || "").trim();
	if (!out.includes(":")) return null;
	const port = out.split(":").pop()?.trim();
	return port || null;
}

export function readTestCmdOverride(repo: string): string {
	try {
		const config = loadConfig(repo);
		const value = config.test_cmd;
		if (value === undefined) return "";
		if (typeof value === "string" && value.trim()) return value.trim();
		warn(`test_cmd=${value} is invalid, ignoring override`);
		return "";
	} catch {
		warn(`could not load config for ${repo}; ignoring test_cmd override`);
		return "";
	}
}

export function buildTestCmd(composePrefix: string, app: string, runner: string): string {
	return `${composePrefix} exec -T ${app} ${capWorkers(runner)}`;
}

// --------------------------------------------------------------------------- I/O

export function composeConfig(repo: string, composeFile: string): Record<string, unknown> | null {
	const proc = run(["docker", "compose", "-f", composeFile, "config", "--format", "json"], { cwd: repo });
	if (proc.status !== 0) return null;
	try {
		return JSON.parse(proc.stdout);
	} catch {
		return null;
	}
}

export function writeOverride(repo: string, config: Record<string, unknown>): boolean {
	const services = Object.keys((config.services as Record<string, unknown>) || {});
	if (!services.length) return false;
	fs.writeFileSync(
		path.join(repo, ".docker-agent.yml"),
		JSON.stringify(limitsOverride(services, config), null, 2) + "\n",
	);
	return true;
}

export interface StackUpOpts {
	runDir: string;
	repo?: string;
	lockTimeout?: number;
}

export function stackUp(opts: StackUpOpts): Record<string, unknown> {
	const ledger = loadLedger(opts.runDir);
	const repo = repoOf(ledger, opts.repo);
	const testRoot = ledger.context.test_root as string | undefined;

	const override = readTestCmdOverride(repo);
	const prior = (ledger.context.test_cmd as string) || "";

	const runner = detectHostRunner(repo, testRoot);
	if (!runner) warn("no host test runner detected — stations will be told there is none");

	const composeFile = findComposeFile(repo, testRoot);
	if (!composeFile || !runner) {
		return record(opts.runDir, ledger, {
			stack: "none",
			test_cmd_host: runner || "",
			test_cmd: override || runner || "",
			app_url: "none",
			api_url: "none",
			web_url: "none",
			source_mounted: "yes",
			compose_prefix: "",
			tests_unverified: runner || override ? "" : "no test runner detected on the host",
		});
	}

	const lockTimeout = opts.lockTimeout ?? LOCK_TIMEOUT;
	const project = composeProject(repo, ledger.issue);
	if (!acquireLock(opts.runDir, ledger.issue, repo, lockTimeout)) {
		const holder = readHolder(lockPath(project)) || {};
		const who = (holder.run_dir as string) || "another run";
		return record(opts.runDir, ledger, {
			stack: "failed",
			compose_prefix: "",
			test_cmd: override || prior,
			test_cmd_host: runner,
			app_url: "none",
			api_url: "none",
			web_url: "none",
			source_mounted: "no",
			tests_unverified: `stack lock held by ${who}; timed out after ${lockTimeout}s`,
		});
	}

	const config = composeConfig(repo, composeFile) || {};
	let prefix = `docker compose -p ${project} -f ${composeFile}`;
	if (writeOverride(repo, config)) prefix += " -f .docker-agent.yml";

	let proc = shell(`${prefix} up -d --build --wait`, { cwd: repo, timeout: UP_TIMEOUT });
	if (proc.status !== 0) {
		warn("stack failed to come up; retrying once");
		proc = shell(`${prefix} up -d --build --wait`, { cwd: repo, timeout: UP_TIMEOUT });
	}
	if (proc.status !== 0) {
		shell(`${prefix} down -v --remove-orphans`, { cwd: repo, timeout: UP_TIMEOUT });
		releaseLock(opts.runDir, ledger.issue, repo);
		const reason = (proc.stderr || proc.stdout || "unknown").trim().split("\n");
		return record(opts.runDir, ledger, {
			stack: "failed",
			compose_prefix: prefix,
			test_cmd: override || prior,
			test_cmd_host: runner,
			app_url: "none",
			api_url: "none",
			web_url: "none",
			source_mounted: "no",
			tests_unverified: "docker stack would not come up: " + (reason[reason.length - 1] || "?"),
		});
	}

	const app = pickAppService(config);
	if (!app) {
		warn("stack is up but no app service could be identified; treating tests as unrunnable");
		shell(`${prefix} down -v --remove-orphans`, { cwd: repo, timeout: UP_TIMEOUT });
		releaseLock(opts.runDir, ledger.issue, repo);
		return record(opts.runDir, ledger, {
			stack: "failed",
			compose_prefix: prefix,
			test_cmd: override || prior,
			test_cmd_host: runner,
			app_url: "none",
			api_url: "none",
			web_url: "none",
			source_mounted: "no",
			tests_unverified: "no app service found in the test compose file",
		});
	}

	const appPort = containerPorts(config, app);
	const port = appPort.length ? resolvePort(prefix, repo, app, appPort[0]) : null;

	const [apiService, webService] = pickApiWebServices(config);
	const apiContainerPort = containerPorts(config, apiService);
	const webContainerPort = containerPorts(config, webService);
	const apiPort =
		apiService && apiContainerPort.length
			? resolvePort(prefix, repo, apiService, apiContainerPort[0])
			: port;
	const webPort =
		webService && webContainerPort.length
			? resolvePort(prefix, repo, webService, webContainerPort[0])
			: port;

	const appUrl = port ? `http://localhost:${port}` : "none";
	const apiUrl = apiPort ? `http://localhost:${apiPort}` : appUrl;
	const webUrl = webPort ? `http://localhost:${webPort}` : appUrl;

	return record(opts.runDir, ledger, {
		stack: "up",
		compose_prefix: prefix,
		compose_project: project,
		app_service: app,
		test_cmd: override || buildTestCmd(prefix, app, runner),
		test_cmd_host: runner,
		source_mounted: sourceIsMounted(config, app, repo) ? "yes" : "no",
		app_url: appUrl,
		api_url: apiUrl,
		web_url: webUrl,
		tests_unverified: "",
	});
}

export function stackDown(opts: { runDir: string; repo?: string }): void {
	const ledger = loadLedger(opts.runDir);
	const repo = repoOf(ledger, opts.repo);
	const prefix = ledger.context.compose_prefix as string | undefined;
	if (!prefix || ledger.context.stack === "none") {
		releaseLock(opts.runDir, ledger.issue, repo);
		console.log("no stack to tear down");
		return;
	}
	const proc = shell(`${prefix} down -v --remove-orphans`, { cwd: repo, timeout: UP_TIMEOUT });
	releaseLock(opts.runDir, ledger.issue, repo);
	if (proc.status !== 0) {
		warn("teardown failed: " + (proc.stderr || "").trim().slice(0, 200));
		return;
	}
	console.log("stack down");
}

export function appHealthy(ledger: Ledger, repo: string): [boolean, string] {
	const prefix = ledger.context.compose_prefix as string | undefined;
	const app = ledger.context.app_service as string | undefined;
	if (!prefix || !app) return [false, "no stack recorded"];
	const proc = shell(`${prefix} ps --format json ${app}`, { cwd: repo, timeout: 60 });
	if (proc.status !== 0) return [false, "compose ps failed: " + (proc.stderr || "").trim().slice(0, 120)];
	const rows: Record<string, unknown>[] = [];
	for (const line of (proc.stdout || "").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (Array.isArray(parsed)) rows.push(...parsed);
			else rows.push(parsed);
		} catch { /* ignore */ }
	}
	if (!rows.length) return [false, `service ${app} is not running`];
	const row = rows[0];
	const state = ((row.State as string) || "").toLowerCase();
	const health = ((row.Health as string) || "").toLowerCase();
	if (state !== "running") return [false, `service ${app} is ${state || "unknown"}`];
	if (health && health !== "healthy" && health !== "none") {
		return [false, `service ${app} is ${health}`];
	}
	return [true, `service ${app} is running`];
}

export function stackStatus(opts: { runDir: string; repo?: string }): void {
	const ledger = loadLedger(opts.runDir);
	if (ledger.context.stack !== "up") {
		console.log(`stack=${ledger.context.stack || "unknown"}`);
		return;
	}
	const [ok, reason] = appHealthy(ledger, repoOf(ledger, opts.repo));
	console.log((ok ? "healthy: " : "unhealthy: ") + reason);
	if (!ok) process.exit(1);
}

export function stackRebuild(opts: { runDir: string; repo?: string }): void {
	const ledger = loadLedger(opts.runDir);
	const repo = repoOf(ledger, opts.repo);
	if (ledger.context.stack !== "up") {
		console.log("no stack to rebuild");
		return;
	}
	if (ledger.context.source_mounted === "yes") {
		console.log("source is mounted — no rebuild needed");
		return;
	}
	const prefix = ledger.context.compose_prefix as string;
	const app = (ledger.context.app_service as string) || "";
	const proc = shell(`${prefix} up -d --build --wait ${app}`.trimEnd(), { cwd: repo, timeout: UP_TIMEOUT });
	if (proc.status !== 0) {
		die(1, "rebuild failed: " + (proc.stderr || proc.stdout || "").trim().slice(0, 300));
	}
	console.log(`rebuilt ${app}`);
}

/**
 * I/O helpers shared by mechanical subcommands.
 *
 * Port of shared.py. Everything the mechanical modules have in common — reading
 * the ledger, writing it back, running a subprocess, talking to `gh` — lives here.
 *
 * Exit-code doctrine: 0 ok · 1 failed · 2 usage.
 * This is NOT `piw route`'s vocabulary (0/2/3/4/5/6/7).
 */

import { execFileSync, execSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../engine/types.ts";

export const OK = 0;
export const FAILED = 1;
export const USAGE = 2;

export const OVERLAY_NAME = ".run-issue.json";

/** Where plugin state lives, outside the plugin install directory. */
export function dataDir(): string {
	return (
		process.env.PI_AW_DATA ||
		path.join(os.homedir(), ".pi", "agent", "data", "pi-ai-workflow")
	);
}

export class DieError extends Error {
	constructor(
		public readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "DieError";
	}
}

export function die(code: number, message: string): never {
	process.stderr.write(message.trimEnd() + "\n");
	throw new DieError(code, message);
}

export function warn(message: string): void {
	process.stderr.write("warning: " + message.trimEnd() + "\n");
}

/** Return the first balanced top-level {...} that parses, or null. */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
	let start = raw.indexOf("{");
	while (start !== -1) {
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (let i = start; i < raw.length; i++) {
			const ch = raw[i];
			if (inStr) {
				if (esc) {
					esc = false;
				} else if (ch === "\\") {
					esc = true;
				} else if (ch === '"') {
					inStr = false;
				}
				continue;
			}
			if (ch === '"') {
				inStr = true;
			} else if (ch === "{") {
				depth++;
			} else if (ch === "}") {
				depth--;
				if (depth === 0) {
					try {
						return JSON.parse(raw.slice(start, i + 1));
					} catch {
						break;
					}
				}
			}
		}
		start = raw.indexOf("{", start + 1);
	}
	return null;
}

export function readJson(filePath: string, missingCode: number = 3): unknown {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		die(missingCode, `cannot read: ${filePath}`);
	}
	try {
		return JSON.parse(raw);
	} catch {
		// Envelopes are written by LLMs — recover the object rather than failing.
		const obj = extractJsonObject(raw);
		if (obj === null) {
			die(4, `no JSON object found in: ${filePath}`);
		}
		return obj;
	}
}

export function writeJson(filePath: string, data: unknown): void {
	const dir = path.dirname(filePath);
	if (dir) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/** Dicts merge; lists (and scalars) REPLACE. */
export function deepMerge(
	base: Record<string, unknown>,
	overlay: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		const existing = out[key];
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			existing !== null &&
			typeof existing === "object" &&
			!Array.isArray(existing)
		) {
			out[key] = deepMerge(
				existing as Record<string, unknown>,
				value as Record<string, unknown>,
			);
		} else {
			out[key] = value;
		}
	}
	return out;
}

export function loadConfig(
	pluginRoot: string,
	repo?: string,
): Record<string, unknown> {
	const defaultPath = path.join(pluginRoot, "config", "default.json");
	let config: Record<string, unknown> = {};
	if (fs.existsSync(defaultPath)) {
		config = JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
	}
	if (repo) {
		const overlayPath = path.join(repo, OVERLAY_NAME);
		if (fs.existsSync(overlayPath)) {
			const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf-8"));
			config = deepMerge(config, overlay);
		}
	}
	return config;
}

// --------------------------------------------------------------------------- ledger

export function ledgerPath(runDir: string): string {
	return path.join(runDir, "run.json");
}

export function runDirFor(runsDir: string, slug: string, issue: number): string {
	const parts = slug.split("/");
	return path.join(runsDir, `${parts[0]}-${parts[parts.length - 1]}-issue-${issue}`);
}

export function loadLedger(runDir: string): Ledger {
	return Ledger.fromDict(readJson(ledgerPath(runDir)) as Record<string, unknown>);
}

export function saveLedger(runDir: string, ledger: Ledger): void {
	writeJson(ledgerPath(runDir), ledger.toDict());
}

export function record(
	runDir: string,
	ledger: Ledger,
	pairs: Record<string, unknown>,
): Record<string, unknown> {
	const written: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(pairs)) {
		if (v !== null && v !== undefined) {
			written[k] = v;
		}
	}
	Object.assign(ledger.context, written);
	saveLedger(runDir, ledger);
	return written;
}

export function printWritten(written: Record<string, unknown>): void {
	for (const key of Object.keys(written).sort()) {
		console.log(`${key}=${written[key]}`);
	}
}

export function repoOf(ledger: Ledger, override?: string): string {
	return override || (ledger.context.repo as string) || process.cwd();
}

// --------------------------------------------------------------------------- process

export interface RunResult {
	stdout: string;
	stderr: string;
	status: number;
}

/** Run a command with no shell. Never throws on nonzero exit — callers decide. */
export function run(
	argv: string[],
	opts?: { cwd?: string; timeout?: number; env?: Record<string, string> },
): RunResult {
	try {
		const result = spawnSync(argv[0], argv.slice(1), {
			cwd: opts?.cwd,
			timeout: opts?.timeout ? opts.timeout * 1000 : undefined,
			env: opts?.env ? { ...process.env, ...opts.env } : undefined,
			encoding: "utf-8",
		});
		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return { stdout: "", stderr: String(result.error), status: 127 };
		}
		if (result.status === null) {
			return { stdout: "", stderr: `timed out after ${opts?.timeout}s`, status: 124 };
		}
		return {
			stdout: result.stdout || "",
			stderr: result.stderr || "",
			status: result.status ?? 1,
		};
	} catch (e) {
		return { stdout: "", stderr: String(e), status: 1 };
	}
}

/** Run a command STRING through the shell. Only for verbatim ledger strings. */
export function shell(
	cmd: string,
	opts?: { cwd?: string; timeout?: number },
): RunResult {
	try {
		const result = spawnSync("sh", ["-c", cmd], {
			cwd: opts?.cwd,
			timeout: opts?.timeout ? opts.timeout * 1000 : undefined,
			encoding: "utf-8",
		});
		if (result.status === null) {
			return { stdout: "", stderr: `timed out after ${opts?.timeout}s`, status: 124 };
		}
		return {
			stdout: result.stdout || "",
			stderr: result.stderr || "",
			status: result.status ?? 1,
		};
	} catch (e) {
		return { stdout: "", stderr: String(e), status: 1 };
	}
}

/** `gh <args>`. Returns [value, proc]. */
export function ghJson(
	args: string[],
	opts?: { cwd?: string; timeout?: number },
): [unknown, RunResult] {
	const proc = run(["gh", ...args], opts);
	if (proc.status !== 0) return [null, proc];
	const raw = (proc.stdout || "").trim();
	try {
		return [JSON.parse(raw || "null"), proc];
	} catch {
		return [raw || null, proc];
	}
}

// --------------------------------------------------------------------------- gh refs

/** Accept a PR URL, `owner/repo#123`, `owner/repo 123`, or a bare number. */
export function parsePrRef(
	ref: string,
	cwd?: string,
): [string, string, number] {
	ref = (ref || "").trim();
	const urlMatch = ref.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
	if (urlMatch) return [urlMatch[1], urlMatch[2], Number(urlMatch[3])];

	const slugMatch = ref.match(/^([^/\s]+)\/([^/#\s]+)[#\s](\d+)$/);
	if (slugMatch) return [slugMatch[1], slugMatch[2], Number(slugMatch[3])];

	if (/^\d+$/.test(ref)) {
		const [slug] = ghJson(
			["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
			{ cwd },
		);
		if (typeof slug === "string" && slug.includes("/")) {
			const [owner, , repo] = slug.split("/");
			return [owner, repo, Number(ref)];
		}
		die(USAGE, `cannot resolve owner/repo for PR ${ref}`);
	}
	die(USAGE, `unrecognised PR reference: ${ref} (want a URL, owner/repo#N, or N)`);
}

/** Warn but don't die — for best-effort subcommands. */
export function warnOnly(message: string): void {
	warn(message);
}

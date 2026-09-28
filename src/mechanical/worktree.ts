/**
 * Worktree setup: git worktree create with secret copying.
 *
 * Port of worktree.py. Three failure modes caught early:
 * - missed gitignored .env surfaces as spurious test failures
 * - renamed branch breaks phase 4b's gitnexus key
 * - renamed directory breaks phase 5's push
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { die, loadLedger, printWritten, record, run, warn } from "./shared.ts";

const SECRET_SUFFIXES = [".env", ".key", ".pem", ".p12", ".crt", ".p8"];
const SECRET_PREFIXES = [".env."];

interface InstallEntry {
	lockfile: string;
	cmd: string[];
}

const INSTALLS: InstallEntry[] = [
	{ lockfile: "pnpm-lock.yaml", cmd: ["pnpm", "install", "--frozen-lockfile"] },
	{ lockfile: "yarn.lock", cmd: ["yarn", "install", "--frozen-lockfile"] },
	{ lockfile: "bun.lockb", cmd: ["bun", "install"] },
	{ lockfile: "package-lock.json", cmd: ["npm", "ci"] },
	{ lockfile: "composer.lock", cmd: ["composer", "install", "--no-interaction"] },
	{ lockfile: "go.mod", cmd: ["go", "mod", "download"] },
	{ lockfile: "pubspec.yaml", cmd: ["flutter", "pub", "get"] },
	{ lockfile: "requirements.txt", cmd: ["pip", "install", "-r", "requirements.txt"] },
	{ lockfile: "pyproject.toml", cmd: ["pip", "install", "-e", "."] },
];

export function slugify(title: string, words: number = 5): string {
	const parts = (title || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.trim()
		.split("-")
		.filter(Boolean);
	return parts.join("-").slice(0, 60).replace(/^-+|-+$/g, "") || "issue";
}

export function isSecret(filePath: string): boolean {
	const name = path.basename(filePath);
	return (
		SECRET_SUFFIXES.some((s) => name.endsWith(s)) ||
		SECRET_PREFIXES.some((p) => name.startsWith(p))
	);
}

export function ignoredSecrets(mainCheckout: string): string[] {
	const proc = run(["git", "status", "--porcelain", "--ignored"], { cwd: mainCheckout });
	if (proc.status !== 0) {
		warn("could not list ignored files; copying nothing into the worktree");
		return [];
	}
	const out: string[] = [];
	for (const line of (proc.stdout || "").split("\n")) {
		if (!line.startsWith("!! ")) continue;
		const p = line.slice(3).trim();
		if (p.endsWith("/")) {
			// Walk directory for key material only
			const dirPath = path.join(mainCheckout, p);
			if (fs.existsSync(dirPath)) {
				const walk = (dir: string) => {
					for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
						const full = path.join(dir, entry.name);
						if (entry.isDirectory()) walk(full);
						else if (isSecret(full)) out.push(path.relative(mainCheckout, full));
					}
				};
				walk(dirPath);
			}
		} else if (isSecret(p)) {
			out.push(p);
		}
	}
	return out;
}

export function pickInstall(directory: string): string[] | null {
	for (const { lockfile, cmd } of INSTALLS) {
		if (fs.existsSync(path.join(directory, lockfile))) {
			if (lockfile === "pubspec.yaml") {
				try {
					const content = fs.readFileSync(path.join(directory, lockfile), "utf-8");
					if (!content.includes("flutter:")) return ["dart", "pub", "get"];
				} catch { /* ignore */ }
			}
			return cmd;
		}
	}
	return null;
}

function installDir(repo: string, testRoot?: string): string {
	if (testRoot) {
		let cur = path.dirname(path.join(repo, testRoot.replace(/\/$/, "")));
		while (cur.startsWith(repo) && cur.length > repo.length) {
			if (pickInstall(cur)) return cur;
			cur = path.dirname(cur);
		}
	}
	return repo;
}

export interface WorktreeCreateOpts {
	runDir: string;
	repo?: string;
	base?: string;
	title: string;
}

export function worktreeCreate(opts: WorktreeCreateOpts): Record<string, unknown> {
	const ledger = loadLedger(opts.runDir);
	const mainCheckout = path.resolve(opts.repo || (ledger.context.repo as string) || process.cwd());
	const base = opts.base || (ledger.context.base_branch as string | undefined);
	if (!base) die(2, "no base branch: pass --base, or record base_branch from the approved plan first");

	const issue = ledger.issue;
	const branch = `issue-${issue}-${slugify(opts.title)}`;
	const worktree = path.resolve(path.join(mainCheckout, "..", `wt-issue-${issue}`));

	if (fs.existsSync(worktree)) {
		die(1, `${worktree} already exists — phase 0's resume path owns it; do not re-create`);
	}

	const fetchProc = run(["git", "fetch", "origin", base], { cwd: mainCheckout, timeout: 600 });
	if (fetchProc.status !== 0) {
		die(1, `git fetch origin ${base} failed: ` + (fetchProc.stderr || "").trim().slice(0, 300));
	}

	const wtProc = run(["git", "worktree", "add", worktree, "-b", branch, `origin/${base}`], {
		cwd: mainCheckout,
		timeout: 600,
	});
	if (wtProc.status !== 0) {
		die(1, "git worktree add failed: " + (wtProc.stderr || "").trim().slice(0, 300));
	}

	let copied = 0;
	for (const rel of ignoredSecrets(mainCheckout)) {
		const src = path.join(mainCheckout, rel);
		const dst = path.join(worktree, rel);
		fs.mkdirSync(path.dirname(dst) || worktree, { recursive: true });
		try {
			fs.copyFileSync(src, dst);
			copied++;
		} catch (e) {
			warn(`could not copy ${rel}: ${e}`);
		}
	}

	const where = installDir(worktree, ledger.context.test_root as string | undefined);
	const install = pickInstall(where);
	if (install) {
		const proc = run(install, { cwd: where, timeout: 1800 });
		if (proc.status !== 0) {
			warn(install.join(" ") + " failed: " + (proc.stderr || "").trim().slice(0, 300));
		}
	} else {
		warn("no lockfile found — skipping dependency install");
	}

	// Exclude .docker-agent.yml from the PR
	const excludeProc = run(
		["git", "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
		{ cwd: worktree },
	);
	const excludePath = (excludeProc.stdout || "").trim();
	if (excludePath) {
		fs.mkdirSync(path.dirname(excludePath), { recursive: true });
		let existing = "";
		if (fs.existsSync(excludePath)) {
			existing = fs.readFileSync(excludePath, "utf-8");
		}
		if (!existing.includes(".docker-agent.yml")) {
			fs.appendFileSync(excludePath, "\n.docker-agent.yml\n");
		}
	} else {
		warn("could not locate info/exclude; .docker-agent.yml may reach the PR");
	}

	console.log(
		`copied ${copied} gitignored file(s); install: ${install ? install.join(" ") : "skipped"}`,
	);

	const written = record(opts.runDir, ledger, {
		branch,
		base_branch: base,
		worktree,
	});
	printWritten(written);
	return written;
}

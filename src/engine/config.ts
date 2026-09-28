/**
 * Config loading and overlay resolution.
 *
 * Port of shared.py's config loading. Config is a JSON file with a deep-merge
 * overlay mechanism: config/default.json is the base, and a repo-level
 * .run-issue.json can override any key. Dicts merge, lists replace.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Deep merge: dicts merge recursively, everything else replaces. */
export function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		const existing = result[key];
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			existing !== null &&
			typeof existing === "object" &&
			!Array.isArray(existing)
		) {
			result[key] = deepMerge(
				existing as Record<string, unknown>,
				value as Record<string, unknown>,
			);
		} else {
			result[key] = value;
		}
	}
	return result;
}

/** Load config from the default location. */
export function loadConfig(pluginRoot: string, repoDir?: string): Record<string, unknown> {
	const defaultPath = path.join(pluginRoot, "config", "default.json");
	let config: Record<string, unknown> = {};

	if (fs.existsSync(defaultPath)) {
		config = JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
	}

	// Overlay: repo-level .run-issue.json
	if (repoDir) {
		const overlayPath = path.join(repoDir, ".run-issue.json");
		if (fs.existsSync(overlayPath)) {
			const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf-8"));
			config = deepMerge(config, overlay);
		}
	}

	return config;
}

/** Resolve the bounce cap from config. */
export function bounceCap(config: Record<string, unknown>): number {
	const value = (config.bounce_cap as number) ?? 2;
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 2;
}

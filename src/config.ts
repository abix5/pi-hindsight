/**
 * Configuration for the pi-hindsight extension.
 *
 * All values come from environment variables with safe defaults so the
 * extension works out-of-the-box against a local Hindsight instance.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Budget = "low" | "mid" | "high";

/** How hard recall works: number of bank queries and refine rounds. */
export type RecallEffort = "light" | "normal" | "thorough";

export interface HindsightConfig {
	/** Base URL of the Hindsight HTTP API. */
	baseUrl: string;
	/** API namespace (path segment after /v1). */
	namespace: string;
	/** Memory bank id (one per project by default). */
	bankId: string;
	/** Whether the plugin should run in this cwd (a bank was explicitly declared). */
	active: boolean;
	/** Legacy default model as "provider/id". Used as fallback. */
	modelId?: string;
	/** Fast model for recall query-building / model-pick filtering. */
	recallModelId?: string;
	/** Stronger model for retain/summarize/write pipeline. */
	retainModelId?: string;
	/** Token budget for a single rolling summary. */
	summaryMaxTokens: number;
	/** Token budget for recall responses. */
	recallMaxTokens: number;
	/** Max memory lines injected per turn (keeps context small). */
	recallMaxLines: number;
	/** Recent session context budget for building a bank query. */
	recallContextTokens: number;
	/** Recall operation: raw facts or Hindsight-generated reflection. */
	recallOperation: "recall" | "reflect";
	/** How thorough recall is: controls how many bank queries / refine rounds we spend. */
	recallEffort: RecallEffort;
	/** Hard ceiling on total bank queries per recall (safety bound across all rounds). */
	recallMaxQueries: number;
	/**
	 * Fact-category configurator for the memorize contour. Loose shape:
	 * `{ <key>: "on"|"off"|"ban", custom?: CustomCategory[] }`. Parsed by categories.ts.
	 */
	factCategories?: Record<string, unknown>;
	/** Recall filtering mode: model-selected indexes, or off. */
	recallFilter: "model" | "off";
	/** Recall search budget. */
	recallBudget: Budget;
	/** Feature flags. */
	autoMemorize: boolean;
	autoRecall: boolean;
	/**
	 * Memorize engine:
	 * - "inline": run extract→verify→retain in-process with the small model (self-contained).
	 * - "taskflow": build delta files and ask the agent to launch the memory-fill flow.
	 */
	memorizeEngine: "inline" | "taskflow";
	/** Name of the taskflow flow to launch in "taskflow" engine mode. */
	flowName: string;
	/** Language every stored memory is written in (free-form name/code, e.g. "en", "ru", "russian"). */
	memoryLanguage: string;
	/** Bank extraction lever: what durable knowledge the retain pipeline should keep. Synced to the bank's retain_mission at startup. */
	retainMission: string;
	/** Bank extraction lever: what qualifies as a stable observation. Synced to the bank's observations_mission at startup. */
	observationsMission: string;
	/**
	 * Fraction of the working model's context window used for a single delta chunk's
	 * input. The rest is reserved for the instruction and the model's output.
	 */
	chunkInputFraction: number;
	/** Directory (relative to cwd) for delta chunk files. */
	deltaDir: string;
	/** Path (relative to cwd) of the rolling prior-summary file. */
	priorSummaryPath: string;
	/** Durable JSONL operation log for /mem-log. */
	logPath: string;
	/** Append-only JSONL of dispatched memorize windows (docId → window), for /mem-resave upsert cleanup. */
	dispatchLogPath: string;
	/** Background poll interval (ms) for refreshing widget doc/fact counters. */
	countsRefreshMs: number;
	/** Verbose debug logging (full prompts + HTTP bodies) to .pi/hindsight/debug.log. Off by default (may leak sensitive data). */
	debug: boolean;
}

function envBool(name: string, def: boolean): boolean {
	const v = process.env[name];
	if (v === undefined) return def;
	return /^(1|true|yes|on)$/i.test(v.trim());
}

function envInt(name: string, def: number): number {
	const v = process.env[name];
	if (v === undefined) return def;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : def;
}

function envFloat(name: string, def: number): number {
	const v = process.env[name];
	if (v === undefined) return def;
	const n = Number.parseFloat(v);
	return Number.isFinite(n) ? n : def;
}

/** Coerce an arbitrary value into a RecallEffort, falling back when unknown. */
export function parseEffort(v: unknown, def: RecallEffort): RecallEffort {
	return v === "light" || v === "normal" || v === "thorough" ? v : def;
}

/** Normalize an arbitrary string into a safe bank id slug. */
export function slugify(input: string): string {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "default"
	);
}

/** Derive a default bank id from the working directory (project name). */
function defaultBankId(cwd: string): string {
	const base = cwd.split("/").filter(Boolean).pop() ?? "default";
	return slugify(base);
}

/**
 * Config keys that may be supplied by a global/project override file. Shared by
 * both `readGlobalOverrides` and `readProjectOverrides` so the two layers accept
 * exactly the same set of keys. `active` is derived, never file-supplied.
 */
export const CONFIG_ALLOW = new Set<keyof HindsightConfig>([
	"baseUrl",
	"namespace",
	"bankId",
	"modelId",
	"recallModelId",
	"retainModelId",
	"summaryMaxTokens",
	"recallMaxTokens",
	"recallMaxLines",
	"recallContextTokens",
	"recallOperation",
	"recallEffort",
	"recallMaxQueries",
	"factCategories",
	"recallFilter",
	"recallBudget",
	"autoMemorize",
	"autoRecall",
	"memorizeEngine",
	"flowName",
	"memoryLanguage",
	"retainMission",
	"observationsMission",
	"chunkInputFraction",
	"deltaDir",
	"priorSummaryPath",
	"logPath",
	"dispatchLogPath",
	"countsRefreshMs",
	"debug",
]);

/** Absolute path of the project-local override file (`<cwd>/.pi/hindsight.json`). */
export function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", "hindsight.json");
}

/** Absolute path of the global override file (`~/.pi/agent/hindsight.json`). */
export function globalConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "hindsight.json");
}

/** Read a JSON override file, keeping only allow-listed keys. Never throws. */
function readOverridesFile(file: string): Partial<HindsightConfig> {
	try {
		const obj = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
			string,
			unknown
		>;
		const out: Partial<HindsightConfig> = {};
		for (const [k, v] of Object.entries(obj)) {
			if (CONFIG_ALLOW.has(k as keyof HindsightConfig))
				(out as Record<string, unknown>)[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Optional project-local overrides read from `.pi/hindsight.json` (trusted project).
 * Convenient for hot `/reload`, where shell env changes are not visible to a
 * running pi process. File values win over env defaults and global overrides.
 */
export function readProjectOverrides(cwd: string): Partial<HindsightConfig> {
	return readOverridesFile(projectConfigPath(cwd));
}

/**
 * Optional global overrides read from `~/.pi/agent/hindsight.json`. Apply to
 * every project; project-local values win over them. Pass an explicit path to
 * read a different file (used by the self-test). Never throws.
 */
export function readGlobalOverrides(
	file: string = globalConfigPath(),
): Partial<HindsightConfig> {
	return readOverridesFile(file);
}

export function loadConfig(cwd: string): HindsightConfig {
	const base: HindsightConfig = {
		active: false,
		baseUrl: (
			process.env.HINDSIGHT_BASE_URL ?? "http://localhost:8888"
		).replace(/\/+$/, ""),
		namespace: process.env.HINDSIGHT_NAMESPACE ?? "default",
		bankId: process.env.HINDSIGHT_BANK ?? defaultBankId(cwd),
		modelId: process.env.HINDSIGHT_MODEL || undefined,
		recallModelId: process.env.HINDSIGHT_RECALL_MODEL || undefined,
		retainModelId: process.env.HINDSIGHT_RETAIN_MODEL || undefined,
		summaryMaxTokens: envInt("HINDSIGHT_SUMMARY_MAX_TOKENS", 6000),
		recallMaxTokens: envInt("HINDSIGHT_RECALL_MAX_TOKENS", 2048),
		recallMaxLines: envInt("HINDSIGHT_RECALL_MAX_LINES", 8),
		recallContextTokens: envInt("HINDSIGHT_RECALL_CONTEXT_TOKENS", 5000),
		recallOperation:
			process.env.HINDSIGHT_RECALL_OPERATION === "reflect"
				? "reflect"
				: "recall",
		recallEffort: parseEffort(process.env.HINDSIGHT_RECALL_EFFORT, "normal"),
		recallMaxQueries: envInt("HINDSIGHT_RECALL_MAX_QUERIES", 8),
		recallFilter:
			process.env.HINDSIGHT_RECALL_FILTER === "off" ? "off" : "model",
		recallBudget: (process.env.HINDSIGHT_RECALL_BUDGET as Budget) || "mid",
		autoMemorize: envBool("HINDSIGHT_AUTO_MEMORIZE", true),
		autoRecall: envBool("HINDSIGHT_AUTO_RECALL", true),
		memorizeEngine:
			process.env.HINDSIGHT_MEMORIZE_ENGINE === "taskflow"
				? "taskflow"
				: "inline",
		flowName: process.env.HINDSIGHT_FLOW_NAME ?? "memory-fill",
		memoryLanguage: process.env.HINDSIGHT_MEMORY_LANGUAGE ?? "en",
		retainMission:
			process.env.HINDSIGHT_RETAIN_MISSION ??
			"Focus on durable engineering knowledge that changes future behavior: decisions with their rationale, standing user constraints and preferences, verified procedures and commands, failed approaches with the reason they failed, and concrete project facts (paths, endpoints, config keys, env-var names). Ignore session narration, status updates, plans, greetings, and one-off task chatter.",
		observationsMission:
			process.env.HINDSIGHT_OBSERVATIONS_MISSION ??
			"Observations are stable engineering facts about this project and its owner's working preferences: architecture decisions still in force, standing constraints, recurring workflows, verified tooling know-how, and known dead-ends. Exclude one-off events, session narration, and completed task goals.",
		chunkInputFraction: envFloat("HINDSIGHT_CHUNK_INPUT_FRACTION", 0.5),
		deltaDir: process.env.HINDSIGHT_DELTA_DIR ?? ".pi/hindsight/delta",
		priorSummaryPath:
			process.env.HINDSIGHT_PRIOR_SUMMARY ?? ".pi/hindsight/prior-summary.md",
		logPath: process.env.HINDSIGHT_LOG_PATH ?? ".pi/hindsight/log.jsonl",
		dispatchLogPath:
			process.env.HINDSIGHT_DISPATCH_LOG_PATH ??
			".pi/hindsight/dispatch-log.jsonl",
		countsRefreshMs: envInt("HINDSIGHT_COUNTS_REFRESH_MS", 20000),
		debug: envBool("HINDSIGHT_DEBUG", false),
	};
	const global = readGlobalOverrides();
	const project = readProjectOverrides(cwd);
	return finalizeActivation(
		{ ...base, ...global, ...project },
		base,
		global,
		project,
		cwd,
	);
}

/**
 * Resolve `bankId` + `active` from the merged config plus the raw layers.
 *
 * Activation is gated on an explicitly-declared bank. The declared value is
 * taken project-first, then env `HINDSIGHT_BANK` (treated as project-level),
 * then a global `"auto"` — a concrete bankId coming ONLY from the global layer
 * is deliberately ignored, so one named bank is never shared across projects.
 *
 * - explicit name (not "auto") → `bankId = slugify(name)`, `active = true`
 * - "auto"                     → `bankId = defaultBankId(cwd)`, `active = true`
 * - nothing declared          → `active = false`, `bankId = defaultBankId(cwd)`
 */
function finalizeActivation(
	merged: HindsightConfig,
	_base: HindsightConfig,
	global: Partial<HindsightConfig>,
	project: Partial<HindsightConfig>,
	cwd: string,
): HindsightConfig {
	const projectBank =
		typeof project.bankId === "string" ? project.bankId.trim() : "";
	const envBank = process.env.HINDSIGHT_BANK?.trim() ?? "";
	let declaredBank: string | undefined;
	if (projectBank) declaredBank = projectBank;
	else if (envBank) declaredBank = envBank;
	else if (global.bankId === "auto") declaredBank = "auto";
	else declaredBank = undefined;

	let active: boolean;
	let bankId: string;
	if (declaredBank && declaredBank !== "auto") {
		bankId = slugify(declaredBank);
		active = true;
	} else if (declaredBank === "auto") {
		bankId = defaultBankId(cwd);
		active = true;
	} else {
		bankId = defaultBankId(cwd);
		active = false;
	}
	return { ...merged, bankId, active };
}

/**
 * Merge a partial config into an override file and write it back (pretty).
 * Scope selects the target: "project" (`<cwd>/.pi/hindsight.json`, default) or
 * "global" (`~/.pi/agent/hindsight.json`).
 * Used by /mem-types and /mem-effort to persist runtime changes for next session.
 * Returns true on success. Never throws — a failed write just means the change
 * lives only in the in-memory config until reload.
 */
export function patchConfigFile(
	cwd: string,
	patch: Record<string, unknown>,
	scope: "project" | "global" = "project",
): boolean {
	const file = scope === "global" ? globalConfigPath() : projectConfigPath(cwd);
	try {
		let current: Record<string, unknown> = {};
		try {
			current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
				string,
				unknown
			>;
		} catch {
			/* no file yet — start fresh */
		}
		const next = { ...current, ...patch };
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}

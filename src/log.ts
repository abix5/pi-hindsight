import fs from "node:fs";
import path from "node:path";

const MAX_FIELD = 20_000;
const DEBUG_PATH = ".pi/hindsight/debug.log";

// Debug logging is OFF by default: the debug log captures full prompts, HTTP
// request/response bodies, recalled facts and stored documents, which can leak
// sensitive project data if the file is shared/committed. index.ts turns it on
// only when `debug` is enabled in config. The operation log (appendLog) is
// separate and always on — it powers the dashboard Log tab and the alt+h history UI.
let DEBUG_ENABLED = false;
export function setDebugEnabled(on: boolean): void {
	DEBUG_ENABLED = on;
}

export type HindsightLogEntry = {
	ts: string;
	type: "recall" | "reflect" | "retain" | "error";
	user?: string;
	query?: string;
	operation?: "recall" | "reflect";
	filter?: string;
	found?: number;
	injected?: number;
	skipped?: number;
	injectedText?: string;
	rawHits?: string[];
	reason?: string;
	chunks?: number;
	documents?: number;
	lines?: number;
	documentText?: string;
	stage?: string;
	message?: string;
};

function clip(value: unknown): unknown {
	if (typeof value === "string")
		return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…` : value;
	if (Array.isArray(value)) return value.map(clip);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = clip(v);
		return out;
	}
	return value;
}

export function appendLog(
	cwd: string,
	logPath: string,
	entry: Omit<HindsightLogEntry, "ts">,
): void {
	try {
		const file = path.resolve(cwd, logPath);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(
			file,
			`${JSON.stringify(clip({ ts: new Date().toISOString(), ...entry }))}\n`,
		);
	} catch {
		/* best-effort only */
	}
}

export function appendDebug(
	cwd: string,
	stage: string,
	data: Record<string, unknown> = {},
): void {
	if (!DEBUG_ENABLED) return;
	try {
		const file = path.resolve(cwd, DEBUG_PATH);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(
			file,
			`${JSON.stringify(clip({ ts: new Date().toISOString(), stage, ...data }))}\n`,
		);
	} catch {
		/* best-effort only */
	}
}

export function readLog(
	cwd: string,
	logPath: string,
	limit = 200,
): HindsightLogEntry[] {
	try {
		const file = path.resolve(cwd, logPath);
		const lines = fs
			.readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean);
		return lines
			.slice(-limit)
			.map((l) => JSON.parse(l) as HindsightLogEntry)
			.reverse();
	} catch {
		return [];
	}
}

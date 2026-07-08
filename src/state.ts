/**
 * Persistent state for the memory contours.
 *
 * - watermark: id of the last session entry already memorized. Stored as a
 *   session custom entry (survives reload/branch) via pi.appendEntry.
 * - prior-summary + delta chunks: plain files under the project (cwd), so the
 *   taskflow engine (or the inline engine) can read/write them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const STATE_CUSTOM_TYPE = "hindsight-state";

/**
 * A transcript range whose facts were ALREADY stored to the bank out-of-band
 * (via /mem-remember), bounded by entry ids as (start, end]. When a later
 * memorize pass includes this range in its delta, those entries are wrapped in
 * ALREADY-SAVED markers so the extractor does not emit their facts a second
 * time. Ephemeral: pruned once the watermark advances past `end`.
 */
export interface SavedRange {
	/** Entry id just BEFORE the saved block (exclusive lower bound). */
	start: string;
	/** Last entry id of the saved block (inclusive upper bound). */
	end: string;
}

export interface HindsightState {
	/** Id of the last session entry already flushed to memory. */
	watermark?: string;
	/** Ranges already stored via /mem-remember, excluded from re-extraction. */
	savedRanges?: SavedRange[];
}

/** Restore the latest state from session custom entries. */
export function loadState(entries: SessionEntry[]): HindsightState {
	let state: HindsightState = {};
	for (const e of entries) {
		if (e.type === "custom" && e.customType === STATE_CUSTOM_TYPE) {
			state = { ...state, ...((e.data as HindsightState) ?? {}) };
		}
	}
	return state;
}

/** Persist state as an appended custom entry. */
export function saveState(pi: ExtensionAPI, state: HindsightState): void {
	pi.appendEntry<HindsightState>(STATE_CUSTOM_TYPE, state);
}

function resolve(cwd: string, rel: string): string {
	return path.isAbsolute(rel) ? rel : path.join(cwd, rel);
}

export function readPriorSummary(cwd: string, rel: string): string {
	try {
		return fs.readFileSync(resolve(cwd, rel), "utf8");
	} catch {
		return "";
	}
}

export function writePriorSummary(
	cwd: string,
	rel: string,
	text: string,
): void {
	const abs = resolve(cwd, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, text, "utf8");
}

/**
 * Delete orphaned per-run flow docs (`_doc-<tag>.txt`) older than maxAgeMs.
 *
 * The taskflow write phase deletes its own `_doc-<tag>.txt` after storing, but a
 * crashed or aborted flow leaves its staged report behind. Without a sweep those
 * pile up in the delta dir. This removes orphaned per-run files matching
 * `_doc-*.txt`, `current-*.md`, or `spec-*.md` (never the numbered chunk files)
 * and is best-effort. Returns the count removed.
 */
export function sweepStaleFlowDocs(
	cwd: string,
	rel: string,
	maxAgeMs: number,
): number {
	const dir = resolve(cwd, rel);
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return 0;
	}
	const cutoff = Date.now() - maxAgeMs;
	let removed = 0;
	for (const f of files) {
		if (!/^(_doc-.*\.txt|current-.*\.md|spec-.*\.md)$/.test(f)) continue;
		const p = path.join(dir, f);
		try {
			if (fs.statSync(p).mtimeMs < cutoff) {
				fs.rmSync(p, { force: true });
				removed += 1;
			}
		} catch {
			/* ignore a single unreadable/again-deleted entry */
		}
	}
	return removed;
}

/**
 * Write delta chunks as NNN.md into the delta dir (cleared first).
 * Returns the absolute chunk file paths in order.
 */
export function writeDeltaChunks(
	cwd: string,
	rel: string,
	chunks: string[],
): string[] {
	const dir = resolve(cwd, rel);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const paths: string[] = [];
	chunks.forEach((chunk, i) => {
		const file = path.join(dir, `${String(i + 1).padStart(3, "0")}.md`);
		fs.writeFileSync(file, chunk, "utf8");
		paths.push(file);
	});
	return paths;
}

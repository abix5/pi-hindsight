/**
 * Persistent state for the memory contours.
 *
 * - watermark: id of the last session entry already memorized. Stored as a
 *   session custom entry (survives reload/branch) via pi.appendEntry.
 * - prior-summary + delta chunks: plain files under the project (cwd), so the
 *   inline engine can read/write them.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const STATE_CUSTOM_TYPE = "hindsight-state";

/**
 * Deterministic document id for a memorize window, so re-ingesting the SAME
 * window (session + first + last delta entry id) upserts the existing Hindsight
 * document (bank deletes it and its facts, then re-extracts) instead of creating
 * a duplicate. Prefixed "pi-" and truncated for readability in logs/URLs.
 */
export function computeDocId(
	sessionId: string,
	firstId: string,
	lastId: string,
): string {
	const hash = createHash("sha256")
		.update(`${sessionId}:${firstId}:${lastId}`)
		.digest("hex");
	return `pi-${hash.slice(0, 24)}`;
}

/**
 * A transcript range whose facts were ALREADY stored to the bank out-of-band
 * (via /mem-retain), bounded by entry ids as (start, end]. When a later
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
	/** Ranges already stored via /mem-retain, excluded from re-extraction. */
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

/**
 * Read the append-only dispatch log and return docIds dispatched for `sessionId`
 * (deduped, order preserved). Used by /mem-save all to delete previously stored
 * documents before a full re-collect. Best-effort: a missing/garbled file or a
 * malformed line is skipped, never thrown.
 */
export function readDispatchDocIds(
	cwd: string,
	rel: string,
	sessionId: string,
): string[] {
	let raw: string;
	try {
		raw = fs.readFileSync(resolve(cwd, rel), "utf8");
	} catch {
		return [];
	}
	const seen = new Set<string>();
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const rec = JSON.parse(t) as { docId?: string; sessionId?: string };
			if (rec.sessionId === sessionId && rec.docId) seen.add(rec.docId);
		} catch {
			/* skip a malformed line */
		}
	}
	return [...seen];
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

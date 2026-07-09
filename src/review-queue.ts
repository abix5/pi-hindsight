/**
 * Global review queue — an append-only event log shared by ALL pi sessions.
 *
 * Every stored document is enqueued here; the /mem-review UI folds the log into
 * the current pending set and lets the user approve / edit / delete each one.
 *
 * WHY append-only: multiple pi sessions run in parallel and all write to this
 * one file. A single small `fs.appendFileSync` is O_APPEND and atomic on POSIX,
 * so concurrent appends never interleave a partial line. We therefore NEVER
 * read-modify-write the file during normal operation — state changes are
 * expressed as new "done" events, not edits to prior "add" events.
 *
 * The queue path is fixed at ~/.pi/hindsight/review-queue.jsonl (per-user, spans
 * every project). HINDSIGHT_REVIEW_QUEUE overrides it (used by the self-test).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** An "add" event: a document was stored and now awaits review. */
export interface AddEvent {
	ev: "add";
	docId: string;
	bank: string;
	baseUrl: string;
	namespace: string;
	project: string;
	reason: string;
	ts: string;
}

/** A "done" event: a document left the queue (approved or deleted). */
export interface DoneEvent {
	ev: "done";
	docId: string;
	action: "approved" | "deleted";
	ts: string;
}

/** A pending document = an "add" with no later "done" for the same docId. */
export interface PendingDoc {
	docId: string;
	bank: string;
	baseUrl: string;
	namespace: string;
	project: string;
	reason: string;
	ts: string;
}

/** Fields the caller supplies for an add; ts/ev are filled in here. */
export type AddInput = Omit<AddEvent, "ev" | "ts"> & { ts?: string };

/** Resolve the queue file path (env override → homedir default). */
export function queuePath(): string {
	return (
		process.env.HINDSIGHT_REVIEW_QUEUE ||
		path.join(os.homedir(), ".pi", "hindsight", "review-queue.jsonl")
	);
}

/**
 * Fold a list of raw JSONL lines into the current pending set.
 *
 * Pure and total: malformed lines and unknown event kinds are skipped, so a
 * torn write from a crashing session can never break the fold. The last "add"
 * for a docId wins (re-ingest upserts); a "done" removes it.
 */
export function foldEvents(lines: Iterable<string>): PendingDoc[] {
	const pending = new Map<string, PendingDoc>();
	for (const line of lines) {
		const t = line.trim();
		if (!t) continue;
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(t) as Record<string, unknown>;
		} catch {
			continue; // skip malformed line
		}
		if (!rec || typeof rec.docId !== "string") continue;
		const docId = rec.docId;
		const str = (v: unknown): string => (typeof v === "string" ? v : "");
		if (rec.ev === "add") {
			pending.set(docId, {
				docId,
				bank: str(rec.bank),
				baseUrl: str(rec.baseUrl),
				namespace: str(rec.namespace),
				project: str(rec.project),
				reason: str(rec.reason),
				ts: str(rec.ts),
			});
		} else if (rec.ev === "done") {
			pending.delete(docId);
		}
	}
	return [...pending.values()];
}

/** Read all lines of the queue file (best-effort; missing file → []). */
function readLines(): string[] {
	try {
		return fs.readFileSync(queuePath(), "utf8").split("\n");
	} catch {
		return [];
	}
}

/** Append one event as a single atomic O_APPEND write. */
function appendEvent(rec: AddEvent | DoneEvent): void {
	const file = queuePath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

/** Enqueue a stored document for review (best-effort; never throws). */
export function enqueueAdd(input: AddInput): void {
	try {
		appendEvent({
			ev: "add",
			...input,
			ts: input.ts ?? new Date().toISOString(),
		});
	} catch {
		/* best-effort: losing a review entry must never break the write path */
	}
}

/** Mark a document done (removes it from the pending fold). Never throws. */
export function markDone(docId: string, action: "approved" | "deleted"): void {
	try {
		appendEvent({ ev: "done", docId, action, ts: new Date().toISOString() });
	} catch {
		/* best-effort */
	}
}

/**
 * Compact the log IN PLACE when it has grown large but few docs are pending.
 *
 * Rewrite is write-temp-then-rename INTO THE SAME DIRECTORY so the swap is
 * atomic. A concurrent append between our read and the rename would be lost, so
 * we only compact when the file's mtime is older than 60s — i.e. no session has
 * touched it recently. Best-effort: any failure just leaves the log as-is.
 */
function maybeCompact(pending: PendingDoc[]): void {
	const file = queuePath();
	try {
		const st = fs.statSync(file);
		const ageMs = Date.now() - st.mtimeMs;
		if (st.size <= 1_000_000 || pending.length > 200 || ageMs < 60_000) return;
		const body = pending
			.map((p) => JSON.stringify({ ev: "add", ...p } satisfies AddEvent))
			.join("\n");
		const tmp = path.join(
			path.dirname(file),
			`.review-queue.${process.pid}.${Date.now()}.tmp`,
		);
		fs.writeFileSync(tmp, body ? `${body}\n` : "");
		fs.renameSync(tmp, file);
	} catch {
		/* best-effort: leave the log uncompacted on any error */
	}
}

/** Load the current pending set (folds the log, then opportunistically compacts). */
export function loadPending(): PendingDoc[] {
	const pending = foldEvents(readLines());
	maybeCompact(pending);
	return pending;
}

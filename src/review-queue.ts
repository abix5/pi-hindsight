/**
 * Global review queue — an append-only event log shared by ALL pi sessions.
 *
 * Every stored document is enqueued here; the /mem dashboard Review tab folds the log into
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
import { loadConfig, readProjectOverrides } from "./config.ts";

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
	/**
	 * The language THAT project's bank is kept in, stamped at enqueue time. The
	 * queue is global and cross-project, so the reviewing session cannot infer it
	 * later: re-extracting a hand-edited document under the reviewer's own
	 * `memoryLanguage` silently rewrites a foreign bank in the wrong language.
	 */
	language?: string;
}

/** A "done" event: a document left the queue (approved or deleted). */
export interface DoneEvent {
	ev: "done";
	docId: string;
	action: "approved" | "deleted";
	/**
	 * Who ended the review. Absent = a human pressed a key; "expiry" = the entry
	 * aged out. Deliberately an OPTIONAL extra field rather than a third `action`
	 * value: `action` is an exhaustively-handled union everywhere it is consumed,
	 * and widening it would silently change behaviour at every switch. An unknown
	 * optional field is invisible to `foldEvents` and to every existing reader,
	 * yet still tells a later human which entries nobody actually looked at.
	 */
	by?: "expiry";
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
	/** Language of the ORIGIN project's bank; "" for entries written before 0.4.1. */
	language: string;
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
				language: str(rec.language),
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

/**
 * Enqueue a stored document for review (best-effort; never throws).
 *
 * The origin project's `memoryLanguage` is stamped here when the caller does not
 * supply one: at review time the entry may be read by a session in a DIFFERENT
 * project whose bank is kept in another language.
 */
export function enqueueAdd(input: AddInput): void {
	try {
		appendEvent({
			ev: "add",
			...input,
			language: input.language ?? projectLanguage(input.project),
			ts: input.ts ?? new Date().toISOString(),
		});
	} catch {
		/* best-effort: losing a review entry must never break the write path */
	}
}

/** The bank language declared by a project's own config file ("" when it does not). */
export function projectLanguage(projectDir: string): string {
	try {
		return readProjectOverrides(projectDir).memoryLanguage ?? "";
	} catch {
		return "";
	}
}

/** Mark a document done (removes it from the pending fold). Never throws. */
export function markDone(
	docId: string,
	action: "approved" | "deleted",
	by?: "expiry",
): void {
	try {
		appendEvent({
			ev: "done",
			docId,
			action,
			...(by ? { by } : {}),
			ts: new Date().toISOString(),
		});
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

/**
 * Drop pending entries older than `days`, recording each as a normal "done".
 *
 * WHY this accepts nothing into memory: the queue is bank-first. The document
 * was already written to the bank at enqueue time; "approve" only removes it
 * from the pending set, and "delete" is the sole action that issues a DELETE.
 * So expiring an aged entry changes nothing in the bank — it only stops a queue
 * nobody reviews from growing without bound. (A reader who assumes the opposite
 * would think this silently launders unreviewed data into memory. It cannot.)
 *
 * The window comes from the REVIEWING session's config, while the queue is
 * global: an entry written by another project ages out on this session's
 * setting. That is the same asymmetry every other queue-wide setting has, and
 * the alternative — storing a per-entry deadline — buys nothing, since the
 * outcome is a no-op in the bank either way.
 *
 * An entry whose `ts` cannot be parsed stays pending: we never auto-approve a
 * document we cannot date.
 */
function expireAged(pending: PendingDoc[], days: number): PendingDoc[] {
	if (!(days > 0)) return pending;
	const cutoff = Date.now() - days * 86_400_000;
	const survivors: PendingDoc[] = [];
	for (const p of pending) {
		const t = Date.parse(p.ts);
		if (Number.isNaN(t) || t >= cutoff) {
			survivors.push(p);
			continue;
		}
		markDone(p.docId, "approved", "expiry");
	}
	return survivors;
}

/** Load the current pending set (folds the log, expires stale entries, then opportunistically compacts). */
export function loadPending(
	expireAfterDays: number = loadConfig(process.cwd()).reviewAutoApproveDays,
): PendingDoc[] {
	const pending = expireAged(foldEvents(readLines()), expireAfterDays);
	maybeCompact(pending);
	return pending;
}

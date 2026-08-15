/**
 * Contour A — Memorize (write path).
 *
 * Triggered on compaction, at session shutdown, and by manual /mem-save. Runs
 * OFF the event handler (fire-and-forget) so the main agent never waits.
 * Per-session FIFO queue keeps jobs of one session strictly sequential (each
 * needs the prior watermark).
 *
 * A shutdown flush is deliberately UNBOUNDED — it is the last chance, so it runs
 * to the end of the session instead of stopping at a compaction boundary. That
 * pushes the watermark past where a later compaction's boundary sits, and the
 * next compaction then legitimately finds an empty window; `run` tells that
 * apart from an idle session rather than claiming memory is up to date.
 *
 * Steps: collect delta after watermark → deterministic clean → chunk by model
 * window → write chunk files → move watermark → notify main window → run the
 * extract/merge/verify/retain pipeline (inline engine).
 *
 * Durability rests on the transcript rather than on a copy of the job: a failed
 * write leaves the watermark where it was, so the same delta is re-collected on
 * the next flush from the source of truth.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "./config.ts";
import type { HindsightClient } from "./hindsight.ts";
import { appendDebug, appendLog } from "./log.ts";
import { type ModelChain, resolveChain, runModel } from "./model.ts";
import {
	buildDedupPrompt,
	buildDedupQueriesPrompt,
	buildExtractPrompt,
	buildMergePrompt,
	buildSummarizePrompt,
	buildVerifyPrompt,
	DEDUP_INVALIDATE,
} from "./prompts.ts";
import {
	extractHits,
	normalizeLine,
	parseInvalidations,
	type RecallHit,
} from "./recall-utils.ts";
import { retainContext, retainMetadata } from "./retain-hygiene.ts";
import {
	computeDocId,
	loadState,
	readPriorSummary,
	saveState,
	writeDeltaChunks,
	writePriorSummary,
} from "./state.ts";
import {
	chunkByWindow,
	getDeltaEntries,
	pruneConsumedRanges,
	savedEntryIds,
	serializeDelta,
} from "./transcript.ts";
import { enqueueAdd } from "./review-queue.ts";
import type { HindsightStatus } from "./ui.ts";

/** Session entries as returned by the session manager. */
type Entries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;

/**
 * Chars of transcript that fit ONE model window at our input fraction (~4 chars
 * per token). Shared by the verify pass and the invalidation pass: both must see
 * the WHOLE delta or not run at all.
 */
function windowBudget(chain: ModelChain, cfg: HindsightConfig): number {
	return Math.floor(
		chain.primary.model.contextWindow * cfg.chunkInputFraction * 4,
	);
}

/** Stored facts offered to the invalidation pass in one run. */
const MAX_INVALIDATION_CANDIDATES = 60;

export interface MemorizeDeps {
	pi: ExtensionAPI;
	cfg: HindsightConfig;
	client: HindsightClient;
	status: HindsightStatus;
}

/**
 * Normalize a prose model reply: trim, treat the NONE sentinel as empty, and
 * strip a wrapping markdown code fence if the model added one.
 */
function cleanProse(raw: string): string {
	const t = (raw ?? "").trim();
	if (!t || /^none$/i.test(t)) return "";
	return t
		.replace(/^```[a-z]*\n?/i, "")
		.replace(/\n?```$/, "")
		.trim();
}

/** Count bullet lines in a prose note (for the "saved N" status signal). */
function countBullets(note: string): number {
	const lines = note.split("\n").map((l) => l.trim());
	const bullets = lines.filter((l) => /^[-*\u2022]/.test(l)).length;
	return bullets || lines.filter(Boolean).length;
}

/**
 * Longest a single subject may be before it is cut on a word boundary. One
 * subject owns a whole line now, so the budget is a terminal line minus the
 * `  · ` indent — wide enough that a normal bullet arrives whole instead of
 * being guillotined mid-word.
 */
const SUBJECT_MAX = 68;
/** How many subjects the notice lists before it collapses the rest into "+N more". */
const SUBJECT_COUNT = 5;

/**
 * Reduce one note line to its subject: the opening words, which is where a
 * distilled bullet names what it is about.
 *
 * Everything a terminal must never see is stripped here, because the result
 * lands in `ctx.ui.notify`. The TUI puts it through `theme.fg("dim", …)` into a
 * chat `Text` node whose wrapper splits on `\n` and re-emits the active ANSI per
 * line (verified against pi-tui's `wrapTextWithAnsi`), so newlines are fine —
 * but RPC clients get the message as a raw string, so ANSI and every other
 * control char are not. Newlines belong to the notice's own layout, never to a
 * subject: so ANSI first (the escape AND its payload), then every control char
 * including newlines and tabs, then markdown noise.
 * Returns "" when nothing legible survives — the caller degrades to counts.
 */
function lineSubject(raw: string): string {
	const flat = raw
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI escapes, payload included
		.replace(/[\u0000-\u001f\u007f]+/g, " ") // newlines, tabs, stray ESC
		.replace(/^\s*[-*\u2022]\s*/, "") // bullet marker
		.replace(/^#{1,6}\s*/, "") // heading marker
		.replace(/[`*_]+/g, "") // markdown emphasis / code ticks
		.replace(/\s+/g, " ")
		.trim();
	// A line of punctuation, a bare separator, or a fragment too short to mean
	// anything is not a subject — say so instead of printing garbage.
	if (flat.length < 4 || !/[\p{L}\p{N}]/u.test(flat)) return "";
	if (flat.length <= SUBJECT_MAX) return flat;
	const cut = flat.slice(0, SUBJECT_MAX);
	const space = cut.lastIndexOf(" ");
	const kept = space > SUBJECT_MAX / 2 ? cut.slice(0, space) : cut;
	// Trailing punctuation before an ellipsis reads as a typo.
	return `${kept.replace(/[\s,;:.\u2013\u2014-]+$/, "")}\u2026`;
}

/** Subjects of a note's bullets (or of its plain lines when it has no bullets). */
function noteSubjects(note: string): string[] {
	const lines = note
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const bullets = lines.filter((l) => /^[-*\u2022]/.test(l));
	// No bullets at all: fall back to plain lines, minus the heading labels the
	// extract prompt puts above them ("## Decisions:") — those name a category, not
	// a subject.
	const source = bullets.length
		? bullets
		: lines.filter((l) => !l.startsWith("#") && !/^[^.!?]{1,40}:$/.test(l));
	const out: string[] = [];
	for (const line of source) {
		const subject = lineSubject(line);
		if (subject && !out.includes(subject)) out.push(subject);
	}
	return out;
}

/** ` · N facts retired`, or nothing at all. Shared by both post-write notices. */
function retiredSuffix(invalidated: number): string {
	if (invalidated < 1) return "";
	return ` \u00b7 ${invalidated} fact${invalidated === 1 ? "" : "s"} retired`;
}

/**
 * The post-write notice: WHAT went into the bank, not just how much.
 *
 * A headline of counts, then one line per subject:
 *
 *     saved 1 note · 3 lines · 2 facts retired
 *       · Recall effort is a real ceiling, not a prompt anchor.
 *       · Never commit `.pi/hindsight.json`.
 *
 * Multi-line because the destination is an ordinary chat text node, not a status
 * bar — squeezing the same content onto one line only bought truncation at 34
 * characters and a `(+N more)` that hid most of the write. The note is already
 * distilled prose whose bullets name their own subjects, so this is derived from
 * it with no extra model call. "1 note" is literal: the inline path writes
 * exactly one document, which is what the user is being told about.
 *
 * Still a notice, not a report: at most SUBJECT_COUNT subjects, and only a
 * genuinely long note is allowed to hide a remainder behind "+N more". An
 * unparseable note degrades to the headline alone.
 */
export function writeNotice(note: string, invalidated = 0): string {
	const lines = countBullets(note);
	const head = `saved 1 note \u00b7 ${lines} line${lines === 1 ? "" : "s"}${retiredSuffix(invalidated)}`;
	const subjects = noteSubjects(note);
	if (subjects.length === 0) return head;
	const body = subjects.slice(0, SUBJECT_COUNT).map((s) => `  \u00b7 ${s}`);
	const rest = subjects.length - SUBJECT_COUNT;
	if (rest > 0) body.push(`  \u00b7 +${rest} more`);
	return [head, ...body].join("\n");
}

/**
 * Append one dispatch-log record (docId → memorize window) as a single O_APPEND
 * write. Best-effort: a single small `JSON.stringify(...) + "\n"` write is atomic
 * enough for parallel sessions, so we never read-modify-write the file. /mem-save all
 * reads it back to delete previously stored documents before re-collecting.
 */
function appendDispatchLog(
	cwd: string,
	rel: string,
	rec: {
		docId: string;
		sessionId: string;
		firstId: string;
		lastId: string;
		reason: string;
	},
): void {
	try {
		const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.appendFileSync(
			abs,
			`${JSON.stringify({ ...rec, ts: new Date().toISOString() })}\n`,
		);
	} catch (err) {
		appendDebug(cwd, "memorize.dispatchlog.error", {
			error: (err as Error).message,
		});
	}
}

/**
 * Best-effort enqueue of a stored document into the GLOBAL review queue
 * (~/.pi/hindsight/review-queue.jsonl). Called alongside appendDispatchLog at
 * every store/dispatch point. A single atomic O_APPEND write, so it is safe to
 * call from parallel sessions; failures are swallowed inside enqueueAdd.
 */
function enqueueReview(
	cwd: string,
	cfg: HindsightConfig,
	docId: string,
	reason: string,
): void {
	try {
		enqueueAdd({
			docId,
			bank: cfg.bankId,
			baseUrl: cfg.baseUrl,
			namespace: cfg.namespace,
			project: cwd,
			reason,
		});
	} catch (err) {
		appendDebug(cwd, "memorize.review.enqueue_error", {
			error: (err as Error).message,
		});
	}
}

function scrubMemoryNote(note: string): string {
	const bad =
		/(скопируй|вставь|пришли|жду|как только увижу|тебе нужно|выполни команду|send .*logs|copy .*command|paste .*terminal|run .*and send)/i;
	const kept = note.split("\n").filter((line) => {
		const t = line.trim();
		if (!t) return true;
		if (/^#{1,6}\s/.test(t)) return false;
		if (/^(отлично|понял|жду)[!.]?$/i.test(t)) return false;
		return !bad.test(t);
	});
	return kept
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export class Memorizer {
	private readonly queues = new Map<string, Promise<void>>();
	private pending = 0;

	constructor(private readonly deps: MemorizeDeps) {}

	/**
	 * Retire this Memorizer. Queued memorize jobs are fire-and-forget and left
	 * to settle on their own. Kept as a no-op since index.ts calls it.
	 */
	dispose(): void {}

	/** Waiting jobs = everything pending minus the one currently running. */
	private syncQueue(): void {
		this.deps.status.setQueue(Math.max(0, this.pending - 1));
	}

	/**
	 * Enqueue a memorize job for this session (non-blocking, serialized per session).
	 *
	 * The session entries are SNAPSHOT synchronously here, at schedule time. This
	 * matters for compaction: the `session_before_compact` handler fires, we grab
	 * the pre-compaction entries now, and compaction is then free to replace them
	 * with a summary. The background job processes the snapshot, so the delta is
	 * never lost to a compaction that ran before the job got a turn.
	 */
	schedule(
		ctx: ExtensionContext,
		reason: string,
		opts?: { fromStart?: boolean; boundaryId?: string },
	): Promise<void> {
		const sessionId = ctx.sessionManager.getSessionId() ?? "default";
		const snapshot = ctx.sessionManager.getEntries();
		appendDebug(ctx.cwd ?? process.cwd(), "memorize.schedule", {
			reason,
			fromStart: opts?.fromStart ?? false,
			sessionId,
			entries: snapshot.length,
			pending: this.pending,
		});
		const prev = this.queues.get(sessionId) ?? Promise.resolve();
		this.pending += 1;
		this.syncQueue();
		const next = prev
			.then(() =>
				this.run(
					ctx,
					reason,
					opts?.fromStart ?? false,
					snapshot,
					opts?.boundaryId,
					sessionId,
				),
			)
			.catch((err) => {
				console.error("\uD83E\uDDE0 memorize failed:", (err as Error).message);
				this.deps.status.memoError((err as Error).message);
			})
			.finally(() => {
				this.pending = Math.max(0, this.pending - 1);
				this.syncQueue();
			});
		this.queues.set(sessionId, next);
		return next;
	}

	/**
	 * Notify through the UI, tolerating a torn-down or REPLACED session.
	 *
	 * A memorize job outlives the ctx that scheduled it (it is queued, and the
	 * shutdown write runs while the session is being replaced). Touching a stale
	 * ctx throws "This extension ctx is stale after session replacement or
	 * reload", which would abort an otherwise healthy write, so every access is
	 * guarded.
	 */
	private notify(ctx: ExtensionContext, msg: string): void {
		try {
			ctx.ui?.notify?.(`\uD83E\uDDE0 ${msg}`, "info");
		} catch {
			/* stale ctx after /new or reload — the write itself still matters */
		}
	}

	private async run(
		ctx: ExtensionContext,
		reason: string,
		fromStart = false,
		snapshot?: Entries,
		boundaryId?: string,
		scheduledSessionId?: string,
	): Promise<void> {
		const { pi, cfg } = this.deps;
		const cwd = ctx.cwd ?? process.cwd();
		// Prefer the snapshot taken at schedule time (pre-compaction). Fall back to
		// a live read only if none was provided.
		const entries = snapshot ?? ctx.sessionManager.getEntries();
		// fromStart ignores the watermark: re-collect the whole session (recovery).
		const state = loadState(entries);
		const watermark = fromStart ? undefined : state.watermark;
		// Entries already stored via /mem-retain are wrapped in ALREADY-SAVED markers
		// below so the extractor does not emit their facts again (even on a full
		// re-collect, the facts are already in the bank).
		const savedIds = savedEntryIds(entries, state.savedRanges);

		// boundaryId = compaction's firstKeptEntryId. Memorize ONLY what compaction
		// discards (before it), never the still-live tail. fromStart recovery ignores
		// the boundary and re-collects the whole session.
		const delta = getDeltaEntries(
			entries,
			watermark,
			fromStart ? undefined : boundaryId,
		);
		const deltaText = serializeDelta(delta, savedIds);
		// New watermark = last entry of THIS window (the entry just before the
		// compaction boundary), so the next flush resumes exactly at firstKeptEntryId.
		const windowLastId = delta[delta.length - 1]?.id;
		appendDebug(cwd, "memorize.delta", {
			reason,
			fromStart,
			entries: entries.length,
			watermark,
			boundaryId,
			windowLastId,
			deltaEntries: delta.length,
			deltaChars: deltaText.length,
		});
		// Nothing to write in THIS window — but the two reasons are different and the
		// advice differs with them, so tell them apart. A shutdown/manual flush runs to
		// the very end of the session, which pushes the watermark past where a later
		// compaction's boundary sits (compaction always keeps a live tail). The window
		// then collapses to nothing even though the conversation has moved on. That is
		// not an idle session, and "/mem-save all" is actively wrong advice for it:
		// re-collecting everything would delete and rewrite documents that are fine.
		// A plain /mem-save is the right lever — it passes no boundary, so it takes the
		// whole pending tail immediately instead of waiting for compaction to reach it.
		if (!deltaText.trim()) {
			const pending = boundaryId
				? getDeltaEntries(entries, watermark, undefined).length
				: 0;
			const blocked = pending > 0;
			const plural = pending === 1 ? "y" : "ies";
			this.deps.status.memoBlocked();
			appendDebug(cwd, "memorize.delta.empty", {
				reason,
				cause: blocked ? "watermark_past_boundary" : "no_new_entries",
				pending,
			});
			appendLog(cwd, cfg.logPath, {
				type: "retain",
				reason: blocked
					? `${reason}: watermark past boundary, ${pending} entries pending`
					: `${reason}: no delta`,
				documents: 0,
				lines: 0,
			});
			this.notify(
				ctx,
				blocked
					? `already saved through the live tail — ${pending} newer entr${plural} still waiting for compaction to reach them (nothing is lost; /mem-save writes them now)`
					: "nothing new since last flush — memory is up to date (use /mem-save all to re-collect the whole session)",
			);
			return;
		}

		// Deterministic document id for THIS window (session + first/last delta entry
		// id). Re-ingesting the same window upserts the existing Hindsight document
		// (bank deletes it and its facts, then re-extracts) instead of duplicating.
		// Use the id captured at schedule time: by now the session may have been
		// replaced (/new, reload), and re-reading it off the old ctx throws.
		const sessionId =
			scheduledSessionId ?? ctx.sessionManager.getSessionId() ?? "default";
		const firstId = delta[0]?.id ?? "";
		const docId = computeDocId(sessionId, firstId, windowLastId ?? "");
		appendDebug(cwd, "memorize.docid", {
			reason,
			sessionId,
			firstId,
			lastId: windowLastId,
			docId,
		});

		const chain = resolveChain(ctx, cfg);
		if (!chain) {
			this.deps.status.memoError("model unavailable");
			appendLog(cwd, cfg.logPath, {
				type: "error",
				stage: `${reason}: resolve model`,
				message: "model unavailable",
			});
			this.notify(ctx, "model unavailable — skipping memory write");
			return;
		}

		const chunks = chunkByWindow(
			deltaText,
			chain.primary.model.contextWindow,
			cfg.chunkInputFraction,
		);
		appendDebug(cwd, "memorize.chunks", {
			reason,
			model: chain.label,
			contextWindow: chain.primary.model.contextWindow,
			chunks: chunks.length,
			chunkChars: chunks.map((c) => c.length),
		});
		this.deps.status.memoCollecting(chunks.length, reason);
		writeDeltaChunks(cwd, cfg.deltaDir, chunks);

		// Show in the MAIN window that we launched memory collection. No 🧠 here:
		// notify() prepends one to every message, and this call site used to add a
		// second, rendering "🧠 🧠 memory collection started".
		this.notify(
			ctx,
			`memory collection started (${reason}): ${chunks.length} chunk(s)`,
		);

		const lastId = windowLastId;

		// Inline engine: advance the watermark ONLY after the run finishes without
		// error. On a real failure (e.g. bank write threw) we keep the watermark so
		// the same delta is retried on the next flush instead of being lost.
		try {
			appendDebug(cwd, "memorize.inline.start", {
				reason,
				chunks: chunks.length,
			});
			await this.runInline(ctx, chain, chunks, deltaText, docId, sessionId);
			if (lastId) {
				const saved = saveState(pi, {
					watermark: lastId,
					savedRanges: pruneConsumedRanges(entries, state.savedRanges, lastId),
				});
				// Record the stored window so /mem-save all can delete this doc before a
				// full re-collect (best-effort, single O_APPEND write).
				appendDispatchLog(cwd, cfg.dispatchLogPath, {
					docId,
					sessionId,
					firstId,
					lastId,
					reason,
				});
				// Also enqueue the stored document into the GLOBAL review queue.
				enqueueReview(cwd, cfg, docId, reason);
				if (!saved)
					appendDebug(cwd, "memorize.watermark.stale", { reason, lastId });
			}
			appendDebug(cwd, "memorize.watermark.saved", { reason, lastId });
		} catch (err) {
			appendDebug(cwd, "memorize.inline.error", {
				reason,
				error: (err as Error).message,
			});
			this.deps.status.memoError((err as Error).message);
			appendLog(cwd, cfg.logPath, {
				type: "error",
				stage: `${reason}: inline write`,
				message: (err as Error).message,
			});
			this.notify(
				ctx,
				`memory write error: ${(err as Error).message} — delta kept, will retry on next flush`,
			);
		}
	}

	/**
	 * Inline engine: distil → merge → verify → retain → update prior-summary.
	 *
	 * The model only ever produces PROSE. The API call is made here, in code:
	 * the merged note is POSTed to the bank as one document and Hindsight extracts
	 * the individual facts. No JSON contract, no fragile parsing.
	 */
	private async runInline(
		ctx: ExtensionContext,
		chain: ModelChain,
		chunks: string[],
		deltaText: string,
		docId: string,
		sessionId: string,
	): Promise<"done" | "blocked"> {
		const { cfg } = this.deps;
		const cwd = ctx.cwd ?? process.cwd();

		// map: distil each chunk into a short prose note
		this.deps.status.memoExtracting();
		appendDebug(cwd, "memorize.extract.start", { chunks: chunks.length });
		const notes: string[] = [];
		for (const [i, chunk] of chunks.entries()) {
			const out = cleanProse(
				await runModel(ctx, chain, buildExtractPrompt(cfg), chunk, {
					maxTokens: 1536,
				}),
			);
			appendDebug(cwd, "memorize.extract.chunk", {
				index: i,
				inputChars: chunk.length,
				outputChars: out.length,
				empty: !out,
			});
			if (out) notes.push(out);
		}
		appendDebug(cwd, "memorize.extract.done", { notes: notes.length });
		if (notes.length === 0) {
			this.deps.status.memoBlocked();
			appendLog(cwd, cfg.logPath, {
				type: "retain",
				reason: "inline: extractor found no reusable facts",
				chunks: chunks.length,
				documents: 0,
				lines: 0,
			});
			this.notify(ctx, "memory skipped: extractor found no reusable facts");
			return "blocked";
		}

		const prior = readPriorSummary(cwd, cfg.priorSummaryPath);
		appendDebug(cwd, "memorize.prior", {
			path: cfg.priorSummaryPath,
			chars: prior.length,
		});

		// reduce: merge notes + drop already-known → one note.
		// Skip entirely when there is a single note and no prior (nothing to merge).
		let note = notes.join("\n\n");
		if (notes.length > 1 || prior) {
			try {
				appendDebug(cwd, "memorize.merge.start", {
					notes: notes.length,
					priorChars: prior.length,
				});
				const merged = cleanProse(
					await runModel(
						ctx,
						chain,
						buildMergePrompt(cfg),
						`PRIOR SUMMARY:\n${prior || "(empty)"}\n\nNOTES:\n${note}`,
						{ maxTokens: 2048 },
					),
				);
				// MERGE returns NONE when everything is already known → nothing to store.
				appendDebug(cwd, "memorize.merge.done", { outputChars: merged.length });
				note = merged;
			} catch (err) {
				appendDebug(cwd, "memorize.merge.error", {
					error: (err as Error).message,
				});
				/* keep the joined notes */
			}
		}
		if (!note.trim()) {
			this.deps.status.memoBlocked();
			appendLog(cwd, cfg.logPath, {
				type: "retain",
				reason: "inline: merge found no new facts",
				chunks: chunks.length,
				documents: 0,
				lines: 0,
			});
			this.notify(ctx, "memory skipped: no new reusable facts after merge");
			return "blocked";
		}

		// verify: only when the delta fits one window (else trust distil+merge).
		// Never zero-out on a flaky reply — keep the note if verify returns empty.
		const verifyBudget = windowBudget(chain, cfg);
		if (deltaText.length <= verifyBudget) {
			try {
				appendDebug(cwd, "memorize.verify.start", {
					deltaChars: deltaText.length,
					verifyBudget,
					noteChars: note.length,
				});
				const verified = cleanProse(
					await runModel(
						ctx,
						chain,
						buildVerifyPrompt(cfg),
						`TRANSCRIPT:\n${deltaText}\n\nNOTE:\n${note}`,
						{ maxTokens: 2048 },
					),
				);
				appendDebug(cwd, "memorize.verify.done", {
					outputChars: verified.length,
				});
				if (verified) note = verified;
			} catch (err) {
				appendDebug(cwd, "memorize.verify.error", {
					error: (err as Error).message,
				});
				/* keep the note */
			}
		} else {
			appendDebug(cwd, "memorize.verify.skip", {
				deltaChars: deltaText.length,
				verifyBudget,
			});
		}

		note = scrubMemoryNote(note);
		appendDebug(cwd, "memorize.scrub.done", { noteChars: note.length });
		if (!note.trim()) {
			this.deps.status.memoBlocked();
			appendLog(cwd, cfg.logPath, {
				type: "retain",
				reason: "inline: scrub removed assistant chatter",
				chunks: chunks.length,
				documents: 0,
				lines: 0,
			});
			this.notify(
				ctx,
				"memory skipped: note was assistant chatter, not reusable memory",
			);
			return "blocked";
		}

		// Cross-document dedup against the bank. This is the ONE thing document_id
		// cannot provide: the deterministic id only stops the SAME window from
		// duplicating on re-ingest; it does NOTHING for the same fact recurring
		// across different windows/sessions. So we recall what the bank already
		// knows on this note's topic and drop bullets already stored anywhere.
		// This recall is a plain HTTP call (client.recall) — it creates NO
		// conversation turn, so the pipeline stays invisible / off-conversation.
		// Declared out here because the dedup block can return early ("blocked") and
		// a kill that already happened must still reach the user.
		let invalidated = 0;
		try {
			const noteCharsBefore = note.length;
			appendDebug(cwd, "memorize.dedup.start", { noteCharsBefore });
			// A SINGLE recall of the whole note misses already-stored facts on the
			// note's other topics (the reranker only returns top-N for one query), so
			// their duplicates slip through. But one recall PER bullet is wasteful
			// (dozens of HTTP calls). Instead, let the small model CLUSTER the note by
			// meaning and emit a few well-formed queries (2-5) — few requests, wide
			// coverage. This query-build is an isolated completion (no conversation
			// turn), and so are the recalls, so the whole step stays off-dialogue.
			let queries: string[] = [note];
			try {
				const raw = await runModel(
					ctx,
					chain,
					buildDedupQueriesPrompt(cfg),
					`NOTE:\n${note}`,
					{ maxTokens: 320 },
				);
				const parsed: unknown = JSON.parse(raw.trim());
				if (Array.isArray(parsed)) {
					const grouped = parsed
						.filter(
							(q): q is string => typeof q === "string" && q.trim().length > 0,
						)
						.slice(0, 5);
					// Whole-note catch-all first, then the grouped topical queries.
					if (grouped.length) queries = [note, ...grouped];
				}
			} catch (err) {
				// Query-builder flaked (bad JSON / model error): fall back to the single
				// whole-note recall rather than skipping dedup entirely.
				appendDebug(cwd, "memorize.dedup.querybuild_error", {
					error: (err as Error).message,
				});
			}
			const seen = new Set<string>();
			const facts: RecallHit[] = [];
			// Cap the union so the dedup prompt stays bounded regardless of note size.
			const maxFacts = 120;
			for (const q of queries) {
				if (facts.length >= maxFacts) break;
				let recall: unknown;
				try {
					recall = await this.deps.client.recall(
						q,
						{ maxTokens: 800, budget: "mid", preferObservations: true },
						ctx.signal,
					);
				} catch (err) {
					appendDebug(cwd, "memorize.dedup.query_error", {
						error: (err as Error).message,
					});
					continue;
				}
				for (const hit of extractHits(recall)) {
					const key = normalizeLine(hit.text);
					if (!key || seen.has(key)) continue;
					seen.add(key);
					facts.push(hit);
					if (facts.length >= maxFacts) break;
				}
			}
			// The SAME recalled facts feed the third verdict. Run it before the prose
			// dedup: a note that turns out fully duplicate returns early below, and
			// that is exactly the run where the bank is most likely holding orphans.
			invalidated = await this.invalidateOrphans(ctx, chain, facts, deltaText);
			// A kill is rare and newsworthy, and the notice that reports it scrolls
			// away. Put it on the always-on widget too, from the ONE place that knows
			// the count — the blocked path below returns before the write finishes.
			this.deps.status.memoRetired(invalidated);
			if (facts.length === 0) {
				// Bank knows nothing on this topic → nothing to dedup against. Keep the
				// note unchanged (do NOT spend a model call).
				appendDebug(cwd, "memorize.dedup.skip_empty", {});
			} else {
				const existing = facts.map((f) => `- ${f.text}`).join("\n");
				const deduped = cleanProse(
					await runModel(
						ctx,
						chain,
						buildDedupPrompt(cfg),
						`EXISTING MEMORY:\n${existing}\n\nNOTE:\n${note}`,
						{ maxTokens: 2048 },
					),
				);
				appendDebug(cwd, "memorize.dedup.done", {
					queries: queries.length,
					existingFacts: facts.length,
					noteCharsBefore,
					noteCharsAfter: deduped.length,
				});
				if (!deduped.trim()) {
					// The whole note is already known — nothing new to store.
					this.deps.status.memoBlocked();
					appendLog(cwd, cfg.logPath, {
						type: "retain",
						reason: "inline: dedup found nothing new",
						chunks: chunks.length,
						documents: 0,
						lines: 0,
					});
					this.notify(
						ctx,
						`memory skipped: everything already in the bank${retiredSuffix(invalidated)}`,
					);
					return "blocked";
				}
				note = deduped;
			}
		} catch (err) {
			// Never lose data because dedup flaked: keep the pre-dedup note.
			appendDebug(cwd, "memorize.dedup.error", {
				error: (err as Error).message,
			});
		}

		// The CODE makes the API call: store the prose as ONE document.
		// Hindsight extracts the individual facts from it.
		this.deps.status.memoWriting();
		appendDebug(cwd, "memorize.retain.start", {
			bankId: cfg.bankId,
			noteChars: note.length,
		});
		// async:true — the server queues the extraction; we do not wait for the bank
		// to finish processing. The widget counters refresh in the background later.
		const provenance = {
			project: path.basename(cwd),
			language: cfg.memoryLanguage,
			session: sessionId,
		};
		await this.deps.client.retain(note, {
			tags: [cfg.bankId, "agent-summary"],
			// Stable id → re-ingesting the same window upserts instead of duplicating.
			documentId: docId,
			// Both go into the server's extraction prompt; see retain-hygiene.ts for
			// what each word there is buying.
			context: retainContext("session-note", provenance),
			metadata: retainMetadata("session-note", provenance),
			async: true,
		});
		appendDebug(cwd, "memorize.retain.done", {
			bankId: cfg.bankId,
			async: true,
		});

		// update rolling prior-summary (prose)
		try {
			appendDebug(cwd, "memorize.summary.start", { noteChars: note.length });
			const summary = cleanProse(
				await runModel(
					ctx,
					chain,
					buildSummarizePrompt(cfg),
					`PREVIOUS:\n${prior || "(empty)"}\n\nNEW NOTE:\n${note}`,
					{ maxTokens: cfg.summaryMaxTokens },
				),
			);
			appendDebug(cwd, "memorize.summary.done", {
				outputChars: summary.length,
			});
			if (summary) writePriorSummary(cwd, cfg.priorSummaryPath, summary);
		} catch (err) {
			appendDebug(cwd, "memorize.summary.error", {
				error: (err as Error).message,
			});
			/* non-fatal: prior-summary just stays as-is */
		}

		const lines = countBullets(note);
		const documents = 1;
		this.deps.status.memoDone(documents, lines);
		appendLog(cwd, cfg.logPath, {
			type: "retain",
			reason: "inline",
			chunks: chunks.length,
			documents,
			lines,
			documentText: note,
		});
		this.notify(ctx, writeNotice(note, invalidated));
		// Refresh the bank counters shown in the widget (best-effort).
		try {
			const s = await this.deps.client.stats(ctx.signal);
			appendDebug(cwd, "memorize.stats.done", { ...s });
			this.deps.status.bankOk();
			this.deps.status.setBankCounts(s.documents, s.facts);
		} catch (err) {
			appendDebug(cwd, "memorize.stats.error", {
				error: (err as Error).message,
			});
			/* counts are best-effort */
		}
		return "done";
	}

	/**
	 * The DEDUP step's third verdict, carried out: retire bank facts this delta
	 * proves are ORPHANS.
	 *
	 * Only orphans — a duplicate, or a fact about code that was deleted and will
	 * never get a successor fact. A "was/now" pair is left alone: storing the new
	 * fact is enough, and the bank's own consolidation reconciles the two.
	 *
	 * Every failure here is swallowed. Invalidation is housekeeping on top of the
	 * write; a bank that refuses a PATCH, a model that returns junk, or an
	 * unverifiable quote must all end with the memory still stored.
	 *
	 * Returns how many facts were actually retired, so the post-write notification
	 * can say so — the user has no other window onto a kill.
	 */
	private async invalidateOrphans(
		ctx: ExtensionContext,
		chain: ModelChain,
		facts: RecallHit[],
		deltaText: string,
	): Promise<number> {
		const { cfg } = this.deps;
		const cwd = ctx.cwd ?? process.cwd();
		if (!cfg.factInvalidation) return 0;
		// Observations are derived and regenerate from their sources, so the server
		// refuses to curate them (400). Offering one as a candidate would only waste
		// a kill on a fact that comes straight back.
		const candidates: Array<{ id: string; text: string }> = [];
		for (const f of facts) {
			if (!f.id || f.type === "observation") continue;
			candidates.push({ id: f.id, text: f.text });
			if (candidates.length >= MAX_INVALIDATION_CANDIDATES) break;
		}
		if (candidates.length === 0) return 0;
		// The verdict is only as good as the evidence, and the evidence must be
		// QUOTED from this transcript. A delta too big for one window would arrive
		// truncated, and a quote from the missing half is unverifiable — so skip the
		// pass entirely rather than judge on a fragment of a fragment.
		const budget = windowBudget(chain, cfg);
		if (deltaText.length > budget) {
			appendDebug(cwd, "memorize.invalidate.skip_oversize", {
				deltaChars: deltaText.length,
				budget,
			});
			return 0;
		}
		let raw: string;
		try {
			const listed = candidates
				.map((c) => `- id=${c.id} :: ${c.text}`)
				.join("\n");
			raw = await runModel(
				ctx,
				chain,
				DEDUP_INVALIDATE,
				`TRANSCRIPT:\n${deltaText}\n\nSTORED FACTS:\n${listed}`,
				{ maxTokens: 512 },
			);
		} catch (err) {
			appendDebug(cwd, "memorize.invalidate.model_error", {
				error: (err as Error).message,
			});
			return 0;
		}
		const kills = parseInvalidations(raw, {
			allowedIds: candidates.map((c) => c.id),
			transcript: deltaText,
		});
		appendDebug(cwd, "memorize.invalidate.verdict", {
			candidates: candidates.length,
			output: raw,
			kills: kills.length,
		});
		let retired = 0;
		// What was killed, for the local log. A kill is the one memory action that
		// destroys knowledge, and the server-side `invalidation_reason` is the only
		// other record of it — which this package gives no view onto. Without the
		// text here, "2 facts retired" tells a user something vanished but never what,
		// so a wrong kill could neither be noticed nor reconstructed.
		const byId = new Map(candidates.map((c) => [c.id, c.text]));
		const killed: Array<{ id: string; quote: string; text: string }> = [];
		for (const kill of kills) {
			try {
				// The quote IS the reason: the server stores it as invalidation_reason,
				// so every kill stays auditable next to the fact it retired.
				await this.deps.client.invalidate(kill.id, kill.quote, ctx.signal);
				retired += 1;
				killed.push({
					id: kill.id,
					quote: kill.quote,
					text: byId.get(kill.id) ?? "",
				});
				appendDebug(cwd, "memorize.invalidate.done", { id: kill.id });
			} catch (err) {
				appendDebug(cwd, "memorize.invalidate.error", {
					id: kill.id,
					error: (err as Error).message,
				});
			}
		}
		if (killed.length > 0)
			appendLog(cwd, cfg.logPath, { type: "invalidate", kills: killed });
		return retired;
	}
}

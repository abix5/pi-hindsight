/**
 * Contour A — Memorize (write path).
 *
 * Triggered on compaction and manual /mem-save ONLY (never shutdown or
 * reload). Runs OFF the event handler (fire-and-forget) so the main agent never
 * waits. Per-session FIFO queue keeps jobs of one session strictly sequential
 * (each needs the prior watermark).
 *
 * Steps: collect delta after watermark → deterministic clean → chunk by model
 * window → write chunk files → move watermark → notify main window → run the
 * extract/merge/verify/retain pipeline (inline engine).
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
import { type ResolvedModel, resolveModel, runModel } from "./model.ts";
import {
	buildDedupPrompt,
	buildDedupQueriesPrompt,
	buildExtractPrompt,
	buildMergePrompt,
	buildSummarizePrompt,
	buildVerifyPrompt,
} from "./prompts.ts";
import { extractHits, normalizeLine } from "./recall-utils.ts";
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

	private notify(ctx: ExtensionContext, msg: string): void {
		ctx.ui?.notify?.(`\uD83E\uDDE0 ${msg}`, "info");
	}

	private async run(
		ctx: ExtensionContext,
		reason: string,
		fromStart = false,
		snapshot?: Entries,
		boundaryId?: string,
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
		// Nothing new since the last flush. Make it VISIBLE (a manual flush that
		// silently does nothing looks broken) and tell the user how to force a
		// full re-collect. Use /mem-save all to ignore the watermark.
		if (!deltaText.trim()) {
			this.deps.status.memoBlocked();
			appendLog(cwd, cfg.logPath, {
				type: "retain",
				reason: `${reason}: no delta`,
				documents: 0,
				lines: 0,
			});
			this.notify(
				ctx,
				"nothing new since last flush — memory is up to date (use /mem-save all to re-collect the whole session)",
			);
			return;
		}

		// Deterministic document id for THIS window (session + first/last delta entry
		// id). Re-ingesting the same window upserts the existing Hindsight document
		// (bank deletes it and its facts, then re-extracts) instead of duplicating.
		const sessionId = ctx.sessionManager.getSessionId() ?? "default";
		const firstId = delta[0]?.id ?? "";
		const docId = computeDocId(sessionId, firstId, windowLastId ?? "");
		appendDebug(cwd, "memorize.docid", {
			reason,
			sessionId,
			firstId,
			lastId: windowLastId,
			docId,
		});

		const resolved = resolveModel(ctx, cfg);
		if (!resolved) {
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
			resolved.model.contextWindow,
			cfg.chunkInputFraction,
		);
		appendDebug(cwd, "memorize.chunks", {
			reason,
			model: resolved.label,
			contextWindow: resolved.model.contextWindow,
			chunks: chunks.length,
			chunkChars: chunks.map((c) => c.length),
		});
		this.deps.status.memoCollecting(chunks.length, reason);
		writeDeltaChunks(cwd, cfg.deltaDir, chunks);

		// Show in the MAIN window that we launched memory collection.
		this.notify(
			ctx,
			`🧠 memory collection started (${reason}): ${chunks.length} chunk(s)`,
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
			await this.runInline(ctx, resolved, chunks, deltaText, docId);
			if (lastId) {
				saveState(pi, {
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
		resolved: ResolvedModel,
		chunks: string[],
		deltaText: string,
		docId: string,
	): Promise<"done" | "blocked"> {
		const { cfg } = this.deps;
		const cwd = ctx.cwd ?? process.cwd();

		// map: distil each chunk into a short prose note
		this.deps.status.memoExtracting();
		appendDebug(cwd, "memorize.extract.start", { chunks: chunks.length });
		const notes: string[] = [];
		for (const [i, chunk] of chunks.entries()) {
			const out = cleanProse(
				await runModel(ctx, resolved, buildExtractPrompt(cfg), chunk, {
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
						resolved,
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
		const verifyBudget = Math.floor(
			resolved.model.contextWindow * cfg.chunkInputFraction * 4,
		);
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
						resolved,
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
					resolved,
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
			const facts: string[] = [];
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
					facts.push(hit.text);
					if (facts.length >= maxFacts) break;
				}
			}
			if (facts.length === 0) {
				// Bank knows nothing on this topic → nothing to dedup against. Keep the
				// note unchanged (do NOT spend a model call).
				appendDebug(cwd, "memorize.dedup.skip_empty", {});
			} else {
				const existing = facts.map((f) => `- ${f}`).join("\n");
				const deduped = cleanProse(
					await runModel(
						ctx,
						resolved,
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
					this.notify(ctx, "memory skipped: everything already in the bank");
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
		await this.deps.client.retain(note, {
			tags: [cfg.bankId, "agent-summary"],
			// Stable id → re-ingesting the same window upserts instead of duplicating.
			documentId: docId,
			// `context` is injected directly into Hindsight's fact-extraction prompt and
			// shapes HOW facts are pulled from this document — the API docs call it one of
			// the highest-leverage quality levers. Describe what the report actually is.
			context: `Curated long-term engineering notes from a pair-programming session between a software engineer and their AI coding agent on one software project. Every line is already-distilled durable knowledge, so treat each as an established fact about this project, not chit-chat or momentary state. Categories: architectural and design decisions with rationale; standing user constraints and preferences; verified know-how (commands, procedures, fixes that worked); pitfalls (approaches tried that failed, and why); and concrete facts and locations (file paths, endpoints, config keys, ports, env-var names). Record where secrets live, never their values. The note is written in ${cfg.memoryLanguage}.`,
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
					resolved,
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
		this.notify(ctx, `wrote ${documents} document · ${lines} note lines`);
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
}

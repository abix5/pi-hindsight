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
 * extract/merge/verify/retain pipeline (inline engine) OR ask the agent to
 * launch the taskflow flow (taskflow engine).
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
import { extractionSections } from "./categories.ts";
import {
	buildExtractPrompt,
	buildMergePrompt,
	buildSummarizePrompt,
	buildVerifyPrompt,
} from "./prompts.ts";
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
 * enough for parallel sessions, so we never read-modify-write the file. /mem-resave
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
	// Active flow-watch poll timers, tracked so dispose() (called on /reload) can
	// stop them before a replacement Memorizer takes over the widget.
	private readonly watchers = new Set<ReturnType<typeof setInterval>>();

	constructor(private readonly deps: MemorizeDeps) {}

	/**
	 * Retire this Memorizer: stop every in-flight flow watcher so its polling
	 * timers stop updating a widget that a /reload has already replaced. Queued
	 * memorize jobs are fire-and-forget and left to settle on their own.
	 */
	dispose(): void {
		for (const t of this.watchers) clearInterval(t);
		this.watchers.clear();
	}

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
		opts?: { fromStart?: boolean; boundaryId?: string; forceInline?: boolean },
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
					opts?.forceInline ?? false,
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
		// forceInline bypasses the taskflow engine and runs the in-process pipeline,
		// awaited by the caller. Used at session shutdown, where taskflow cannot run
		// (it needs a future agent turn that will never happen once we are exiting).
		forceInline = false,
	): Promise<void> {
		const { pi, cfg } = this.deps;
		const cwd = ctx.cwd ?? process.cwd();
		// Prefer the snapshot taken at schedule time (pre-compaction). Fall back to
		// a live read only if none was provided.
		const entries = snapshot ?? ctx.sessionManager.getEntries();
		// fromStart ignores the watermark: re-collect the whole session (recovery).
		const state = loadState(entries);
		const watermark = fromStart ? undefined : state.watermark;
		// Entries already stored via /mem-remember are wrapped in ALREADY-SAVED markers
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
		// full re-collect. Use /mem-resave to ignore the watermark.
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
				"nothing new since last flush — memory is up to date (use /mem-resave to re-collect the whole session)",
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

		// taskflow engine: the whole delta is injected into the flow as CONTEXT.
		// We write ONE per-run input file (current-<tag>.md), advance the watermark,
		// and ask the agent to run the flow. No chunking, no model resolution here.
		if (cfg.memorizeEngine === "taskflow" && !forceInline) {
			const lastId = windowLastId;
			// Unique tag correlates OUR run inside taskflow's run records AND names the
			// per-run input file, so two dispatches (e.g. a manual flush racing a
			// compact) can never share or overwrite one another's delta.
			const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const deltaRel = `current-${tag}.md`;
			const deltaFile = path.resolve(cwd, cfg.deltaDir, deltaRel);
			try {
				fs.mkdirSync(path.dirname(deltaFile), { recursive: true });
				fs.writeFileSync(deltaFile, deltaText);
			} catch (err) {
				// If we cannot persist the delta, the flow would run against a missing
				// file and the window would be lost while the watermark advanced. Treat
				// it as terminal: surface the error, KEEP the watermark, do NOT dispatch.
				appendDebug(cwd, "memorize.taskflow.write_error", {
					error: (err as Error).message,
				});
				this.deps.status.memoError("could not write delta file");
				return;
			}
			// Category spec for the flow's build phase: which headings to extract and
			// which to exclude, from the user's /mem-types config. Best-effort — if it
			// cannot be written the flow just falls back to general extraction.
			const specRel = `spec-${tag}.md`;
			try {
				const { headings, bans } = extractionSections(cfg);
				const specText = `${
					"EXTRACTION CATEGORIES \u2014 obey exactly.\n\n" +
					"ENABLED headings (use ONLY these; each becomes a '## <heading>' section; skip one with nothing):\n\n"
				}${
					headings ||
					"(none configured \u2014 extract general durable project knowledge)"
				}${
					bans
						? `\n\nEXCLUDED headings \u2014 NEVER extract anything whose only home is one of these: ${bans}.\n`
						: "\n"
				}`;
				fs.writeFileSync(path.resolve(cwd, cfg.deltaDir, specRel), specText);
			} catch (err) {
				appendDebug(cwd, "memorize.taskflow.spec_error", {
					error: (err as Error).message,
				});
			}
			// Delta is durably on disk, so advance the watermark on dispatch, and drop
			// any saved ranges this window has now consumed.
			if (lastId) {
				saveState(pi, {
					watermark: lastId,
					savedRanges: pruneConsumedRanges(entries, state.savedRanges, lastId),
				});
				// Record the dispatched window so /mem-resave can delete this doc before
				// a full re-collect (best-effort, single O_APPEND write).
				appendDispatchLog(cwd, cfg.dispatchLogPath, {
					docId,
					sessionId,
					firstId,
					lastId,
					reason,
				});
				// Enqueue into the GLOBAL review queue at dispatch time. The flow may
				// still store nothing (build → NONE); the review UI auto-drops queue
				// entries whose bank GET returns 404, so an empty doc is harmless.
				enqueueReview(cwd, cfg, docId, reason);
			}
			const dispatchedAt = Date.now();
			// Stage 0: flow handed off. Shows "flow queued…" for the brief moment
			// before the triggered turn creates the run record; watchFlowRun then
			// advances it to "building doc…" as soon as the run appears.
			this.deps.status.memoProgress({ reason, doc: "queued" });
			appendDebug(cwd, "memorize.taskflow.dispatch", {
				reason,
				flowName: cfg.flowName,
				lastId,
				tag,
				deltaChars: deltaText.length,
			});
			appendLog(cwd, cfg.logPath, {
				type: "retain",
				reason: `${reason}: taskflow dispatched`,
				documents: 0,
				lines: 0,
			});
			// Run the flow VISIBLY (no detach) so its progress shows in the chat.
			// triggerTurn:true STARTS the turn now (via _runAgentPrompt), so the flow
			// actually executes on its own. We must NOT use deliverAs:"nextTurn": that
			// only pushes the message onto the pending-next-turn queue and triggers no
			// turn, so the flow never runs and the widget sticks on "flow queued…".
			// This call returns void (does not await the turn), so the fire-and-forget
			// memorize job never blocks compaction.
			pi.sendMessage(
				{
					customType: "mem-write",
					content:
						`Store project memory now: use the taskflow tool to run flow \`${cfg.flowName}\` ` +
						`with args.bank="${cfg.bankId}", args.tag="${tag}", args.baseUrl="${cfg.baseUrl}", ` +
						`args.namespace="${cfg.namespace}", args.docId="${docId}", args.lang="${cfg.memoryLanguage}". The session delta is already prepared as context ` +
						`in ${cfg.deltaDir}/${deltaRel}. Run it now and report the stored result. ` +
						`Do not edit any source files.`,
					display: true,
				},
				{ triggerTurn: true },
			);
			// Advance the widget through the pipeline by reading taskflow's OWN run
			// records (runtime-written, not model-written), matched by our tag.
			this.watchFlowRun(cwd, reason, tag, dispatchedAt);
			return;
		}

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
			engine: cfg.memorizeEngine,
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
				// Record the stored window so /mem-resave can delete this doc before a
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
	 * Drive the widget's second line from taskflow's OWN run records, which the
	 * runtime writes deterministically (NOT any model). We locate our run by the
	 * unique args.tag we passed at dispatch (fallback: newest run created at/after
	 * dispatch) and translate its phase statuses/outputs into check-marked stages:
	 *   build running               → building doc…
	 *   build done, output NONE      → doc ✗ (nothing durable)
	 *   build done, stage+dedup run  → doc ✓ · dedup…
	 *   dedup done, output NONE      → doc ✓ · dedup ✓ · nothing new (all known)
	 *   dedup done, has content      → doc ✓ · dedup -N · sending… (store script)
	 *   store done                   → doc ✓ · dedup -N · bank ✓ · +1  (or bank ✗)
	 *   run failed / timed out       → doc ✓/✗ (flow failed / timed out)
	 * The bank write is done by the flow's `store` script phase, not in code.
	 * REMOVED:<n> is parsed from the dedup phase output for the -N count.
	 * The poll is unref'd, bounded, tracked for disposal, and stops on the first
	 * terminal state.
	 */
	private watchFlowRun(
		cwd: string,
		reason: string,
		tag: string,
		dispatchedAt: number,
	): void {
		type PhaseRec = { status?: string; output?: string };
		type RunRec = {
			status?: string;
			createdAt?: number;
			args?: { tag?: string };
			phases?: Record<string, PhaseRec>;
		};
		const runsDir = path.resolve(
			cwd,
			".pi/taskflows/runs",
			this.deps.cfg.flowName,
		);
		const status = this.deps.status;
		let ticks = 0;
		const maxTicks = 150; // ~5 min at 2s
		let sentBuilding = false;
		let sentCleaning = false;
		let sentSending = false;

		const readRun = (p: string): RunRec | undefined => {
			try {
				return JSON.parse(fs.readFileSync(p, "utf8")) as RunRec;
			} catch {
				return undefined;
			}
		};
		// Prefer the run whose args.tag matches ours; otherwise the newest run created
		// at/after dispatch (tolerant fallback if the tag did not round-trip).
		const findRun = (): RunRec | undefined => {
			let files: string[];
			try {
				files = fs.readdirSync(runsDir).filter((f) => f.endsWith(".json"));
			} catch {
				return undefined;
			}
			let fallback: RunRec | undefined;
			for (const f of files) {
				const rec = readRun(path.join(runsDir, f));
				if (!rec) continue;
				if (rec.args?.tag === tag) return rec;
				const createdAt = rec.createdAt ?? 0;
				if (
					createdAt >= dispatchedAt - 1000 &&
					createdAt > (fallback?.createdAt ?? 0)
				)
					fallback = rec;
			}
			return fallback;
		};
		const isNone = (s?: string): boolean => {
			const t = (s ?? "").trim();
			return t === "" || t.toUpperCase() === "NONE";
		};
		// The dedup phase ends its report with a machine-readable `REMOVED: <n>` line.
		const parseRemoved = (out?: string): number => {
			const m = /REMOVED:\s*(\d+)/i.exec(out ?? "");
			return m ? Number(m[1]) : 0;
		};
		// Per-run scratch files: the report doc the flow edits, and the delta input
		// we wrote for it. On any TERMINAL state we delete BOTH here (deterministic)
		// so a crashed flow can never orphan them; the 24h sweep is only a backstop.
		// (On timeout we deliberately do NOT delete — the flow may still be reading.)
		const docFile = path.resolve(
			cwd,
			this.deps.cfg.deltaDir,
			`_doc-${tag}.txt`,
		);
		const deltaFile = path.resolve(
			cwd,
			this.deps.cfg.deltaDir,
			`current-${tag}.md`,
		);
		const specFile = path.resolve(
			cwd,
			this.deps.cfg.deltaDir,
			`spec-${tag}.md`,
		);
		const finish = () => {
			for (const f of [docFile, deltaFile, specFile]) {
				try {
					fs.rmSync(f, { force: true });
				} catch {
					/* best-effort cleanup */
				}
			}
			clearInterval(timer);
			this.watchers.delete(timer);
		};

		const timer = setInterval(() => {
			ticks += 1;
			const rec = findRun();
			if (rec) {
				const build = rec.phases?.build;
				const dedup = rec.phases?.dedup;
				const store = rec.phases?.store;
				const removed = parseRemoved(dedup?.output);

				// Build produced nothing durable → no document formed. (terminal)
				if (build?.status === "done" && isNone(build.output)) {
					status.memoProgress({
						reason,
						doc: "none",
						note: "nothing durable to store",
					});
					finish();
					return;
				}
				// store (script) finished. Its output is the bank HTTP response, or a
				// 'skipped: ...' line when dedup left nothing new. (terminal)
				if (store?.status === "done") {
					const out = store.output ?? "";
					if (/skipped/i.test(out)) {
						status.memoProgress({
							reason,
							doc: "ok",
							clean: "ok",
							bank: "skip",
						});
					} else {
						const ok = /"success"\s*:\s*true/.test(out);
						status.memoProgress({
							reason,
							doc: "ok",
							clean: "ok",
							removed,
							bank: ok ? "ok" : "fail",
							note: ok ? undefined : "bank did not confirm",
						});
					}
					finish();
					return;
				}
				// Dedup found everything already stored → nothing new; store will skip.
				// Show it now without waiting for the (no-op) store phase. (terminal)
				if (dedup?.status === "done" && isNone(dedup.output)) {
					status.memoProgress({ reason, doc: "ok", clean: "ok", bank: "skip" });
					finish();
					return;
				}
				// Whole run failed. (terminal)
				if (rec.status === "failed") {
					const builtOk = build?.status === "done" && !isNone(build.output);
					status.memoProgress(
						builtOk
							? { reason, doc: "ok", note: "flow failed" }
							: { reason, doc: "none", note: "flow failed" },
					);
					finish();
					return;
				}
				// Progress transitions, each fired once:
				if (dedup?.status === "done") {
					// Reconciled against the bank → store (script) is posting the doc.
					if (!sentSending) {
						sentSending = true;
						status.memoProgress({
							reason,
							doc: "ok",
							clean: "ok",
							removed,
							bank: "sending",
						});
					}
				} else if (build?.status === "done") {
					// Build done; stage(recall) + dedup reconciling against the bank.
					if (!sentCleaning) {
						sentCleaning = true;
						status.memoProgress({ reason, doc: "ok", clean: "running" });
					}
				} else if (!sentBuilding) {
					// Run exists and the build is actually in progress now.
					sentBuilding = true;
					status.memoProgress({ reason, doc: "pending" });
				}
			}
			if (ticks >= maxTicks) {
				// Give up watching (the flow may still be running) but never leave the
				// widget stuck on an in-progress label. Leave the scratch files for the
				// 24h sweep since the flow could still be reading them.
				status.memoProgress({
					reason,
					doc: "ok",
					note: "flow watch timed out - check /tf runs",
				});
				clearInterval(timer);
				this.watchers.delete(timer);
			}
		}, 2000);
		timer.unref?.();
		this.watchers.add(timer);
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

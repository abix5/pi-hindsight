/** Recall flow: gate+query → Hindsight recall/reflect → inject small, deduped context. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig, RecallEffort } from "./config.ts";
import type { HindsightClient } from "./hindsight.ts";
import { appendDebug } from "./log.ts";
import { type ModelChain, runModel } from "./model.ts";
import { DEEP_SYNTHESIS, QUERY_BUILDER, RECALL_JUDGE } from "./prompts.ts";
import type { Boundary } from "./reminder.ts";
import {
	detectTaskChange,
	digestAssistant,
	newTaskState,
	recordTurn,
	type TaskState,
} from "./task-detector.ts";
import {
	extractHits,
	heuristicQueries,
	normalizeLine,
	parseJudge,
	parseQueryPlan,
	type QueryPlan,
	recentContext,
	seenInjectedFacts,
	type RecallHit,
} from "./recall-utils.ts";

/** Facts shown to the judge for ONE query (the bank can return dozens). */
const JUDGE_CANDIDATES = 24;
/** A query scoring below this contributed nothing usable and is dropped whole. */
const MIN_USEFUL_SCORE = 25;

/** Map the recall-effort setting to a query budget (hard ceiling: 5 queries). */
function effortPlan(effort: RecallEffort): { queries: number } {
	if (effort === "light") return { queries: 2 };
	if (effort === "thorough") return { queries: 5 };
	return { queries: 3 };
}

/** One bank recall call → raw hits. */
async function bankHits(
	client: HindsightClient,
	query: string,
	cfg: HindsightConfig,
	signal?: AbortSignal,
): Promise<RecallHit[]> {
	const res = await client.recall(
		query,
		{ maxTokens: cfg.recallMaxTokens, budget: cfg.recallBudget },
		signal,
	);
	return extractHits(res);
}

export interface RecallInjectResult {
	found: number;
	injected: number;
	skippedSeen: number;
	skippedFiltered: number;
	text: string;
	query: string;
	operation: "recall" | "reflect";
	queried: boolean;
	reason: string;
	rawHits: string[];
	/** True when `text` is the deep pass's synthesized briefing, not a bullet list. */
	synthesized?: boolean;
	/**
	 * Normalized keys of the facts this call actually injected. The caller carries
	 * them into the next turn's `priorSeen`, which is the ONLY way a synthesized
	 * (prose) block's facts can be deduped — they leave no bullets in the
	 * transcript for `seenInjectedFacts` to read back.
	 */
	injectedKeys: string[];
}

/**
 * The deep pass, run only at a task boundary: wider recall driven by the task
 * detector's query, then ONE synthesis call over the facts the judge kept.
 *
 * Deliberately NOT `POST /reflect`: measured on four banks it takes 28-59s and
 * the curve is flat in bank size (a 10-fact bank answers in 28s) because it is
 * an LLM-bound agent loop. Our own recall + one cheap completion is seconds.
 */
export interface DeepPass {
	/** Bank query from the detector's verdict; empty for the deterministic triggers. */
	query?: string;
	/** Short task title, for the debug log. */
	title?: string;
}

function emptyRecall(): RecallInjectResult {
	return {
		found: 0,
		injected: 0,
		skippedSeen: 0,
		skippedFiltered: 0,
		text: "",
		query: "",
		operation: "recall",
		queried: false,
		reason: "not queried",
		rawHits: [],
		injectedKeys: [],
	};
}

/**
 * Tolerantly turn a recall API response into readable lines of memory text.
 * Hindsight can return several near-identical facts for one query, so we
 * dedupe by normalized text (order-preserving) — otherwise the recall tool
 * floods the agent with repeated lines. Server-side max_tokens already bounds
 * the overall size, so no line cap is applied here.
 */
export function formatRecallHits(res: unknown): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const h of extractHits(res)) {
		const key = normalizeLine(h.text);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		lines.push(`- ${h.text}`);
	}
	return lines.join("\n");
}

/** One query's independent recall: bank hits + the model's verdict on them. */
interface QueryOutcome {
	query: string;
	found: number;
	score: number;
	hits: RecallHit[];
}

/**
 * Run ONE query end to end: hit the bank, then have the model judge THAT query's
 * results on their own.
 *
 * Judging per query (rather than once over the merged pool) is what keeps a
 * precise query's facts from being diluted by a vague query's noise, and lets a
 * query that returned only junk be discarded wholesale via score 0.
 */
async function runOneQuery(
	ctx: ExtensionContext,
	cfg: HindsightConfig,
	client: HindsightClient,
	chain: ModelChain,
	prompt: string,
	query: string,
	judge: boolean,
	signal?: AbortSignal,
): Promise<QueryOutcome> {
	const cwd = ctx.cwd ?? process.cwd();
	let hits: RecallHit[];
	try {
		hits = await bankHits(client, query, cfg, signal);
	} catch (err) {
		appendDebug(cwd, "recall.bank.error", {
			query,
			error: (err as Error).message,
		});
		return { query, found: 0, score: 0, hits: [] };
	}
	const found = hits.length;
	// Bound what the judge sees: the bank can return dozens of near-duplicates.
	const candidates = dedupeHits(hits).slice(0, JUDGE_CANDIDATES);
	if (!judge || candidates.length === 0)
		return {
			query,
			found,
			score: candidates.length ? 50 : 0,
			hits: candidates,
		};

	const numbered = candidates.map((h, i) => `${i + 1}. ${h.text}`).join("\n");
	let raw: string;
	try {
		raw = await runModel(
			ctx,
			chain,
			RECALL_JUDGE,
			`TASK:\n${prompt}\n\nQUERY:\n${query}\n\nFACTS:\n${numbered}`,
			{ maxTokens: 160, signal },
		);
	} catch (err) {
		if (signal?.aborted) throw err;
		appendDebug(cwd, "recall.judge.error", {
			query,
			error: (err as Error).message,
		});
		// No judge available: keep the hits unscored rather than lose the query.
		return { query, found, score: 50, hits: candidates };
	}
	const verdict = parseJudge(raw, candidates.length);
	appendDebug(cwd, "recall.judge", {
		query,
		found,
		candidates: candidates.length,
		output: raw,
		score: verdict.score,
		kept: verdict.keep.size,
		valid: verdict.valid,
	});
	// Unparseable verdict is a formatting failure, not a rejection: keep the hits
	// (ranked below judged ones) instead of silently dropping the whole query.
	if (!verdict.valid) return { query, found, score: 40, hits: candidates };
	return {
		query,
		found,
		score: verdict.score,
		hits: candidates.filter((_, i) => verdict.keep.has(i + 1)),
	};
}

/** Order-preserving dedupe of hits by normalized text. */
function dedupeHits(hits: RecallHit[]): RecallHit[] {
	const seen = new Set<string>();
	const out: RecallHit[] = [];
	for (const h of hits) {
		const key = normalizeLine(h.text);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(h);
	}
	return out;
}

export async function runRecall(
	ctx: ExtensionContext,
	cfg: HindsightConfig,
	client: HindsightClient,
	chain: ModelChain,
	prompt: string,
	signal?: AbortSignal,
	deep?: DeepPass,
	/**
	 * Facts injected earlier in this session that the transcript cannot show —
	 * a deep pass injects prose, so its facts have no bullets to read back.
	 */
	priorSeen?: Iterable<string>,
): Promise<RecallInjectResult> {
	const cwd = ctx.cwd ?? process.cwd();
	const eff = deep
		? { queries: Math.max(1, cfg.deepRecallQueries) }
		: effortPlan(cfg.recallEffort);
	appendDebug(cwd, "recall.gate.start", {
		promptChars: prompt.length,
		model: chain.label,
		effort: cfg.recallEffort,
		maxQueries: eff.queries,
		filter: cfg.recallFilter,
		deep: deep?.query,
	});
	// The query builder is what makes recall work: it rewrites the user's message
	// into standalone bank queries. When EVERY model in the chain is down we must
	// still search rather than skip memory entirely — degrade to keyword queries
	// distilled from the prompt instead of shipping the raw message.
	let plan: QueryPlan;
	let degraded = false;
	try {
		const gateRaw = await runModel(
			ctx,
			chain,
			QUERY_BUILDER,
			`LATEST USER REQUEST:\n${prompt}\n\nRECENT CONTEXT:\n${recentContext(ctx, cfg.recallContextTokens)}`,
			{ maxTokens: 320, signal },
		);
		appendDebug(cwd, "recall.gate.raw", { output: gateRaw });
		plan = parseQueryPlan(gateRaw);
	} catch (err) {
		if (signal?.aborted) throw err;
		appendDebug(cwd, "recall.gate.error", {
			error: (err as Error).message,
			chain: chain.label,
		});
		plan = { shouldQuery: false, op: "recall", queries: [], reason: "" };
		degraded = true;
	}
	// Non-JSON from a weak model is the same failure mode as a dead provider:
	// keep searching, just with keyword queries.
	if (
		!plan.shouldQuery &&
		(degraded || !plan.reason || plan.reason.startsWith("query-builder"))
	) {
		const queries = heuristicQueries(prompt, eff.queries);
		if (queries.length > 0) {
			plan = {
				shouldQuery: true,
				op: "recall",
				queries,
				reason: degraded
					? "query-builder unavailable — keyword fallback"
					: "query-builder returned non-JSON — keyword fallback",
			};
			degraded = true;
		}
	}
	// The detector already named the subject, so the deep pass always queries —
	// even when the builder gated out or every model was down. Its query goes
	// FIRST so it survives the per-query cap.
	if (deep) {
		const queries = [
			...new Set([deep.query ?? "", ...plan.queries].map((q) => q.trim())),
		].filter(Boolean);
		plan = {
			shouldQuery: queries.length > 0,
			op: "recall",
			queries,
			reason: plan.reason,
		};
	}
	appendDebug(cwd, "recall.gate.plan", { ...plan, degraded });
	if (!plan.shouldQuery)
		return {
			...emptyRecall(),
			reason: plan.reason || "not enough standalone context to query bank",
		};

	const queryLabel = plan.queries.join(" | ");
	const seen = seenInjectedFacts(ctx);
	for (const key of priorSeen ?? []) seen.add(key);
	// The effort setting is the REAL ceiling, enforced here rather than announced to
	// the model: naming a number in the prompt made it a target (8 of 12 real turns
	// hit the stated maximum exactly). recallMaxQueries stays as the absolute safety
	// bound on top, so neither setting can be escaped by a chatty query builder.
	const cap = deep
		? Math.max(1, Math.min(cfg.deepRecallQueries, cfg.recallMaxQueries))
		: Math.max(1, Math.min(eff.queries, cfg.recallMaxQueries));
	const maxLines = deep
		? Math.max(1, cfg.deepRecallMaxLines)
		: cfg.recallMaxLines;

	// Each query is an independent recall: its own bank call and its own verdict,
	// all in flight at once. Merging only afterwards is what lets a junk query be
	// dropped whole instead of polluting one shared pool.
	const queries = plan.queries.slice(0, cap);
	const judge = cfg.recallFilter === "model" && !degraded;
	appendDebug(cwd, "recall.queries", { queries, judge });
	const outcomes = await Promise.all(
		queries.map((q) =>
			runOneQuery(ctx, cfg, client, chain, prompt, q, judge, signal),
		),
	);

	const totalFound = outcomes.reduce((n, o) => n + o.found, 0);
	// Best-scoring queries contribute their facts first, so when the line budget
	// runs out it is the weakest query that loses its tail.
	const ranked = [...outcomes].sort((a, b) => b.score - a.score);
	const local = new Set<string>();
	const merged: RecallHit[] = [];
	let skippedSeen = 0;
	for (const outcome of ranked) {
		if (outcome.score < MIN_USEFUL_SCORE) continue; // judged worthless
		for (const hit of outcome.hits) {
			const key = normalizeLine(hit.text);
			if (!key || local.has(key)) continue;
			if (seen.has(key)) {
				skippedSeen += 1;
				continue;
			}
			local.add(key);
			merged.push(hit);
		}
	}
	appendDebug(cwd, "recall.merged", {
		totalFound,
		scores: outcomes.map((o) => ({ query: o.query, score: o.score })),
		merged: merged.length,
		skippedSeen,
	});

	const finalHits = merged.slice(0, maxLines);
	if (finalHits.length === 0) {
		let reason = "recalled facts judged irrelevant";
		if (totalFound === 0) reason = "bank returned no facts";
		else if (skippedSeen > 0) reason = "all facts already injected";
		return {
			...emptyRecall(),
			found: totalFound,
			skippedSeen,
			query: queryLabel,
			operation: plan.op,
			queried: true,
			reason,
		};
	}
	const bullets = finalHits.map((h) => `- ${h.text}`).join("\n");
	const text = deep
		? await synthesize(ctx, chain, prompt, bullets, signal)
		: bullets;
	return {
		found: totalFound,
		injected: finalHits.length,
		skippedSeen,
		skippedFiltered: merged.length - finalHits.length,
		text: text || bullets,
		query: queryLabel,
		operation: plan.op,
		queried: true,
		reason: degraded ? `${plan.reason} (degraded)` : "bank recalled facts",
		rawHits: merged.map((h) => h.text),
		synthesized: Boolean(deep && text && text !== bullets),
		injectedKeys: finalHits.map((h) => normalizeLine(h.text)).filter(Boolean),
	};
}

/**
 * One cheap completion that turns the kept facts into a coherent briefing.
 * Returns "" when it cannot help, so the caller falls back to the bullet list —
 * a boundary turn must degrade to today's behaviour, never to nothing.
 */
async function synthesize(
	ctx: ExtensionContext,
	chain: ModelChain,
	prompt: string,
	bullets: string,
	signal?: AbortSignal,
): Promise<string> {
	const cwd = ctx.cwd ?? process.cwd();
	try {
		const raw = await runModel(
			ctx,
			chain,
			DEEP_SYNTHESIS,
			`TASK:\n${prompt}\n\nFACTS:\n${bullets}`,
			{ maxTokens: 600, signal },
		);
		const text = raw.trim();
		appendDebug(cwd, "recall.synthesis", { chars: text.length });
		if (!text || /^NONE\b/i.test(text)) return "";
		return text;
	} catch (err) {
		if (signal?.aborted) throw err;
		appendDebug(cwd, "recall.synthesis.error", {
			error: (err as Error).message,
		});
		return "";
	}
}

/** What one turn's recall produced, plus what kind of turn it was. */
export interface TurnRecall {
	recall: RecallInjectResult;
	boundary: Boundary;
}

/**
 * One turn's recall, ordinary or deep.
 *
 * The vendor benchmarked injecting scattered facts on every turn and measured
 * the agent getting WORSE (1.06 corrections/task vs 0.97 with no memory at
 * all). So the bullet spray stays only for ordinary turns; at a TASK BOUNDARY
 * we pay once for a wider recall and a synthesized briefing instead.
 *
 * Exactly three triggers: the detector said the task changed, the first turn
 * of a session, the first turn after a compaction.
 *
 * The detector runs CONCURRENTLY with the ordinary recall, never in front of
 * it: an ordinary turn must cost exactly what it costs today, and on a
 * boundary the ordinary result is the price of not lengthening the hot path —
 * and, when the deep pass fails, the fallback that keeps the turn from
 * injecting nothing at all.
 *
 * `run`/`detect` are injectable for the self-test only; production always uses
 * the real ones.
 */
export async function recallForTurn(args: {
	ctx: ExtensionContext;
	cfg: HindsightConfig;
	client: HindsightClient;
	chain: ModelChain;
	prompt: string;
	signal?: AbortSignal;
	task: TaskState;
	run?: typeof runRecall;
	detect?: typeof detectTaskChange;
}): Promise<TurnRecall> {
	const { ctx, cfg, client, chain, prompt, signal, task } = args;
	const run = args.run ?? runRecall;
	const detect = args.detect ?? detectTaskChange;
	const cwd = ctx.cwd ?? process.cwd();
	const entries = ctx.sessionManager.getEntries() as Array<{
		id?: string;
		type?: string;
	}>;
	const sessionId = ctx.sessionManager.getSessionId?.();
	const compactions = entries.filter((e) => e.type === "compaction").length;
	if (task.sessionId !== sessionId) {
		// Reset IN PLACE: the caller holds this object for the whole session.
		Object.assign(task, newTaskState());
		task.sessionId = sessionId;
		task.compactions = compactions;
	}
	const firstTurn = !task.started;
	// A compaction rewrites what the agent can see, so whatever memory was
	// injected before it is gone: treat the next turn as a fresh boundary, and
	// drop the carried-forward seen-set with it.
	const afterCompact = compactions > task.compactions;
	if (afterCompact) task.seenFacts.clear();
	const boundary: Boundary = firstTurn || afterCompact ? "session" : "none";
	task.compactions = compactions;
	task.started = true;
	recordTurn(task, digestAssistant(entries, task.markerId), prompt, cfg);
	// Everything appended from here on is THIS turn's answer.
	task.markerId = entries[entries.length - 1]?.id;

	const remember = (out: TurnRecall): TurnRecall => {
		for (const key of out.recall.injectedKeys) task.seenFacts.add(key);
		return out;
	};

	if (!cfg.taskDetect)
		return remember({
			recall: await run(
				ctx,
				cfg,
				client,
				chain,
				prompt,
				signal,
				undefined,
				task.seenFacts,
			),
			boundary,
		});
	if (firstTurn || afterCompact) {
		const deep: DeepPass = { title: task.title };
		return remember({
			recall: await run(
				ctx,
				cfg,
				client,
				chain,
				prompt,
				signal,
				deep,
				task.seenFacts,
			),
			boundary,
		});
	}
	const ordinary = run(
		ctx,
		cfg,
		client,
		chain,
		prompt,
		signal,
		undefined,
		task.seenFacts,
	).catch((err) => {
		// Swallowed here so a discarded parallel run cannot reject unhandled;
		// rethrown below only if we actually need its result.
		return err as Error;
	});
	const verdict = await detect(ctx, cfg, chain, task, sessionId, signal);
	if (verdict.changed) {
		try {
			return remember({
				recall: await run(
					ctx,
					cfg,
					client,
					chain,
					prompt,
					signal,
					{ query: verdict.query, title: verdict.title },
					task.seenFacts,
				),
				boundary: "task" as Boundary,
			});
		} catch (err) {
			// The deep pass is the one most likely to hit the recall ceiling, and a
			// boundary is where memory is worth most — so degrade to the ordinary
			// result we already paid for rather than to nothing. It only rethrows
			// when that one failed too (an aborted turn takes both down).
			appendDebug(cwd, "recall.deep.error", {
				error: (err as Error).message,
			});
			const fallback = await ordinary;
			if (fallback instanceof Error) throw err;
			return remember({ recall: fallback, boundary: "task" as Boundary });
		}
	}
	const result = await ordinary;
	if (result instanceof Error) throw result;
	return remember({ recall: result, boundary });
}

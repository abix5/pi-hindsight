/** Recall flow: gate+query → Hindsight recall/reflect → inject small, deduped context. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig, RecallEffort } from "./config.ts";
import type { HindsightClient } from "./hindsight.ts";
import { appendDebug } from "./log.ts";
import { type ResolvedModel, runModel } from "./model.ts";
import { QUERY_BUILDER, QUERY_REFINE, RECALL_PICK } from "./prompts.ts";
import {
	directAnswer,
	extractHits,
	normalizeLine,
	parseQueryPlan,
	parseIndexList,
	parseRefine,
	recentContext,
	seenInjectedFacts,
	type RecallHit,
} from "./recall-utils.ts";

/** Map the recall-effort setting to a query/round budget. */
function effortPlan(effort: RecallEffort): { queries: number; rounds: number } {
	if (effort === "light") return { queries: 1, rounds: 1 };
	if (effort === "thorough") return { queries: 4, rounds: 3 };
	return { queries: 3, rounds: 1 };
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

async function modelPick(
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	prompt: string,
	hits: RecallHit[],
	signal?: AbortSignal,
): Promise<RecallHit[]> {
	const numbered = hits.map((h, i) => `${i + 1}. ${h.text}`).join("\n");
	const raw = await runModel(
		ctx,
		resolved,
		RECALL_PICK,
		`TASK:\n${prompt}\n\nFACTS:\n${numbered}`,
		{ maxTokens: 128, signal },
	);
	// Distinguish a legitimate empty selection ("[]" = nothing relevant, honored)
	// from a formatting failure (cheap model emitted prose). On a failure, do NOT
	// silently drop every fact - keep all candidates (already capped upstream).
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.trim());
	} catch {
		parsed = undefined;
	}
	if (!Array.isArray(parsed)) {
		appendDebug(ctx.cwd ?? process.cwd(), "recall.pick.invalid", {
			model: resolved.label,
			hits: hits.length,
			output: raw,
		});
		return hits;
	}
	const picked = parseIndexList(raw, hits.length);
	appendDebug(ctx.cwd ?? process.cwd(), "recall.pick.raw", {
		model: resolved.label,
		hits: hits.length,
		output: raw,
		picked: [...picked],
	});
	return hits.filter((_, i) => picked.has(i + 1));
}

export async function runRecall(
	ctx: ExtensionContext,
	cfg: HindsightConfig,
	client: HindsightClient,
	resolved: ResolvedModel,
	prompt: string,
	signal?: AbortSignal,
): Promise<RecallInjectResult> {
	const cwd = ctx.cwd ?? process.cwd();
	const eff = effortPlan(cfg.recallEffort);
	appendDebug(cwd, "recall.gate.start", {
		promptChars: prompt.length,
		model: resolved.label,
		effort: cfg.recallEffort,
		maxQueries: eff.queries,
		rounds: eff.rounds,
		filter: cfg.recallFilter,
	});
	const gateRaw = await runModel(
		ctx,
		resolved,
		QUERY_BUILDER,
		`LATEST USER REQUEST:\n${prompt}\n\nRECENT CONTEXT:\n${recentContext(ctx, cfg.recallContextTokens)}\n\nMAX QUERIES: ${eff.queries}`,
		{ maxTokens: 320, signal },
	);
	appendDebug(cwd, "recall.gate.raw", { output: gateRaw });
	let plan = parseQueryPlan(gateRaw);
	// If the cheap gate returns prose instead of JSON, fall back to a single bounded
	// query built from the user's prompt (a short slice keeps it non-leaky).
	if (!plan.shouldQuery && plan.reason === "query-builder returned non-JSON")
		plan = {
			shouldQuery: true,
			op: "recall",
			queries: [prompt.trim().slice(0, 240)],
			reason: "fallback to user prompt (bounded)",
		};
	appendDebug(cwd, "recall.gate.plan", { ...plan });
	if (!plan.shouldQuery)
		return {
			...emptyRecall(),
			reason: plan.reason || "not enough standalone context to query bank",
		};

	const queryLabel = plan.queries.join(" | ");
	const seen = seenInjectedFacts(ctx);
	const local = new Set<string>();
	const pool: RecallHit[] = [];
	let queriesUsed = 0;
	let totalFound = 0;
	const cap = Math.max(1, cfg.recallMaxQueries);
	// Gather roughly twice the injection budget as candidates, then let the pick
	// step choose the most relevant recallMaxLines.
	const targetPool = Math.max(cfg.recallMaxLines * 2, cfg.recallMaxLines + 2);

	const addHits = (hits: RecallHit[]): number => {
		let added = 0;
		totalFound += hits.length;
		for (const hit of hits) {
			const key = normalizeLine(hit.text);
			if (!key || seen.has(key) || local.has(key)) continue;
			local.add(key);
			pool.push(hit);
			added += 1;
		}
		return added;
	};

	if (plan.op === "reflect") {
		// reflect composes a single answer from the bank's own context.
		const q = plan.queries[0];
		appendDebug(cwd, "recall.reflect.start", { query: q });
		const res = await client.reflect(q, signal);
		appendDebug(cwd, "recall.reflect.done", { response: res });
		const answer = directAnswer(res);
		if (answer)
			return {
				...emptyRecall(),
				found: 1,
				injected: 1,
				text: answer,
				query: q,
				operation: "reflect",
				queried: true,
				reason: "bank reflected",
			};
		addHits(extractHits(res));
	} else {
		const runQueries = async (queries: string[]): Promise<number> => {
			let added = 0;
			for (const q of queries) {
				if (queriesUsed >= cap) break;
				queriesUsed += 1;
				try {
					added += addHits(await bankHits(client, q, cfg, signal));
				} catch (err) {
					appendDebug(cwd, "recall.bank.error", {
						query: q,
						error: (err as Error).message,
					});
				}
				if (pool.length >= targetPool) break;
			}
			return added;
		};
		appendDebug(cwd, "recall.round", { round: 1, queries: plan.queries });
		await runQueries(plan.queries);
		// Refine rounds (thorough): ask for NEW angles based on what we already have,
		// and stop as soon as the model has nothing to add or a round finds nothing.
		for (
			let round = 2;
			round <= eff.rounds && queriesUsed < cap && pool.length < targetPool;
			round += 1
		) {
			const factsSoFar = pool
				.slice(0, 20)
				.map((h, i) => `${i + 1}. ${h.text}`)
				.join("\n");
			const refineRaw = await runModel(
				ctx,
				resolved,
				QUERY_REFINE,
				`ORIGINAL REQUEST:\n${prompt}\n\nFACTS SO FAR:\n${factsSoFar || "(none)"}\n\nMAX QUERIES: ${eff.queries}`,
				{ maxTokens: 256, signal },
			);
			const more = parseRefine(refineRaw);
			appendDebug(cwd, "recall.refine", { round, more });
			if (more.length === 0) break;
			if ((await runQueries(more)) === 0) break;
		}
	}

	appendDebug(cwd, "recall.pool", {
		pool: pool.length,
		queriesUsed,
		totalFound,
	});
	if (pool.length === 0)
		return {
			...emptyRecall(),
			query: queryLabel,
			operation: plan.op,
			queried: true,
			reason:
				totalFound > 0
					? "all facts already injected"
					: "bank returned no facts",
		};

	// Bound candidates before the pick to keep the pick prompt small.
	const candidates = pool.slice(0, Math.max(cfg.recallMaxLines * 3, 12));
	const picked =
		cfg.recallFilter === "model"
			? await modelPick(ctx, resolved, prompt, candidates, signal)
			: candidates;
	const finalHits = picked.slice(0, cfg.recallMaxLines);
	appendDebug(cwd, "recall.pick.done", {
		candidates: candidates.length,
		picked: picked.length,
		injected: finalHits.length,
	});
	const text = finalHits.map((h) => `- ${h.text}`).join("\n");
	return {
		found: totalFound,
		injected: finalHits.length,
		skippedSeen: 0,
		skippedFiltered: candidates.length - finalHits.length,
		text,
		query: queryLabel,
		operation: plan.op,
		queried: true,
		reason: "bank recalled facts",
		rawHits: pool.map((h) => h.text),
	};
}

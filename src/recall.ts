/** Recall flow: gate+query → Hindsight recall/reflect → inject small, deduped context. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "./config.ts";
import type { HindsightClient } from "./hindsight.ts";
import { appendDebug } from "./log.ts";
import { type ResolvedModel, runModel } from "./model.ts";
import { QUERY_BUILDER, RECALL_PICK } from "./prompts.ts";
import {
	directAnswer,
	extractHits,
	normalizeLine,
	parseDecision,
	parseIndexList,
	recentContext,
	seenInjectedFacts,
	type RecallHit,
} from "./recall-utils.ts";

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
	appendDebug(cwd, "recall.gate.start", {
		promptChars: prompt.length,
		model: resolved.label,
		operation: cfg.recallOperation,
		filter: cfg.recallFilter,
	});
	const gateRaw = await runModel(
		ctx,
		resolved,
		QUERY_BUILDER,
		`LATEST USER REQUEST:\n${prompt}\n\nRECENT CONTEXT:\n${recentContext(ctx, cfg.recallContextTokens)}`,
		{ maxTokens: 256, signal },
	);
	appendDebug(cwd, "recall.gate.raw", { output: gateRaw });
	let decision = parseDecision(gateRaw);
	// ponytail: if the cheap gate returns prose instead of JSON, use the user's
	// prompt as the bank query; tighten prompting later only if this gets noisy.
	if (
		!decision.shouldQuery &&
		decision.reason === "query-builder returned non-JSON"
	)
		// Bound the fallback query: sending the entire (possibly huge/sensitive)
		// user prompt to the bank is noisy and leaky. A short slice is enough to
		// retrieve relevant facts; tighten prompting later if this stays noisy.
		decision = {
			shouldQuery: true,
			query: prompt.trim().slice(0, 240),
			op: "recall",
			reason: "fallback to user prompt (bounded)",
		};
	appendDebug(cwd, "recall.gate.decision", { ...decision });
	if (!decision.shouldQuery)
		return {
			...emptyRecall(),
			reason: decision.reason || "not enough standalone context to query bank",
		};

	// The query-builder routes per request: recall (default) vs reflect. Fall back
	// to the configured default only if the gate somehow left it unset.
	const operation = decision.op ?? cfg.recallOperation;
	appendDebug(cwd, "recall.bank.start", {
		operation,
		query: decision.query,
		maxTokens: cfg.recallMaxTokens,
		budget: cfg.recallBudget,
	});
	const res =
		operation === "reflect"
			? await client.reflect(decision.query, signal)
			: await client.recall(
					decision.query,
					{ maxTokens: cfg.recallMaxTokens, budget: cfg.recallBudget },
					signal,
				);
	appendDebug(cwd, "recall.bank.done", { response: res });

	const answer = directAnswer(res);
	if (answer)
		return {
			...emptyRecall(),
			found: 1,
			injected: 1,
			text: answer,
			query: decision.query,
			operation,
			queried: true,
			reason: "bank reflected",
		};

	const hits = extractHits(res);
	appendDebug(cwd, "recall.hits", { hits: hits.length });
	if (hits.length === 0)
		return {
			...emptyRecall(),
			query: decision.query,
			operation,
			queried: true,
			reason: "bank returned no facts",
		};

	const seen = seenInjectedFacts(ctx);
	const local = new Set<string>();
	let skippedSeen = 0;
	const fresh: RecallHit[] = [];
	for (const hit of hits) {
		const key = normalizeLine(hit.text);
		if (!key || seen.has(key) || local.has(key)) {
			skippedSeen += 1;
			continue;
		}
		local.add(key);
		fresh.push(hit);
		if (fresh.length >= cfg.recallMaxLines) break;
	}
	if (fresh.length === 0)
		return {
			found: hits.length,
			injected: 0,
			skippedSeen,
			skippedFiltered: 0,
			text: "",
			query: decision.query,
			operation,
			queried: true,
			reason: "all facts already injected",
			rawHits: hits.map((h) => h.text),
		};

	appendDebug(cwd, "recall.fresh", {
		fresh: fresh.length,
		skippedSeen,
		filter: cfg.recallFilter,
	});
	const picked =
		cfg.recallFilter === "model"
			? await modelPick(ctx, resolved, prompt, fresh, signal)
			: fresh;
	appendDebug(cwd, "recall.pick.done", { picked: picked.length });
	const text = picked.map((h) => `- ${h.text}`).join("\n");
	return {
		found: hits.length,
		injected: picked.length,
		skippedSeen,
		skippedFiltered: fresh.length - picked.length,
		text,
		query: decision.query,
		operation,
		queried: true,
		reason: "bank recalled facts",
		rawHits: hits.map((h) => h.text),
	};
}

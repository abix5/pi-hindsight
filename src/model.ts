/**
 * Small-model helper.
 *
 * IMPORTANT: this extension never registers providers/models. It only uses
 * models already present in pi's ModelRegistry (configured via HINDSIGHT_MODEL
 * as a fallback, or HINDSIGHT_RECALL_MODEL / HINDSIGHT_RETAIN_MODEL per role).
 *
 * Every call goes through a CHAIN, not a single model: the configured primary,
 * then each id in the role's `*ModelChain`, then the session's own model. A
 * provider that is down (auth error, timeout, 5xx) must never take the whole
 * memory contour with it — the next candidate answers instead.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "./config.ts";
import { appendDebug } from "./log.ts";

type AnyModel = NonNullable<ExtensionContext["model"]>;

export interface ResolvedModel {
	model: AnyModel;
	label: string;
}

/**
 * Ordered model candidates for one role. `primary` drives sizing decisions
 * (context window / chunking); `candidates` is what `runModel` walks on failure.
 */
export interface ModelChain {
	primary: ResolvedModel;
	candidates: ResolvedModel[];
	label: string;
}

/** Look one "provider/id" up in the registry. */
function findModel(
	ctx: ExtensionContext,
	modelId: string,
): ResolvedModel | undefined {
	const slash = modelId.indexOf("/");
	if (slash <= 0 || !ctx.modelRegistry) return undefined;
	const provider = modelId.slice(0, slash);
	const id = modelId.slice(slash + 1);
	const found = ctx.modelRegistry.find(provider, id);
	return found ? { model: found, label: `${provider}/${id}` } : undefined;
}

/** The session's own model, used as the last fallback link. */
function sessionModel(ctx: ExtensionContext): ResolvedModel | undefined {
	if (!ctx.model) return undefined;
	const m = ctx.model as { provider?: string; id?: string };
	return { model: ctx.model, label: `${m.provider ?? "?"}/${m.id ?? "?"}` };
}

/**
 * Resolve the ordered chain for a role: configured primary → configured chain →
 * the session model. Unknown ids are skipped (a stale id in the config must not
 * break memory), duplicates are collapsed. Returns undefined only when NO model
 * at all is reachable.
 */
export function resolveChain(
	ctx: ExtensionContext,
	cfg: HindsightConfig,
	role: "recall" | "retain" = "retain",
): ModelChain | undefined {
	const ids = [
		role === "recall" ? cfg.recallModelId : cfg.retainModelId,
		cfg.modelId,
		...(role === "recall" ? cfg.recallModelChain : cfg.retainModelChain),
	];
	const candidates: ResolvedModel[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (!id) continue;
		const found = findModel(ctx, id);
		if (!found || seen.has(found.label)) continue;
		seen.add(found.label);
		candidates.push(found);
	}
	const session = sessionModel(ctx);
	if (session && !seen.has(session.label)) candidates.push(session);
	if (candidates.length === 0) return undefined;
	return {
		primary: candidates[0],
		candidates,
		label: candidates.map((c) => c.label).join(" → "),
	};
}

/** Abort (Esc / time budget) must stop the chain, not advance to the next link. */
function isAbort(err: unknown): boolean {
	const e = err as { name?: string };
	return e?.name === "AbortError";
}

/**
 * Run a single completion, walking the chain until one model answers.
 * Throws the LAST error only when every candidate failed.
 */
export async function runModel(
	ctx: ExtensionContext,
	chain: ModelChain,
	systemPrompt: string,
	userText: string,
	opts: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
	if (!ctx.modelRegistry) throw new Error("modelRegistry unavailable");
	const cwd = ctx.cwd ?? process.cwd();
	let lastError: unknown;
	for (const [index, resolved] of chain.candidates.entries()) {
		try {
			return await runOne(ctx, resolved, systemPrompt, userText, opts);
		} catch (err) {
			if (isAbort(err) || opts.signal?.aborted) throw err;
			lastError = err;
			appendDebug(cwd, "model.fallback", {
				failed: resolved.label,
				error: (err as Error).message,
				next: chain.candidates[index + 1]?.label ?? "(none left)",
			});
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error(`all models failed: ${chain.label}`);
}

/** One completion against one resolved model. */
async function runOne(
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	systemPrompt: string,
	userText: string,
	opts: { maxTokens?: number; signal?: AbortSignal },
): Promise<string> {
	if (!ctx.modelRegistry) throw new Error("modelRegistry unavailable");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key for ${resolved.label}`);

	const response = await complete(
		resolved.model,
		{
			systemPrompt,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: userText }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: opts.maxTokens,
			signal: opts.signal,
		},
	);

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/**
 * Small-model helper.
 *
 * IMPORTANT: this extension never registers providers/models. It only uses
 * models already present in pi's ModelRegistry (configured via HINDSIGHT_MODEL
 * as a fallback, or HINDSIGHT_RECALL_MODEL / HINDSIGHT_RETAIN_MODEL per role).
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "./config.ts";

type AnyModel = NonNullable<ExtensionContext["model"]>;

export interface ResolvedModel {
	model: AnyModel;
	label: string;
}

/** Resolve the model to use for a role, else fallback to ctx.model. */
export function resolveModel(
	ctx: ExtensionContext,
	cfg: HindsightConfig,
	role: "recall" | "retain" = "retain",
): ResolvedModel | undefined {
	const modelId =
		(role === "recall" ? cfg.recallModelId : cfg.retainModelId) ?? cfg.modelId;
	if (modelId && ctx.modelRegistry) {
		const slash = modelId.indexOf("/");
		if (slash > 0) {
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			const found = ctx.modelRegistry.find(provider, id);
			if (found) return { model: found, label: `${provider}/${id}` };
		}
	}
	if (ctx.model) {
		const m = ctx.model as { provider?: string; id?: string };
		return { model: ctx.model, label: `${m.provider ?? "?"}/${m.id ?? "?"}` };
	}
	return undefined;
}

/**
 * Run a single completion with the resolved small model.
 * Returns the concatenated text content, or throws on auth/model errors.
 */
export async function runModel(
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	systemPrompt: string,
	userText: string,
	opts: { maxTokens?: number; signal?: AbortSignal } = {},
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

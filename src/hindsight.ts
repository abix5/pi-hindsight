/**
 * Thin REST client for the local Hindsight HTTP API.
 *
 * Endpoints (Hindsight HTTP API v0.8.x, prefix /v1/{namespace}):
 *   PUT  /banks/{bank}                    -> ensure/update bank
 *   GET  /banks                           -> list banks
 *   POST /banks/{bank}/memories           -> retain (store memory items)
 *   POST /banks/{bank}/memories/recall    -> recall (search)
 *   POST /banks/{bank}/reflect            -> reflect (synthesis)
 *
 * No auth header is sent (local instance).
 */

import type { Budget, HindsightConfig } from "./config.ts";
import { appendDebug } from "./log.ts";

export interface RetainOptions {
	context?: string;
	tags?: string[];
	metadata?: Record<string, string>;
	/** Process asynchronously on the server side. */
	async?: boolean;
}

export interface RecallOptions {
	maxTokens?: number;
	budget?: Budget;
	tags?: string[];
	types?: string[];
	/**
	 * Drop raw facts that a returned observation was consolidated from, so the
	 * same content is not returned twice (raw + observation). Provenance-based
	 * (exact source-id membership), not semantic. Hindsight >= v0.8.4; older
	 * servers ignore the unknown field. Defaults to true.
	 */
	preferObservations?: boolean;
}

/** Bank size counters shown in the status widget. */
export interface BankStats {
	/** Stored documents (total_documents). */
	documents: number;
	/** Extracted memory units / graph nodes (total_nodes). */
	facts: number;
}

export class HindsightError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly body?: string,
	) {
		super(message);
		this.name = "HindsightError";
	}
}

export class HindsightClient {
	constructor(private readonly cfg: HindsightConfig) {}

	private bankBase(): string {
		return `${this.cfg.baseUrl}/v1/${this.cfg.namespace}/banks/${encodeURIComponent(this.cfg.bankId)}`;
	}

	private async request<T>(
		method: string,
		url: string,
		body?: unknown,
		signal?: AbortSignal,
		timeoutMs = 15000,
	): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		// Keep the handler reference so we can detach it in finally: a long-lived
		// caller signal (hook/command) would otherwise accumulate one listener per
		// request until it eventually aborts.
		const onAbort = () => controller.abort();
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		try {
			appendDebug(process.cwd(), "http.start", {
				method,
				url,
				timeoutMs,
				body,
			});
			const res = await fetch(url, {
				method,
				headers: body ? { "content-type": "application/json" } : undefined,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
			const text = await res.text();
			appendDebug(process.cwd(), "http.done", {
				method,
				url,
				status: res.status,
				body: text,
			});
			if (!res.ok) {
				throw new HindsightError(
					`${method} ${url} -> ${res.status}`,
					res.status,
					text,
				);
			}
			return (text ? JSON.parse(text) : undefined) as T;
		} catch (err) {
			appendDebug(process.cwd(), "http.error", {
				method,
				url,
				error: (err as Error).message,
			});
			throw err;
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
		}
	}

	/** GET /health (not bank-scoped). */
	async health(signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"GET",
			`${this.cfg.baseUrl}/health`,
			undefined,
			signal,
			5000,
		);
	}

	/** GET /v1/{ns}/banks/{bank}/stats — document/fact counts for the widget. */
	async stats(signal?: AbortSignal): Promise<BankStats> {
		const s = (await this.request(
			"GET",
			`${this.bankBase()}/stats`,
			undefined,
			signal,
			5000,
		)) as { total_documents?: number; total_nodes?: number } | undefined;
		return {
			documents: Number(s?.total_documents ?? 0),
			facts: Number(s?.total_nodes ?? 0),
		};
	}

	/** GET /v1/{ns}/banks */
	async listBanks(signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"GET",
			`${this.cfg.baseUrl}/v1/${this.cfg.namespace}/banks`,
			undefined,
			signal,
		);
	}

	/** PUT /v1/{ns}/banks/{bank} — idempotent ensure. */
	async ensureBank(name?: string, signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"PUT",
			this.bankBase(),
			{ name: name ?? this.cfg.bankId },
			signal,
		);
	}

	/** POST /v1/{ns}/banks/{bank}/memories — store a single memory item. */
	async retain(
		content: string,
		opts: RetainOptions = {},
		signal?: AbortSignal,
	): Promise<unknown> {
		const item = {
			content,
			context: opts.context,
			tags: opts.tags,
			metadata: opts.metadata,
			timestamp: new Date().toISOString(),
		};
		return this.request(
			"POST",
			`${this.bankBase()}/memories`,
			{ items: [item], async: opts.async ?? false },
			signal,
			30000,
		);
	}

	/** POST /v1/{ns}/banks/{bank}/reflect — Hindsight synthesized answer. */
	async reflect(query: string, signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"POST",
			`${this.bankBase()}/reflect`,
			{ query },
			signal,
			30000,
		);
	}

	/** POST /v1/{ns}/banks/{bank}/memories/recall — semantic search. */
	async recall(
		query: string,
		opts: RecallOptions = {},
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.request(
			"POST",
			`${this.bankBase()}/memories/recall`,
			{
				query,
				max_tokens: opts.maxTokens ?? this.cfg.recallMaxTokens,
				budget: opts.budget ?? this.cfg.recallBudget,
				tags: opts.tags,
				types: opts.types,
				prefer_observations: opts.preferObservations ?? true,
			},
			signal,
			30000,
		);
	}
}

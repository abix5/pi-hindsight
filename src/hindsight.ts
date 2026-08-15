/**
 * Thin REST client for the local Hindsight HTTP API.
 *
 * Endpoints (Hindsight HTTP API v0.8.x, prefix /v1/{namespace}):
 *   PUT  /banks/{bank}                    -> ensure/update bank
 *   GET  /banks                           -> list banks
 *   POST /banks/{bank}/memories           -> retain (store memory items)
 *   POST /banks/{bank}/memories/recall    -> recall (search)
 *   PATCH /banks/{bank}/memories/{id}     -> curate (edit / invalidate / restore)
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
	/**
	 * Stable document id for upsert semantics: when it matches an existing
	 * document the bank deletes that document and its facts, then re-extracts.
	 * Omitted → server assigns a random UUID (duplicates on re-ingest).
	 */
	documentId?: string;
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

	/** GET /v1/{ns}/banks/{bank}/config — resolved config plus explicit overrides. */
	async getBankConfig(signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"GET",
			`${this.bankBase()}/config`,
			undefined,
			signal,
			5000,
		);
	}

	/** PATCH /v1/{ns}/banks/{bank}/config — update only the provided keys. */
	async updateBankConfig(
		updates: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.request(
			"PATCH",
			`${this.bankBase()}/config`,
			{ updates },
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
			document_id: opts.documentId,
		};
		return this.request(
			"POST",
			`${this.bankBase()}/memories`,
			{ items: [item], async: opts.async ?? false },
			signal,
			30000,
		);
	}

	/**
	 * DELETE /v1/{ns}/banks/{bank}/documents/{doc_id} — remove a document and
	 * its extracted memories. Tolerates 404 (already gone).
	 */
	async deleteDocument(docId: string, signal?: AbortSignal): Promise<void> {
		try {
			await this.request(
				"DELETE",
				`${this.bankBase()}/documents/${encodeURIComponent(docId)}`,
				undefined,
				signal,
			);
		} catch (err) {
			if (err instanceof HindsightError && err.status === 404) return;
			throw err;
		}
	}

	/**
	 * PATCH /v1/{ns}/banks/{bank}/memories/{id} — soft-retire ONE fact.
	 *
	 * Request shape verified against the live server (Hindsight 0.9.0,
	 * `UpdateMemoryRequest`): the body field is `reason`, NOT `invalidation_reason`
	 * — the latter is what the row reads back as in `memories/list`.
	 *
	 * An invalidated fact leaves recall, consolidation and the graph but stays in
	 * the bank for audit, and can be restored. Two rejections are expected and
	 * swallowed as no-ops rather than failing the write that triggered them:
	 *   404 — the memory is already gone;
	 *   400 — the id is an OBSERVATION. Observations are derived and regenerate
	 *         from their sources, so the server refuses to curate them.
	 */
	async invalidate(
		id: string,
		reason: string,
		signal?: AbortSignal,
	): Promise<void> {
		try {
			await this.request(
				"PATCH",
				`${this.bankBase()}/memories/${encodeURIComponent(id)}`,
				{ state: "invalidated", reason },
				signal,
			);
		} catch (err) {
			if (
				err instanceof HindsightError &&
				(err.status === 404 || err.status === 400)
			)
				return;
			throw err;
		}
	}

	/**
	 * PATCH /v1/{ns}/banks/{bank}/memories/{id} — bring ONE retired fact back.
	 *
	 * The exact inverse of `invalidate`, verified against the live server (Hindsight
	 * 0.9.0, `UpdateMemoryRequest`): `state: "valid"` and nothing else. `reason`
	 * belongs to the kill and is deliberately not repeated here — it is the record of
	 * why the fact died, not of why it came back, and resending it would overwrite
	 * the audit trail the kill left behind.
	 *
	 * The same two rejections as the kill side are swallowed as no-ops, because a
	 * restore is driven from a log entry that may be older than the bank:
	 *   404 — the memory is gone for good (the document was deleted or reprocessed),
	 *         so there is nothing to bring back and nothing to report;
	 *   400 — the id is an OBSERVATION. Observations are derived and regenerate from
	 *         their sources, so the server refuses to curate them either way.
	 */
	async restore(id: string, signal?: AbortSignal): Promise<void> {
		try {
			await this.request(
				"PATCH",
				`${this.bankBase()}/memories/${encodeURIComponent(id)}`,
				{ state: "valid" },
				signal,
			);
		} catch (err) {
			if (
				err instanceof HindsightError &&
				(err.status === 404 || err.status === 400)
			)
				return;
			throw err;
		}
	}

	/**
	 * POST /v1/{ns}/banks/{bank}/reflect — Hindsight synthesized answer.
	 *
	 * Timed out at 30s, reflect had never once succeeded in production: measured
	 * across four banks it takes 28-59s, and the curve is flat in bank size (a
	 * 10-fact bank still answers in 28s) because it is an LLM-bound agent loop,
	 * not a retrieval problem. This ceiling is for the DELIBERATE `hindsight_reflect`
	 * tool call, where the agent chose to wait; automatic callers stay bounded by
	 * their own, much shorter, abort ceiling.
	 */
	async reflect(query: string, signal?: AbortSignal): Promise<unknown> {
		return this.request(
			"POST",
			`${this.bankBase()}/reflect`,
			{ query },
			signal,
			180000,
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

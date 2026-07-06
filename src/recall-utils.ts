import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface RecallHit {
	text: string;
}

export interface QueryDecision {
	shouldQuery: boolean;
	query: string;
	/** How to hit the bank for this request. recall (raw facts) is the default;
	 *  reflect makes the bank answer strictly from its own stored context. */
	op?: "recall" | "reflect";
	reason?: string;
}

export function normalizeLine(s: string): string {
	return s
		.trim()
		.replace(/^[-*•]\s*/, "")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) =>
			(b as { type?: string; text?: string }).type === "text"
				? ((b as { text?: string }).text ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

export function recentContext(
	ctx: ExtensionContext,
	maxTokens: number,
): string {
	const maxChars = maxTokens * 4;
	const entries = ctx.sessionManager.getEntries() as Array<{
		type?: string;
		message?: { role?: string; content?: unknown };
	}>;
	const parts: string[] = [];
	for (const entry of entries.slice(-20).reverse()) {
		if (entry.type !== "message" || !entry.message) continue;
		const text = textFromContent(entry.message.content).trim();
		if (!text) continue;
		parts.unshift(`${entry.message.role ?? "unknown"}: ${text}`);
		if (parts.join("\n\n").length >= maxChars) break;
	}
	const joined = parts.join("\n\n");
	return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

export function parseDecision(raw: string): QueryDecision {
	try {
		const obj = JSON.parse(raw.trim()) as Partial<QueryDecision>;
		return {
			shouldQuery: obj.shouldQuery === true && !!obj.query?.trim(),
			query: obj.query?.trim() ?? "",
			// Default to recall; only honour an explicit, valid "reflect".
			op: obj.op === "reflect" ? "reflect" : "recall",
			reason: typeof obj.reason === "string" ? obj.reason.trim() : undefined,
		};
	} catch {
		return {
			shouldQuery: false,
			query: "",
			reason: "query-builder returned non-JSON",
		};
	}
}

function hitText(item: unknown): string {
	if (typeof item === "string") return item;
	const it = item as Record<string, unknown>;
	return (
		(it.content as string) ?? (it.text as string) ?? (it.memory as string) ?? ""
	);
}

export function directAnswer(res: unknown): string {
	if (typeof res === "string") return res.trim();
	if (!res || typeof res !== "object") return "";
	const obj = res as Record<string, unknown>;
	if (Array.isArray(obj.memories ?? obj.results ?? obj.items ?? obj.hits))
		return "";
	return ((obj.answer as string) ?? (obj.text as string) ?? "").trim();
}

export function extractHits(res: unknown): RecallHit[] {
	if (!res) return [];
	if (typeof res === "string")
		return [{ text: res.trim() }].filter((h) => h.text);
	const obj = res as Record<string, unknown>;
	const list =
		(obj.memories as unknown[]) ??
		(obj.results as unknown[]) ??
		(obj.items as unknown[]) ??
		(obj.hits as unknown[]);
	if (Array.isArray(list))
		return list
			.map((item) => ({ text: hitText(item).trim() }))
			.filter((h) => h.text);
	if (typeof obj.text === "string") return [{ text: obj.text.trim() }];
	if (typeof obj.answer === "string") return [{ text: obj.answer.trim() }];
	return [];
}

export function parseIndexList(raw: string, max: number): Set<number> {
	try {
		const arr = JSON.parse(raw.trim()) as unknown;
		if (!Array.isArray(arr)) return new Set();
		return new Set(
			arr
				.map((n) => (typeof n === "number" ? Math.trunc(n) : NaN))
				.filter((n) => Number.isInteger(n) && n >= 1 && n <= max),
		);
	} catch {
		return new Set();
	}
}

export function seenInjectedFacts(ctx: ExtensionContext): Set<string> {
	const seen = new Set<string>();
	const entries = ctx.sessionManager.getEntries() as Array<{ type?: string }>;
	const lastCompact = entries.findLastIndex((e) => e.type === "compaction");
	for (const entry of entries.slice(lastCompact + 1)) {
		const text = JSON.stringify(entry);
		if (!text.includes("hindsight-recall")) continue;
		// Record ONLY the bullets UNDER the "Injected facts" marker. The trace lines
		// above it are ALSO bullets ("- Bank query:", "- Found in bank:") but are not
		// facts, so anchoring on the marker keeps them out of the seen-set.
		const marker = text.indexOf("Injected facts");
		if (marker === -1) continue;
		for (const raw of text.slice(marker).split(/\\n|\n/)) {
			const m = /[-*•]\s+(.+)$/.exec(raw.replace(/\\"/g, '"'));
			if (!m) continue;
			// Strip trailing JSON artifacts (the stringified entry's closing quote/
			// braces after the last fact), then normalize.
			const line = m[1].replace(/["}\]]+$/, "").trim();
			if (line) seen.add(normalizeLine(line));
		}
	}
	return seen;
}

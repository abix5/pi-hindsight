import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface RecallHit {
	text: string;
	/**
	 * Bank memory id. Recall returns one per hit; a prose/string response has
	 * none. Required to curate the fact (PATCH memories/{id}) — the recall path
	 * itself never reads it.
	 */
	id?: string;
	/**
	 * Fact type as the bank reports it (`world` | `experience` | `observation`).
	 * Only world/experience facts can be curated: a PATCH on an observation is
	 * rejected with 400 because observations are derived and regenerate.
	 */
	type?: string;
}

export function normalizeLine(s: string): string {
	return s
		.trim()
		.replace(/^[-*•]\s*/, "")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

/**
 * Flatten one message's content for the query builder.
 *
 * Text, thinking, and tool CALLS are kept: the reasoning and the tools the agent
 * reached for say what the turn was actually about. Tool RESULTS are dropped —
 * they are bulky recon output that adds no retrieval signal.
 */
function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const raw of content) {
		const b = raw as {
			type?: string;
			text?: string;
			thinking?: string;
			name?: string;
			arguments?: Record<string, unknown>;
		};
		if (b.type === "text" && b.text?.trim()) out.push(b.text.trim());
		else if (b.type === "thinking") {
			const t = (b.thinking ?? b.text ?? "").trim();
			if (t) out.push(t);
		} else if (b.type === "toolCall" && b.name) {
			const arg = firstArgHint(b.arguments);
			out.push(arg ? `[tool ${b.name}: ${arg}]` : `[tool ${b.name}]`);
		}
	}
	return out.join("\n");
}

/** A short subject hint from a tool call's arguments (path/pattern/command/query). */
function firstArgHint(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	for (const k of ["path", "file", "pattern", "query", "command", "symbol"]) {
		const v = args[k];
		if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
	}
	return "";
}

/**
 * Conversation context for the query builder: dialogue prose, agent thinking and
 * tool calls — never tool output.
 *
 * A coding session's last N entries are almost entirely toolCall/toolResult
 * records; slicing a fixed window off the tail therefore handed the builder an
 * empty RECENT CONTEXT and it had nothing to do but paraphrase the user's
 * message back as the bank query. So we walk the WHOLE post-compaction history
 * backwards, keep only what carries retrieval signal, and fill up to the budget.
 */
export function recentContext(
	ctx: ExtensionContext,
	maxTokens: number,
): string {
	const maxChars = maxTokens * 4;
	const entries = ctx.sessionManager.getEntries() as Array<{
		type?: string;
		message?: { role?: string; content?: unknown; customType?: string };
	}>;
	// Everything before the last compaction is gone from the model's own context;
	// don't resurrect it here either.
	const lastCompact = entries.findLastIndex((e) => e.type === "compaction");
	const parts: string[] = [];
	let chars = 0;
	for (const entry of entries.slice(lastCompact + 1).reverse()) {
		const msg = entry.message;
		if (!msg) continue;
		const role = msg.role ?? "";
		if (role !== "user" && role !== "assistant") continue; // drop tool traffic
		// Our own injected recall blocks are not conversation — feeding them back
		// makes the builder query for what was already recalled.
		if (msg.customType === "mem-recall") continue;
		const text = textFromContent(msg.content).trim();
		if (!text) continue;
		const line = `${role}: ${text}`;
		if (chars + line.length > maxChars) {
			const room = maxChars - chars;
			if (room > 200) parts.unshift(line.slice(-room));
			break;
		}
		parts.unshift(line);
		chars += line.length + 2;
	}
	return parts.join("\n\n");
}

/** A multi-query recall plan produced by the QUERY_BUILDER. */
export interface QueryPlan {
	shouldQuery: boolean;
	op: "recall" | "reflect";
	queries: string[];
	reason?: string;
}

/** Parse the multi-query builder output; tolerates the legacy single-"query" shape. */
export function parseQueryPlan(raw: string): QueryPlan {
	try {
		const obj = JSON.parse(raw.trim()) as {
			shouldQuery?: unknown;
			op?: unknown;
			queries?: unknown;
			query?: unknown;
			reason?: unknown;
		};
		const list = Array.isArray(obj.queries)
			? obj.queries
			: typeof obj.query === "string"
				? [obj.query]
				: [];
		const queries = [
			...new Set(
				list
					.map((q) => (typeof q === "string" ? q.trim() : ""))
					.filter(Boolean),
			),
		];
		return {
			shouldQuery: obj.shouldQuery === true && queries.length > 0,
			// The automatic contour NEVER reflects: a diagnosed reflect takes tens of
			// seconds even on a 10-fact bank, so it would burn the recall ceiling on the
			// hot path and return nothing. The deliberate `hindsight_reflect` tool is
			// the only path to reflect. A stray "reflect" from the model is coerced.
			op: "recall",
			queries,
			reason: typeof obj.reason === "string" ? obj.reason.trim() : undefined,
		};
	} catch {
		return {
			shouldQuery: false,
			op: "recall",
			queries: [],
			reason: "query-builder returned non-JSON",
		};
	}
}

/** One query's verdict: how useful its hits were, and which to keep. */
export interface JudgeVerdict {
	score: number;
	keep: Set<number>;
	/** false when the model's output was unparseable (caller falls back). */
	valid: boolean;
}

/** Parse a RECALL_JUDGE reply. Unparseable output is reported, never guessed. */
export function parseJudge(raw: string, max: number): JudgeVerdict {
	try {
		const obj = JSON.parse(raw.trim()) as { score?: unknown; keep?: unknown };
		if (!Array.isArray(obj.keep))
			return { score: 0, keep: new Set(), valid: false };
		const keep = new Set(
			obj.keep
				.map((n) => (typeof n === "number" ? Math.trunc(n) : Number.NaN))
				.filter((n) => Number.isInteger(n) && n >= 1 && n <= max),
		);
		const rawScore = typeof obj.score === "number" ? obj.score : 0;
		const score = Math.min(100, Math.max(0, Math.round(rawScore)));
		// A non-zero score with nothing kept is self-contradictory; trust `keep`.
		return { score: keep.size === 0 ? 0 : score, keep, valid: true };
	} catch {
		return { score: 0, keep: new Set(), valid: false };
	}
}

/**
 * Model-free query builder used when EVERY model in the chain is unavailable.
 *
 * Sending the raw user message to the bank retrieves badly (it is long, full of
 * filler, and semantically diffuse). Instead, strip filler words and group the
 * remaining content terms into a few short keyword queries — the same shape the
 * model would have produced, minus the paraphrasing.
 */
export function heuristicQueries(prompt: string, max: number): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const raw of prompt.toLowerCase().split(/[^\p{L}\p{N}_./-]+/u)) {
		const term = raw.replace(/^[./-]+|[./-]+$/g, "");
		if (term.length < 3 || STOPWORDS.has(term) || seen.has(term)) continue;
		seen.add(term);
		terms.push(term);
		if (terms.length >= 40) break;
	}
	if (terms.length === 0) return [];
	const limit = Math.max(1, max);
	const perQuery = Math.max(3, Math.ceil(terms.length / limit));
	const queries: string[] = [];
	for (let i = 0; i < terms.length && queries.length < limit; i += perQuery)
		queries.push(terms.slice(i, i + perQuery).join(" "));
	return queries;
}

/** Filler words carrying no retrieval signal (ru + en), used by heuristicQueries. */
const STOPWORDS = new Set([
	"the",
	"and",
	"but",
	"for",
	"not",
	"you",
	"our",
	"его",
	"это",
	"как",
	"что",
	"так",
	"вот",
	"нет",
	"них",
	"там",
	"тут",
	"все",
	"всё",
	"еще",
	"ещё",
	"уже",
	"был",
	"без",
	"для",
	"надо",
	"меня",
	"мне",
	"нам",
	"нас",
	"мы",
	"который",
	"которая",
	"которые",
	"давай",
	"сейчас",
	"очень",
	"просто",
	"тоже",
	"также",
	"хотелось",
	"хочу",
	"есть",
	"было",
	"будет",
	"когда",
	"чтобы",
	"потом",
	"короче",
	"вообще",
]);

function hitText(item: unknown): string {
	if (typeof item === "string") return item;
	const it = item as Record<string, unknown>;
	return (
		(it.content as string) ?? (it.text as string) ?? (it.memory as string) ?? ""
	);
}

/** Read a string field off a hit object, ignoring anything non-string. */
function hitField(item: unknown, key: string): string | undefined {
	if (typeof item !== "object" || item === null) return undefined;
	const v = (item as Record<string, unknown>)[key];
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
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
			.map((item) => ({
				text: hitText(item).trim(),
				id: hitField(item, "id"),
				// recall calls it `type`, memories/list calls it `fact_type`.
				type: hitField(item, "type") ?? hitField(item, "fact_type"),
			}))
			.filter((h) => h.text);
	if (typeof obj.text === "string") return [{ text: obj.text.trim() }];
	if (typeof obj.answer === "string") return [{ text: obj.answer.trim() }];
	return [];
}

/**
 * One fact the DEDUP step ruled an ORPHAN: its subject died and no replacement
 * fact will ever be stored, so consolidation cannot reconcile it.
 */
export interface Invalidation {
	/** Bank memory id to retire. */
	id: string;
	/** Verbatim transcript sentence proving the subject died → `invalidation_reason`. */
	quote: string;
}

/** Collapse whitespace/case so a quote can be matched against the transcript. */
function loose(s: string): string {
	return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Parse the DEDUP step's extended verdict list.
 *
 * The step's three verdicts are `new` / `duplicate` / `contradicts:<id>`; the
 * first two are already expressed by the surviving prose note, so only
 * `contradicts` carries an action here.
 *
 * Every rejection below is a SILENT-LOSS guard. The step sees ONE delta chunk,
 * not the whole picture, so a model that merely reads a fact discussed in the
 * past tense would happily call it dead. Killing a fact is not undone by the
 * next run, so each candidate must clear all of:
 *   - a known id (the model cannot invent a victim),
 *   - a non-empty quote (the kill is auditable afterwards),
 *   - a quote that ACTUALLY OCCURS in the transcript (checked here, in code,
 *     because a model asked for evidence will otherwise paraphrase one).
 */
export function parseInvalidations(
	raw: string,
	opts: { allowedIds: Iterable<string>; transcript: string },
): Invalidation[] {
	const allowed = new Set(opts.allowedIds);
	const haystack = loose(opts.transcript);
	let list: unknown;
	try {
		const obj = JSON.parse(raw.trim()) as { verdicts?: unknown };
		list = obj?.verdicts;
	} catch {
		return [];
	}
	if (!Array.isArray(list)) return [];
	const out: Invalidation[] = [];
	const taken = new Set<string>();
	for (const entry of list) {
		const e = entry as { verdict?: unknown; id?: unknown; quote?: unknown };
		if (e?.verdict !== "contradicts") continue;
		const id = typeof e.id === "string" ? e.id.trim() : "";
		if (!id || !allowed.has(id) || taken.has(id)) continue;
		const quote = typeof e.quote === "string" ? e.quote.trim() : "";
		if (!quote) continue;
		if (!haystack.includes(loose(quote))) continue;
		taken.add(id);
		out.push({ id, quote });
	}
	return out;
}

export function seenInjectedFacts(ctx: ExtensionContext): Set<string> {
	const seen = new Set<string>();
	const entries = ctx.sessionManager.getEntries() as Array<{ type?: string }>;
	const lastCompact = entries.findLastIndex((e) => e.type === "compaction");
	for (const entry of entries.slice(lastCompact + 1)) {
		const text = JSON.stringify(entry);
		if (!text.includes("mem-recall")) continue;
		// Record ONLY the bullets UNDER the "Injected facts" marker. The trace lines
		// above it are ALSO bullets ("- Bank query:", "- Found in bank:") but are not
		// facts, so anchoring on the marker keeps them out of the seen-set. The block
		// may also carry a plugin reminder in its tail, below the closing marker —
		// its bullets are plugin text, not bank text, so the region ends there.
		const marker = text.indexOf("Injected facts");
		if (marker === -1) continue;
		const end = text.indexOf("end of recalled memory", marker);
		const region = end === -1 ? text.slice(marker) : text.slice(marker, end);
		for (const raw of region.split(/\\n|\n/)) {
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

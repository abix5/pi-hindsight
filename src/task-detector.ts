/**
 * Task-change detector: a cheap LLM run that keeps its OWN short conversation
 * alongside the main one and answers, each turn, whether the work has moved to
 * a different task.
 *
 * Why a second conversation instead of comparing turns lexically: an earlier
 * design compared noun sets between consecutive turns and, replayed against real
 * logs, fired 10 false "task changed" in 14 turns of ONE task. People do not
 * repeat file names — they write "продолжай" and "это не сработает". Only a
 * model reading the thread can tell continuation from a new subject.
 *
 * Three properties keep this affordable:
 *   - the history holds a DIGEST of each answer (first sentence + touched
 *     files), never the answer itself — the full text would multiply the cached
 *     prefix by an order of magnitude, and that prefix is the whole cost;
 *   - the user's message is CAPPED too (see USER_CHARS). `event.prompt` is the
 *     EXPANDED text, so one `@file` reference would otherwise inline a whole
 *     file into the prefix — ×12 turns, re-sent every turn, and written into a
 *     long-retention cache;
 *   - on "changed" the history is dropped, so the retained slice always IS the
 *     description of the task currently in progress.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "./config.ts";
import { appendDebug } from "./log.ts";
import { type ModelChain, type ModelMessage, runModel } from "./model.ts";
import { TASK_DETECTOR } from "./prompts.ts";

/** One exchange as the detector sees it: what we asked, what it answered. */
export interface DetectorTurn {
	/** Digest of the previous answer + the user's message, verbatim. */
	user: string;
	/** The detector's own reply (compact JSON), replayed as conversation history. */
	verdict?: string;
}

export interface TaskState {
	/** Session this history belongs to; a different id resets everything. */
	sessionId?: string;
	turns: DetectorTurn[];
	/** One line per finished task, so a RETURN to a morning topic is not read as new. */
	pastTitles: string[];
	/** Title of the task currently in progress. */
	title?: string;
	/** Entry id at the start of the current turn; the digest is taken from after it. */
	markerId?: string;
	/** Compactions seen so far — a new one is a deep-pass trigger. */
	compactions: number;
	/** False until the first turn of this session has been handled. */
	started: boolean;
	/**
	 * Normalized keys of facts already injected in this session, carried in
	 * extension memory because the transcript cannot show them all: a deep pass
	 * injects a synthesized PROSE briefing, which has no bullets for
	 * `seenInjectedFacts` to read back. Cleared on a compaction (the transcript,
	 * and with it everything injected, is gone) and on a session change.
	 */
	seenFacts: Set<string>;
}

export function newTaskState(): TaskState {
	return {
		turns: [],
		pastTitles: [],
		compactions: 0,
		started: false,
		seenFacts: new Set(),
	};
}

export interface TaskVerdict {
	changed: boolean;
	title?: string;
	query?: string;
	/** False when the model produced something we could not parse. */
	valid: boolean;
}

/**
 * Parse a detector reply.
 *
 * Garbage means "no verdict", and no verdict must read as UNCHANGED: a boundary
 * costs a deep pass, so a malformed answer must never be able to trigger one.
 * A `changed:true` with no usable query is equally useless — the deep pass has
 * nothing to search for — so it degrades to unchanged too.
 */
export function parseTaskVerdict(raw: string): TaskVerdict {
	try {
		const obj = JSON.parse(raw.trim()) as {
			changed?: unknown;
			title?: unknown;
			query?: unknown;
		};
		if (typeof obj !== "object" || obj === null || !("changed" in obj))
			return { changed: false, valid: false };
		if (obj.changed !== true) return { changed: false, valid: true };
		const query = typeof obj.query === "string" ? obj.query.trim() : "";
		const title = typeof obj.title === "string" ? obj.title.trim() : "";
		if (!query) return { changed: false, valid: true };
		return { changed: true, title: title || query, query, valid: true };
	} catch {
		return { changed: false, valid: false };
	}
}

/** Tools whose call means a file was written; their path is the useful part of a digest. */
const EDIT_TOOLS = new Set([
	"edit",
	"write",
	"multiedit",
	"apply_patch",
	"str_replace_editor",
]);

/** Max chars of the answer's opening sentence kept in a digest. */
const SENTENCE_CHARS = 200;
/** Max files named in one digest (a refactor can touch dozens). */
const DIGEST_FILES = 6;
/**
 * Max chars of the user's message kept per turn. `event.prompt` is the EXPANDED
 * prompt, so an `@file` reference arrives with the whole file inlined; uncapped,
 * one such turn would sit in the detector prefix for the next twelve turns and
 * in the long-retention cache. Head + tail, because the instruction is at one
 * end or the other and the bulk in the middle is the part that is not signal.
 */
const USER_CHARS = 600;

type LooseEntry = {
	id?: string;
	type?: string;
	message?: { role?: string; content?: unknown; customType?: string };
};

/**
 * Digest of what the assistant did after `afterId`: the first substantive
 * sentence plus the files it wrote. Deliberately lossy — see the file header.
 */
export function digestAssistant(entries: unknown[], afterId?: string): string {
	const list = entries as LooseEntry[];
	const start = afterId ? list.findIndex((e) => e.id === afterId) : -1;
	let sentence = "";
	const files: string[] = [];
	for (const entry of list.slice(start + 1)) {
		const msg = entry.message;
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content))
			continue;
		for (const raw of msg.content as Array<Record<string, unknown>>) {
			if (raw.type === "text" && !sentence) {
				const text = String(raw.text ?? "").trim();
				if (text) sentence = firstSentence(text);
			} else if (raw.type === "toolCall" && EDIT_TOOLS.has(String(raw.name))) {
				const args = (raw.arguments ?? {}) as Record<string, unknown>;
				const path = ["path", "file", "filename", "file_path"]
					.map((k) => args[k])
					.find((v): v is string => typeof v === "string" && v.trim() !== "");
				if (path && !files.includes(path)) files.push(path);
			}
		}
	}
	const parts: string[] = [];
	if (sentence) parts.push(sentence);
	if (files.length)
		parts.push(`files: ${files.slice(0, DIGEST_FILES).join(", ")}`);
	return parts.join(" | ");
}

function firstSentence(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const stop = flat.search(/[.!?](\s|$)/);
	const cut = stop > 0 ? flat.slice(0, stop + 1) : flat;
	return cut.length > SENTENCE_CHARS
		? `${cut.slice(0, SENTENCE_CHARS)}…`
		: cut;
}

/** Head + tail of an over-long message, so both ends of the instruction survive. */
function clipUser(text: string): string {
	const flat = text.trim();
	if (flat.length <= USER_CHARS) return flat;
	const head = Math.ceil(USER_CHARS * 0.7);
	const tail = USER_CHARS - head;
	return `${flat.slice(0, head)}\n…\n${flat.slice(-tail)}`;
}

/**
 * Append this turn to the detector's history.
 *
 * The cap is a safety bound only: a task that genuinely runs for fifty turns
 * would otherwise grow the prefix without limit. Normal truncation happens at
 * task boundaries, not here.
 */
export function recordTurn(
	state: TaskState,
	digest: string,
	userText: string,
	cfg: HindsightConfig,
): void {
	const head = digest ? `PREVIOUS ANSWER: ${digest}\n\n` : "";
	state.turns.push({ user: `${head}USER: ${clipUser(userText)}` });
	const cap = Math.max(2, cfg.taskHistoryTurns);
	if (state.turns.length > cap) state.turns.splice(0, state.turns.length - cap);
}

/**
 * Close a turn: on "changed" the finished task's title joins the tail and the
 * history is dropped, so the next turn starts describing the NEW task from
 * scratch. That truncation is what keeps the cached prefix small.
 *
 * An INVALID reply is recorded as no verdict at all. Storing the raw text would
 * replay junk as an assistant turn and few-shot-train the next call to produce
 * more of it. The user turn then stays unanswered, which `renderHistory` folds
 * into the next one rather than emitting two user messages in a row.
 */
export function applyVerdict(
	state: TaskState,
	verdict: TaskVerdict,
	raw: string,
	cfg: HindsightConfig,
): void {
	if (!verdict.changed) {
		if (!verdict.valid) return;
		const last = state.turns[state.turns.length - 1];
		if (last) last.verdict = raw.trim();
		return;
	}
	if (state.title && !state.pastTitles.includes(state.title))
		state.pastTitles.push(state.title);
	const tail = Math.max(0, cfg.taskTitleTail);
	if (state.pastTitles.length > tail)
		state.pastTitles.splice(0, state.pastTitles.length - tail);
	state.title = verdict.title;
	// The message that STARTED the new task stays: it is the only description of
	// the new task the detector will have on the next turn.
	state.turns = state.turns.slice(-1);
	state.turns[0].verdict = raw.trim();
}

/**
 * Render the history as an alternating conversation.
 *
 * The past-task tail and the current title ride on the FIRST user message
 * rather than the system prompt: they change only at a boundary (where the
 * history is dropped anyway), so the cached prefix survives every ordinary turn.
 *
 * Strict alternation is enforced here rather than assumed. A turn can end
 * WITHOUT a verdict in two ways — an unparseable reply, or an error/abort that
 * returns before `applyVerdict` — and consecutive user messages are a hard 400
 * on a strict-alternation provider, which would kill boundary detection
 * silently and permanently for the rest of the session. So unanswered user
 * turns are merged into the next one; nothing is lost but the empty slot.
 */
export function renderHistory(state: TaskState): ModelMessage[] {
	const out: ModelMessage[] = [];
	let pending: string[] = [];
	for (const [i, turn] of state.turns.entries()) {
		let text = turn.user;
		if (i === 0) {
			const header: string[] = [];
			if (state.pastTitles.length)
				header.push(
					`PAST TASKS (earlier in this session):\n${state.pastTitles.map((t) => `- ${t}`).join("\n")}`,
				);
			if (state.title) header.push(`CURRENT TASK: ${state.title}`);
			if (header.length) text = `${header.join("\n\n")}\n\n${text}`;
		}
		pending.push(text);
		if (!turn.verdict) continue;
		out.push({ role: "user", text: pending.join("\n\n") });
		pending = [];
		out.push({ role: "assistant", text: turn.verdict });
	}
	if (pending.length) out.push({ role: "user", text: pending.join("\n\n") });
	// A trailing assistant turn would leave the model nothing to answer.
	if (out[out.length - 1]?.role === "assistant") out.pop();
	return out;
}

/**
 * Run one detection pass. Never throws: a dead model chain means "unchanged",
 * because the fallback for an unknown boundary must be the CHEAP path.
 */
export async function detectTaskChange(
	ctx: ExtensionContext,
	cfg: HindsightConfig,
	chain: ModelChain,
	state: TaskState,
	sessionId: string | undefined,
	signal?: AbortSignal,
): Promise<TaskVerdict> {
	const cwd = ctx.cwd ?? process.cwd();
	const messages = renderHistory(state);
	if (messages.length === 0) return { changed: false, valid: false };
	let raw: string;
	try {
		raw = await runModel(ctx, chain, TASK_DETECTOR, messages, {
			maxTokens: 120,
			signal,
			// Always cache: break-even is ~83 tokens of prefix and the unused-write
			// surcharge is fifteen millionths of a cent, so a "should we?" check
			// costs more than being wrong in either direction.
			cacheRetention: "long",
			sessionId,
		});
	} catch (err) {
		if (signal?.aborted) return { changed: false, valid: false };
		appendDebug(cwd, "task.detect.error", { error: (err as Error).message });
		return { changed: false, valid: false };
	}
	const verdict = parseTaskVerdict(raw);
	appendDebug(cwd, "task.detect", {
		turns: state.turns.length,
		pastTitles: state.pastTitles.length,
		output: raw,
		changed: verdict.changed,
		valid: verdict.valid,
	});
	applyVerdict(state, verdict, raw, cfg);
	return verdict;
}

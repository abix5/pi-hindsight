/**
 * Delta extraction + deterministic (no-LLM) cleaning + chunking.
 *
 * The goal here is only to SHRINK the raw transcript before it reaches the small
 * model — never to "understand" it. Cleaning is rule-based per entry/tool type;
 * chunk size is derived from the working model's context window.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Read-only navigation/recon tools whose calls & results are pure noise for memory. */
const NAV_TOOLS = new Set(["grep", "find", "ls", "read", "glob"]);
/** Tools that mutate files — keep a one-line marker, drop the body. */
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch"]);

/** Max lines kept from a bash/exec result body. */
const BASH_OUTPUT_LINES = 20;
/** Max lines kept from a long code block / dump before truncation. */
const CODE_BLOCK_LINES = 40;
/** Rough chars-per-token estimate for budgeting. */
const CHARS_PER_TOKEN = 4;

type Msg = { role: string; [k: string]: unknown };

interface TextC {
	type: "text";
	text: string;
}
interface ThinkingC {
	type: "thinking";
	text?: string;
}
interface ToolCallC {
	type: "toolCall";
	name: string;
	arguments?: Record<string, unknown>;
}

/**
 * Return session entries strictly AFTER the watermark and strictly BEFORE the
 * compaction boundary (firstKeptEntryId).
 *
 * The upper bound is the crux of memory quality. pi compacts (summarizes and
 * discards) ONLY the entries before firstKeptEntryId; the tail from that id
 * onward stays live in context. If we memorized to the end we would also ingest
 * that still-live tail — which keeps growing and gets memorized AGAIN on the
 * next compaction, producing paraphrased duplicate facts in the bank. Bounding
 * the delta at firstKeptEntryId makes us capture EXACTLY the window compaction
 * is discarding — no more, no less.
 *
 * With no watermark the window starts at the beginning; with no boundary
 * (manual flush) it runs to the end.
 */
export function getDeltaEntries(
	entries: SessionEntry[],
	watermarkId: string | undefined,
	boundaryId?: string,
): SessionEntry[] {
	const startIdx = watermarkId
		? entries.findIndex((e) => e.id === watermarkId)
		: -1;
	let endIdx = entries.length;
	if (boundaryId) {
		const bi = entries.findIndex((e) => e.id === boundaryId);
		if (bi >= 0) endIdx = bi;
	}
	// Watermark already at/after the boundary → nothing new in this window.
	if (startIdx + 1 >= endIdx) return [];
	return entries.slice(startIdx + 1, endIdx);
}

function truncateLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return `${lines.slice(0, maxLines).join("\n")}\n… (+${lines.length - maxLines} lines truncated)`;
}

function firstString(
	obj: Record<string, unknown> | undefined,
	keys: string[],
): string | undefined {
	if (!obj) return undefined;
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "string" && v.trim()) return v;
	}
	return undefined;
}

/** Clean a single assistant message into kept lines (text/thinking/relevant tool calls). */
function cleanAssistant(content: unknown[]): string[] {
	const out: string[] = [];
	for (const block of content as Array<
		TextC | ThinkingC | ToolCallC | { type: string }
	>) {
		if (block.type === "text" && (block as TextC).text.trim()) {
			out.push((block as TextC).text.trim());
		} else if (block.type === "thinking") {
			const t = (block as ThinkingC).text;
			if (t && t.trim()) out.push(truncateLines(t.trim(), CODE_BLOCK_LINES));
		} else if (block.type === "toolCall") {
			const tc = block as ToolCallC;
			const name = tc.name;
			if (NAV_TOOLS.has(name)) continue; // recon noise
			if (EDIT_TOOLS.has(name)) {
				const path = firstString(tc.arguments, ["path", "file", "filename"]);
				out.push(`[edited ${path ?? "file"}]`);
			} else if (name === "bash") {
				const cmd = firstString(tc.arguments, ["command", "cmd", "script"]);
				if (cmd) out.push(`$ ${cmd}`);
			}
			// other tools: skip the call, their meaningful outcome shows up in text
		}
	}
	return out;
}

/** Concatenate the text of a message content field (string or content array). */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content) {
		if ((b as { type?: string }).type === "text") parts.push((b as TextC).text);
	}
	return parts.join("\n");
}

/** Clean one entry into a role-tagged block, or null to drop it. */
function cleanEntry(entry: SessionEntry): string | null {
	if (entry.type !== "message") return null;
	const msg = (entry as unknown as { message: Msg }).message;
	if (!msg || typeof msg !== "object") return null;

	if (msg.role === "user") {
		const trimmed = extractText(msg.content).trim();
		return trimmed ? `USER: ${trimmed}` : null;
	}

	if (msg.role === "assistant") {
		const lines = cleanAssistant((msg.content as unknown[]) ?? []);
		return lines.length ? `ASSISTANT: ${lines.join("\n")}` : null;
	}

	if (msg.role === "toolResult") {
		const toolName = (msg.toolName as string) ?? "tool";
		if (NAV_TOOLS.has(toolName)) return null; // drop nav results entirely
		const isError = Boolean(msg.isError);
		const status = isError ? "err" : "ok";
		if (toolName === "bash") {
			const body = truncateLines(
				extractText(msg.content).trim(),
				BASH_OUTPUT_LINES,
			);
			return body ? `OUTPUT(${status}): ${body}` : null;
		}
		// any other tool result: keep only a one-line status marker
		return `[${toolName} → ${status}]`;
	}

	return null;
}

/** Clean + serialize delta entries into a single plain-text transcript. */
export function serializeDelta(entries: SessionEntry[]): string {
	const blocks: string[] = [];
	for (const e of entries) {
		const cleaned = cleanEntry(e);
		if (cleaned) blocks.push(cleaned);
	}
	return blocks.join("\n\n");
}

/**
 * Split text into chunks each fitting the model's window.
 * maxChars is derived from the working model: contextWindow * fraction * charsPerToken.
 * Splits on blank-line boundaries where possible.
 */
export function chunkByWindow(
	text: string,
	contextWindow: number,
	inputFraction: number,
): string[] {
	const maxChars = Math.max(
		2000,
		Math.floor(contextWindow * inputFraction * CHARS_PER_TOKEN),
	);
	if (text.length <= maxChars) return text.trim() ? [text] : [];

	const blocks = text.split("\n\n");
	const chunks: string[] = [];
	let cur = "";
	for (const block of blocks) {
		if (block.length > maxChars) {
			// A single oversized block: hard-split by characters.
			if (cur) {
				chunks.push(cur);
				cur = "";
			}
			for (let i = 0; i < block.length; i += maxChars) {
				chunks.push(block.slice(i, i + maxChars));
			}
			continue;
		}
		if (cur.length + block.length + 2 > maxChars) {
			chunks.push(cur);
			cur = block;
		} else {
			cur = cur ? `${cur}\n\n${block}` : block;
		}
	}
	if (cur.trim()) chunks.push(cur);
	return chunks;
}

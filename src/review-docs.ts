/**
 * Data layer for the /mem Review tab.
 *
 * The review QUEUE (review-queue.ts) only tracks which documents still need a
 * look; the BANK is the source of truth for their text. This module joins the
 * two: it hydrates queue entries with the stored document, and applies the three
 * review actions (approve / delete / edit) against whatever bank coordinates the
 * queue recorded — entries can come from OTHER projects, so we never assume the
 * current session's client.
 *
 * SECURITY: a queue entry's baseUrl is only honoured when it points at
 * localhost/127.0.0.1, and docIds must match /^[\w-]+$/ before going into a URL.
 */

import * as path from "node:path";
import {
	type PendingDoc,
	loadPending,
	markDone,
	projectLanguage,
} from "./review-queue.ts";
import { retainContext, retainMetadata } from "./retain-hygiene.ts";

const DOC_ID_RE = /^[\w-]+$/;

/** A queue entry joined with the document text stored in the bank. */
export interface ReviewDoc {
	docId: string;
	bank: string;
	baseUrl: string;
	namespace: string;
	project: string;
	reason: string;
	ts: string;
	text: string;
	createdAt: string;
	factCount: number;
	/**
	 * Language of the bank this document belongs to — from the queue entry, which
	 * recorded it in the ORIGIN project. "" only for entries written before the
	 * field existed AND whose project no longer declares one.
	 */
	language: string;
	/** True when the bank could not be reached for this entry. */
	unreachable: boolean;
}

/** Accept only localhost bank URLs recorded in the queue (anti-SSRF guard). */
function safeBaseUrl(u: string): string | undefined {
	if (u.startsWith("http://localhost") || u.startsWith("http://127.0.0.1"))
		return u.replace(/\/+$/, "");
	return undefined;
}

function bankBase(doc: {
	baseUrl: string;
	namespace: string;
	bank: string;
}): string {
	return `${doc.baseUrl}/v1/${encodeURIComponent(doc.namespace)}/banks/${encodeURIComponent(doc.bank)}`;
}

/** fetch with a hard timeout (undefined on any failure/timeout). */
async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	ms: number,
): Promise<Response | undefined> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), ms);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

async function hydrate(p: PendingDoc): Promise<ReviewDoc | undefined> {
	const base = safeBaseUrl(p.baseUrl);
	// A malformed docId or bad baseUrl can never be actioned safely — drop it.
	// Stamped `auto` so the audit trail does not later read as a human decision.
	if (!base || !DOC_ID_RE.test(p.docId)) {
		markDone(p.docId, "approved", "auto");
		return undefined;
	}
	const coords = { ...p, baseUrl: base };
	const url = `${bankBase(coords)}/documents/${encodeURIComponent(p.docId)}`;
	const res = await fetchWithTimeout(url, { method: "GET" }, 5000);
	const shell: ReviewDoc = {
		docId: p.docId,
		bank: p.bank,
		baseUrl: base,
		namespace: p.namespace,
		project: p.project,
		reason: p.reason,
		ts: p.ts,
		text: "",
		createdAt: "",
		factCount: 0,
		// Legacy entries carry no language: fall back to the origin project's own
		// config rather than to the reviewing session's.
		language: p.language || projectLanguage(p.project),
		unreachable: false,
	};
	// Network/timeout: keep it pending but flag it, so the user is not silently
	// missing an entry.
	if (!res) return { ...shell, unreachable: true };
	if (res.status === 404) {
		// Auto-drop: nothing stored / already gone. Nobody reviewed this either.
		markDone(p.docId, "approved", "auto");
		return undefined;
	}
	let doc: Record<string, unknown> = {};
	try {
		doc = (await res.json()) as Record<string, unknown>;
	} catch {
		/* leave doc empty */
	}
	return {
		...shell,
		text: typeof doc.original_text === "string" ? doc.original_text : "",
		createdAt: typeof doc.created_at === "string" ? doc.created_at : "",
		factCount:
			typeof doc.memory_unit_count === "number" ? doc.memory_unit_count : 0,
	};
}

/** The current pending set, newest first, joined with bank document text. */
export async function loadReviewDocs(): Promise<ReviewDoc[]> {
	const settled = await Promise.allSettled(loadPending().map(hydrate));
	const out: ReviewDoc[] = [];
	for (const r of settled)
		if (r.status === "fulfilled" && r.value) out.push(r.value);
	return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

/** Approve: leave the document in the bank, drop it from the queue. */
export function approveDoc(doc: ReviewDoc): void {
	markDone(doc.docId, "approved");
}

/** Delete the document (and its facts) from the bank, then drop it from the queue. */
export async function deleteDoc(doc: ReviewDoc): Promise<void> {
	const url = `${bankBase(doc)}/documents/${encodeURIComponent(doc.docId)}`;
	const res = await fetchWithTimeout(url, { method: "DELETE" }, 10_000);
	// Tolerate 404 (already gone); any other hard failure keeps it queued.
	if (res && !res.ok && res.status !== 404)
		throw new Error(`bank ${res.status}`);
	markDone(doc.docId, "deleted");
}

/**
 * Re-retain the edited text under the SAME document_id → Hindsight upserts
 * (deletes the old document + its facts, then re-extracts). Stays in the queue
 * so the user can review the result of their edit and then approve it.
 *
 * `language` comes from the caller because a queue entry can belong to ANOTHER
 * project, whose bank may be kept in a different language than this session's.
 */
export async function editDoc(
	doc: ReviewDoc,
	text: string,
	language: string,
): Promise<void> {
	const provenance = {
		project: path.basename(doc.project) || doc.bank,
		language,
	};
	const item = {
		content: text,
		document_id: doc.docId,
		tags: [doc.bank, "agent-summary"],
		context: retainContext("user-edit", provenance),
		metadata: retainMetadata("user-edit", provenance),
		timestamp: new Date().toISOString(),
	};
	const res = await fetchWithTimeout(
		`${bankBase(doc)}/memories`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ items: [item], async: true }),
		},
		10_000,
	);
	if (!res || !res.ok) throw new Error(`bank ${res?.status ?? "unreachable"}`);
}

/**
 * Local review server for /mem-review.
 *
 * Serves a tiny single-file web UI (no framework, no external deps) that folds
 * the GLOBAL review queue across every project and lets the user Approve / Edit
 * / Delete each stored document. The bank is the source of truth for document
 * text; the queue only tracks what still needs review.
 *
 * Concurrency: each pi session may run its own ephemeral server (127.0.0.1,
 * port 0). That is safe because the queue file is append-only + atomic and the
 * bank is shared — two servers just show overlapping views of the same queue.
 *
 * SECURITY: bind 127.0.0.1 only; validate docId with /^[\w-]+$/ before putting
 * it in a URL; cap request bodies at 1MB; only fixed routes (no path traversal);
 * and any baseUrl coming from the browser MUST point at localhost/127.0.0.1 so
 * the page cannot be used to proxy arbitrary hosts.
 */

import { spawn } from "node:child_process";
import * as http from "node:http";
import { type PendingDoc, loadPending, markDone } from "./review-queue.ts";

/** A live server instance, reused across repeated /mem-review invocations. */
interface Running {
	server: http.Server;
	url: string;
}
let running: Running | undefined;

const DOC_ID_RE = /^[\w-]+$/;
const BODY_LIMIT = 1_000_000;

/** Accept only localhost bank URLs from the browser (anti-proxy guard). */
function safeBaseUrl(u: unknown): string | undefined {
	if (typeof u !== "string") return undefined;
	if (u.startsWith("http://localhost") || u.startsWith("http://127.0.0.1"))
		return u.replace(/\/+$/, "");
	return undefined;
}

function bankBase(baseUrl: string, namespace: string, bank: string): string {
	return `${baseUrl}/v1/${encodeURIComponent(namespace)}/banks/${encodeURIComponent(bank)}`;
}

/** fetch with a hard timeout (returns undefined on any failure/timeout). */
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

/** Read a request body with a 1MB cap; rejects the connection if exceeded. */
function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > BODY_LIMIT) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sendJson(
	res: http.ServerResponse,
	status: number,
	body: unknown,
): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
}

/**
 * Build the /api/queue payload: fold the queue, then hydrate each pending doc
 * from its bank (concurrently, 5s each). A 404 means the doc was never stored
 * (e.g. a taskflow build → NONE) or already deleted — auto-drop it by writing a
 * "done" event and excluding it from the response.
 */
async function buildQueue(): Promise<unknown[]> {
	const pending = loadPending();
	const results = await Promise.allSettled(pending.map((p) => hydrate(p)));
	const out: unknown[] = [];
	for (const r of results) {
		if (r.status === "fulfilled" && r.value) out.push(r.value);
	}
	return out;
}

async function hydrate(p: PendingDoc): Promise<unknown | undefined> {
	const base = safeBaseUrl(p.baseUrl);
	// A malformed docId or bad baseUrl can never be actioned safely — drop it.
	if (!base || !DOC_ID_RE.test(p.docId)) {
		markDone(p.docId, "approved");
		return undefined;
	}
	const url = `${bankBase(base, p.namespace, p.bank)}/documents/${encodeURIComponent(p.docId)}`;
	const res = await fetchWithTimeout(url, { method: "GET" }, 5000);
	if (!res) {
		// Network/timeout: keep it pending but show it as unreachable so the user
		// is not silently missing an entry.
		return {
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
			unreachable: true,
		};
	}
	if (res.status === 404) {
		markDone(p.docId, "approved"); // auto-drop: nothing stored / already gone
		return undefined;
	}
	let doc: Record<string, unknown> = {};
	try {
		doc = (await res.json()) as Record<string, unknown>;
	} catch {
		/* leave doc empty */
	}
	return {
		docId: p.docId,
		bank: p.bank,
		baseUrl: base,
		namespace: p.namespace,
		project: p.project,
		reason: p.reason,
		ts: p.ts,
		text: typeof doc.original_text === "string" ? doc.original_text : "",
		createdAt: typeof doc.created_at === "string" ? doc.created_at : "",
		factCount:
			typeof doc.memory_unit_count === "number" ? doc.memory_unit_count : 0,
	};
}

/** Parse + validate the common {docId,bank,baseUrl,namespace} action fields. */
function parseAction(
	body: string,
):
	| { docId: string; bank: string; baseUrl: string; namespace: string }
	| undefined {
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const docId = obj.docId;
	const base = safeBaseUrl(obj.baseUrl);
	if (typeof docId !== "string" || !DOC_ID_RE.test(docId) || !base)
		return undefined;
	return {
		docId,
		bank: typeof obj.bank === "string" ? obj.bank : "",
		baseUrl: base,
		namespace: typeof obj.namespace === "string" ? obj.namespace : "default",
	};
}

async function handleApprove(body: string): Promise<[number, unknown]> {
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return [400, { error: "bad json" }];
	}
	if (typeof obj.docId !== "string" || !DOC_ID_RE.test(obj.docId))
		return [400, { error: "bad docId" }];
	markDone(obj.docId, "approved");
	return [200, { ok: true }];
}

async function handleDelete(body: string): Promise<[number, unknown]> {
	const a = parseAction(body);
	if (!a) return [400, { error: "bad request" }];
	const url = `${bankBase(a.baseUrl, a.namespace, a.bank)}/documents/${encodeURIComponent(a.docId)}`;
	const res = await fetchWithTimeout(url, { method: "DELETE" }, 10_000);
	// Tolerate 404 (already gone). Any other hard failure → report it, keep queued.
	if (res && !res.ok && res.status !== 404)
		return [502, { error: `bank ${res.status}` }];
	markDone(a.docId, "deleted");
	return [200, { ok: true }];
}

async function handleEdit(body: string): Promise<[number, unknown]> {
	const a = parseAction(body);
	if (!a) return [400, { error: "bad request" }];
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return [400, { error: "bad json" }];
	}
	const text = obj.text;
	if (typeof text !== "string" || !text.trim())
		return [400, { error: "empty text" }];
	// Re-retain with the SAME document_id → Hindsight upserts (deletes the old
	// doc + its facts, re-extracts from the edited text). Stays in the queue so
	// the user can review the edit result, then approve.
	const item = {
		content: text,
		document_id: a.docId,
		tags: [a.bank, "agent-summary"],
		context:
			"Curated long-term engineering notes, manually reviewed and edited by the user. Treat every line as an established fact about this project.",
		timestamp: new Date().toISOString(),
	};
	const url = `${bankBase(a.baseUrl, a.namespace, a.bank)}/memories`;
	const res = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ items: [item], async: true }),
		},
		10_000,
	);
	if (!res || !res.ok)
		return [502, { error: `bank ${res?.status ?? "unreachable"}` }];
	return [200, { ok: true }];
}

async function route(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const method = req.method ?? "GET";
	const url = (req.url ?? "/").split("?")[0];

	if (method === "GET" && url === "/") {
		const html = PAGE;
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"content-length": Buffer.byteLength(html),
		});
		res.end(html);
		return;
	}
	if (method === "GET" && url === "/api/queue") {
		sendJson(res, 200, { docs: await buildQueue() });
		return;
	}
	if (
		method === "POST" &&
		(url === "/api/approve" || url === "/api/delete" || url === "/api/edit")
	) {
		let body: string;
		try {
			body = await readBody(req);
		} catch {
			sendJson(res, 413, { error: "body too large" });
			return;
		}
		const [status, payload] =
			url === "/api/approve"
				? await handleApprove(body)
				: url === "/api/delete"
					? await handleDelete(body)
					: await handleEdit(body);
		sendJson(res, status, payload);
		return;
	}
	sendJson(res, 404, { error: "not found" });
}

/** Spawn the OS default-browser opener, detached; failures are ignored. */
function openBrowser(url: string): void {
	try {
		const cmd =
			process.platform === "darwin"
				? "open"
				: process.platform === "win32"
					? "cmd"
					: "xdg-open";
		const args =
			process.platform === "win32" ? ["/c", "start", "", url] : [url];
		const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
		child.unref();
	} catch {
		/* best-effort: the URL is always also printed via notify */
	}
}

/**
 * Start the review server if not already running, open the browser, and return
 * the URL. A second call while running just re-opens/returns the existing URL.
 */
export async function startReviewServer(): Promise<string> {
	if (running) {
		openBrowser(running.url);
		return running.url;
	}
	const server = http.createServer((req, res) => {
		void route(req, res).catch(() => {
			try {
				sendJson(res, 500, { error: "internal" });
			} catch {
				/* response may already be sent */
			}
		});
	});
	// Never keep the pi process alive just because the server is idle-listening.
	const url = await new Promise<string>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve(`http://127.0.0.1:${port}/`);
		});
	});
	server.unref?.();
	running = { server, url };
	openBrowser(url);
	return url;
}

/** Is the review server currently listening? */
export function isReviewServerRunning(): boolean {
	return !!running;
}

/** Close the review server if running (idempotent). */
export function stopReviewServer(): void {
	if (!running) return;
	try {
		running.server.close();
	} catch {
		/* best-effort */
	}
	running = undefined;
}

/** The single-file review UI. Vanilla HTML/CSS/JS, dark theme, no deps. */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory Review</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0e0f13; color: #d7dae0;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { position: sticky; top: 0; background: #14161c; border-bottom: 1px solid #23262f;
    padding: 12px 20px; display: flex; align-items: center; gap: 12px; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .sp { flex: 1; }
  button { font: inherit; border: 1px solid #2c303b; background: #1b1e26; color: #d7dae0;
    padding: 6px 12px; border-radius: 6px; cursor: pointer; }
  button:hover { background: #232733; }
  button.primary { background: #1f6feb33; border-color: #1f6feb; color: #cfe0ff; }
  button.danger { background: #f8514933; border-color: #f85149; color: #ffd0cc; }
  button.ok { background: #2ea04333; border-color: #2ea043; color: #c6f6d5; }
  main { padding: 20px; max-width: 960px; margin: 0 auto; }
  .group { margin-bottom: 28px; }
  .group h2 { font-size: 13px; color: #9aa0ac; font-weight: 600; text-transform: none;
    border-bottom: 1px solid #23262f; padding-bottom: 6px; display: flex; align-items: center; gap: 10px; }
  .group h2 .path { color: #c9ccd3; font-family: ui-monospace, monospace; }
  .card { background: #14161c; border: 1px solid #23262f; border-radius: 8px;
    padding: 14px; margin: 12px 0; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: 12px; color: #8b909b;
    margin-bottom: 10px; }
  .meta b { color: #b7bcc7; font-weight: 600; }
  pre, textarea { background: #0b0c10; border: 1px solid #23262f; border-radius: 6px;
    padding: 10px; white-space: pre-wrap; word-break: break-word; margin: 0 0 10px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cfd3da; }
  textarea { width: 100%; min-height: 180px; resize: vertical; display: block; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .tag { background: #1b1e26; border: 1px solid #2c303b; border-radius: 999px;
    padding: 1px 8px; font-size: 11px; }
  .empty { color: #8b909b; text-align: center; padding: 60px 0; }
  .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
    background: #1b1e26; border: 1px solid #2c303b; padding: 8px 16px; border-radius: 8px;
    opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .unreachable { color: #f0a35e; }
</style>
</head>
<body>
<header>
  <h1>Memory Review</h1>
  <span class="tag" id="count">…</span>
  <span class="sp"></span>
  <button id="refresh">Refresh</button>
</header>
<main id="root"><div class="empty">Loading…</div></main>
<div class="toast" id="toast"></div>
<script>
const root = document.getElementById("root");
const countEl = document.getElementById("count");
const toastEl = document.getElementById("toast");
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg; toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}
function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
function fmtDate(s) { if (!s) return "—"; const d = new Date(s); return isNaN(d) ? s : d.toLocaleString(); }

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

let docs = [];
async function load() {
  root.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const res = await fetch("/api/queue");
    const data = await res.json();
    docs = data.docs || [];
  } catch (e) { docs = []; }
  render();
}

function groupByProject(list) {
  const g = new Map();
  for (const d of list) {
    const k = d.project || "(unknown)";
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(d);
  }
  return g;
}

function render() {
  countEl.textContent = docs.length + " pending";
  if (docs.length === 0) {
    root.innerHTML = '<div class="empty">Nothing to review. All caught up.</div>';
    return;
  }
  const groups = groupByProject(docs);
  root.innerHTML = "";
  for (const [project, list] of groups) {
    const sec = document.createElement("section");
    sec.className = "group";
    const h = document.createElement("h2");
    h.innerHTML = '<span class="path">' + esc(project) + '</span>'
      + '<span class="tag">' + list.length + '</span>';
    const approveAll = document.createElement("button");
    approveAll.textContent = "Approve all in project";
    approveAll.onclick = async () => {
      for (const d of list) await api("/api/approve", { docId: d.docId });
      toast("Approved " + list.length + " in project");
      load();
    };
    h.appendChild(approveAll);
    sec.appendChild(h);
    for (const d of list) sec.appendChild(card(d));
    root.appendChild(sec);
  }
}

function card(d) {
  const el = document.createElement("div");
  el.className = "card";
  const meta = '<div class="meta">'
    + '<span><b>bank</b> ' + esc(d.bank) + '</span>'
    + '<span><b>date</b> ' + esc(fmtDate(d.createdAt || d.ts)) + '</span>'
    + '<span><b>reason</b> ' + esc(d.reason || "—") + '</span>'
    + '<span><b>facts</b> ' + esc(String(d.factCount ?? 0)) + '</span>'
    + (d.unreachable ? '<span class="unreachable">bank unreachable</span>' : '')
    + '</div>';
  const pre = document.createElement("pre");
  pre.textContent = d.text || (d.unreachable ? "(could not load document)" : "(nothing stored)");

  const row = document.createElement("div");
  row.className = "row";
  const approve = document.createElement("button");
  approve.className = "ok"; approve.textContent = "Approve";
  approve.onclick = async () => { await api("/api/approve", { docId: d.docId }); toast("Approved"); load(); };
  const edit = document.createElement("button");
  edit.textContent = "Edit";
  const del = document.createElement("button");
  del.className = "danger"; del.textContent = "Delete";
  del.onclick = async () => {
    if (!confirm("Delete this document from the bank?")) return;
    await api("/api/delete", { docId: d.docId, bank: d.bank, baseUrl: d.baseUrl, namespace: d.namespace });
    toast("Deleted"); load();
  };

  edit.onclick = () => {
    const ta = document.createElement("textarea");
    ta.value = d.text || "";
    const save = document.createElement("button");
    save.className = "primary"; save.textContent = "Save";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const erow = document.createElement("div");
    erow.className = "row";
    erow.append(save, cancel);
    pre.replaceWith(ta);
    row.replaceWith(erow);
    save.onclick = async () => {
      const r = await api("/api/edit", { docId: d.docId, bank: d.bank, baseUrl: d.baseUrl, namespace: d.namespace, text: ta.value });
      if (r.ok) { toast("Saved — re-extracting"); load(); }
      else { toast("Save failed: " + (r.error || "error")); }
    };
    cancel.onclick = () => load();
  };

  row.append(approve, edit, del);
  el.innerHTML = meta;
  el.appendChild(pre);
  el.appendChild(row);
  return el;
}

document.getElementById("refresh").onclick = load;
load();
</script>
</body>
</html>`;

/**
 * Local dashboard server for /mem.
 *
 * Serves a tiny single-file web UI (no framework, no external deps) with FOUR
 * tabs:
 *   - Review   — fold the GLOBAL review queue across every project and let the
 *                user Approve / Edit / Delete each stored document.
 *   - Settings — edit the global (~/.pi/agent/hindsight.json) and project-local
 *                (.pi/hindsight.json) override layers, including the fact-category
 *                tri-state editor.
 *   - Log      — recent operations read from the resolved cfg.logPath JSONL.
 *   - Status   — health dot + bank counts + a read-only resolved-config summary.
 *
 * The bank is the source of truth for document text; the queue only tracks what
 * still needs review.
 *
 * Concurrency: each pi session may run its own ephemeral server (127.0.0.1,
 * port 0). That is safe because the queue file is append-only + atomic and the
 * bank is shared — two servers just show overlapping views of the same queue.
 *
 * SECURITY: bind 127.0.0.1 only; validate docId with /^[\w-]+$/ before putting
 * it in a URL; cap request bodies at 1MB; only fixed routes (no path traversal);
 * and any baseUrl coming from the browser MUST point at localhost/127.0.0.1 so
 * the page cannot be used to proxy arbitrary hosts. New endpoints inherit the
 * same guards; config writes are validated against CONFIG_ALLOW; nothing dumps
 * process.env.
 */

import { spawn } from "node:child_process";
import * as http from "node:http";
import { resolveCategories } from "./categories.ts";
import {
	CONFIG_ALLOW,
	globalConfigPath,
	type HindsightConfig,
	patchConfigFile,
	projectConfigPath,
	readGlobalOverrides,
	readProjectOverrides,
} from "./config.ts";
import type { HindsightClient } from "./hindsight.ts";
import { readLog } from "./log.ts";
import { type PendingDoc, loadPending, markDone } from "./review-queue.ts";

/** Per-session context the dashboard needs to read/write config and hit the bank. */
export interface DashboardDeps {
	/** The cwd that launched this session (project root). */
	cwd: string;
	/** Load the current resolved config (re-read each call so edits show up). */
	loadCfg: () => HindsightConfig;
	/** Client bound to the active bank, for health/stats/mission live-sync. */
	client: HindsightClient;
}

/** A live server instance, reused across repeated /mem invocations. */
interface Running {
	server: http.Server;
	url: string;
	deps: DashboardDeps;
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
			tags: [],
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
		tags: Array.isArray(doc.tags) ? doc.tags : [],
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

/** UI-relevant config fields — deliberately a subset (no secrets, no env dump). */
function pickResolved(cfg: HindsightConfig): Record<string, unknown> {
	return {
		baseUrl: cfg.baseUrl,
		namespace: cfg.namespace,
		bankId: cfg.bankId,
		active: cfg.active,
		memoryLanguage: cfg.memoryLanguage,
		retainMission: cfg.retainMission,
		observationsMission: cfg.observationsMission,
		recallEffort: cfg.recallEffort,
		recallOperation: cfg.recallOperation,
		recallFilter: cfg.recallFilter,
		autoRecall: cfg.autoRecall,
		autoMemorize: cfg.autoMemorize,
		memorizeEngine: cfg.memorizeEngine,
		recallModelId: cfg.recallModelId,
		retainModelId: cfg.retainModelId,
	};
}

/** GET /api/config — the two override layers + resolved subset + categories. */
function handleGetConfig(deps: DashboardDeps): [number, unknown] {
	const cfg = deps.loadCfg();
	return [
		200,
		{
			globalPath: globalConfigPath(),
			projectPath: projectConfigPath(deps.cwd),
			active: cfg.active,
			global: readGlobalOverrides(),
			project: readProjectOverrides(deps.cwd),
			resolved: pickResolved(cfg),
			// Tri-state list resolved against the effective (project) config, so the
			// editor reflects overrides already stored under factCategories.
			categories: resolveCategories(cfg).map((c) => ({
				key: c.key,
				label: c.label,
				state: c.state,
				custom: !!c.custom,
			})),
		},
	];
}

/**
 * POST /api/config — validate every key against CONFIG_ALLOW then persist to the
 * chosen scope. Mission edits are additionally pushed to the ACTIVE bank live
 * (best-effort): most other fields only take effect after /reload.
 */
async function handlePostConfig(
	deps: DashboardDeps,
	body: string,
): Promise<[number, unknown]> {
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return [400, { error: "bad json" }];
	}
	const scope = obj.scope === "global" ? "global" : "project";
	const patch = obj.patch;
	if (!patch || typeof patch !== "object" || Array.isArray(patch))
		return [400, { error: "missing patch" }];
	// Reject any key that is not part of the allow-list — the config writer only
	// ever accepts these, but we fail loud rather than silently dropping keys.
	for (const k of Object.keys(patch)) {
		if (!CONFIG_ALLOW.has(k as keyof HindsightConfig))
			return [400, { error: `unknown key: ${k}` }];
	}
	const ok = patchConfigFile(deps.cwd, patch as Record<string, unknown>, scope);
	if (!ok) return [500, { error: "write failed" }];

	// Missions steer the bank's extractor directly, so we apply them live in
	// addition to persisting them. Push the NEW effective values (project wins
	// over global) so the bank always matches what the UI now shows.
	let bankSynced = false;
	const touchesMission =
		"retainMission" in (patch as object) ||
		"observationsMission" in (patch as object);
	if (touchesMission) {
		const eff = deps.loadCfg();
		const updates: Record<string, unknown> = {};
		if ("retainMission" in (patch as object))
			updates.retain_mission = eff.retainMission;
		if ("observationsMission" in (patch as object))
			updates.observations_mission = eff.observationsMission;
		try {
			await deps.client.updateBankConfig(updates);
			bankSynced = true;
		} catch {
			bankSynced = false; // best-effort: reload will re-sync at startup
		}
	}
	return [200, { ok: true, needsReload: true, bankSynced }];
}

/** GET /api/status — health + bank counts + a read-only resolved-config subset. */
async function handleStatus(deps: DashboardDeps): Promise<[number, unknown]> {
	const cfg = deps.loadCfg();
	let health = false;
	try {
		await deps.client.health();
		health = true;
	} catch {
		health = false;
	}
	let bank: { documents: number; facts: number } | null = null;
	try {
		bank = await deps.client.stats();
	} catch {
		bank = null;
	}
	return [
		200,
		{
			health,
			bank,
			cfg: {
				baseUrl: cfg.baseUrl,
				namespace: cfg.namespace,
				bankId: cfg.bankId,
				active: cfg.active,
				memorizeEngine: cfg.memorizeEngine,
				recallEffort: cfg.recallEffort,
				memoryLanguage: cfg.memoryLanguage,
				recallModelId: cfg.recallModelId,
				retainModelId: cfg.retainModelId,
			},
		},
	];
}

/** GET /api/log — last N parsed JSONL entries from the resolved log path. */
function handleLog(deps: DashboardDeps, limit: number): [number, unknown] {
	const cfg = deps.loadCfg();
	// readLog already tails the file and returns newest-first; malformed lines
	// throw inside JSON.parse and abort the read → empty (best-effort).
	const entries = readLog(deps.cwd, cfg.logPath, limit);
	return [200, { entries }];
}

async function route(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	deps: DashboardDeps,
): Promise<void> {
	const method = req.method ?? "GET";
	const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
	const url = parsed.pathname;

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
	if (method === "GET" && url === "/api/config") {
		const [status, payload] = handleGetConfig(deps);
		sendJson(res, status, payload);
		return;
	}
	if (method === "GET" && url === "/api/status") {
		const [status, payload] = await handleStatus(deps);
		sendJson(res, status, payload);
		return;
	}
	if (method === "GET" && url === "/api/log") {
		const raw = Number.parseInt(parsed.searchParams.get("limit") ?? "", 10);
		const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1000) : 100;
		const [status, payload] = handleLog(deps, limit);
		sendJson(res, status, payload);
		return;
	}
	if (
		method === "POST" &&
		(url === "/api/approve" ||
			url === "/api/delete" ||
			url === "/api/edit" ||
			url === "/api/config")
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
					: url === "/api/edit"
						? await handleEdit(body)
						: await handlePostConfig(deps, body);
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
 * Start the dashboard server if not already running, open the browser, and
 * return the URL. A second call while running refreshes the stored deps (so a
 * new session's cwd/client wins) and just re-opens/returns the existing URL.
 */
export async function startDashboard(deps: DashboardDeps): Promise<string> {
	if (running) {
		running.deps = deps;
		openBrowser(running.url);
		return running.url;
	}
	// Capture the singleton's deps by closure so each request reads the latest.
	const server = http.createServer((req, res) => {
		void route(req, res, running?.deps ?? deps).catch(() => {
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
	running = { server, url, deps };
	openBrowser(url);
	return url;
}

/**
 * Back-compat alias: the pre-dashboard command still imports `startReviewServer`.
 * Kept as a synonym for `startDashboard` until the command layer is rewired.
 */
export const startReviewServer = startDashboard;

/** Is the dashboard server currently listening? */
export function isReviewServerRunning(): boolean {
	return !!running;
}

/** Close the dashboard server if running (idempotent). */
export function stopReviewServer(): void {
	if (!running) return;
	try {
		running.server.close();
	} catch {
		/* best-effort */
	}
	running = undefined;
}

/** Alias mirroring `startDashboard` for symmetry with the new naming. */
export const stopDashboard = stopReviewServer;

/** The single-file dashboard UI. Vanilla HTML/CSS/JS, dark theme, no deps. */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory Dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0e0f13; color: #d7dae0;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { position: sticky; top: 0; background: #14161c; border-bottom: 1px solid #23262f;
    padding: 10px 20px; display: flex; align-items: center; gap: 14px; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; white-space: nowrap; }
  header .sp { flex: 1; }
  nav.tabs { display: flex; gap: 4px; }
  nav.tabs button { background: transparent; border: 1px solid transparent; color: #9aa0ac;
    padding: 6px 14px; border-radius: 6px; cursor: pointer; font: inherit; }
  nav.tabs button:hover { background: #1b1e26; }
  nav.tabs button.active { background: #1b1e26; border-color: #2c303b; color: #d7dae0; }
  button { font: inherit; border: 1px solid #2c303b; background: #1b1e26; color: #d7dae0;
    padding: 6px 12px; border-radius: 6px; cursor: pointer; }
  button:hover { background: #232733; }
  button.primary { background: #1f6feb33; border-color: #1f6feb; color: #cfe0ff; }
  button.danger { background: #f8514933; border-color: #f85149; color: #ffd0cc; }
  button.ok { background: #2ea04333; border-color: #2ea043; color: #c6f6d5; }
  main { padding: 20px; max-width: 1100px; margin: 0 auto; }
  .hidden { display: none !important; }

  /* Review layout: sidebar + main pane */
  .review-wrap { display: flex; gap: 18px; align-items: flex-start; }
  .sidebar { width: 230px; flex: none; }
  .sidebar .navrow { display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    border: 1px solid #23262f; border-radius: 6px; margin-bottom: 6px; cursor: pointer;
    background: #14161c; }
  .sidebar .navrow:hover { background: #1b1e26; }
  .sidebar .navrow.active { border-color: #1f6feb; background: #1f6feb1a; }
  .sidebar .navrow .name { flex: 1; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; font-family: ui-monospace, monospace; font-size: 12px; }
  .sidebar .approveall { width: 100%; margin-top: 8px; }
  .pane { flex: 1; min-width: 0; }

  .badge { background: #1b1e26; border: 1px solid #2c303b; border-radius: 999px;
    padding: 0 8px; font-size: 11px; min-width: 20px; text-align: center; }
  .card { background: #14161c; border: 1px solid #23262f; border-radius: 8px; margin: 10px 0; }
  .card .head { padding: 12px 14px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
  .card .head:hover { background: #171a21; }
  .card .head .summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: #b7bcc7; }
  .card .head .when { color: #8b909b; font-size: 12px; white-space: nowrap; }
  .card .body { padding: 0 14px 14px; border-top: 1px solid #23262f; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: 12px; color: #8b909b;
    margin: 10px 0; }
  .meta b { color: #b7bcc7; font-weight: 600; }
  pre, textarea { background: #0b0c10; border: 1px solid #23262f; border-radius: 6px;
    padding: 10px; white-space: pre-wrap; word-break: break-word; margin: 0 0 10px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cfd3da; }
  textarea { width: 100%; min-height: 120px; resize: vertical; display: block; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .tag { background: #1b1e26; border: 1px solid #2c303b; border-radius: 999px;
    padding: 1px 8px; font-size: 11px; }
  .empty { color: #8b909b; text-align: center; padding: 60px 0; }
  .unreachable { color: #f0a35e; }

  /* Settings layout */
  .cols { display: flex; gap: 22px; align-items: flex-start; }
  .col { flex: 1; min-width: 0; }
  .col h2 { font-size: 13px; color: #9aa0ac; font-weight: 600;
    border-bottom: 1px solid #23262f; padding-bottom: 6px; }
  .col h2 .path { color: #c9ccd3; font-family: ui-monospace, monospace; font-size: 11px; }
  .field { margin: 12px 0; }
  .field label { display: block; font-size: 12px; color: #9aa0ac; margin-bottom: 4px; }
  .field .hint { color: #6f747f; font-size: 11px; margin-top: 3px; }
  .field input[type=text], .field select, .field textarea { width: 100%; padding: 6px 8px;
    background: #0b0c10; border: 1px solid #23262f; border-radius: 6px; color: #d7dae0; font: inherit; }
  .field textarea { min-height: 84px; font: 12px/1.5 ui-monospace, monospace; }
  .field.inherited input, .field.inherited select, .field.inherited textarea { color: #7c8290; }
  .cats { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
  .chip { border: 1px solid #2c303b; border-radius: 999px; padding: 3px 12px; cursor: pointer;
    font-size: 12px; user-select: none; }
  .chip.on { background: #2ea04333; border-color: #2ea043; color: #c6f6d5; }
  .chip.off { background: #1b1e26; color: #8b909b; }
  .chip.ban { background: #f8514933; border-color: #f85149; color: #ffd0cc; text-decoration: line-through; }
  .banner { background: #1f6feb1f; border: 1px solid #1f6feb; color: #cfe0ff; padding: 10px 14px;
    border-radius: 8px; margin-bottom: 16px; display: flex; align-items: center; gap: 10px; }
  .banner .sp { flex: 1; }
  .footer-note { color: #6f747f; font-size: 12px; margin-top: 20px;
    border-top: 1px solid #23262f; padding-top: 10px; }

  /* Log + status */
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #23262f; vertical-align: top; }
  th { color: #9aa0ac; font-weight: 600; }
  td.mono { font-family: ui-monospace, monospace; color: #cfd3da; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
  .dot.green { background: #2ea043; }
  .dot.red { background: #f85149; }
  .kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px 14px; font-size: 13px; margin-top: 14px; }
  .kv .k { color: #9aa0ac; }
  .kv .v { font-family: ui-monospace, monospace; color: #cfd3da; word-break: break-word; }
  .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
    background: #1b1e26; border: 1px solid #2c303b; padding: 8px 16px; border-radius: 8px;
    opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <h1>Memory Dashboard</h1>
  <nav class="tabs" id="tabs">
    <button data-tab="review" class="active">Review</button>
    <button data-tab="settings">Settings</button>
    <button data-tab="log">Log</button>
    <button data-tab="status">Status</button>
  </nav>
  <span class="sp"></span>
  <button id="refresh">Refresh</button>
</header>

<main>
  <section id="tab-review"></section>
  <section id="tab-settings" class="hidden"></section>
  <section id="tab-log" class="hidden"></section>
  <section id="tab-status" class="hidden"></section>
</main>
<div class="toast" id="toast"></div>

<script>
const toastEl = document.getElementById("toast");
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg; toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}
function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
function fmtDate(s) { if (!s) return "—"; const d = new Date(s); return isNaN(d) ? s : d.toLocaleString(); }
function basename(p) { const parts = String(p || "").split("/").filter(Boolean); return parts[parts.length - 1] || p || "(unknown)"; }

async function getJson(path) {
  const res = await fetch(path);
  return res.json().catch(() => ({}));
}
async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

/* ---------- tabs ---------- */
const TABS = ["review", "settings", "log", "status"];
function showTab(name) {
  if (!TABS.includes(name)) name = "review";
  localStorage.setItem("mem.tab", name);
  for (const t of TABS) {
    document.getElementById("tab-" + t).classList.toggle("hidden", t !== name);
  }
  for (const b of document.querySelectorAll("#tabs button"))
    b.classList.toggle("active", b.dataset.tab === name);
  if (name === "review") loadReview();
  else if (name === "settings") loadSettings();
  else if (name === "log") loadLog();
  else if (name === "status") loadStatus();
}
for (const b of document.querySelectorAll("#tabs button"))
  b.onclick = () => showTab(b.dataset.tab);
document.getElementById("refresh").onclick = () =>
  showTab(localStorage.getItem("mem.tab") || "review");

/* ---------- Review tab ---------- */
let reviewDocs = [];
let activeProject = "__all__";

async function loadReview() {
  const rootEl = document.getElementById("tab-review");
  rootEl.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const data = await getJson("/api/queue");
    reviewDocs = data.docs || [];
  } catch (e) { reviewDocs = []; }
  renderReview();
}

function projectsOf(list) {
  const g = new Map();
  for (const d of list) {
    const k = d.project || "(unknown)";
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(d);
  }
  return g;
}

function renderReview() {
  const rootEl = document.getElementById("tab-review");
  if (reviewDocs.length === 0) {
    rootEl.innerHTML = '<div class="empty">Nothing to review. All caught up.</div>';
    return;
  }
  const groups = projectsOf(reviewDocs);
  if (activeProject !== "__all__" && !groups.has(activeProject)) activeProject = "__all__";

  const wrap = document.createElement("div");
  wrap.className = "review-wrap";

  // sidebar
  const side = document.createElement("div");
  side.className = "sidebar";
  side.appendChild(navRow("__all__", "All", reviewDocs.length));
  for (const [project, list] of groups)
    side.appendChild(navRow(project, basename(project), list.length));

  // main pane
  const pane = document.createElement("div");
  pane.className = "pane";
  const shown = activeProject === "__all__"
    ? reviewDocs
    : (groups.get(activeProject) || []);

  if (activeProject !== "__all__") {
    const approveAll = document.createElement("button");
    approveAll.className = "primary approveall";
    approveAll.textContent = "Approve all in project (" + shown.length + ")";
    approveAll.onclick = async () => {
      for (const d of shown) await postJson("/api/approve", { docId: d.docId });
      toast("Approved " + shown.length + " in project");
      loadReview();
    };
    side.appendChild(approveAll);
  }

  for (const d of shown) pane.appendChild(card(d));
  wrap.append(side, pane);
  rootEl.innerHTML = "";
  rootEl.appendChild(wrap);
}

function navRow(key, name, count) {
  const el = document.createElement("div");
  el.className = "navrow" + (key === activeProject ? " active" : "");
  el.innerHTML = '<span class="name">' + esc(name) + '</span>'
    + '<span class="badge">' + count + '</span>';
  el.onclick = () => { activeProject = key; renderReview(); };
  return el;
}

function card(d) {
  const el = document.createElement("div");
  el.className = "card";

  const head = document.createElement("div");
  head.className = "head";
  const preview = (d.text || "").replace(/\\s+/g, " ").slice(0, 120);
  head.innerHTML =
    '<span class="badge">' + esc(String(d.factCount ?? 0)) + '</span>'
    + '<span class="summary">' + esc(d.bank) + ' · ' + esc(d.reason || "—")
    + (preview ? ' · ' + esc(preview) : (d.unreachable ? ' · <span class="unreachable">unreachable</span>' : ''))
    + '</span>'
    + '<span class="when">' + esc(fmtDate(d.createdAt || d.ts)) + '</span>';

  const body = document.createElement("div");
  body.className = "body hidden";
  head.onclick = () => body.classList.toggle("hidden");

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML =
    '<span><b>created</b> ' + esc(fmtDate(d.createdAt || d.ts)) + '</span>'
    + '<span><b>docId</b> ' + esc(d.docId) + '</span>'
    + '<span><b>bank</b> ' + esc(d.bank) + '</span>'
    + '<span><b>namespace</b> ' + esc(d.namespace) + '</span>'
    + '<span><b>project</b> ' + esc(d.project || "—") + '</span>'
    + '<span><b>reason</b> ' + esc(d.reason || "—") + '</span>'
    + '<span><b>facts</b> ' + esc(String(d.factCount ?? 0)) + '</span>'
    + ((d.tags && d.tags.length) ? '<span><b>tags</b> ' + esc(d.tags.join(", ")) + '</span>' : '')
    + (d.unreachable ? '<span class="unreachable">bank unreachable</span>' : '');

  const pre = document.createElement("pre");
  pre.textContent = d.text || (d.unreachable ? "(could not load document)" : "(nothing stored)");

  const row = document.createElement("div");
  row.className = "row";
  const approve = document.createElement("button");
  approve.className = "ok"; approve.textContent = "Approve";
  approve.onclick = async () => { await postJson("/api/approve", { docId: d.docId }); toast("Approved"); loadReview(); };
  const edit = document.createElement("button");
  edit.textContent = "Edit";
  const del = document.createElement("button");
  del.className = "danger"; del.textContent = "Delete";
  del.onclick = async () => {
    if (!confirm("Delete this document from the bank?")) return;
    await postJson("/api/delete", { docId: d.docId, bank: d.bank, baseUrl: d.baseUrl, namespace: d.namespace });
    toast("Deleted"); loadReview();
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
      const r = await postJson("/api/edit", { docId: d.docId, bank: d.bank, baseUrl: d.baseUrl, namespace: d.namespace, text: ta.value });
      if (r.ok) { toast("Saved — re-extracting"); loadReview(); }
      else { toast("Save failed: " + (r.error || "error")); }
    };
    cancel.onclick = () => loadReview();
  };
  row.append(approve, edit, del);

  body.append(meta, pre, row);
  el.append(head, body);
  return el;
}

/* ---------- Settings tab ---------- */
// Field catalog. scope: which columns render the control.
const FIELDS = [
  { key: "baseUrl", label: "Base URL", type: "text", scope: ["global"] },
  { key: "namespace", label: "Namespace", type: "text", scope: ["global"] },
  { key: "bankId", label: "Bank id", type: "text", scope: ["project"],
    hint: 'Set a name or "auto" to activate the plugin here.' },
  { key: "memoryLanguage", label: "Memory language", type: "text", scope: ["global", "project"] },
  { key: "recallModelId", label: "Recall model id", type: "text", scope: ["global", "project"] },
  { key: "retainModelId", label: "Retain model id", type: "text", scope: ["global", "project"] },
  { key: "autoRecall", label: "Auto recall", type: "bool", scope: ["global", "project"] },
  { key: "autoMemorize", label: "Auto memorize", type: "bool", scope: ["global", "project"] },
  { key: "recallEffort", label: "Recall effort", type: "select", opts: ["light", "normal", "thorough"], scope: ["global", "project"] },
  { key: "recallOperation", label: "Recall operation", type: "select", opts: ["recall", "reflect"], scope: ["global", "project"] },
  { key: "recallFilter", label: "Recall filter", type: "select", opts: ["model", "off"], scope: ["global", "project"] },
  { key: "memorizeEngine", label: "Memorize engine", type: "select", opts: ["inline", "taskflow"], scope: ["global", "project"] },
  { key: "retainMission", label: "Retain mission", type: "textarea", scope: ["global", "project"] },
  { key: "observationsMission", label: "Observations mission", type: "textarea", scope: ["global", "project"] },
];

let cfgData = null;
let catStates = {};        // key -> "on"|"off"|"ban" (project editor working copy)
let catOriginal = {};      // key -> original state, to diff on save
let settingsDirtyBanner = false;

async function loadSettings() {
  const rootEl = document.getElementById("tab-settings");
  rootEl.innerHTML = '<div class="empty">Loading…</div>';
  cfgData = await getJson("/api/config");
  catStates = {};
  catOriginal = {};
  for (const c of (cfgData.categories || [])) { catStates[c.key] = c.state; catOriginal[c.key] = c.state; }
  renderSettings();
}

// Convert a raw stored value to the string a control shows. Undefined → "".
function toCtl(v, type) {
  if (v === undefined || v === null) return "";
  if (type === "bool") return v ? "on" : "off";
  return String(v);
}
// Convert a control string back to the value we persist.
function fromCtl(s, type) {
  if (type === "bool") return s === "on";
  return s;
}

function fieldControl(scope, f, rawLayer, inheritedVal) {
  const wrap = document.createElement("div");
  const overridden = Object.prototype.hasOwnProperty.call(rawLayer, f.key);
  wrap.className = "field" + (!overridden && scope === "project" ? " inherited" : "");
  const lab = document.createElement("label");
  lab.textContent = f.label;
  wrap.appendChild(lab);

  const id = scope[0] + "_" + f.key;
  const curStr = toCtl(rawLayer[f.key], f.type);
  const inhStr = inheritedVal === undefined ? "" : toCtl(inheritedVal, f.type);

  let ctl;
  if (f.type === "select" || f.type === "bool") {
    ctl = document.createElement("select");
    const opts = f.type === "bool" ? ["on", "off"] : f.opts;
    const inh = document.createElement("option");
    inh.value = ""; inh.textContent = "(inherit" + (inhStr ? ": " + inhStr : "") + ")";
    ctl.appendChild(inh);
    for (const o of opts) {
      const op = document.createElement("option");
      op.value = o; op.textContent = o; ctl.appendChild(op);
    }
    ctl.value = curStr;
  } else if (f.type === "textarea") {
    ctl = document.createElement("textarea");
    ctl.value = curStr;
    if (!overridden && inhStr) ctl.placeholder = inhStr;
  } else {
    ctl = document.createElement("input");
    ctl.type = "text";
    ctl.value = curStr;
    if (!overridden && inhStr) ctl.placeholder = inhStr + "  (inherited)";
  }
  ctl.id = id;
  ctl.dataset.type = f.type;
  wrap.appendChild(ctl);
  if (f.hint) {
    const h = document.createElement("div");
    h.className = "hint"; h.textContent = f.hint;
    wrap.appendChild(h);
  }
  return wrap;
}

function renderSettings() {
  const rootEl = document.getElementById("tab-settings");
  rootEl.innerHTML = "";

  if (settingsDirtyBanner) rootEl.appendChild(savedBanner());

  const cols = document.createElement("div");
  cols.className = "cols";

  const g = cfgData.global || {};
  const p = cfgData.project || {};
  const resolved = cfgData.resolved || {};

  // Global column
  const gcol = document.createElement("div");
  gcol.className = "col";
  gcol.innerHTML = '<h2>Global <span class="path">' + esc(cfgData.globalPath) + '</span></h2>';
  for (const f of FIELDS) {
    if (!f.scope.includes("global")) continue;
    gcol.appendChild(fieldControl(["g"], f, g, resolved[f.key]));
  }
  const gsave = document.createElement("button");
  gsave.className = "primary"; gsave.textContent = "Save global";
  gsave.onclick = () => saveScope("global");
  gcol.appendChild(gsave);

  // Project column
  const pcol = document.createElement("div");
  pcol.className = "col";
  pcol.innerHTML = '<h2>This project <span class="path">' + esc(cfgData.projectPath) + '</span></h2>';
  for (const f of FIELDS) {
    if (!f.scope.includes("project")) continue;
    // Inherited value for the project column = global override, else resolved.
    const inherited = Object.prototype.hasOwnProperty.call(g, f.key) ? g[f.key] : resolved[f.key];
    pcol.appendChild(fieldControl(["p"], f, p, inherited));
  }

  // Fact categories tri-state editor (project scope).
  const catWrap = document.createElement("div");
  catWrap.className = "field";
  catWrap.innerHTML = '<label>Fact categories (click to cycle on → off → ban)</label>';
  const cats = document.createElement("div");
  cats.className = "cats";
  for (const c of (cfgData.categories || [])) {
    const chip = document.createElement("span");
    const render = () => { chip.className = "chip " + catStates[c.key]; chip.textContent = c.label; };
    chip.onclick = () => {
      const order = { on: "off", off: "ban", ban: "on" };
      catStates[c.key] = order[catStates[c.key]] || "on";
      render();
    };
    render();
    cats.appendChild(chip);
  }
  catWrap.appendChild(cats);
  pcol.appendChild(catWrap);

  const psave = document.createElement("button");
  psave.className = "primary"; psave.textContent = "Save project";
  psave.onclick = () => saveScope("project");
  pcol.appendChild(psave);

  cols.append(gcol, pcol);
  rootEl.appendChild(cols);

  const note = document.createElement("div");
  note.className = "footer-note";
  note.textContent = "Changes to most settings require /reload. Auto-toggles and missions apply immediately.";
  rootEl.appendChild(note);
}

function savedBanner() {
  const b = document.createElement("div");
  b.className = "banner";
  b.innerHTML = '<span>Configuration saved. Run <b>/reload</b> in pi to apply (missions applied live).</span><span class="sp"></span>';
  const x = document.createElement("button");
  x.textContent = "Dismiss";
  x.onclick = () => { settingsDirtyBanner = false; renderSettings(); };
  b.appendChild(x);
  return b;
}

// Build the patch of CHANGED fields for a scope and POST it.
async function saveScope(scope) {
  const prefix = scope === "global" ? "g" : "p";
  const rawLayer = (scope === "global" ? cfgData.global : cfgData.project) || {};
  const patch = {};
  for (const f of FIELDS) {
    if (!f.scope.includes(scope)) continue;
    const ctl = document.getElementById(prefix + "_" + f.key);
    if (!ctl) continue;
    const s = ctl.value;
    const had = Object.prototype.hasOwnProperty.call(rawLayer, f.key);
    if (s === "") continue; // empty = inherit; cannot unset an existing override here
    const val = fromCtl(s, f.type);
    const origStr = had ? toCtl(rawLayer[f.key], f.type) : undefined;
    if (String(s) !== origStr) patch[f.key] = val;
  }
  // Categories: project scope only. Persist as a { key: state } map, merged with
  // any previously-stored factCategories block (preserves custom categories).
  if (scope === "project") {
    let changed = false;
    for (const k of Object.keys(catStates))
      if (catStates[k] !== catOriginal[k]) changed = true;
    if (changed) {
      const prev = (cfgData.project && cfgData.project.factCategories) || {};
      patch.factCategories = Object.assign({}, prev, catStates);
    }
  }
  if (Object.keys(patch).length === 0) { toast("No changes"); return; }

  const r = await postJson("/api/config", { scope, patch });
  if (r.ok) {
    settingsDirtyBanner = true;
    toast("Saved" + (r.bankSynced ? " (bank synced)" : ""));
    await loadSettings();
    settingsDirtyBanner = true;   // survive the reload
    renderSettings();
  } else {
    toast("Save failed: " + (r.error || "error"));
  }
}

/* ---------- Log tab ---------- */
async function loadLog() {
  const rootEl = document.getElementById("tab-log");
  rootEl.innerHTML = '<div class="empty">Loading…</div>';
  const data = await getJson("/api/log?limit=100");
  const entries = data.entries || [];
  const bar = document.createElement("div");
  bar.className = "row";
  const rf = document.createElement("button");
  rf.textContent = "Refresh"; rf.onclick = loadLog;
  bar.appendChild(rf);

  rootEl.innerHTML = "";
  rootEl.appendChild(bar);
  if (entries.length === 0) {
    const e = document.createElement("div"); e.className = "empty";
    e.textContent = "No operations logged yet.";
    rootEl.appendChild(e);
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = '<thead><tr><th>Time</th><th>Type</th><th>Reason</th><th>Detail</th></tr></thead>';
  const tb = document.createElement("tbody");
  for (const e of entries) {
    const tr = document.createElement("tr");
    const detail = e.message
      ? e.message
      : [e.query ? "q: " + e.query : "",
         e.documents != null ? "docs: " + e.documents : "",
         e.lines != null ? "lines: " + e.lines : "",
         e.found != null ? "found: " + e.found : "",
         e.injected != null ? "injected: " + e.injected : ""].filter(Boolean).join("  ");
    tr.innerHTML =
      '<td class="mono">' + esc(fmtDate(e.ts)) + '</td>'
      + '<td>' + esc(e.type || "—") + '</td>'
      + '<td>' + esc(e.reason || "—") + '</td>'
      + '<td>' + esc(detail || "—") + '</td>';
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  rootEl.appendChild(table);
}

/* ---------- Status tab ---------- */
async function loadStatus() {
  const rootEl = document.getElementById("tab-status");
  rootEl.innerHTML = '<div class="empty">Loading…</div>';
  const data = await getJson("/api/status");
  const c = data.cfg || {};
  rootEl.innerHTML = "";

  const bar = document.createElement("div");
  bar.className = "row";
  const rf = document.createElement("button");
  rf.textContent = "Refresh"; rf.onclick = loadStatus;
  bar.appendChild(rf);
  rootEl.appendChild(bar);

  const head = document.createElement("div");
  head.style.marginTop = "16px";
  head.style.fontSize = "15px";
  head.innerHTML = '<span class="dot ' + (data.health ? "green" : "red") + '"></span>'
    + (data.health ? "Bank reachable" : "Bank unreachable");
  rootEl.appendChild(head);

  const counts = document.createElement("div");
  counts.className = "row";
  counts.style.marginTop = "12px";
  const docs = data.bank ? data.bank.documents : "—";
  const facts = data.bank ? data.bank.facts : "—";
  counts.innerHTML = '<span class="tag">documents: ' + esc(String(docs)) + '</span>'
    + '<span class="tag">facts: ' + esc(String(facts)) + '</span>';
  rootEl.appendChild(counts);

  const kv = document.createElement("div");
  kv.className = "kv";
  const rows = [
    ["baseUrl", c.baseUrl], ["namespace", c.namespace], ["bankId", c.bankId],
    ["active", String(c.active)], ["engine", c.memorizeEngine],
    ["effort", c.recallEffort], ["language", c.memoryLanguage],
    ["recall model", c.recallModelId || "(default)"], ["retain model", c.retainModelId || "(default)"],
  ];
  for (const [k, v] of rows) {
    kv.innerHTML += '<div class="k">' + esc(k) + '</div><div class="v">' + esc(String(v ?? "—")) + '</div>';
  }
  rootEl.appendChild(kv);
}

/* ---------- boot ---------- */
showTab(localStorage.getItem("mem.tab") || "review");
</script>
</body>
</html>`;

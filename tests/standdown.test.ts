/**
 * Stand-down behavior for in-process PEW workflow agent sessions.
 *
 * pi-extensible-workflows runs workflow agents as IN-PROCESS pi sessions inside
 * the host's process, labelled `${workflow}:${label}:attempt-${n}` via
 * appendSessionInfo BEFORE extensions load. These tests prove that such a
 * session (a) initializes nothing (no timer, no widget) while keeping the
 * hindsight_* tools registered, and (b) never disposes the HOST instance's
 * global disposer handle — while a normal host session still initializes fully.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import factory, { isWorkflowAgentSession } from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** Minimal fake ExtensionAPI capturing registrations and event handlers. */
function fakePi() {
	const tools: string[] = [];
	const handlers = new Map<string, Handler[]>();
	return {
		tools,
		handlers,
		emit(type: string, event: unknown, ctx: unknown) {
			return Promise.all((handlers.get(type) ?? []).map((h) => h(event, ctx)));
		},
		api: {
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			registerTool(def: { name: string }) {
				tools.push(def.name);
			},
			registerCommand() {},
			registerShortcut() {},
			sendMessage() {},
			appendEntry() {},
			on(type: string, handler: Handler) {
				const list = handlers.get(type) ?? [];
				list.push(handler);
				handlers.set(type, list);
			},
		},
	};
}

/** Fake session ctx. `name` mimics the PEW session label (or a host's none). */
function fakeCtx(cwd: string, name: string | undefined) {
	const widgetCalls: unknown[][] = [];
	return {
		widgetCalls,
		ctx: {
			cwd,
			ui: {
				setWidget(...args: unknown[]) {
					widgetCalls.push(args);
				},
				setStatus() {},
				notify() {},
			},
			sessionManager: {
				getSessionName: () => name,
				getEntries: () => [],
			},
		},
	};
}

/** Track setInterval calls (the counts-refresh timer) during fn(). */
async function countIntervals(fn: () => Promise<void>): Promise<number> {
	const real = globalThis.setInterval;
	let calls = 0;
	(globalThis as { setInterval: unknown }).setInterval = (
		...args: unknown[]
	) => {
		calls++;
		return real.apply(globalThis, args as Parameters<typeof setInterval>);
	};
	try {
		await fn();
	} finally {
		globalThis.setInterval = real;
	}
	return calls;
}

// Isolate config from this machine: empty HOME (no ~/.pi/agent/hindsight.json)
// and no env bank means `active: false` — session_start never touches the
// network. The temp cwd has no project config either.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-home-"));
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-cwd-"));
process.env.HOME = tmpHome;
delete process.env.HINDSIGHT_BANK;
delete process.env.HINDSIGHT_AUTO_OFF;

type G = { __piHindsightDispose?: () => void };
const g = globalThis as unknown as G;

test("predicate recognizes the PEW session label shape", () => {
	assert.equal(isWorkflowAgentSession("work0-hindsight:builder:attempt-1"), true);
	assert.equal(isWorkflowAgentSession("wf:some label with spaces:attempt-12"), true);
	assert.equal(isWorkflowAgentSession(undefined), false);
	assert.equal(isWorkflowAgentSession(""), false);
	assert.equal(isWorkflowAgentSession("my renamed session"), false);
	assert.equal(isWorkflowAgentSession("notes:attempt-1"), false); // only two segments
	assert.equal(isWorkflowAgentSession("a:b:attempt-x"), false); // n must be numeric
});

test("agent-labelled session stands down: no timer, no widget, tools present", async () => {
	delete g.__piHindsightDispose;
	const pi = fakePi();
	factory(pi.api as never);

	const { ctx, widgetCalls } = fakeCtx(tmpCwd, "wf:label:attempt-2");
	const intervals = await countIntervals(async () => {
		await pi.emit("session_start", { reason: "startup" }, ctx);
	});

	assert.equal(intervals, 0, "stand-down must not start the counts timer");
	assert.equal(widgetCalls.length, 0, "stand-down must not touch the widget");
	assert.ok(pi.tools.includes("hindsight_recall"), "tools must stay registered");
	assert.ok(pi.tools.includes("hindsight_retain"), "tools must stay registered");
	assert.ok(pi.tools.includes("hindsight_reflect"), "tools must stay registered");
	assert.equal(
		g.__piHindsightDispose,
		undefined,
		"stand-down must not register a global disposer",
	);
});

test("normal host session initializes: timer, widget, disposer registered", async () => {
	delete g.__piHindsightDispose;
	const pi = fakePi();
	factory(pi.api as never);

	const { ctx, widgetCalls } = fakeCtx(tmpCwd, undefined);
	const intervals = await countIntervals(async () => {
		await pi.emit("session_start", { reason: "startup" }, ctx);
	});

	assert.equal(intervals, 1, "host session must start the counts timer");
	assert.ok(widgetCalls.length > 0, "host session must render/clear the widget");
	assert.ok(pi.tools.includes("hindsight_recall"));
	assert.equal(
		typeof g.__piHindsightDispose,
		"function",
		"host session must register its global disposer",
	);
	g.__piHindsightDispose?.(); // clean up the timer
	delete g.__piHindsightDispose;
});

test("agent session does not dispose a previously registered host instance", async () => {
	let hostDisposed = 0;
	const hostDisposer = () => {
		hostDisposed++;
	};
	g.__piHindsightDispose = hostDisposer;

	const pi = fakePi();
	factory(pi.api as never);
	const { ctx } = fakeCtx(tmpCwd, "deploy:verifier:attempt-3");
	await pi.emit("session_start", { reason: "startup" }, ctx);

	assert.equal(hostDisposed, 0, "agent session must not call the host's disposer");
	assert.equal(
		g.__piHindsightDispose,
		hostDisposer,
		"agent session must not replace the host's disposer handle",
	);
	delete g.__piHindsightDispose;
});

test("host session DOES retire a previous host instance (handshake intact)", async () => {
	let prevDisposed = 0;
	g.__piHindsightDispose = () => {
		prevDisposed++;
	};

	const pi = fakePi();
	factory(pi.api as never);
	const { ctx } = fakeCtx(tmpCwd, undefined);
	await pi.emit("session_start", { reason: "startup" }, ctx);

	assert.equal(prevDisposed, 1, "new host must dispose the previous instance");
	assert.notEqual(g.__piHindsightDispose, undefined);
	g.__piHindsightDispose?.();
	delete g.__piHindsightDispose;
});

/**
 * Driver shared by the two user-block self-tests.
 *
 * The tests judge BEHAVIOUR, so they must run the real extension: its own
 * factory, its own hooks, its own client, its own widget. Everything this file
 * fakes is outside that boundary — the pi runner, the HTTP transport, the home
 * directory and the project on disk. Nothing here re-implements a decision the
 * extension is supposed to make; if a check passes, the shipped code made it.
 *
 * The runner emulation is deliberately faithful to
 * `dist/core/extensions/runner.js`: `before_agent_start` handlers run in
 * registration order, each one seeing the systemPrompt the previous one left,
 * a returned message is collected rather than replacing anything, and a
 * throwing handler is swallowed. A driver that chained differently would prove
 * something about itself instead of about the extension.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Safe as a static import: this module is pure string work over rows and reads
// neither the config nor the home directory (the home redirect below could not
// precede it anyway — ESM hoists every static import).
import { USER_BLOCK_MARKER } from "../src/user-block.ts";

// The home directory is redirected BEFORE the extension (and with it config.ts)
// is imported: `globalConfigPath()` otherwise reads the developer's own
// ~/.pi/agent/hindsight.json, which on this machine really does declare a user
// bank — the tests would then measure that config instead of the fixture. The
// same goes for a global AGENTS.md carrying the marker. That is why the
// extension arrives through a dynamic import further down, not through one of
// these.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hs-ub-home-"));
fs.mkdirSync(path.join(tmpHome, ".pi", "agent"), { recursive: true });
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
for (const key of Object.keys(process.env))
	if (key.startsWith("HINDSIGHT_")) delete process.env[key];

const cleanup: string[] = [tmpHome];

// ------------------------------------------------------------------ fixtures

export const BASE_URL = "http://bank.test";
export const NAMESPACE = "default";
export const PROJECT_BANK = "project-bank";
export const USER_BANK = "user-bank";

/** The literal under test, taken from the source rather than retyped here. */
export const MARKER = USER_BLOCK_MARKER;

/**
 * A theme that wraps every coloured fragment in a COMPLETE escape pair, so a
 * line cut mid-sequence is visible to the geometry checks.
 */
export const THEME = {
	fg: (_color: string, s: string) => `\x1b[35m${s}\x1b[39m`,
	bold: (s: string) => s,
};

export const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Visible columns; the brain glyph is the only double-width character the
 * widget emits. Mirrors `width()` in src/ui.ts, counting every occurrence.
 */
export const cols = (s: string): number =>
	[...strip(s)].length + (strip(s).match(/\uD83E\uDDE0/g)?.length ?? 0);

/** One row of `memories/list`, in the shape the server really returns. */
export interface BankItem {
	id: string;
	text: string;
	// Optional so a test can express a row the server never sends: one whose type
	// or state is missing. What the block does with a row it cannot identify is a
	// requirement, and an interface that forbade writing one would hide it.
	fact_type?: string;
	state?: string;
}

/**
 * A bank listing built from tags. Each valid tag produces the pair the server
 * actually stores — the stated `world` fact and the shorter `observation`
 * consolidated from it — so a block that stopped dropping derived rows would
 * carry the tag twice and the composition check would see it.
 */
export function bankOf(valid: string[], invalid: string[] = []): BankItem[] {
	const items: BankItem[] = [];
	const id = () =>
		`00000000-0000-4000-8000-${String(items.length).padStart(12, "0")}`;
	const stated = (tag: string) =>
		`${tag}: the person keeps this in mind on every task, expects it to hold in any repository, and treats a violation of it as a defect worth reporting.`;
	for (const tag of valid) {
		items.push({ id: id(), text: stated(tag), fact_type: "world", state: "valid" });
		items.push({
			id: id(),
			text: `${tag}: the person expects this to hold everywhere.`,
			fact_type: "observation",
			state: "valid",
		});
	}
	for (const tag of invalid)
		items.push({
			id: id(),
			text: stated(tag),
			fact_type: "world",
			state: "invalid",
		});
	return items;
}

/** AGENTS.md text carrying `markers` occurrences of the marker line. */
export function agentsMd(markers: number): string {
	const out = ["# Agent Instructions", "", "House conventions.", ""];
	for (let i = 0; i < markers; i += 1)
		out.push(`## Standing context ${i + 1}`, "", MARKER, "");
	out.push("## Commits", "", "- Commit messages are written in English.", "");
	return out.join("\n");
}

/**
 * The system prompt as the HOST assembles it: the instruction file inlined
 * verbatim inside a larger string. The extension never opens AGENTS.md to
 * substitute — it works on this assembled string — so the tests hand it the
 * same bytes pi would.
 */
export function hostPrompt(md: string): string {
	return [
		"You are an expert coding assistant operating inside pi.",
		"",
		"<project_context>",
		"",
		'<project_instructions path="AGENTS.md">',
		md,
		"</project_instructions>",
		"",
		"</project_context>",
		"",
		"Be concise in your responses.",
	].join("\n");
}

/**
 * A throwaway project: the config the extension will load, plus the AGENTS.md
 * whose text the matching `hostPrompt()` inlines.
 *
 * `autoMemorize` is off and `bankReminderTurns` is 1 so the two contours that
 * share `before_agent_start` are in a known state: no write path runs (it needs
 * a model), and the reminder fires on the first turn, where a test can see that
 * the block did not displace it.
 */
export function makeCwd(
	name: string,
	overrides: Record<string, unknown>,
	md: string = agentsMd(1),
): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hs-ub-${name}-`));
	cleanup.push(dir);
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".pi", "hindsight.json"),
		JSON.stringify(
			{
				baseUrl: BASE_URL,
				namespace: NAMESPACE,
				bankId: PROJECT_BANK,
				userBankId: USER_BANK,
				autoRecall: true,
				autoMemorize: false,
				bankReminder: true,
				bankReminderTurns: 1,
				// Far beyond any test's lifetime: the background counts poll must not
				// slip a request into the middle of a measurement.
				countsRefreshMs: 3_600_000,
				debug: false,
				...overrides,
			},
			null,
			2,
		),
	);
	fs.writeFileSync(path.join(dir, "AGENTS.md"), md);
	return dir;
}

// ----------------------------------------------------------------- transport

export interface WireCall {
	url: string;
	method: string;
}

/** Every request the extension put on the wire, newest last. */
export const wire: WireCall[] = [];

type Mode = "ok" | "error" | "reject" | "hang";

/** The stubbed server, one entry per bank the tests care about. */
export const bank = {
	user: {
		mode: "ok" as Mode,
		items: [] as BankItem[],
		/** What a mental model GET answers with, placeholder included. */
		model: "" as string,
	},
	project: { mode: "ok" as Mode, documents: 0, nodes: 0 },
};

const bankInUrl = (url: string): string =>
	decodeURIComponent(/\/banks\/([^/?]+)/.exec(url)?.[1] ?? "");

/** Requests addressed to the user bank, whatever they are. */
export const userCalls = (): WireCall[] =>
	wire.filter((c) => bankInUrl(c.url) === USER_BANK);

/** The one read the block is built from. */
export const userReads = (): WireCall[] =>
	userCalls().filter(
		(c) => c.method === "GET" && c.url.includes("/memories/list"),
	);

/** Requests to any bank that is NOT this project's own. */
export const foreignBankCalls = (): WireCall[] =>
	wire.filter((c) => {
		const b = bankInUrl(c.url);
		return b !== "" && b !== PROJECT_BANK;
	});

const aborted = () =>
	Object.assign(new Error("The operation was aborted."), {
		name: "AbortError",
	});

const realFetch = globalThis.fetch;
// biome-ignore lint/suspicious/noExplicitAny: a minimal transport stub
globalThis.fetch = (async (url: any, init: any) => {
	const target = String(url);
	const method = init?.method ?? "GET";
	wire.push({ url: target, method });
	if (!target.startsWith(BASE_URL))
		throw new Error(`unstubbed request: ${method} ${target}`);
	const side = bankInUrl(target) === USER_BANK ? bank.user : bank.project;
	if (side.mode === "reject") throw new Error("fetch failed");
	if (side.mode === "error")
		return { ok: false, status: 500, text: async () => "boom" };
	if (side.mode === "hang")
		// A server that accepted the connection and then said nothing: the only way
		// out is the caller's own timeout, which is exactly what is under test.
		return new Promise((_resolve, reject) => {
			const signal: AbortSignal | undefined = init?.signal;
			if (signal?.aborted) return reject(aborted());
			signal?.addEventListener("abort", () => reject(aborted()), {
				once: true,
			});
		});

	let body: unknown = {};
	if (target.includes("/memories/list"))
		body = {
			items: bank.user.items,
			total: bank.user.items.length,
			limit: 200,
			offset: 0,
		};
	else if (target.includes("/mental-models/"))
		// The server answers 200 with a placeholder while a model is still being
		// generated, so the stub can serve that state too — it is a real answer the
		// block has to refuse, not an error path.
		body = {
			id: target.slice(target.lastIndexOf("/") + 1),
			content: bank.user.model,
			is_stale: false,
		};
	else if (target.includes("/memories/recall"))
		body = { results: bank.user.items };
	else if (target.endsWith("/stats"))
		body = {
			total_documents: bank.project.documents,
			total_nodes: bank.project.nodes,
		};
	else if (target.endsWith("/config")) body = { overrides: {} };
	return { ok: true, status: 200, text: async () => JSON.stringify(body) };
	// biome-ignore lint/suspicious/noExplicitAny: a minimal transport stub
}) as any;

// ------------------------------------------------------------- the extension

const extension = (await import("../src/index.ts")).default;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** What one emulated turn produced. */
export interface Turn {
	/** The runner received a systemPrompt from some handler. */
	returned: boolean;
	/** The prompt the runner would use, after every handler had its say. */
	final: string;
	messages: Array<{ customType?: string }>;
}

export interface Harness {
	handlers: Map<string, Handler[]>;
	tools: string[];
	start(reason?: string): Promise<void>;
	turn(systemPrompt: string): Promise<Turn>;
	/**
	 * Run one of the extension's own registered tools.
	 *
	 * The only way to exercise a user-bank WRITE the way the model would: the
	 * write path, its transport call and the callback it fires on success all
	 * belong to the extension, and a test that set the resulting state by hand
	 * would be asserting against itself.
	 */
	callTool(name: string, params: unknown): Promise<string>;
	/** A turn that ended: no boundary. */
	ordinary(): Promise<void>;
	/** A compaction that was announced and then cancelled: no boundary. */
	cancelledCompact(): Promise<void>;
	/** A compaction that actually happened: a boundary. */
	compact(): Promise<void>;
	widget(): string[] | undefined;
	done(): void;
}

/**
 * Load one extension instance against a fixture project and drive it.
 *
 * A fresh instance per harness on purpose: an epoch lives exactly as long as the
 * instance, so reusing one would carry a frozen block into the next scenario.
 */
type ToolDef = {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal?: AbortSignal,
	) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

export function newHarness(opts: {
	cwd: string;
	sessionName?: string;
	toolsOnly?: boolean;
}): Harness {
	const handlers = new Map<string, Handler[]>();
	const tools: string[] = [];
	const toolDefs = new Map<string, ToolDef>();
	let widget: string[] | undefined;

	const api = {
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		registerTool(def: ToolDef) {
			tools.push(def.name);
			toolDefs.set(def.name, def);
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
	};

	const ctx = {
		cwd: opts.cwd,
		ui: {
			setWidget(_id: string, content: string[] | undefined) {
				widget = content;
			},
			setStatus() {},
			notify() {},
			theme: THEME,
		},
		sessionManager: {
			getSessionName: () => opts.sessionName,
			getSessionId: () => `session-${path.basename(opts.cwd)}`,
			getEntries: () => [],
		},
	};

	// The tools-only switch and the load-time config are both read off the
	// process at factory time, so both are set up around that single call.
	const prevCwd = process.cwd();
	const addedFlag = !!opts.toolsOnly && !process.argv.includes("--mem-only-tools");
	if (addedFlag) process.argv.push("--mem-only-tools");
	process.chdir(opts.cwd);
	try {
		// biome-ignore lint/suspicious/noExplicitAny: the slice of ExtensionAPI in use
		extension(api as any);
	} finally {
		process.chdir(prevCwd);
		if (addedFlag)
			process.argv.splice(process.argv.indexOf("--mem-only-tools"), 1);
	}

	type Disposer = { __piHindsightDispose?: () => void };
	const g = globalThis as unknown as Disposer;
	const disposerBefore = g.__piHindsightDispose;

	const emit = async (type: string, event: unknown) => {
		for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
	};

	return {
		handlers,
		tools,
		async start(reason = "startup") {
			await emit("session_start", { type: "session_start", reason });
		},
		async turn(systemPrompt: string): Promise<Turn> {
			let current = systemPrompt;
			let modified = false;
			const messages: Array<{ customType?: string }> = [];
			for (const handler of handlers.get("before_agent_start") ?? []) {
				try {
					const result = (await handler(
						{
							type: "before_agent_start",
							prompt: "do the thing",
							images: undefined,
							systemPrompt: current,
							systemPromptOptions: {},
						},
						ctx,
					)) as
						| { message?: { customType?: string }; systemPrompt?: string }
						| undefined;
					if (result?.message) messages.push(result.message);
					if (result?.systemPrompt !== undefined) {
						current = result.systemPrompt;
						modified = true;
					}
				} catch (err) {
					// The real runner swallows the error and reports it out of band; a
					// silent swallow here would hide a crash behind "nothing injected",
					// so it is echoed where a reader of the output will see it.
					console.log(`      !! handler threw: ${(err as Error).message}`);
				}
			}
			return { returned: modified, final: current, messages };
		},
		async callTool(name: string, params: unknown): Promise<string> {
			const def = toolDefs.get(name);
			if (!def) throw new Error(`no such tool registered: ${name}`);
			// The tool reads the process cwd for its own bookkeeping, exactly as it
			// does under the runner, so the fixture project has to be current.
			const prev = process.cwd();
			process.chdir(opts.cwd);
			try {
				const res = await def.execute("call-1", params);
				return res.content.map((c) => c.text).join("\n");
			} finally {
				process.chdir(prev);
			}
		},
		async ordinary() {
			await emit("turn_end", { type: "turn_end" });
		},
		async cancelledCompact() {
			await emit("session_before_compact", {
				type: "session_before_compact",
				reason: "manual",
				preparation: { firstKeptEntryId: "entry-1" },
			});
		},
		async compact() {
			await emit("session_compact", {
				type: "session_compact",
				reason: "auto",
				fromExtension: false,
				willRetry: false,
				compactionEntry: { id: "entry-2" },
			});
		},
		widget() {
			return widget;
		},
		done() {
			const current = g.__piHindsightDispose;
			if (current && current !== disposerBefore) {
				current();
				if (disposerBefore) g.__piHindsightDispose = disposerBefore;
				else delete g.__piHindsightDispose;
			}
		},
	};
}

// ------------------------------------------------------------------ measuring

/**
 * What each marker occurrence turned into, or undefined when the rest of the
 * prompt did not survive verbatim.
 *
 * The host prompt is split on the marker and the pieces are required back in
 * order, anchored at both ends: anything else the extension edited — a stray
 * heading, a trimmed blank line — makes the match fail, which is the point.
 */
export function replacements(
	final: string,
	host: string,
): string[] | undefined {
	const parts = host.split(MARKER);
	if (parts.length < 2) return undefined;
	const quote = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^${parts.map(quote).join("([\\s\\S]*?)")}$`);
	const m = re.exec(final);
	return m ? m.slice(1) : undefined;
}

/** The block this turn injected, or "" when the prompt came back untouched. */
export function blockOf(turn: Turn, host: string): string {
	if (turn.final === host) return "";
	return replacements(turn.final, host)?.[0] ?? "";
}

// ------------------------------------------------------------------ reporting

let failures = 0;

export function check(label: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) console.log(`PASS  ${label}`);
	else {
		failures += 1;
		console.log(`FAIL  ${label}\n      expected ${e}\n      actual   ${a}`);
	}
}

export function report(): never {
	globalThis.fetch = realFetch;
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

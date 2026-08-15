/**
 * Self-test for bringing a killed fact back (run with bun or node).
 *   bun scripts/restore-killed-fact.test.ts
 *
 * 0.4.0 shipped a mechanism that soft-retires a fact and NO way to undo one, so
 * it ships off by default. This pins the recovery path that lets the default
 * flip: the client call, the row-granular Log-tab action, the append-only
 * `restore` entry it leaves behind, and the row that renders it.
 *
 * Nothing here touches a live server: the client is driven through a stubbed
 * `fetch`, and the panel through a stub client plus a throwaway log file.
 *
 * The restore key is DISCOVERED by probing, not hard-coded — the specification
 * fixes the conventions the binding must follow (a single unmodified letter, no
 * collision with `r`/Enter/arrows/Esc, advertised in the footer), not which
 * letter it is. Probing keeps every behavioural check below independent of that
 * choice, so a wrong letter fails one named check instead of all of them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "../src/config.ts";
import { HindsightClient, HindsightError } from "../src/hindsight.ts";
import { type HindsightLogEntry, appendLog, readLog } from "../src/log.ts";
import { openMemPanel } from "../src/mem-panel.ts";

initTheme(); // SettingsList's theme helper reads the global theme.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) console.log(`PASS  ${label}`);
	else {
		failures += 1;
		console.log(`FAIL  ${label}\n      expected ${e}\n      actual   ${a}`);
	}
}

// ------------------------------------------------------------------ fixtures

const LOG_PATH = ".pi/hindsight/log.jsonl";
const TS = "2026-02-03T10:04:00.000Z";

const KILLS_A = [
	{
		id: "fact-a",
		quote: "I deleted src/review-server.ts entirely",
		text: "review-server.ts serves the review UI.",
	},
	{
		id: "fact-b",
		quote: "port 7788 moved to 9100.",
		text: "The review UI listens on port 7788.",
	},
];
const KILLS_B = [
	{
		id: "fact-c",
		quote: "the taskflow engine was removed in 0.3.",
		text: "The taskflow engine runs steps from .pi/taskflows.",
	},
];

const RECALL_ENTRY = { ts: TS, type: "recall", query: "review server", found: 2 };
const INVALIDATE_A = { ts: TS, type: "invalidate", kills: KILLS_A };
const INVALIDATE_B = { ts: TS, type: "invalidate", kills: KILLS_B };

/** A throwaway cwd holding one JSONL log, newest entry LAST (as on disk). */
function writeLog(entries: object[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-restore-"));
	fs.mkdirSync(path.dirname(path.join(dir, LOG_PATH)), { recursive: true });
	fs.writeFileSync(
		path.join(dir, LOG_PATH),
		`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);
	return dir;
}

const logFile = (dir: string) => path.join(dir, LOG_PATH);
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The panel's bank calls are async; let the microtasks and timers settle. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i += 1)
		await new Promise((resolve) => setTimeout(resolve, 0));
}

const cfgFor = (cwd: string) =>
	({
		bankId: "test",
		active: true,
		baseUrl: "http://127.0.0.1:1",
		namespace: "default",
		autoRecall: true,
		autoMemorize: true,
		recallEffort: "normal",
		recallFilter: "model",
		recallMaxLines: 8,
		recallModelChain: [],
		retainModelChain: [],
		memoryLanguage: "en",
		logPath: LOG_PATH,
		cwd,
	}) as unknown as HindsightConfig;

type Panel = { render(w: number): string[]; handleInput(d: string): void };

/** Open /mem, walk to the Log tab and descend into its rows. */
function openLogPanel(cwd: string): { panel: Panel; restored: string[] } {
	const restored: string[] = [];
	const client = {
		health: () => Promise.reject(new Error("offline")),
		stats: () => Promise.reject(new Error("offline")),
		restore: async (id: string) => {
			restored.push(id);
		},
	} as unknown as HindsightClient;

	let made!: Panel;
	const ctx = {
		ui: {
			custom: async (factory: (...a: unknown[]) => unknown) => {
				made = factory(
					{ requestRender() {}, terminal: { rows: 40, columns: 120 } },
					// The panel only needs `fg`/`bold`; a plain stub keeps the rendered
					// lines free of ANSI so the assertions stay readable.
					{ fg: (_c: string, t: string) => t, bold: (t: string) => t },
					{},
					() => {},
				) as Panel;
			},
		},
	};
	void openMemPanel(ctx as never, {
		cwd,
		loadCfg: () => cfgFor(cwd),
		client,
		modelChains: () => ({ recall: "a/b", retain: "a/b" }),
	});

	made.handleInput("\t"); // Status -> Settings
	made.handleInput("\t"); // -> Review
	made.handleInput("\t"); // -> Log
	made.handleInput("\r"); // descend into the log rows
	return { panel: made, restored };
}

function lines(panel: Panel): string[] {
	return panel.render(120).map(strip);
}

/** The highlighted log row, without the panel's `›` cursor. */
function selectedRow(panel: Panel): string {
	const row = lines(panel).find((l) => l.trimStart().startsWith("›")) ?? "";
	return row.trimStart().slice(1).trim();
}

/** The sticky message line: two rows under the title/tab strip. */
function messageLine(panel: Panel): string {
	const all = lines(panel);
	const head = all.findIndex((l) => l.includes("Memory"));
	return (all[head + 2] ?? "").trim();
}

function footerLine(panel: Panel): string {
	return (lines(panel).find((l) => l.includes("back to tabs")) ?? "").trim();
}

// --------------------------------------------------- Requirement: client call

const calls: Array<{ url: string; method: string; body: unknown }> = [];
let nextStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
	calls.push({
		url: String(url),
		method: init.method ?? "GET",
		body: JSON.parse(String(init.body)),
	});
	return {
		ok: nextStatus < 400,
		status: nextStatus,
		text: async () =>
			nextStatus < 400 ? '{"state":"valid"}' : '{"detail":"nope"}',
	};
	// biome-ignore lint/suspicious/noExplicitAny: minimal fetch stub for the shape assertion
}) as any;

const client = new HindsightClient({
	baseUrl: "http://127.0.0.1:8888",
	namespace: "default",
	bankId: "throwaway bank",
	// biome-ignore lint/suspicious/noExplicitAny: only the three fields above are read
} as any);

/** Never let a missing method abort the run — report it as a failed check. */
async function callRestore(id: string): Promise<Error | undefined> {
	try {
		await client.restore(id);
		return undefined;
	} catch (err) {
		return err as Error;
	}
}

const restoreErr = await callRestore("mem-1");

check(
	"Restore a killed fact: exactly one PATCH to the memory's URL",
	[calls.length, calls[0]?.method, calls[0]?.url],
	[
		1,
		"PATCH",
		// The bank id is URL-encoded, as everywhere else in the client.
		"http://127.0.0.1:8888/v1/default/banks/throwaway%20bank/memories/mem-1",
	],
);

check(
	"Restore a killed fact: the body is {state:valid} and no other fields",
	calls[0]?.body,
	{ state: "valid" },
);

check("Restore a killed fact: the promise resolves", restoreErr, undefined);

// A 400 means the id is an observation (derived, not curatable) and a 404 means
// the memory is gone. `invalidate` swallows both; `restore` must mirror it.
for (const status of [404, 400]) {
	nextStatus = status;
	check(
		`Server refuses the id: HTTP ${status} resolves as a no-op`,
		(await callRestore("mem-2")) === undefined,
		true,
	);
}

nextStatus = 500;
check(
	"Any other failure: the HindsightError propagates to the caller",
	(await callRestore("mem-3")) instanceof HindsightError,
	true,
);

globalThis.fetch = realFetch;

// ------------------------------------------- Requirement: the Log tab action

/**
 * Find the letter bound to restore by pressing each candidate on a retire row
 * and watching for the bank call. `r` (reload) and `q` (close) are already
 * taken, so they are never offered as candidates.
 */
async function discoverRestoreKey(): Promise<string | undefined> {
	for (const key of "abcdefghijklmnopqrstuvwxyz") {
		if (key === "r" || key === "q") continue;
		const { panel, restored } = openLogPanel(writeLog([INVALIDATE_A]));
		panel.handleInput(key);
		await flush();
		if (restored.length > 0) return key;
	}
	return undefined;
}

const RESTORE_KEY = await discoverRestoreKey();

check(
	"Key binding follows the tab's conventions: a single unmodified letter",
	typeof RESTORE_KEY === "string" && /^[a-z]$/.test(RESTORE_KEY),
	true,
);
check(
	"Key binding follows the tab's conventions: no collision with r/Enter/arrows/Esc",
	RESTORE_KEY !== undefined &&
		!["r", "\r", "\n", "\x1b"].includes(RESTORE_KEY) &&
		!RESTORE_KEY.startsWith("\x1b"),
	true,
);

// A key nobody can find is a key nobody uses — the tab advertises its actions.
{
	const { panel } = openLogPanel(writeLog([INVALIDATE_A]));
	const footer = footerLine(panel);
	check(
		"Key binding follows the tab's conventions: the Log footer advertises it",
		RESTORE_KEY !== undefined &&
			new RegExp(`${RESTORE_KEY}\\s+restore`, "i").test(footer),
		true,
	);
	check(
		"Key binding follows the tab's conventions: the existing hints survive",
		/r reload/.test(footer) && /Enter details/.test(footer),
		true,
	);
}

const KEY = RESTORE_KEY ?? "\u0000";

// Newest entry is LAST on disk and FIRST in the panel, so INVALIDATE_A (two
// kills) is the selected row and INVALIDATE_B is the neighbour that must not
// be touched.
{
	const dir = writeLog([RECALL_ENTRY, INVALIDATE_B, INVALIDATE_A]);
	const before = fs.readFileSync(logFile(dir), "utf8");
	const { panel, restored } = openLogPanel(dir);
	panel.handleInput(KEY);
	await flush();

	check(
		"Restoring a retire row: restore is called once per kill, in that entry only",
		restored,
		["fact-a", "fact-b"],
	);

	check(
		"Outcome is reported to the user: the message line states how many were restored",
		/restor/i.test(messageLine(panel)) && /\b2\b/.test(messageLine(panel)),
		true,
	);

	const after = fs.readFileSync(logFile(dir), "utf8");
	check(
		"Appending the restore entry: the pre-existing lines are byte-identical",
		after.slice(0, before.length),
		before,
	);
	const added = after.slice(before.length).trim().split("\n").filter(Boolean);
	check(
		"Appending the restore entry: exactly one entry is appended",
		added.length,
		1,
	);
	const appended = JSON.parse(added[0] ?? "{}") as HindsightLogEntry;
	check(
		"Appending the restore entry: its type is restore",
		appended.type,
		"restore",
	);
	check(
		"Appending the restore entry: it carries the kills payload that was restored",
		appended.kills,
		KILLS_A,
	);
}

// Anything that is not a retire row with facts on it is inert: no bank call and
// no log line, so a stray keypress can never manufacture history.
for (const [label, entries] of [
	["a recall entry", [INVALIDATE_A, RECALL_ENTRY]],
	["an invalidate entry with an empty kills array", [{ ts: TS, type: "invalidate", kills: [] }]],
	["an invalidate entry with no kills field", [{ ts: TS, type: "invalidate" }]],
	["a restore row", [{ ts: TS, type: "restore", kills: KILLS_A }]],
] as const) {
	const dir = writeLog([...entries]);
	const before = fs.readFileSync(logFile(dir), "utf8");
	const { panel, restored } = openLogPanel(dir);
	panel.handleInput(KEY);
	await flush();
	check(
		`Row that cannot be restored: ${label} makes no bank call`,
		restored,
		[],
	);
	check(
		`Row that cannot be restored: ${label} appends nothing to the log`,
		fs.readFileSync(logFile(dir), "utf8"),
		before,
	);
}

// ------------------------------------ Requirement: the restore entry and row

/** Source of a repo file, for the checks that inspect declarations and docs. */
const repoSrc = (rel: string) =>
	fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

// The union is compile-time only AND tsconfig typechecks `src/**` alone, so no
// annotation in this file can gate it. The union is therefore read where it is
// declared, and the round trip proves the payload survives the JSONL hop.
{
	const unionLine = /type:\s*([^;]+);/.exec(repoSrc("src/log.ts"))?.[1] ?? "";
	const members = [...unionLine.matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
	check(
		"Type union: HindsightLogEntry's type union includes restore alongside the rest",
		members,
		["error", "invalidate", "recall", "reflect", "restore", "retain"],
	);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-union-"));
	const entry: Omit<HindsightLogEntry, "ts"> = {
		type: "restore",
		kills: KILLS_A,
	};
	appendLog(dir, LOG_PATH, entry);
	const back = readLog(dir, LOG_PATH, 10);
	check(
		"Type union: a restore entry round-trips through the append-only log",
		[back[0]?.type, back[0]?.kills],
		["restore", KILLS_A],
	);
}

{
	const { panel } = openLogPanel(
		writeLog([{ ts: TS, type: "restore", kills: KILLS_A }]),
	);
	const row = selectedRow(panel);
	check(
		"Restore row rendering: it does not fall through to the error line",
		row.startsWith("!"),
		false,
	);
	check(
		"Restore row rendering: an upward glyph opens the row",
		/^[\u2191\u2197]/.test(row),
		true,
	);
	check(
		"Restore row rendering: the word restore and a plural fact count",
		/\brestore\b/.test(row) && row.includes("2 facts"),
		true,
	);
	check(
		"Restore row rendering: the first kill's one-lined text",
		row.includes(KILLS_A[0].text),
		true,
	);
}

{
	const { panel } = openLogPanel(
		writeLog([{ ts: TS, type: "restore", kills: KILLS_B }]),
	);
	const row = selectedRow(panel);
	check(
		"Restore row rendering: a single fact is counted in the singular",
		row.includes("1 fact") && !row.includes("1 facts"),
		true,
	);
}

// ------------------------------------------ Requirement: configuration truth

const configSrc = repoSrc("src/config.ts");
const configLines = configSrc.split("\n");
const flagLine = configLines.findIndex((l) =>
	l.includes("factInvalidation: envBool("),
);
const flagComment: string[] = [];
for (
	let i = flagLine - 1;
	i >= 0 && (configLines[i] ?? "").trim().startsWith("//");
	i -= 1
)
	flagComment.unshift(configLines[i] ?? "");
const flagCommentText = flagComment.join("\n");

check(
	"Comment and default after the change: the default is untouched",
	configSrc.includes(
		'factInvalidation: envBool("HINDSIGHT_FACT_INVALIDATION", false)',
	),
	true,
);
check(
	"Comment and default after the change: it no longer claims no restore path exists",
	/flips once a restore path exists/i.test(flagCommentText),
	false,
);
check(
	"Comment and default after the change: it says the restore path exists now",
	/restore/i.test(flagCommentText),
	true,
);
check(
	"Comment and default after the change: it names the flip as a separate pending decision",
	/(owner|separate|deliberate|confirm)/i.test(flagCommentText),
	true,
);

// Every env-backed default, frozen. The restore path is allowed to change the
// COMMENT above one flag and nothing else in this file's behaviour.
const defaults = [...configSrc.matchAll(/env(?:Bool|Int)\("([A-Z_]+)",\s*([^)]+)\)/g)]
	.map((m) => `${m[1]}=${m[2].trim()}`)
	.sort();
check("No other default moves: every env-backed default is unchanged", defaults, [
	"HINDSIGHT_AUTO_MEMORIZE=true",
	"HINDSIGHT_AUTO_OFF=false",
	"HINDSIGHT_AUTO_RECALL=true",
	"HINDSIGHT_BANK_REMINDER=true",
	"HINDSIGHT_BANK_REMINDER_TURNS=5",
	"HINDSIGHT_COUNTS_REFRESH_MS=20000",
	"HINDSIGHT_DEBUG=false",
	"HINDSIGHT_DEEP_RECALL_MAX_LINES=24",
	"HINDSIGHT_DEEP_RECALL_QUERIES=5",
	"HINDSIGHT_FACT_INVALIDATION=false",
	"HINDSIGHT_RECALL_CONTEXT_TOKENS=5000",
	"HINDSIGHT_RECALL_MAX_LINES=8",
	"HINDSIGHT_RECALL_MAX_QUERIES=8",
	"HINDSIGHT_RECALL_MAX_TOKENS=2048",
	"HINDSIGHT_SUMMARY_MAX_TOKENS=6000",
	"HINDSIGHT_TASK_DETECT=true",
	"HINDSIGHT_TASK_HISTORY_TURNS=12",
	"HINDSIGHT_TASK_TITLE_TAIL=8",
]);

// ----------------------------------------------- Requirement: documentation

const readme = repoSrc("README.md");
const start = readme.indexOf("### Letting a fact die");
const rest = readme.slice(start + 1);
const end = rest.indexOf("\n### ");
const section = end < 0 ? rest : rest.slice(0, end);

check(
	"Reading the invalidation section: it names the Log tab and the retire row",
	/\bLog\b/.test(section) && /retire/i.test(section) && /\brow\b/i.test(section),
	true,
);
check(
	"Reading the invalidation section: it names the restore key",
	RESTORE_KEY !== undefined && section.includes(`\`${RESTORE_KEY}\``),
	true,
);
check(
	"Reading the invalidation section: it says restoring is row-granular",
	/(row-granular|whole row|entire row|all the facts|one keypress)/i.test(
		section,
	),
	true,
);
check(
	"Reading the invalidation section: it says a restore entry is appended to the log",
	/restore[^.\n]{0,40}(log )?entry|appends[^.\n]{0,40}restore/i.test(section),
	true,
);
check(
	"Reading the invalidation section: it no longer requires a hand-written PATCH",
	/hand-written/i.test(section),
	false,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Self-test for the SECOND rubber-meets-road half of "the automatic write path
 * cannot reach the user bank":
 *   bun scripts/memorize-user-bank.test.ts
 *
 * `scripts/user-bank.test.ts` guards the source of `src/memorize.ts` by name —
 * it fails if that file ever mentions `userBankId`. That is a tripwire, not an
 * impossibility: the Memorizer is handed the whole `HindsightConfig`, so the
 * identifier of the user bank is sitting inside its dependencies waiting to be
 * read.
 *
 * This test closes the hole from the other side: whatever `src/index.ts` hands
 * the Memorizer, its `userBankId` must be EMPTY even when the project declares
 * one. Then a future edit to memorize.ts has nothing to read — it addresses no
 * bank — and the greping guard stays as the second line of defence.
 *
 * The Memorizer itself is replaced by a recording stub, so this asserts the
 * WIRING (what index.ts passes) and never the Memorizer's own behaviour.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "bun:test";

// Same HOME redirection as user-bank.test.ts: the developer's own global
// hindsight.json must not answer these questions for us.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "memorize-user-bank-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.HINDSIGHT_BANK;
delete process.env.HINDSIGHT_USER_BANK;

const here = path.dirname(new URL(import.meta.url).pathname);
const memorizePath = path.join(here, "..", "src", "memorize.ts");

const realMemorize = await import("../src/memorize.ts");
const constructed: Array<Record<string, unknown>> = [];
mock.module(memorizePath, () => ({
	...realMemorize,
	Memorizer: class {
		constructor(deps: Record<string, unknown>) {
			constructed.push(deps);
		}
		dispose(): void {}
	},
}));

const { loadConfig } = await import("../src/config.ts");
const extension = (await import("../src/index.ts")).default;

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

// Nothing here talks to a bank; the stub also records where a write would land.
const urls: string[] = [];
const realFetch = globalThis.fetch;
// biome-ignore lint/suspicious/noExplicitAny: minimal transport stub
globalThis.fetch = (async (url: string) => {
	urls.push(String(url));
	return { ok: true, status: 200, text: async () => "{}" };
}) as any;

const USER_BANK = "user-bank";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "memorize-user-bank-"));
fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
fs.writeFileSync(
	path.join(cwd, ".pi", "hindsight.json"),
	JSON.stringify({
		baseUrl: "http://bank.test",
		bankId: "project-bank",
		userBankId: USER_BANK,
	}),
);

// The test is only meaningful if the project really declares a user bank.
check(
	"The project under test declares a user bank",
	(loadConfig(cwd) as unknown as Record<string, unknown>).userBankId,
	USER_BANK,
);

// Drive the real entry point: a session_start on a HOST session is the one
// place a Memorizer is built.
type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
const handlers: Record<string, Handler[]> = {};
const pi = {
	registerFlag: () => {},
	registerTool: () => {},
	registerCommand: () => {},
	registerShortcut: () => {},
	on: (name: string, fn: Handler) => {
		(handlers[name] ??= []).push(fn);
	},
};
const prev = process.cwd();
process.chdir(cwd);
try {
	// biome-ignore lint/suspicious/noExplicitAny: the stub implements the slice of ExtensionAPI this path uses
	extension(pi as any);
	for (const fn of handlers.session_start ?? []) {
		try {
			await fn(
				{},
				{ cwd, sessionManager: { getSessionName: () => "host-session" } },
			);
		} catch {
			// Everything after init() in that handler (widget, bank warm-up) is
			// irrelevant here; the Memorizer is already built by then.
		}
	}
} finally {
	process.chdir(prev);
}

check("A Memorizer was constructed", constructed.length, 1);

const memoCfg = (constructed[0]?.cfg ?? {}) as Record<string, unknown>;
check(
	"The Memorizer is handed an EMPTY userBankId even though the project declares one",
	memoCfg.userBankId,
	"",
);
check(
	"The rest of the config still reaches the Memorizer",
	[memoCfg.bankId, memoCfg.baseUrl],
	["project-bank", "http://bank.test"],
);
// The other dependency that could address a bank is the transport. Ask it where
// a write goes rather than reading its internals: one bank, and it is not the
// user's.
urls.length = 0;
await (
	constructed[0]?.client as { retain: (items: unknown[]) => Promise<unknown> }
)
	.retain([{ content: "probe" }])
	.catch(() => {});
check(
	"The client the Memorizer got can only write to the project bank",
	[
		urls.some((u) => u.includes("project-bank")),
		urls.some((u) => u.includes(USER_BANK)),
	],
	[true, false],
);

globalThis.fetch = realFetch;
for (const dir of [tmpHome, cwd])
	fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

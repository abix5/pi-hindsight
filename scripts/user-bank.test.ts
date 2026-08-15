/**
 * Self-test for the OPTIONAL user bank — the second, non-project bank that
 * holds what stays true when the person opens a different repository.
 *   bun scripts/user-bank.test.ts
 *
 * This slice adds WRITING only. What must hold:
 *
 *   1. `userBankId` is an ordinary config key (env `HINDSIGHT_USER_BANK`) whose
 *      default is the empty string, so a project that never heard of it behaves
 *      exactly as it does today — not "almost", but with the same tool list and
 *      the same number of HTTP requests;
 *   2. a whitespace-only value is unconfigured, not a bank named " ";
 *   3. with a bank declared, ONE extra tool appears and it writes to the USER
 *      bank while `hindsight_retain` keeps writing to the PROJECT bank. Two
 *      addresses, proven on a stubbed transport — nothing here talks to a live
 *      bank;
 *   4. the two tools share one write hygiene (retain-hygiene.ts), because a
 *      second, drifting copy of the context/metadata is how a bank ends up
 *      bilingual;
 *   5. the AUTOMATIC write path cannot address the user bank at all. Not "does
 *      not today" — cannot: `src/memorize.ts` is handed one client and never
 *      learns the key. That guard is written against a FUTURE edit, so it names
 *      the reference it found;
 *   6. nothing READS the user bank. No recall, no injected context, no command,
 *      no panel row. Reading is a later slice and must not leak into this one.
 *
 * The behavioural checks drive the real extension entry point in TOOLS-ONLY
 * mode (`--mem-only-tools`): the one seam where the whole thing initializes —
 * config, clients, tool registration — with no widget, no timers and no
 * session. Going through it means the test asserts BEHAVIOUR and never pins an
 * internal signature the implementation is free to choose.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Redirect HOME before importing config.ts: `globalConfigPath()` reads the
// developer's own ~/.pi/agent/hindsight.json, which may well declare a user
// bank of its own and would silently answer these questions for us.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "user-bank-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.HINDSIGHT_BANK;
delete process.env.HINDSIGHT_USER_BANK;
if (!process.argv.includes("--mem-only-tools"))
	process.argv.push("--mem-only-tools");

const { loadConfig, CONFIG_ALLOW } = await import("../src/config.ts");
const { retainContext, retainMetadata } = await import(
	"../src/retain-hygiene.ts"
);
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

// ------------------------------------------------------------------ fixtures

const cleanup: string[] = [tmpHome];

/** A throwaway project directory, optionally carrying `.pi/hindsight.json`. */
function makeCwd(name: string, cfg: Record<string, unknown> | null): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `user-bank-${name}-`));
	cleanup.push(cwd);
	if (cfg !== null) {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "hindsight.json"),
			JSON.stringify(cfg, null, 2),
		);
	}
	return cwd;
}

function repoSrc(file: string): string {
	return fs.readFileSync(
		path.join(path.dirname(new URL(import.meta.url).pathname), "..", file),
		"utf8",
	);
}

const BASE_URL = "http://bank.test";
const PROJECT_BANK = "project-bank";
const USER_BANK = "user-bank";
const LANGUAGE = "ru";

interface FakeTool {
	name: string;
	description?: string;
	promptGuidelines?: string[];
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<unknown>;
}

interface WireCall {
	url: string;
	method: string;
	body: Record<string, unknown>;
}

const calls: WireCall[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
	calls.push({
		url: String(url),
		method: init?.method ?? "GET",
		body: init?.body ? JSON.parse(String(init.body)) : {},
	});
	return { ok: true, status: 200, text: async () => "{}" };
	// biome-ignore lint/suspicious/noExplicitAny: minimal transport stub
}) as any;

/**
 * Initialize the extension in the given project directory and return the tools
 * it registered. `process.cwd()` stays on that directory: the tools read it at
 * call time (provenance, debug log), so the caller runs them inside `body`.
 */
async function withExtension(
	cwd: string,
	body: (tools: FakeTool[]) => Promise<void> | void,
): Promise<void> {
	const tools: FakeTool[] = [];
	const pi = {
		registerFlag: () => {},
		registerTool: (t: FakeTool) => tools.push(t),
		on: () => {},
		registerCommand: () => {},
	};
	const prev = process.cwd();
	process.chdir(cwd);
	calls.length = 0;
	try {
		// biome-ignore lint/suspicious/noExplicitAny: the stub implements the slice of ExtensionAPI tools-only mode uses
		extension(pi as any);
		await body(tools);
	} finally {
		process.chdir(prev);
	}
}

function names(tools: FakeTool[]): string[] {
	return tools.map((t) => t.name);
}

/** Everything a tool puts in front of the model, as one searchable string. */
function toolProse(tools: FakeTool[]): string {
	return tools
		.map((t) => [t.description ?? "", ...(t.promptGuidelines ?? [])].join(" "))
		.join(" ");
}

async function invoke(
	tools: FakeTool[],
	name: string,
	content: string,
): Promise<void> {
	const tool = tools.find((t) => t.name === name);
	if (!tool) return;
	await tool.execute("test-call", { content });
}

const retainBody = (call: WireCall | undefined) =>
	// biome-ignore lint/suspicious/noExplicitAny: reading the stubbed request back
	(call?.body as any)?.items?.[0];

const memoriesUrl = (bank: string) =>
	`${BASE_URL}/v1/default/banks/${bank}/memories`;

// =================================================== Requirement: the config key

// --- Scenario: No configuration anywhere
{
	const cfg = loadConfig(makeCwd("unset", null)) as unknown as Record<
		string,
		unknown
	>;
	check(
		"No configuration anywhere: the loaded config has userBankId === \"\"",
		cfg.userBankId,
		"",
	);
}

// --- Scenario: Declared via env or file
{
	process.env.HINDSIGHT_USER_BANK = "env-user-bank";
	const fromEnv = loadConfig(makeCwd("env", null)) as unknown as Record<
		string,
		unknown
	>;
	check(
		"Declared via env or file: HINDSIGHT_USER_BANK reaches the config",
		fromEnv.userBankId,
		"env-user-bank",
	);

	// The file layer is the one that survives a hot /reload, so it must accept
	// the key too — and, like every other key, beat the environment.
	const fromFile = loadConfig(
		makeCwd("file", { userBankId: "file-user-bank" }),
	) as unknown as Record<string, unknown>;
	delete process.env.HINDSIGHT_USER_BANK;
	check(
		"Declared via env or file: .pi/hindsight.json declares it through the existing merge order",
		fromFile.userBankId,
		"file-user-bank",
	);
	check(
		"Declared via env or file: the key is a member of CONFIG_ALLOW",
		CONFIG_ALLOW.has("userBankId" as never),
		true,
	);
	check(
		"Declared via env or file: the key is always a string, never undefined",
		typeof (loadConfig(makeCwd("typed", null)) as unknown as Record<string, unknown>)
			.userBankId,
		"string",
	);
}

// --- Scenario: Whitespace-only value
{
	process.env.HINDSIGHT_USER_BANK = "   ";
	const cfg = loadConfig(makeCwd("blank-env", null)) as unknown as Record<
		string,
		unknown
	>;
	delete process.env.HINDSIGHT_USER_BANK;
	check(
		"Whitespace-only value: it resolves to nothing addressable",
		typeof cfg.userBankId === "string" &&
			(cfg.userBankId as string).trim() === "",
		true,
	);

	await withExtension(
		makeCwd("blank-file", {
			baseUrl: BASE_URL,
			bankId: PROJECT_BANK,
			userBankId: "  \t ",
		}),
		(tools) => {
			check(
				"Whitespace-only value: no user-bank tool is registered",
				names(tools).includes("hindsight_retain_user"),
				false,
			);
			check(
				"Whitespace-only value: no request is issued for a blank bank",
				calls.length,
				0,
			);
		},
	);
}

// ====================== Requirement: the client and the tool exist only when configured

// --- Scenario: Unconfigured (client) + Unconfigured user bank (tool)
{
	await withExtension(
		makeCwd("off", { baseUrl: BASE_URL, bankId: PROJECT_BANK }),
		(tools) => {
			check(
				"Unconfigured user bank: the registered tool list is identical to today's",
				names(tools),
				["hindsight_retain", "hindsight_recall", "hindsight_reflect"],
			);
			// A second client would have to be built from the same config, and the
			// only observable difference at startup is traffic. There is none today.
			check(
				"Unconfigured: no HTTP request is issued beyond those the current code already issues",
				calls.length,
				0,
			);
			check(
				"Unconfigured user bank: no prompt guideline mentions a user bank",
				/user[ -]?bank|retain_user/i.test(toolProse(tools)),
				false,
			);
		},
	);
}

// --- Scenario: Configured (client) + Configured user bank (tool)
const configuredCwd = makeCwd("on", {
	baseUrl: BASE_URL,
	bankId: PROJECT_BANK,
	userBankId: USER_BANK,
	memoryLanguage: LANGUAGE,
});

await withExtension(configuredCwd, async (tools) => {
	check(
		"Configured user bank: hindsight_retain_user appears alongside the unchanged hindsight_retain",
		names(tools).slice().sort(),
		[
			"hindsight_recall",
			"hindsight_reflect",
			"hindsight_retain",
			"hindsight_retain_user",
		],
	);
	check(
		"Configured: constructing the second client issues no request of its own",
		calls.length,
		0,
	);

	// --- Scenario: Two tools, two bank addresses
	calls.length = 0;
	await invoke(tools, "hindsight_retain", "a project fact");
	const projectCalls = calls.slice();
	calls.length = 0;
	await invoke(tools, "hindsight_retain_user", "a standing user instruction");
	const userCalls = calls.slice();

	check(
		"Two tools, two bank addresses: hindsight_retain wrote only to the project bank",
		projectCalls.map((c) => `${c.method} ${c.url}`),
		[`POST ${memoriesUrl(PROJECT_BANK)}`],
	);
	check(
		"Two tools, two bank addresses: hindsight_retain_user wrote only to the user bank",
		userCalls.map((c) => `${c.method} ${c.url}`),
		[`POST ${memoriesUrl(USER_BANK)}`],
	);
	check(
		"Two tools, two bank addresses: neither tool touched the other's bank",
		[
			projectCalls.some((c) => c.url.includes(USER_BANK)),
			userCalls.some((c) => c.url.includes(PROJECT_BANK)),
		],
		[false, false],
	);

	const projectItem = retainBody(projectCalls[0]);
	const userItem = retainBody(userCalls[0]);

	// --- Scenario: Tags identify the bank
	check(
		"Tags identify the bank: the user note is tagged with userBankId",
		Array.isArray(userItem?.tags) && userItem.tags.includes(USER_BANK),
		true,
	);
	check(
		"Tags identify the bank: the user note carries no project bank tag",
		Array.isArray(userItem?.tags) && userItem.tags.includes(PROJECT_BANK),
		false,
	);
	check(
		"Tags identify the bank: the two tools' tags are distinguishable",
		JSON.stringify(userItem?.tags) === JSON.stringify(projectItem?.tags),
		false,
	);
	check(
		"Tags identify the bank: the project tool still tags with the project bank",
		Array.isArray(projectItem?.tags) && projectItem.tags.includes(PROJECT_BANK),
		true,
	);

	// --- Scenario: Hygiene parity
	// The user tool must reuse retain-hygiene.ts, not grow its own wording: the
	// context is what pins the speaker and the LANGUAGE on the server side, and a
	// second copy of it drifts the moment either is tuned.
	const provenance = {
		project: path.basename(configuredCwd),
		language: LANGUAGE,
	};
	check(
		"Hygiene parity: the user note carries the shared retain context",
		userItem?.context,
		retainContext("agent-note", provenance),
	);
	check(
		"Hygiene parity: the user note carries the shared retain metadata",
		userItem?.metadata,
		retainMetadata("agent-note", provenance),
	);
	check(
		"Hygiene parity: both tools send the same context",
		userItem?.context === projectItem?.context,
		true,
	);
	check(
		"Hygiene parity: the user note is written in the configured memory language",
		typeof userItem?.context === "string" &&
			userItem.context.includes(`write every extracted fact in ${LANGUAGE}`),
		true,
	);
});

// ---- the mirror of the unconfigured guideline check: once a bank is declared,
// the model has to be TOLD the second bank exists, or the tool is never called.
{
	await withExtension(configuredCwd, (tools) => {
		const userTool = tools.find((t) => t.name === "hindsight_retain_user");
		const prose = [
			userTool?.description ?? "",
			...(userTool?.promptGuidelines ?? []),
		].join(" ");
		check(
			"Configured user bank: the user tool names the bank it writes to",
			/user[ -]?bank/i.test(prose),
			true,
		);
	});
}

// ============ Requirement: the automatic memorize path cannot reach the user bank

{
	const memorizeSrc = repoSrc("src/memorize.ts");
	const indexSrc = repoSrc("src/index.ts");

	// A guard is worthless if it also passes on a tree where the feature was
	// never built: prove first that the wiring EXISTS somewhere, then that it is
	// deliberately absent from the automatic path.
	const srcDir = path.join(
		path.dirname(new URL(import.meta.url).pathname),
		"..",
		"src",
	);
	const wired = fs
		.readdirSync(srcDir)
		.filter((f) => f.endsWith(".ts") && f !== "memorize.ts")
		.filter((f) => /userBankId|HINDSIGHT_USER_BANK/.test(repoSrc(`src/${f}`)));
	check(
		"Automatic capture stays in the project bank: the user bank is wired somewhere else",
		wired.length > 0,
		true,
	);

	const forbidden = ["userBankId", "HINDSIGHT_USER_BANK", "userClient"];
	const found = forbidden.filter((ref) => memorizeSrc.includes(ref));
	check(
		`Guard against a future regression: src/memorize.ts references none of ${forbidden.join(", ")}`,
		found,
		[],
	);

	// One client in, one bank out. A second client field on the dependency
	// object is the shortest route to an automatic write landing in the user
	// bank, so the shape of the object is pinned, not just the current calls.
	const deps = /export interface MemorizeDeps \{([\s\S]*?)\n\}/.exec(
		memorizeSrc,
	)?.[1];
	check(
		"Guard against a future regression: MemorizeDeps carries exactly one client",
		(deps?.match(/HindsightClient/g) ?? []).length,
		1,
	);
	check(
		"Guard against a future regression: every memorize write goes through the single injected client",
		[...memorizeSrc.matchAll(/(\S+)\.retain\(/g)].map((m) => m[1]),
		["this.deps.client"],
	);

	// The dependency wiring is the other half: whatever index.ts builds for the
	// user bank, it must not hand it to the Memorizer.
	const memorizerCall = /new Memorizer\(([\s\S]*?)\);/.exec(indexSrc)?.[1] ?? "";
	check(
		"Guard against a future regression: index.ts hands the Memorizer no user-bank dependency",
		/user/i.test(memorizerCall),
		false,
	);
}

// ================== Requirement: this slice adds writing only, never reading

{
	// Every surface that could put bank content in front of a human or in the
	// model's context. Reading the user bank is a later slice; a mention here
	// means it started early.
	const readSurfaces = [
		"src/recall.ts",
		"src/recall-utils.ts",
		"src/reminder.ts",
		"src/commands.ts",
		"src/mem-panel.ts",
		"src/ui.ts",
		"src/review-docs.ts",
		"src/review-queue.ts",
		"src/task-detector.ts",
		"src/transcript.ts",
		"src/prompts.ts",
		"src/memorize.ts",
	];
	const leaked = readSurfaces.filter((f) =>
		/userBankId|HINDSIGHT_USER_BANK|retain_user/.test(repoSrc(f)),
	);
	check(
		"No new read surface: no recall, prompt, command or panel file knows the user bank",
		leaked,
		[],
	);

	await withExtension(configuredCwd, (tools) => {
		check(
			"No new read surface: the only user-bank tool is the one that writes",
			names(tools).filter((n) => /user/i.test(n)),
			["hindsight_retain_user"],
		);
	});
}

globalThis.fetch = realFetch;
for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

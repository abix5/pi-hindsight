/**
 * Self-test for the FRAME a user-bank write carries.
 *   bun scripts/user-bank-context.test.ts
 *
 * WHY this file exists, next to write-hygiene.test.ts: the server splices
 * `context` straight into the fact-extraction prompt, so the frame is not
 * decoration — it decides what the extracted fact CLAIMS. The project bank is
 * framed as `Knowledge base of the software project "X"`, which is right for
 * knowledge about a checkout and wrong for the optional user bank: a standing
 * rule about the PERSON came back out of extraction rewritten as a rule about
 * one repository. The metadata told the same lie, carrying `project: <repo>`
 * on knowledge that is deliberately not bound to any repo.
 *
 * So this file pins three things at once, because fixing one by breaking
 * another is the obvious failure mode:
 *
 *   1. the user-bank frame talks about a PERSON and about knowledge that holds
 *      across projects, and names no repository;
 *   2. it still does the two jobs retain-hygiene.ts exists for — naming the
 *      speaker in the third person (measured: 40% of facts land as
 *      `experience` when the assistant reads as the speaker) and pinning the
 *      output language with an IMPERATIVE (measured: 78% Cyrillic without it,
 *      0% with it);
 *   3. the PROJECT frame and metadata are byte-for-byte what commit 940daeb
 *      produced — asserted against literal strings, not against the code that
 *      builds them.
 *
 * The user-side assertions run against the bytes the extension actually PUTS
 * ON THE WIRE, driven through the real entry point in tools-only mode. That
 * way they describe behaviour and pin no internal helper name.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Redirect HOME before importing config.ts: `globalConfigPath()` otherwise
// reads the developer's own ~/.pi/agent/hindsight.json, which may declare a
// user bank and answer these questions for us.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hs-frame-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.HINDSIGHT_BANK;
delete process.env.HINDSIGHT_USER_BANK;
delete process.env.HINDSIGHT_MEMORY_LANGUAGE;
if (!process.argv.includes("--mem-only-tools"))
	process.argv.push("--mem-only-tools");

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

const BASE_URL = "http://bank.test";
const PROJECT_BANK = "project-bank";
const USER_BANK = "user-bank";
const LANGUAGE = "ru";

interface FakeTool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<unknown>;
}

interface WireCall {
	url: string;
	method: string;
	// biome-ignore lint/suspicious/noExplicitAny: reading a stubbed request back
	body: any;
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

// The directory name must not contain the word "user": it becomes the project
// name, and a scope marker is looked for by value below.
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hs-frame-repo-"));
cleanup.push(cwd);
fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
fs.writeFileSync(
	path.join(cwd, ".pi", "hindsight.json"),
	JSON.stringify(
		{
			baseUrl: BASE_URL,
			bankId: PROJECT_BANK,
			userBankId: USER_BANK,
			memoryLanguage: LANGUAGE,
		},
		null,
		2,
	),
);
/** The provenance the tools derive at call time: the working directory's name. */
const PROJECT = path.basename(cwd);

const tools: FakeTool[] = [];
const pi = {
	registerFlag: () => {},
	registerTool: (t: FakeTool) => tools.push(t),
	on: () => {},
	registerCommand: () => {},
};

const prevCwd = process.cwd();
process.chdir(cwd);
// biome-ignore lint/suspicious/noExplicitAny: the stub implements the slice of ExtensionAPI tools-only mode uses
extension(pi as any);

async function invoke(name: string, content: string): Promise<WireCall[]> {
	calls.length = 0;
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`tool ${name} was never registered`);
	await tool.execute("test-call", { content });
	return calls.slice();
}

const projectCalls = await invoke("hindsight_retain", "a project fact");
const userCalls = await invoke(
	"hindsight_retain_user",
	"the owner refuses a mechanism before its cost is known",
);
process.chdir(prevCwd);

const projectItem = projectCalls[0]?.body?.items?.[0];
const userItem = userCalls[0]?.body?.items?.[0];
const userCtx: string = userItem?.context ?? "";
const projectCtx: string = projectItem?.context ?? "";
const userMeta: Record<string, string> = userItem?.metadata ?? {};

console.log(`\nUSER CONTEXT:\n${userCtx}\n`);
console.log(`USER METADATA: ${JSON.stringify(userMeta)}\n`);

// ====== Requirement: User-bank retain context frames a person, not a repository

// --- Scenario: User-bank context carries no project frame
check(
	"User-bank context carries no project frame: no `Knowledge base of the software project` phrase",
	userCtx.includes("Knowledge base of the software project"),
	false,
);
check(
	"User-bank context carries no project frame: the repository name is absent",
	userCtx.includes(PROJECT),
	false,
);
// The replacement has to SAY what the bank holds, or the extractor is simply
// left without a frame: knowledge about a person, true wherever they work.
// `third person` is the SPEAKER discipline, not a subject, so it is removed
// before asking whether the frame names a human at all.
const subjectText = userCtx.replace(/third person/gi, "");
check(
	"User-bank context carries no project frame: the frame names the person the knowledge is about",
	/\b(person|human|individual)\b/i.test(subjectText),
	true,
);
check(
	"User-bank context carries no project frame: the frame says the knowledge holds across projects",
	/(across|in)\s+(all\s+|every\s+|any\s+)?projects|every project|any project|regardless of (the )?(project|repository|checkout)|not (just |only )?(in )?(one|a single) (repository|project|checkout)/i.test(
		userCtx,
	),
	true,
);

// --- Scenario: User-bank context differs from the project-bank context
// Same provenance, same tool call shape — only the frame may differ, and it
// must: an identical string is exactly the defect this slice repairs.
check(
	"User-bank context differs from the project-bank context: the two strings are not equal",
	userCtx === projectCtx,
	false,
);

// ============== Requirement: User-bank context keeps both extraction disciplines

// --- Scenario: Speaker is named in the third person
check(
	"Speaker is named in the third person: the speaker is named in the third person",
	/third person/i.test(userCtx),
	true,
);
check(
	"Speaker is named in the third person: the assistant is denied as the speaker",
	/is NOT the speaker/i.test(userCtx),
	true,
);
check(
	"Speaker is named in the third person: nothing recorded is an experience of the assistant",
	/experience of the assistant/i.test(userCtx),
	true,
);

// --- Scenario: Language is pinned imperatively
// The bank above is configured `memoryLanguage: "ru"`, so the imperative must
// carry `ru` — a hard-coded language would pass a laxer check.
check(
	"Language is pinned imperatively: the configured language is ordered, not described",
	/write\s+every\s+extracted\s+fact\s+in\s+ru\b/i.test(userCtx),
	true,
);
check(
	"Language is pinned imperatively: the note's own language does not win",
	/whatever language this note happens to be in|regardless of (the )?language/i.test(
		userCtx,
	),
	true,
);

// ================= Requirement: User-bank metadata does not claim one repository

// --- Scenario: No project key in user metadata
check(
	"No project key in user metadata: there is no `project` key",
	Object.keys(userMeta).includes("project"),
	false,
);
check(
	"No project key in user metadata: no value names the current checkout",
	Object.values(userMeta).filter((v) => String(v).includes(PROJECT)),
	[],
);

// --- Scenario: Cross-project scope is stated
// The key name WAS the implementer's to choose while the spec was open; now
// that it is chosen, the assertion is exact. A loose "some field mentions
// user" check would let the source label silently fall back to `agent-note`,
// or an extra key appear, and still pass — and the whole point of this record
// shape is that a recalled fact carries an honest account of where it came
// from. Changing the shape on purpose means changing this literal on purpose.
check(
	"Cross-project scope is stated: the metadata is exactly the user-note shape",
	userMeta,
	{
		source: "pi-hindsight/user-note",
		scope: "user",
		language: LANGUAGE,
	},
);
check(
	"Cross-project scope is stated: every value is still a string (the API rejects anything else)",
	Object.values(userMeta).every((v) => typeof v === "string"),
	true,
);

// ======================= Requirement: Project-bank retain hygiene is unchanged

// The expected strings are LITERALS copied from commit 940daeb, not built from
// the module under test: a test that asks the code what it produces cannot
// notice the code changing.
const SPEAKER =
	"SPEAKER: the project's memory keeper, writing in the third person about the project itself." +
	" The AI coding assistant is NOT the speaker and no conversation is being reported, so nothing here is an experience of the assistant \u2014 every line is an established fact about the project or a standing preference of its owner." +
	" LANGUAGE: write every extracted fact in en, whatever language this note happens to be in. Keep code identifiers, paths and commands verbatim.";

const EXPECTED_PROJECT_CONTEXT: Record<string, string> = {
	"session-note":
		'Knowledge base of the software project "pi-hindsight": a distilled note of durable engineering knowledge that surfaced while the project was being worked on.' +
		` ${SPEAKER}`,
	"agent-note":
		'Knowledge base of the software project "pi-hindsight": one durable fact, decision, procedure or dead-end recorded the moment it was learned.' +
		` ${SPEAKER}`,
	"user-edit":
		'Knowledge base of the software project "pi-hindsight": a distilled note of durable engineering knowledge, reviewed and corrected by hand by the project\'s owner.' +
		` ${SPEAKER}`,
};

const P = { project: "pi-hindsight", language: "en", session: "sess-1" };

// --- Scenario: Project context strings match exact expected text
for (const source of ["session-note", "agent-note", "user-edit"] as const) {
	check(
		`Project context strings match exact expected text: ${source}`,
		retainContext(source, P),
		EXPECTED_PROJECT_CONTEXT[source],
	);
}

// --- Scenario: Project metadata still carries the project
check(
	"Project metadata still carries the project: without a session",
	retainMetadata("agent-note", { project: "p", language: "en" }),
	{ source: "pi-hindsight/agent-note", project: "p", language: "en" },
);
check(
	"Project metadata still carries the project: with a session",
	retainMetadata("session-note", { project: "p", language: "en", session: "s-1" }),
	{
		source: "pi-hindsight/session-note",
		project: "p",
		language: "en",
		session: "s-1",
	},
);

// ================ Requirement: Only the user-bank tool uses the user framing

// --- Scenario: The user tool sends the user frame on the wire
check(
	"The user tool sends the user frame on the wire: it POSTed to the user bank",
	userCalls.map((c) => `${c.method} ${c.url}`),
	[`POST ${BASE_URL}/v1/default/banks/${USER_BANK}/memories`],
);
check(
	"The user tool sends the user frame on the wire: the context on the wire never mentions the repository",
	userCtx.includes(PROJECT) || userCtx.includes("software project"),
	false,
);
check(
	"The user tool sends the user frame on the wire: the metadata on the wire never mentions the repository",
	JSON.stringify(userMeta).includes(PROJECT),
	false,
);

// --- Scenario: The project tool is untouched
// Same run, same directory: whatever the user tool now sends, the project tool
// must still send the 940daeb bytes.
check(
	"The project tool is untouched: the context is the 940daeb project context",
	projectCtx,
	`Knowledge base of the software project "${PROJECT}": one durable fact, decision, procedure or dead-end recorded the moment it was learned.` +
		" SPEAKER: the project's memory keeper, writing in the third person about the project itself." +
		" The AI coding assistant is NOT the speaker and no conversation is being reported, so nothing here is an experience of the assistant \u2014 every line is an established fact about the project or a standing preference of its owner." +
		` LANGUAGE: write every extracted fact in ${LANGUAGE}, whatever language this note happens to be in. Keep code identifiers, paths and commands verbatim.`,
);
check(
	"The project tool is untouched: the metadata still carries the project",
	projectItem?.metadata,
	{
		source: "pi-hindsight/agent-note",
		project: PROJECT,
		language: LANGUAGE,
	},
);

// ============== Requirement: README documents server-side language agreement

// The extension can only steer extraction through `context`; the SERVER has its
// own two language switches, and nothing in the API reports them back, so the
// only place the agreement can live is a line a human reads.
{
	const readme = fs.readFileSync(
		path.join(path.dirname(new URL(import.meta.url).pathname), "..", "README.md"),
		"utf8",
	);
	const near = (needle: string, radius = 600): string => {
		const i = readme.indexOf(needle);
		return i < 0 ? "" : readme.slice(Math.max(0, i - radius), i + radius);
	};

	check(
		"README names the two server variables and the blind spot: HINDSIGHT_API_LLM_OUTPUT_LANGUAGE is named",
		readme.includes("HINDSIGHT_API_LLM_OUTPUT_LANGUAGE"),
		true,
	);
	check(
		"README names the two server variables and the blind spot: it is described as forcing the language of the LLM's artifacts",
		/(forc|pin|impos)\w*[^.]{0,120}language[^.]{0,160}(artifact|output|everything|all)|language of (all|every)[^.]{0,80}(artifact|output)/i.test(
			near("HINDSIGHT_API_LLM_OUTPUT_LANGUAGE"),
		),
		true,
	);
	check(
		"README names the two server variables and the blind spot: HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE is named",
		readme.includes("HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE"),
		true,
	);
	check(
		"README names the two server variables and the blind spot: it is described as the PostgreSQL full-text-search dictionary defaulting to english",
		/postgres/i.test(near("HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE")) &&
			/english/i.test(near("HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE")),
		true,
	);
	check(
		"README names the two server variables and the blind spot: a Russian bank must set it",
		/russian|\bru\b/i.test(near("HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE")),
		true,
	);
	check(
		"README names the two server variables and the blind spot: the memoryLanguage setting is tied to the server settings",
		/memoryLanguage/.test(near("HINDSIGHT_API_LLM_OUTPUT_LANGUAGE", 1200)),
		true,
	);

	const configMatch = /banks\/[^\s`)]*\/config/.exec(readme);
	check(
		"README names the two server variables and the blind spot: the bank config endpoint is named",
		configMatch !== null,
		true,
	);
	const aroundConfig = configMatch ? near(configMatch[0], 700) : "";
	check(
		"README names the two server variables and the blind spot: the endpoint is stated to return no language key",
		/no( \w+){0,3} language|nothing about (the )?language|not (report|expose|return)\w*[^.]{0,60}language|language[^.]{0,60}(is|are) not (report|expose|return)/i.test(
			aroundConfig,
		),
		true,
	);
	check(
		"README names the two server variables and the blind spot: reconciliation is left to the human",
		/(cannot|can not|no way to|impossible)[^.]{0,120}(check|verif|reconcil|compar)|(left to|up to|down to) the (human|person|owner|reader|you)|manual\w*[^.]{0,60}(check|reconcil|agree)/i.test(
			aroundConfig + near("HINDSIGHT_API_LLM_OUTPUT_LANGUAGE", 1200),
		),
		true,
	);
}

globalThis.fetch = realFetch;
for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

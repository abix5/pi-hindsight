/**
 * Self-test for write hygiene (run with bun or node).
 *   bun scripts/write-hygiene.test.ts
 *
 * What must hold:
 *   1. every write path builds its `context` and `metadata` from ONE helper, so
 *      "context on every retain" cannot rot back into "context on some";
 *   2. the context names the speaker in the third person and explicitly denies
 *      that the assistant is speaking — that is what keeps `fact_type` at
 *      `world` instead of `experience` (measured on the live 0.9.0 server: the
 *      same note with "The assistant is speaking" extracted 40% `experience`);
 *   3. the context carries an IMPERATIVE naming the bank's language. The server
 *      forbids its extractor to translate, so without this a Russian note lands
 *      as Russian facts in an English bank (measured: 78% Cyrillic without the
 *      line, 0% with it);
 *   4. the request the client sends is the shape the live server accepts, and
 *      `document_id` still rides along so upsert behaviour is unchanged;
 *   5. the bank-config PATCH keeps its `{updates:{…}}` wrapper (bare keys 422);
 *   6. the post-write notification names WHAT was stored, on ONE line, with no
 *      ANSI and no newline — and degrades to counts rather than to garbage.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { HindsightClient } from "../src/hindsight.ts";
import { writeNotice } from "../src/memorize.ts";
import { reminderText } from "../src/reminder.ts";
import {
	type RetainSource,
	retainContext,
	retainMetadata,
} from "../src/retain-hygiene.ts";

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

const SOURCES: RetainSource[] = ["session-note", "agent-note", "user-edit"];
const P = { project: "pi-hindsight", language: "en", session: "sess-1" };

// ----------------------------------------------------------------- context

for (const source of SOURCES) {
	const ctx = retainContext(source, P);
	check(`${source}: names the project`, ctx.includes('"pi-hindsight"'), true);
	check(`${source}: names the speaker`, ctx.includes("SPEAKER:"), true);
	// The whole point of the wording: a first-person claim by the bank's own
	// agent becomes an `experience` fact. These documents are knowledge ABOUT a
	// project, so the context has to disown that reading out loud.
	check(
		`${source}: denies that the assistant is the speaker`,
		ctx.includes("The AI coding assistant is NOT the speaker"),
		true,
	);
	check(
		`${source}: says nothing here is an experience of the assistant`,
		ctx.includes("nothing here is an experience of the assistant"),
		true,
	);
	// An IMPERATIVE, not a description. The old context said "The note is written
	// in ru" and steered nothing at all.
	check(
		`${source}: orders the fact language`,
		ctx.includes("write every extracted fact in en"),
		true,
	);
	check(
		`${source}: overrides the note's own language`,
		ctx.includes("whatever language this note happens to be in"),
		true,
	);
}

check(
	"the language is the configured one, not a constant",
	retainContext("session-note", { ...P, language: "ru" }).includes(
		"write every extracted fact in ru",
	),
	true,
);

// Each source still identifies itself, so the extractor knows whether it is
// reading a session digest, a single hand-recorded note, or a human edit.
check(
	"the three sources describe themselves differently",
	new Set(SOURCES.map((s) => retainContext(s, P))).size,
	3,
);

// ---------------------------------------------------------------- metadata

check("session-note metadata", retainMetadata("session-note", P), {
	source: "pi-hindsight/session-note",
	project: "pi-hindsight",
	language: "en",
	session: "sess-1",
});

// The deliberate `hindsight_retain` tool has no session handle; the key must be
// absent rather than present-and-empty (every key is fed to the extractor).
check(
	"a source without a session omits the key",
	retainMetadata("agent-note", { project: "p", language: "en" }),
	{ source: "pi-hindsight/agent-note", project: "p", language: "en" },
);

check(
	"metadata values are all strings (the API rejects anything else)",
	Object.values(retainMetadata("session-note", P)).every(
		(v) => typeof v === "string",
	),
	true,
);

// ------------------------------------------------- every write path uses it

// Three files POST documents to the bank. A new one that forgets `context`
// would silently undo this whole change, so the invariant is pinned in code
// rather than in a comment.
const here = path.dirname(new URL(import.meta.url).pathname);
for (const file of ["memorize.ts", "tools.ts", "review-docs.ts"]) {
	const src = fs.readFileSync(path.join(here, "..", "src", file), "utf8");
	check(
		`src/${file} builds its context from the shared helper`,
		src.includes("retainContext(") && src.includes("retainMetadata("),
		true,
	);
	check(
		`src/${file} has no hand-written context left`,
		/context:\s*["'`]/.test(src),
		false,
	);
}

// --------------------------------------------------------- request shapes

const calls: Array<{ url: string; method: string; body: any }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
	calls.push({
		url: String(url),
		method: init.method ?? "GET",
		body: JSON.parse(String(init.body)),
	});
	return { ok: true, status: 200, text: async () => "{}" };
	// biome-ignore lint/suspicious/noExplicitAny: minimal fetch stub for the shape assertion
}) as any;

const client = new HindsightClient({
	baseUrl: "http://localhost:8888",
	namespace: "default",
	bankId: "zz-hygiene-probe",
	// biome-ignore lint/suspicious/noExplicitAny: only the three fields above are read
} as any);

await client.retain("a durable fact", {
	tags: ["zz-hygiene-probe", "agent-summary"],
	documentId: "pi-deadbeef",
	context: retainContext("session-note", P),
	metadata: retainMetadata("session-note", P),
	async: true,
});

const item = calls[0]?.body?.items?.[0];
check("retain POSTs one item to memories", [calls[0]?.method, calls[0]?.url], [
	"POST",
	"http://localhost:8888/v1/default/banks/zz-hygiene-probe/memories",
]);
check("the context reaches the wire", item?.context, retainContext("session-note", P));
check(
	"the metadata reaches the wire",
	item?.metadata,
	retainMetadata("session-note", P),
);
// Adding the two fields must not disturb the deterministic upsert.
check("document_id still rides along", item?.document_id, "pi-deadbeef");
check("tags still ride along", item?.tags, [
	"zz-hygiene-probe",
	"agent-summary",
]);

// The bank config PATCH needs the wrapper: bare keys are a 422, and PUT/POST
// are a 405. Verified against the live server.
calls.length = 0;
await client.updateBankConfig({ retain_mission: "keep decisions" });
check("bank config is PATCHed", calls[0]?.method, "PATCH");
check("bank config keys are wrapped in `updates`", calls[0]?.body, {
	updates: { retain_mission: "keep decisions" },
});

globalThis.fetch = realFetch;

// ------------------------------------------------------ language, upstream

// Converting facts at extraction time fixes the FACTS; the stored document text
// is still whatever the agent typed, and recall can hand that back as a chunk.
// So the reminder tells the agent the bank's language up front.
check(
	"the reminder names the bank language",
	reminderText("pi-hindsight", undefined, "en").includes(
		"Write it in en, whatever language this conversation is in",
	),
	true,
);
check(
	"an unknown language adds no clause",
	reminderText("pi-hindsight").includes("Write it in"),
	false,
);

// ------------------------------------------------------ write notification

// The old line was `wrote 1 document · 5 note lines`: the document count is
// hardcoded 1 (the inline path writes exactly one), so it carried no
// information, and line counts never said WHAT landed in the bank.

const normalNote = [
	"## Decisions:",
	"- Recall effort is a real ceiling, not a prompt anchor.",
	"- The bank reminder counts silent turns instead of a fixed modulo.",
	"",
	"## Constraints:",
	"- Never commit `.pi/hindsight.json`.",
].join("\n");

console.log(`\nNOTICE normal:    ${JSON.stringify(writeNotice(normalNote))}`);
check(
	"a normal note names its subjects",
	writeNotice(normalNote),
	"saved 3 lines: Recall effort is a real ceiling\u2026; The bank reminder counts silent\u2026 (+1 more)",
);

const oneBullet = "- Compaction is the only trigger for the inline write path.";
console.log(`NOTICE one:       ${JSON.stringify(writeNotice(oneBullet))}`);
check(
	"a one-bullet note says one subject and no \u201cmore\u201d",
	writeNotice(oneBullet),
	"saved 1 line: Compaction is the only trigger\u2026",
);

// Awkward: a bullet that spans lines, one that is a single unbreakable token,
// one carrying ANSI, and one that is pure punctuation.
const awkward = [
	"- \u001b[31mred\u001b[0m alert: the widget must render exactly one line",
	"-   ",
	"- ---",
	"- supercalifragilisticexpialidociousandthensomemoreletters follows",
	"- A bullet whose text\twraps onto a second line",
	"  because the model wrote it that way.",
].join("\n");
const awkwardNotice = writeNotice(awkward);
console.log(`NOTICE awkward:   ${JSON.stringify(awkwardNotice)}`);
check(
	"awkward bullets still yield clean subjects",
	awkwardNotice,
	"saved 5 lines: red alert: the widget must render\u2026; supercalifragilisticexpialidocious\u2026 (+1 more)",
);
check("no ANSI escape reaches the notification", /\u001b/.test(awkwardNotice), false);
check(
	"no control character reaches the notification",
	/[\u0000-\u001f\u007f]/.test(awkwardNotice),
	false,
);

// Empty / subject-less input must fall back to the counts it replaced, never to
// a half-built sentence.
console.log(`NOTICE empty:     ${JSON.stringify(writeNotice(""))}`);
check("an empty note degrades to counts", writeNotice(""), "wrote 0 note lines");
check(
	"a note with no legible subject degrades to counts",
	writeNotice("- ---\n- ***"),
	"wrote 2 note lines",
);

// A kill is otherwise invisible: the fact is gone from the bank and nothing in
// the UI ever said so.
const withKills = writeNotice(normalNote, 2);
console.log(`NOTICE kills:     ${JSON.stringify(withKills)}`);
check("invalidations are surfaced", withKills.endsWith(" \u00b7 2 facts retired"), true);
check(
	"one kill is singular",
	writeNotice(oneBullet, 1).endsWith(" \u00b7 1 fact retired"),
	true,
);
check(
	"kills survive the degraded path",
	writeNotice("", 3),
	"wrote 0 note lines \u00b7 3 facts retired",
);
check("no kills, no suffix", writeNotice(normalNote, 0).includes("retired"), false);

// It is a notification, not a report.
for (const [label, notice] of [
	["normal", writeNotice(normalNote, 2)],
	["awkward", awkwardNotice],
	["long", writeNotice(`- ${"word ".repeat(200)}\n- ${"x".repeat(400)}`, 9)],
] as const) {
	check(`${label}: single line`, notice.includes("\n"), false);
	check(`${label}: stays short`, notice.length <= 120, true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);

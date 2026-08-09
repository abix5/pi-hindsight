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

// The old line was `wrote 1 document · 5 note lines`: line counts never said
// WHAT landed in the bank. The one-line replacement was no better — it cut every
// subject at 34 characters and hid the rest behind "(+N more)". `ctx.ui.notify`
// lands in an ordinary chat Text node (pi-tui's wrapTextWithAnsi splits on \n and
// re-emits the active style per line), so the notice is multi-line: a headline of
// counts, then one readable subject per line. RPC clients get the raw string, so
// \n is the ONLY control character allowed anywhere in it.

const normalNote = [
	"## Decisions:",
	"- Recall effort is a real ceiling, not a prompt anchor.",
	"- The bank reminder counts silent turns instead of a fixed modulo.",
	"",
	"## Constraints:",
	"- Never commit `.pi/hindsight.json`.",
].join("\n");

console.log(`\nNOTICE normal:\n${writeNotice(normalNote)}`);
check(
	"a normal note lists every subject in full",
	writeNotice(normalNote),
	[
		"saved 1 note \u00b7 3 lines",
		"  \u00b7 Recall effort is a real ceiling, not a prompt anchor.",
		"  \u00b7 The bank reminder counts silent turns instead of a fixed modulo.",
		"  \u00b7 Never commit .pi/hindsight.json.",
	].join("\n"),
);

const oneBullet = "- Compaction is the only trigger for the inline write path.";
console.log(`\nNOTICE one:\n${writeNotice(oneBullet)}`);
check(
	"a one-bullet note is a headline and one subject",
	writeNotice(oneBullet),
	"saved 1 note \u00b7 1 line\n  \u00b7 Compaction is the only trigger for the inline write path.",
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
console.log(`\nNOTICE awkward:\n${awkwardNotice}`);
check(
	"awkward bullets still yield clean subjects",
	awkwardNotice,
	[
		"saved 1 note \u00b7 5 lines",
		"  \u00b7 red alert: the widget must render exactly one line",
		"  \u00b7 supercalifragilisticexpialidociousandthensomemoreletters follows",
		"  \u00b7 A bullet whose text wraps onto a second line",
	].join("\n"),
);
check("no ANSI escape reaches the notification", /\u001b/.test(awkwardNotice), false);
check(
	"newline is the only control character in the notification",
	/[\u0000-\u0009\u000b-\u001f\u007f]/.test(awkwardNotice),
	false,
);

// A genuinely long note is the ONLY case allowed to hide a remainder.
const longNote = Array.from(
	{ length: 9 },
	(_, i) => `- Subject number ${i + 1} of a note that will not stop growing.`,
).join("\n");
const longNotice = writeNotice(longNote);
console.log(`\nNOTICE long:\n${longNotice}`);
check("a long note keeps 5 subjects", longNotice.split("\n").length, 7);
check("a long note names the remainder", longNotice.endsWith("  \u00b7 +4 more"), true);
check(
	"a 5-subject note hides nothing",
	writeNotice(longNote.split("\n").slice(0, 5).join("\n")).includes("more"),
	false,
);

// A subject longer than one terminal line is still cut — on a word boundary.
const hugeBullet = `- ${"word ".repeat(40)}end`;
const hugeSubject = writeNotice(hugeBullet).split("\n")[1] ?? "";
console.log(`\nNOTICE huge:\n${writeNotice(hugeBullet)}`);
check("an over-long subject is cut", hugeSubject.endsWith("\u2026"), true);
check(
	"\u2026 on a word boundary, never mid-word",
	/^  \u00b7 (word )*word\u2026$/.test(hugeSubject),
	true,
);

// Empty / subject-less input must fall back to the counts it replaced, never to
// a half-built sentence.
console.log(`\nNOTICE empty:     ${JSON.stringify(writeNotice(""))}`);
check("an empty note degrades to counts", writeNotice(""), "saved 1 note \u00b7 0 lines");
check(
	"a note with no legible subject degrades to counts",
	writeNotice("- ---\n- ***"),
	"saved 1 note \u00b7 2 lines",
);

// A kill is otherwise invisible: the fact is gone from the bank and nothing in
// the UI ever said so. It belongs on the headline, above the subjects.
const withKills = writeNotice(normalNote, 2);
console.log(`\nNOTICE kills:\n${withKills}`);
check(
	"invalidations are surfaced on the headline",
	withKills.split("\n")[0],
	"saved 1 note \u00b7 3 lines \u00b7 2 facts retired",
);
check(
	"one kill is singular",
	writeNotice(oneBullet, 1).split("\n")[0]?.endsWith(" \u00b7 1 fact retired"),
	true,
);
check(
	"kills survive the degraded path",
	writeNotice("", 3),
	"saved 1 note \u00b7 0 lines \u00b7 3 facts retired",
);
check("no kills, no suffix", writeNotice(normalNote, 0).includes("retired"), false);

// It is a notice, not a report.
for (const [label, notice] of [
	["normal", writeNotice(normalNote, 2)],
	["awkward", awkwardNotice],
	["one", writeNotice(oneBullet)],
	["empty", writeNotice("", 3)],
	["long", writeNotice(`- ${"word ".repeat(200)}\n- ${"x".repeat(400)}`, 9)],
] as const) {
	const rows = notice.split("\n");
	check(`${label}: at most 6 rows`, rows.length <= 6, true);
	// 73 = `  · ` + SUBJECT_MAX + the ellipsis: fits an 80-column terminal after
	// the chat Text node's own 1-column padding on each side.
	check(`${label}: no row wider than 73`, Math.max(...rows.map((r) => r.length)) <= 73, true);
	check(
		`${label}: newline is the only control char`,
		/[\u0000-\u0009\u000b-\u001f\u007f]/.test(notice),
		false,
	);
	check(`${label}: no blank row`, rows.some((r) => !r.trim()), false);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);

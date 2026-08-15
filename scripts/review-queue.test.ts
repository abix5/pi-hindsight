/**
 * Standalone unit test for the review-queue fold logic (run with bun or node).
 *
 *   bun scripts/review-queue.test.ts
 *   node --experimental-strip-types scripts/review-queue.test.ts
 *
 * Exercises foldEvents (add/done/malformed), the on-disk enqueue/markDone/
 * loadPending round-trip, and the auto-approval window that ages a forgotten
 * entry out of the queue — all against a temp queue file
 * (HINDSIGHT_REVIEW_QUEUE), never the real one.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Point the queue at a throwaway file BEFORE importing the module (queuePath()
// reads the env var at call time, so setting it here is enough).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-queue-"));
process.env.HINDSIGHT_REVIEW_QUEUE = path.join(tmpDir, "review-queue.jsonl");

const { foldEvents, enqueueAdd, markDone, loadPending } = await import(
	"../src/review-queue.ts"
);

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failures++;
}

// --- foldEvents: pure fold ------------------------------------------------
{
	const lines = [
		JSON.stringify({ ev: "add", docId: "a", bank: "b1", project: "p1" }),
		JSON.stringify({ ev: "add", docId: "b", bank: "b1", project: "p1" }),
		JSON.stringify({ ev: "done", docId: "a", action: "approved" }),
		JSON.stringify({ ev: "add", docId: "c", bank: "b2", project: "p2" }),
	];
	const pending = foldEvents(lines);
	const ids = pending.map((p) => p.docId).sort();
	check(
		"done removes its add",
		JSON.stringify(ids) === JSON.stringify(["b", "c"]),
	);
	check(
		"pending keeps bank field",
		pending.find((p) => p.docId === "c")?.bank === "b2",
	);
}

// --- foldEvents: malformed + unknown lines are skipped --------------------
{
	const lines = [
		"not json at all",
		"",
		"   ",
		"{ broken json",
		JSON.stringify({ ev: "weird", docId: "x" }),
		JSON.stringify({ ev: "add" }), // no docId
		JSON.stringify({ ev: "add", docId: "ok" }),
	];
	const pending = foldEvents(lines);
	check(
		"malformed/unknown skipped, valid kept",
		pending.length === 1 && pending[0].docId === "ok",
	);
}

// --- foldEvents: re-add after done (upsert) -------------------------------
{
	const lines = [
		JSON.stringify({ ev: "add", docId: "a", reason: "first" }),
		JSON.stringify({ ev: "done", docId: "a", action: "deleted" }),
		JSON.stringify({ ev: "add", docId: "a", reason: "second" }),
	];
	const pending = foldEvents(lines);
	check("re-add after done is pending again", pending.length === 1);
	check("last add wins", pending[0]?.reason === "second");
}

// --- on-disk round-trip ---------------------------------------------------
{
	enqueueAdd({
		docId: "d1",
		bank: "bank",
		baseUrl: "http://localhost:8888",
		namespace: "default",
		project: "/tmp/proj",
		reason: "manual",
	});
	enqueueAdd({
		docId: "d2",
		bank: "bank",
		baseUrl: "http://localhost:8888",
		namespace: "default",
		project: "/tmp/proj",
		reason: "compact",
	});
	markDone("d1", "approved");
	const pending = loadPending();
	check(
		"disk round-trip: d1 done, d2 pending",
		pending.length === 1 && pending[0].docId === "d2",
	);
	// Each write is one appended line: 2 adds + 1 done = 3 lines.
	const lineCount = fs
		.readFileSync(process.env.HINDSIGHT_REVIEW_QUEUE as string, "utf8")
		.split("\n")
		.filter(Boolean).length;
	check("append-only: 3 event lines on disk", lineCount === 3);
}

// --- m6: the ORIGIN project's bank language is stamped at enqueue time -----
{
	// The queue is global and cross-project. Without the language on the entry,
	// the reviewing session re-extracts a hand-edited document under ITS OWN
	// memoryLanguage — silently rewriting a foreign bank in the wrong language.
	const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-proj-"));
	fs.mkdirSync(path.join(foreign, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(foreign, ".pi", "hindsight.json"),
		JSON.stringify({ bankId: "foreign", memoryLanguage: "russian" }),
	);
	enqueueAdd({
		docId: "d3",
		bank: "foreign",
		baseUrl: "http://localhost:8888",
		namespace: "default",
		project: foreign,
		reason: "compact",
	});
	const entry = loadPending().find((p) => p.docId === "d3");
	check(
		"the entry carries the origin project's memoryLanguage",
		entry?.language === "russian",
	);
	// A project that declares none leaves the field empty rather than guessing.
	enqueueAdd({
		docId: "d4",
		bank: "bank",
		baseUrl: "http://localhost:8888",
		namespace: "default",
		project: path.join(tmpDir, "no-such-project"),
		reason: "compact",
	});
	check(
		"a project with no declared language stamps nothing",
		loadPending().find((p) => p.docId === "d4")?.language === "",
	);
	// A legacy line (written before the field existed) folds to "".
	check(
		"legacy entries fold to an empty language",
		foldEvents([JSON.stringify({ ev: "add", docId: "old", project: "p" })])[0]
			.language === "",
	);
	fs.rmSync(foreign, { recursive: true, force: true });
}

// --- auto-approval: an entry that waited out the window leaves by itself ---
// Nothing ever expired, so a document nobody reviewed sat in the queue forever.
// Aging one out is safe precisely BECAUSE the queue is bank-first: the document
// was written to the bank when it was enqueued, and `approve` only drops it from
// the pending set (`delete` is the action that issues a DELETE). So expiry stops
// the queue growing without bound and changes nothing in memory.

const QUEUE = process.env.HINDSIGHT_REVIEW_QUEUE as string;
const DAY_MS = 86_400_000;

/** Overwrite the THROWAWAY queue file — fixture setup, not queue behaviour. */
function seed(lines: string[]): void {
	fs.writeFileSync(QUEUE, lines.map((l) => `${l}\n`).join(""));
}

/** An "add" line for a document enqueued `ageDays` ago. */
function addLine(
	docId: string,
	ageDays: number,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		ev: "add",
		docId,
		bank: "bank",
		baseUrl: "http://localhost:8888",
		namespace: "default",
		project: "/tmp/proj",
		reason: "compact",
		ts: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
		...extra,
	});
}

function safeParse(line: string): Record<string, unknown> {
	try {
		return JSON.parse(line) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Every event currently on disk, malformed lines dropped. */
function events(): Record<string, unknown>[] {
	return fs
		.readFileSync(QUEUE, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(safeParse);
}

const ids = (): string => JSON.stringify(loadPending().map((p) => p.docId).sort());

// Scenario: Just inside the window survives ---------------------------------
// Scenario: Just outside the window leaves ----------------------------------
{
	// One fold, both sides of the boundary: what discriminates the two entries is
	// only their age, so a fold that keeps or drops both proves nothing.
	seed([addLine("fresh", 0.5), addLine("inside", 6.9), addLine("outside", 7.1)]);
	const pending = loadPending().map((p) => p.docId).sort();
	check(
		"Just inside the window survives: the 6.9-day-old entry is still pending",
		pending.includes("inside") && !pending.includes("outside"),
	);
	check(
		"Just outside the window leaves: the 7.1-day-old entry is gone, with no human action",
		JSON.stringify(pending) === JSON.stringify(["fresh", "inside"]),
	);
}

// Scenario: Zero disables expiry --------------------------------------------
{
	// Someone who wants to review everything by hand must be able to keep that,
	// so the SAME log is folded twice: once with the window off, once with the
	// default window that would otherwise age the entry out.
	seed([addLine("ancient", 400), addLine("fresh", 0.1)]);
	process.env.HINDSIGHT_REVIEW_AUTO_APPROVE_DAYS = "0";
	const withZero = ids();
	delete process.env.HINDSIGHT_REVIEW_AUTO_APPROVE_DAYS;
	seed([addLine("ancient", 400), addLine("fresh", 0.1)]);
	const withDefault = ids();
	check(
		"Zero disables expiry: 0 keeps a 400-day-old entry the default window drops",
		withZero === JSON.stringify(["ancient", "fresh"]) &&
			withDefault === JSON.stringify(["fresh"]),
	);
}

// Scenario: The bank is untouched -------------------------------------------
{
	// Expiry is a queue-state change only. A bank call here would mean the queue
	// stopped being bank-first and started deciding what memory contains.
	const realFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = ((...args: unknown[]) => {
		fetchCalls += 1;
		void args;
		return Promise.reject(new Error("expiry must not talk to the bank"));
	}) as unknown as typeof fetch;
	seed([addLine("aged-1", 30), addLine("aged-2", 9), addLine("fresh", 1)]);
	const left = ids();
	globalThis.fetch = realFetch;
	check(
		"The bank is untouched: two entries expire and no bank request is issued",
		left === JSON.stringify(["fresh"]) && fetchCalls === 0,
	);
}

// Scenario: Unparseable timestamp -------------------------------------------
{
	// An entry whose age cannot be established is not evidence that it is old.
	seed([
		addLine("aged", 30),
		JSON.stringify({ ev: "add", docId: "no-ts", project: "/tmp/proj" }),
		addLine("bad-ts", 30, { ts: "whenever" }),
	]);
	check(
		"Unparseable timestamp: a missing or invalid ts stays pending while a datable aged entry leaves",
		ids() === JSON.stringify(["bad-ts", "no-ts"]),
	);
}

// Scenario: Log grows, never mutates ----------------------------------------
{
	seed([addLine("aged", 30), addLine("fresh", 1)]);
	const before = fs.readFileSync(QUEUE, "utf8");
	loadPending();
	const after = fs.readFileSync(QUEUE, "utf8");
	check(
		"Log grows, never mutates: every prior line is byte-identical afterwards",
		after.startsWith(before) && after.length > before.length,
	);
	const added = after.slice(before.length).split("\n").filter(Boolean);
	const rec = added.length === 1 ? safeParse(added[0]) : {};
	check(
		"Log grows, never mutates: exactly one new done line, for the expired document",
		added.length === 1 && rec.ev === "done" && rec.docId === "aged",
	);
}

// Scenario: Aged-out is distinguishable from human-approved ------------------
// Scenario: Existing consumers keep working ---------------------------------
{
	seed([addLine("human", 1), addLine("aged", 30)]);
	markDone("human", "approved");
	loadPending();
	const done = events().filter((e) => e.ev === "done");
	const human = done.find((e) => e.docId === "human") ?? {};
	const expired = done.find((e) => e.docId === "aged") ?? {};
	check(
		"Aged-out is distinguishable from human-approved: expiry appended its own done event",
		Object.keys(expired).length > 0,
	);
	// The discriminator is deliberately NOT pinned to a name here: the shape is
	// the implementer's choice, the requirement is that reading the log back tells
	// the two apart by an explicit field rather than by guesswork.
	const carried = ["ev", "docId", "action", "ts"];
	const extra = Object.keys(expired).filter((k) => !carried.includes(k));
	console.log(`      expiry done event: ${JSON.stringify(expired)}`);
	check(
		"Aged-out is distinguishable from human-approved: an explicit field on the expiry event differs from the human one",
		extra.length > 0 && extra.some((k) => human[k] !== expired[k]),
	);
	check(
		'Existing consumers keep working: action stays inside "approved" | "deleted"',
		expired.action === "approved" || expired.action === "deleted",
	);
	check(
		"Existing consumers keep working: foldEvents drops the expired doc exactly as a human done does",
		foldEvents(fs.readFileSync(QUEUE, "utf8").split("\n")).length === 0,
	);
}

// Scenario: Compaction is not duplicated ------------------------------------
{
	// >1MB of unparseable padding plus an mtime older than a minute is exactly the
	// state maybeCompact() waits for. Expiry must ride on that ONE rewrite path.
	const pad = Array.from(
		{ length: 1000 },
		(_, i) => `padding ${i} ${"x".repeat(1100)}`,
	);
	seed([...pad, addLine("aged", 30), addLine("fresh", 1)]);
	const old = new Date(Date.now() - 600_000);
	fs.utimesSync(QUEUE, old, old);
	const first = ids();
	const second = ids();
	check(
		"Compaction is not duplicated: expiry and the existing compaction agree on the pending set",
		first === JSON.stringify(["fresh"]) && second === JSON.stringify(["fresh"]),
	);
	const src = fs.readFileSync(
		new URL("../src/review-queue.ts", import.meta.url),
		"utf8",
	);
	check(
		"Compaction is not duplicated: the size/age guard is reused unchanged, with one rewrite path",
		src.includes(
			"if (st.size <= 1_000_000 || pending.length > 200 || ageMs < 60_000) return;",
		) && (src.match(/renameSync/g) ?? []).length === 1,
	);
}

// --- README: the documented contract --------------------------------------
{
	const readme = fs.readFileSync(
		new URL("../README.md", import.meta.url),
		"utf8",
	);
	const row = readme
		.split("\n")
		.find(
			(l) =>
				l.includes("reviewAutoApproveDays") &&
				l.includes("HINDSIGHT_REVIEW_AUTO_APPROVE_DAYS"),
		);
	check(
		"Configuration table: the key, its env var and the 7-day default are listed",
		!!row && /\b7\b/.test(row),
	);
	const start = readme.indexOf("### Review (");
	const rest = readme.slice(start + 1);
	const end = rest.indexOf("\n### ");
	const section = start < 0 ? "" : end < 0 ? rest : rest.slice(0, end);
	check(
		"Configuration table: it says 0 disables expiry",
		/\b0\b/.test(`${row ?? ""}\n${section}`) &&
			/(disable|never|forever|by hand|manual|off)/i.test(
				`${row ?? ""}\n${section}`,
			),
	);
	check(
		"Behaviour prose: the review section says an aged entry is approved automatically after a week",
		/(auto-approv|approved automatically|automatically approv)/i.test(section) &&
			/(week|7 day|7-day|seven day)/i.test(section),
	);
	check(
		"Behaviour prose: it explains why that is safe — the document is already in the bank",
		/(auto-approv|approved automatically|automatically approv)/i.test(section) &&
			/bank/i.test(section) &&
			/(already|untouched|bank-first|does not touch|nothing is written)/i.test(
				section,
			),
	);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

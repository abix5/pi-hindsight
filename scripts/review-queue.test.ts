/**
 * Standalone unit test for the review-queue fold logic (run with bun or node).
 *
 *   bun scripts/review-queue.test.ts
 *   node --experimental-strip-types scripts/review-queue.test.ts
 *
 * Exercises foldEvents (add/done/malformed) and the on-disk enqueue/markDone/
 * loadPending round-trip against a temp queue file (HINDSIGHT_REVIEW_QUEUE).
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

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

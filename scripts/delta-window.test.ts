/**
 * Self-test for the memorize window (run with bun or node).
 *   bun scripts/delta-window.test.ts
 *
 * An empty window has TWO causes that look identical from the return value and
 * call for opposite advice:
 *
 *   - nothing was said since the last flush — "/mem-save all" is fair advice;
 *   - a shutdown or manual flush ran to the END of the session, pushing the
 *     watermark past where a later compaction's boundary sits (compaction
 *     always keeps a live tail). Plenty was said; this window just has no room
 *     for it, and re-collecting everything would delete good documents.
 *
 * Observed live in 0.4.0: a `shutdown:quit` flush saved through the session end,
 * then two consecutive compactions reported deltaEntries 0 while the
 * conversation kept growing. Nothing was lost, but the message said the memory
 * was up to date. This pins the discriminator behind the two messages.
 */

import { getDeltaEntries } from "../src/transcript.ts";

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

type Entry = { id: string; role: string; content: string };
const entry = (id: string): Entry => ({ id, role: "user", content: id });
const ids = (list: Entry[]): string[] => list.map((e) => e.id);

// biome-ignore lint/suspicious/noExplicitAny: test doubles for SessionEntry
const win = (e: Entry[], w?: string, b?: string) =>
	getDeltaEntries(e as any[], w, b);

// a b c d e  — compaction keeps the tail from "d" on, so "d" is the boundary.
const session = ["a", "b", "c", "d", "e"].map(entry);

check("plain window stops before the boundary", ids(win(session, "a", "d")), [
	"b",
	"c",
]);

check("no watermark starts at the beginning", ids(win(session, undefined, "c")), [
	"a",
	"b",
]);

// The live case: a flush to the session end put the watermark on "e", then a
// later compaction's boundary landed back at "c".
check("watermark past boundary yields nothing", ids(win(session, "e", "c")), []);

// ...and that is exactly when the unbounded window still has work in it. This
// pair is the discriminator: bounded empty + unbounded non-empty = "already
// saved through the live tail", NOT "nothing new".
const grown = [...session, entry("f"), entry("g")];
check("bounded window is empty", ids(win(grown, "e", "c")), []);
check("unbounded window shows the pending tail", ids(win(grown, "e", undefined)), [
	"f",
	"g",
]);

// A genuinely idle session: both windows empty, so the "nothing new" advice is
// the correct one and /mem-save all is safe to suggest.
check("idle session is empty either way", ids(win(session, "e", undefined)), []);

// A missing watermark (compaction dropped the entry it named) must not silently
// re-collect from zero on a bounded window — it starts at the beginning, which
// the caller bounds with the boundary.
check("unknown watermark falls back to the start", ids(win(session, "zz", "c")), [
	"a",
	"b",
]);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

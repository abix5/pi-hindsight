/**
 * Self-test for the always-on status widget (run with bun or node).
 *   bun scripts/widget.test.ts
 *
 * The widget lives above the editor, so a height that varies between frames
 * makes the whole TUI jump. This pins the invariant that replaced the old
 * "always render an empty second line" hack: EXACTLY one line in every state,
 * short enough that a narrow terminal will not wrap it into two.
 */

import { HindsightStatus } from "../src/ui.ts";

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

// A theme that really emits ANSI: truncation must never cut an escape sequence.
const theme = {
	fg: (_c: string, s: string) => `\x1b[35m${s}\x1b[39m`,
	bold: (s: string) => s,
};

let widget: string[] | undefined;
const ui = {
	setWidget: (_id: string, content: string[] | undefined) => {
		widget = content;
	},
	setStatus: () => {},
	theme,
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** Visible columns; the brain glyph is the only double-width character. */
const cols = (s: string) => [...strip(s)].length + (s.includes("🧠") ? 1 : 0);

const LONG =
	"a very long recall query about database migrations that nobody would ever type";

/** Drive the widget into `state`, then assert the geometry of what it emitted. */
function frame(label: string, drive: (s: HindsightStatus) => void): void {
	const s = new HindsightStatus();
	s.attach(ui);
	s.setBank("pi-hindsight-with-a-long-bank-id", "http://localhost:7078");
	drive(s);
	const lines = widget ?? [];
	const line = lines[0] ?? "";
	check(`${label}: one line`, lines.length, 1);
	check(`${label}: no embedded newline`, line.includes("\n"), false);
	check(`${label}: fits 72 columns (${cols(line)})`, cols(line) <= 72, true);
	// A cut escape sequence would leave an ESC not followed by a complete SGR.
	check(`${label}: no truncated ANSI`, /\x1b(?!\[[0-9;]*m)/.test(line), false);
	console.log(`      ${strip(line)}`);
}

frame("idle", (s) => {
	s.bankOk();
	s.setBankCounts(16, 153);
});
frame("working (recall)", (s) => {
	s.bankOk();
	s.setBankCounts(16, 153);
	s.recallStart();
});
frame("working (store)", (s) => {
	s.bankOk();
	s.setBankCounts(16, 153);
	s.memoCollecting(3, "compaction");
});
frame("recall outcome", (s) => {
	s.bankOk();
	s.setBankCounts(1234, 5678);
	s.recallOutcome({
		op: "recall",
		query: LONG,
		found: 12,
		injected: 3,
		queried: true,
		reason: "",
	});
});
frame("store done", (s) => {
	s.bankOk();
	s.setBankCounts(16, 153);
	s.memoDone(2, 9);
});
// A kill is rare and newsworthy: it gets three columns in the FIXED head
// (`153f↓3`), so it survives while the last action is truncated away.
frame("store done with kills", (s) => {
	s.bankOk();
	s.setBankCounts(16, 153);
	s.memoRetired(3);
	s.memoDone(2, 9);
});
frame("kills, worst-case head", (s) => {
	s.bankOk();
	s.setBankCounts(999999, 999999);
	s.memoRetired(999);
	s.recallOutcome({
		op: "recall",
		query: LONG,
		found: 12,
		injected: 3,
		queried: true,
		reason: "",
	});
});
frame("kills while the bank is unreachable", (s) => {
	s.memoRetired(2);
	s.bankError("fetch failed: connect ECONNREFUSED 127.0.0.1:7078 (retrying)");
});
frame("bank error", (s) => {
	s.bankError("fetch failed: connect ECONNREFUSED 127.0.0.1:7078 (retrying)");
});
frame("bank error (multiline)", (s) => {
	s.bankError("bank ensure failed\n  Caused by: socket hang up\n  at fetch()");
});
frame("checking", (s) => s.bankChecking());
frame("dormant (never checked)", () => {});
frame("auto off", (s) => {
	s.bankOk();
	s.setBankCounts(16, 153);
	s.recallOff();
	s.memoOff();
	s.memoError("model unavailable for the retain chain, everything is on fire");
});

// The height must not change ACROSS frames either — that was the original bug.
const s = new HindsightStatus();
s.attach(ui);
s.setBank("bank", "http://localhost:7078");
const heights = new Set<number>();
for (const step of [
	() => s.bankChecking(),
	() => s.bankOk(),
	() => s.setBankCounts(16, 153),
	() => s.recallStart(),
	() =>
		s.recallOutcome({
			op: "reflect",
			query: LONG,
			found: 0,
			injected: 0,
			queried: true,
			reason: "",
		}),
	() => s.memoCollecting(2, "manual"),
	() => s.memoWriting(),
	() => s.memoRetired(0),
	() => s.memoRetired(4),
	() => s.memoDone(1, 4),
	() => s.memoBlocked(),
	() => s.memoError("boom"),
	() => s.bankError("gone"),
	() => s.recallOff(),
	() => s.memoOff(),
]) {
	step();
	heights.add((widget ?? []).length);
}
check("height never changes across a session", [...heights], [1]);

// The badge is cumulative for the SESSION, not for the last write: a kill that
// only showed until the next write would be gone before anyone read it.
const k = new HindsightStatus();
k.attach(ui);
k.setBank("bank", "http://localhost:7078");
k.bankOk();
k.setBankCounts(16, 153);
check("no kills, no badge", strip((widget ?? [])[0] ?? "").includes("\u2193"), false);
k.memoRetired(2);
k.memoDone(1, 4);
k.memoRetired(1);
k.memoDone(1, 2);
check(
	"kills accumulate across writes",
	strip((widget ?? [])[0] ?? "").includes("153f\u21933"),
	true,
);
k.memoRetired(0);
check(
	"a zero-kill write does not touch the badge",
	strip((widget ?? [])[0] ?? "").includes("153f\u21933"),
	true,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

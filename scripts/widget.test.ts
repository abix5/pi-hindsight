/**
 * Self-test for the always-on status widget (run with bun or node).
 *   bun scripts/widget.test.ts
 *
 * The widget lives above the editor, so a height that varies between frames
 * makes the whole TUI jump. This pins the invariant that replaced the old
 * "always render an empty second line" hack: EXACTLY one line in every state,
 * short enough that a narrow terminal will not wrap it into two.
 */

import * as fs from "node:fs";
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

// --- Requirement: widget tone reflects whether auto mode is fully on -------
// The widget answers "is automatic memory fully on?" at a glance, so the
// healthy state must be the LOUD one: bank name and arrows bright when both
// flags are on, dim the moment either is off. Which colours those are is the
// implementer's choice among the theme colours the file already uses, so the
// checks below read the tone the widget asked for rather than pinning a name.

/** A theme that records WHICH colour each fragment was painted with. */
const tagTheme = {
	fg: (c: string, s: string) => `\u27e6${c}|${s}\u27e7`,
	bold: (s: string) => s,
};
let toneWidget: string[] | undefined;
const toneUi = {
	setWidget: (_id: string, content: string[] | undefined) => {
		toneWidget = content;
	},
	setStatus: () => {},
	theme: tagTheme,
};
const TONE_BANK = "auto-tone-bank";
/** Visible text of a tagged line (tags and ANSI removed). */
const plain = (s: string) =>
	strip(s)
		.replace(/\u27e6[a-zA-Z]+\|/g, "")
		.replace(/\u27e7/g, "");
/** Colour of the tagged fragment carrying `needle` ("(untagged)" when none). */
function toneOf(line: string, needle: string): string {
	for (const m of line.matchAll(/\u27e6([a-zA-Z]+)\|([^\u27e6\u27e7]*)\u27e7/g))
		if (m[2].includes(needle)) return m[1];
	return "(untagged)";
}
const DIM = new Set(["dim", "muted"]);

/** Render an idle widget (no tail) under one auto-flag combination. */
function autoFrame(drive: (s: HindsightStatus) => void): string {
	const s = new HindsightStatus();
	s.attach(toneUi);
	s.setBank(TONE_BANK, "http://localhost:7078");
	s.bankOk();
	s.setBankCounts(16, 153);
	drive(s);
	return (toneWidget ?? [])[0] ?? "";
}

const onLine = autoFrame(() => {});
const recallOffLine = autoFrame((s) => s.recallOff());
const memoOffLine = autoFrame((s) => s.memoOff());
const bothOffLine = autoFrame((s) => {
	s.recallOff();
	s.memoOff();
});
for (const [what, line] of [
	["both on", onLine],
	["recall off", recallOffLine],
	["memorize off", memoOffLine],
	["both off", bothOffLine],
] as const)
	console.log(`      ${what.padEnd(13)} ${plain(line)}`);

// Scenario: Both auto flags on ---------------------------------------------
{
	const name = toneOf(onLine, TONE_BANK);
	const cue = toneOf(onLine, "\u2199\u2197");
	check(
		"Both auto flags on: the two-arrow cue is shown",
		plain(onLine).includes("\u2199\u2197"),
		true,
	);
	check(
		`Both auto flags on: bank name and cue are bright and share one tone (name=${name}, cue=${cue})`,
		!DIM.has(name) && name === cue,
		true,
	);
}

// Scenario: Auto recall off / Auto memorize off / Both auto flags off -------
// The single-arrow form exists to say WHICH side is off, so the cue still has
// to name it while the tone drops.
for (const [label, line, shown, hidden] of [
	["Auto recall off", recallOffLine, "\u2197", "\u2199"],
	["Auto memorize off", memoOffLine, "\u2199", "\u2197"],
	["Both auto flags off", bothOffLine, "auto off", "\u2197"],
] as const) {
	const name = toneOf(line, TONE_BANK);
	const cue = toneOf(line, shown);
	check(
		`${label}: the cue still names which side is off (${shown})`,
		plain(line).includes(shown) && !plain(line).includes(hidden),
		true,
	);
	check(
		`${label}: bank name and cue are both dim (name=${name}, cue=${cue})`,
		DIM.has(name) && name === cue,
		true,
	);
	check(
		`${label}: the degraded tone differs from the fully-on tone`,
		name !== toneOf(onLine, TONE_BANK),
		true,
	);
}

// --- Requirement: widget invariants survive the tone change ---------------
// Scenario: One line, bounded width, all four combinations ------------------
// frame() drives a LONG bank id and a long tail through the same assertions
// used everywhere above: one line, ≤ 72 columns, no cut escape sequence.
const outcome = (s: HindsightStatus) =>
	s.recallOutcome({
		op: "recall",
		query: LONG,
		found: 12,
		injected: 3,
		queried: true,
		reason: "",
	});
frame("all four combinations: both auto flags on", (s) => {
	s.bankOk();
	s.setBankCounts(999999, 999999);
	outcome(s);
});
frame("all four combinations: auto recall off", (s) => {
	s.bankOk();
	s.setBankCounts(999999, 999999);
	s.recallOff();
	outcome(s);
});
frame("all four combinations: auto memorize off", (s) => {
	s.bankOk();
	s.setBankCounts(999999, 999999);
	s.memoOff();
	outcome(s);
});
frame("all four combinations: both auto flags off", (s) => {
	s.bankOk();
	s.setBankCounts(999999, 999999);
	s.recallOff();
	s.memoOff();
	outcome(s);
});

// Scenario: Plain twin stays in step ----------------------------------------
// headPlain is what the budget arithmetic measures. When the tail is long
// enough to be cut, the whole line lands on EXACTLY the 72-column budget — a
// head whose plain twin over- or under-states its own width shows up here as an
// off-by-N, in whichever auto-flag combination the head changed shape in.
for (const [label, drive] of [
	["both auto flags on", () => {}],
	["auto recall off", (s: HindsightStatus) => s.recallOff()],
	["auto memorize off", (s: HindsightStatus) => s.memoOff()],
	[
		"both auto flags off",
		(s: HindsightStatus) => {
			s.recallOff();
			s.memoOff();
		},
	],
] as const) {
	const s = new HindsightStatus();
	s.attach(ui);
	s.setBank("pi-hindsight-with-a-long-bank-id", "http://localhost:7078");
	s.bankOk();
	s.setBankCounts(999999, 999999);
	drive(s);
	outcome(s);
	const line = (widget ?? [])[0] ?? "";
	check(
		`Plain twin stays in step (${label}): a truncated tail lands on exactly 72 columns`,
		cols(line),
		72,
	);
}

// Scenario: Behaviour prose -------------------------------------------------
{
	const readme = fs.readFileSync(
		new URL("../README.md", import.meta.url),
		"utf8",
	);
	const start = readme.indexOf("## Widget legend");
	const rest = readme.slice(start + 1);
	const end = rest.indexOf("\n## ");
	const legend = start < 0 ? "" : end < 0 ? rest : rest.slice(0, end);
	check(
		"Behaviour prose: the widget legend explains the bright/dim meaning of the bank name and the arrows",
		/bright/i.test(legend) &&
			/dim/i.test(legend) &&
			/(\u2199|arrow)/i.test(legend),
		true,
	);
}

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

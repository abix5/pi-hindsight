/**
 * Self-test for the bank reminder (run with bun or node).
 *   bun scripts/bank-reminder.test.ts
 *
 * The invariant that matters: NO TURN EVER PRODUCES TWO 🧠 BLOCKS. The nudge
 * rides in the recall block's tail, and a standalone block exists only for the
 * case a tail cannot cover — recall stayed silent. Everything else here is that
 * one rule seen from a different angle: full text at session start and after a
 * compaction, one short line on a task boundary, nothing on an ordinary turn,
 * and short-vs-full for the standalone chosen by the in-context flag.
 */

import { recallTrace } from "../src/index.ts";
import { seenInjectedFacts } from "../src/recall-utils.ts";
import {
	type Boundary,
	forgetFullText,
	newReminderState,
	type ReminderGate,
	type ReminderState,
	reminderDue,
	reminderLine,
	reminderStandalone,
	reminderTail,
	reminderText,
} from "../src/reminder.ts";

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

const live: ReminderGate = {
	enabled: true,
	everyTurns: 5,
	active: true,
	autoRecall: true,
	recalled: false,
};

/**
 * One turn, driving the two decisions in the SAME order the two
 * before_agent_start handlers do: the recall handler decides its tail while it
 * still can, then the reminder handler decides whether a standalone is owed.
 * Returns the 🧠 blocks that turn would render.
 */
function turn(
	state: ReminderState,
	sessionId: string | undefined,
	gate: ReminderGate,
	opts: { recalled: boolean; boundary?: Boundary },
): string[] {
	const blocks: string[] = [];
	if (opts.recalled) {
		const tail = reminderTail(
			state,
			sessionId,
			{ ...gate, recalled: true },
			opts.boundary ?? "none",
		);
		blocks.push(tail === "none" ? "recall" : `recall+${tail}`);
	}
	if (reminderDue(state, sessionId, { ...gate, recalled: opts.recalled }))
		blocks.push(`standalone:${reminderStandalone(state)}`);
	return blocks;
}

// ---------------------------------------------------------------- the invariant

{
	// One long session that walks through every shape the design names: session
	// start, ordinary turns, a task boundary, a long silence, auto-recall off and
	// back on, a compaction, and a session change.
	const state = newReminderState();
	const script: Array<{
		sid: string;
		gate?: Partial<ReminderGate>;
		recalled: boolean;
		boundary?: Boundary;
		compactBefore?: boolean;
	}> = [
		{ sid: "s1", recalled: true, boundary: "session" }, // session start
		{ sid: "s1", recalled: true }, // ordinary
		{ sid: "s1", recalled: false }, // silent
		{ sid: "s1", recalled: true, boundary: "task" }, // task boundary
		{ sid: "s1", recalled: false },
		{ sid: "s1", recalled: false },
		{ sid: "s1", recalled: false },
		{ sid: "s1", recalled: false },
		{ sid: "s1", recalled: false }, // 5 silent turns → standalone
		{ sid: "s1", recalled: false },
		{ sid: "s1", gate: { autoRecall: false }, recalled: false },
		{ sid: "s1", gate: { autoRecall: false }, recalled: false },
		{ sid: "s1", recalled: false }, // switched back on
		{ sid: "s1", recalled: true, boundary: "session", compactBefore: true },
		{ sid: "s1", recalled: false },
		{ sid: "s2", recalled: true, boundary: "session" }, // new session
		{ sid: "s2", recalled: false },
	];
	const rendered: string[][] = [];
	for (const step of script) {
		if (step.compactBefore) forgetFullText(state);
		rendered.push(turn(state, step.sid, { ...live, ...step.gate }, step));
	}
	check(
		"NO TURN EVER PRODUCES TWO BLOCKS",
		rendered.filter((b) => b.length > 1),
		[],
	);
	check("session start carries the full text in the tail", rendered[0], [
		"recall+full",
	]);
	check("an ordinary turn carries no tail", rendered[1], ["recall"]);
	check("a task boundary carries one short line", rendered[3], ["recall+short"]);
	check("a silent turn alone shows nothing", rendered[2], []);
	check("five silent turns owe a standalone", rendered[8], [
		"standalone:short",
	]);
	check(
		"the first turn after a compaction repeats the full text",
		rendered[13],
		["recall+full"],
	);
	check("a new session opens with the full text again", rendered[15], [
		"recall+full",
	]);
}

// A recall block on EVERY turn means a nudge never needs a block of its own.
{
	const state = newReminderState();
	const blocks: string[][] = [];
	for (let i = 0; i < 50; i += 1)
		blocks.push(turn(state, "s1", live, { recalled: true }));
	check(
		"a session where recall always speaks never gets a standalone",
		blocks.flat().filter((b) => b.startsWith("standalone")),
		[],
	);
	check("and never two blocks", blocks.filter((b) => b.length > 1), []);
}

// ------------------------------------------------------- short-vs-full standalone

{
	// Nothing was ever shown: the standalone must carry the full text.
	const state = newReminderState();
	const blocks: string[] = [];
	for (let i = 0; i < 10; i += 1)
		blocks.push(...turn(state, "s1", live, { recalled: false }));
	check("the first standalone of a silent session is full", blocks, [
		"standalone:full",
		"standalone:short",
	]);
}

{
	// A compaction wiped the full text: the next standalone repeats it in full.
	const state = newReminderState();
	turn(state, "s1", live, { recalled: true, boundary: "session" });
	forgetFullText(state);
	const blocks: string[] = [];
	for (let i = 0; i < 5; i += 1)
		blocks.push(...turn(state, "s1", live, { recalled: false }));
	check("a compaction makes the next standalone full again", blocks, [
		"standalone:full",
	]);
}

{
	// A tail that carried the full text counts: the next standalone is short.
	const state = newReminderState();
	turn(state, "s1", live, { recalled: true, boundary: "session" });
	const blocks: string[] = [];
	for (let i = 0; i < 5; i += 1)
		blocks.push(...turn(state, "s1", live, { recalled: false }));
	check("a full tail lets the next standalone be short", blocks, [
		"standalone:short",
	]);
}

{
	// A short tail is not the full text: a standalone after it must still be full.
	const state = newReminderState();
	turn(state, "s1", live, { recalled: true, boundary: "task" });
	const blocks: string[] = [];
	for (let i = 0; i < 5; i += 1)
		blocks.push(...turn(state, "s1", live, { recalled: false }));
	check("a short tail does not count as the full text", blocks, [
		"standalone:full",
	]);
}

// -------------------------------------------------------------- gates and cadence

/** Standalone fire pattern over `turns` consecutive silent turns. */
function pattern(
	turns: number,
	gate = live,
	sessionId: string | undefined = "s1",
	recallOn: (turn: number) => boolean = () => false,
): number[] {
	const state = newReminderState();
	const fired: number[] = [];
	for (let i = 0; i < turns; i += 1)
		if (
			turn(state, sessionId, gate, { recalled: recallOn(i) }).some((b) =>
				b.startsWith("standalone"),
			)
		)
			fired.push(i);
	return fired;
}

check("fires at session start, then every N silent turns", pattern(15), [
	0, 5, 10,
]);

check("does not fire in between", pattern(5).length, 1);

check("a shorter interval is honored", pattern(10, { ...live, everyTurns: 3 }), [
	0, 3, 6, 9,
]);

check(
	"a recall block on turn 0 delays the nudge by a full interval",
	pattern(15, live, "s1", (i) => i === 0),
	[5, 10],
);

check(
	"a recall block mid-cadence re-arms the counter",
	pattern(15, live, "s1", (i) => i === 2),
	[0, 7, 12],
);

check(
	"silent when auto-recall is off",
	pattern(30, { ...live, autoRecall: false }),
	[],
);

check(
	"silent when the plugin is dormant",
	pattern(30, { ...live, active: false }),
	[],
);

check("silent when disabled by config", pattern(30, { ...live, enabled: false }), []);

check(
	"a non-positive interval disables the standalone rather than firing every turn",
	pattern(30, { ...live, everyTurns: 0 }),
	[],
);

// The kill switch and the dormant/off gates silence the TAIL too — a block that
// carries no nudge is what "reminder off" has to mean once the two are merged.
for (const [label, gate] of [
	["the kill switch", { ...live, enabled: false }],
	["a dormant plugin", { ...live, active: false }],
	["auto-recall off", { ...live, autoRecall: false }],
] as Array<[string, ReminderGate]>)
	check(
		`${label} silences the tail as well`,
		reminderTail(newReminderState(), "s1", gate, "session"),
		"none",
	);

// Turns must only accumulate while the reminder is live: a session that ran with
// auto-recall off gets its nudge on the first turn after it is switched back on.
{
	const state = newReminderState();
	for (let i = 0; i < 15; i += 1)
		reminderDue(state, "s1", { ...live, autoRecall: false });
	check("re-enabling starts the cadence fresh", reminderDue(state, "s1", live), true);
}

// A new session id (or /reload) is a fresh session: session start fires again.
{
	const state = newReminderState();
	for (let i = 0; i < 5; i += 1) reminderDue(state, "s1", live);
	check("a new session fires at its start", reminderDue(state, "s2", live), true);
	check("and then goes quiet again", reminderDue(state, "s2", live), false);
}

// The counter belongs to the session, not to the run of turns.
{
	const state = newReminderState();
	for (let i = 0; i < 4; i += 1) reminderDue(state, "s1", live);
	check(
		"a new session that opens with recall stays quiet",
		reminderDue(state, "s2", { ...live, recalled: true }),
		false,
	);
	const after: number[] = [];
	for (let i = 0; i < 6; i += 1)
		if (reminderDue(state, "s2", live)) after.push(i);
	check("and counts its silent turns from that block", after, [4]);
}

// A session change must not inherit "the full text is still upstream" from the
// session before it: the transcript the flag described is gone.
{
	const state = newReminderState();
	turn(state, "s1", live, { recalled: true, boundary: "session" });
	check(
		"a new session forgets the previous transcript's full text",
		reminderTail(state, "s2", { ...live, recalled: true }, "task"),
		"short",
	);
	check("and its flag is cleared", state.fullInContext, false);
}

// ------------------------------------------------------------------------- text

const text = reminderText("my-bank", { documents: 12, facts: 300 });
check("names the bank and its size", text.includes('"my-bank" holds 12 document(s) / 300 fact(s)'), true);
check("labels itself as plugin output", text.includes("not a user instruction"), true);
check("points at the tools", ["hindsight_recall", "hindsight_reflect", "hindsight_retain"].every((t) => text.includes(t)), true);
check("warns that reflect is slow", /reflect[^\n]*SLOW/.test(text), true);
check("stays short", text.split("\n").length <= 4, true);
check(
	"degrades without counts",
	reminderText("my-bank").includes('"my-bank" holds prior sessions'),
	true,
);
check(
	"carries no block emoji of its own — it may ride inside the recall block",
	text.includes("\uD83E\uDDE0"),
	false,
);

const line = reminderLine("my-bank");
check("the short form really is one line", line.split("\n").length, 1);
check("and still labels itself as plugin output", line.includes("not recalled facts"), true);
check("and still names the bank and the tools", [
	'"my-bank"',
	"hindsight_recall",
	"hindsight_retain",
].every((t) => line.includes(t)), true);
check(
	"the language clause reaches both forms",
	[reminderText("b", undefined, "English"), reminderLine("b", "English")].every(
		(t) => t.includes("English"),
	),
	true,
);

// The fence is what keeps recalled facts distinguishable from plugin text once
// they share a block: everything between the untrusted-memory header and the
// closing marker is bank text. The dedupe pass reads the same fence, so the
// nudge's own bullets must never enter the seen-set as if they were facts.
{
	const content = recallTrace(
		{
			found: 1,
			injected: 1,
			skippedSeen: 0,
			skippedFiltered: 0,
			text: "- The bank lives at http://localhost:8888.",
			query: "where does the bank live",
			operation: "recall",
			queried: true,
			reason: "bank recalled facts",
			rawHits: [],
			injectedKeys: [],
		},
		reminderText("my-bank", { documents: 12, facts: 300 }),
	);
	const ctx = {
		sessionManager: {
			getEntries: () => [
				{ type: "custom_message", customType: "mem-recall", content },
			],
		},
	} as unknown as Parameters<typeof seenInjectedFacts>[0];
	const seen = [...seenInjectedFacts(ctx)];
	check(
		"the recalled fact is remembered as injected",
		seen.some((s) => s.includes("localhost")),
		true,
	);
	check(
		"the plugin tail below the fence is not",
		seen.filter((s) => s.includes("hindsight_recall") || s.includes("project bank")),
		[],
	);
}

// m1 — the fence must be matched as a WHOLE LINE. This repo's own bank holds
// facts about the fence, and a bare substring search ended the region at the
// first fact that merely mentioned it, dropping every fact below.
{
	const content = recallTrace(
		{
			found: 3,
			injected: 3,
			skippedSeen: 0,
			skippedFiltered: 0,
			text: [
				"- The block is closed by a --- end of recalled memory --- line.",
				"- The widget is one fixed line.",
				"- The bank lives at http://localhost:8888.",
			].join("\n"),
			query: "how is the recall block delimited",
			operation: "recall",
			queried: true,
			reason: "bank recalled facts",
			rawHits: [],
			injectedKeys: [],
		},
		reminderText("my-bank"),
	);
	const ctx = {
		sessionManager: {
			getEntries: () => [
				{ type: "custom_message", customType: "mem-recall", content },
			],
		},
	} as unknown as Parameters<typeof seenInjectedFacts>[0];
	const seen = [...seenInjectedFacts(ctx)];
	check(
		"a fact that quotes the fence does not truncate the region",
		[
			seen.some((s) => s.includes("end of recalled memory")),
			seen.some((s) => s.includes("one fixed line")),
			seen.some((s) => s.includes("localhost")),
		],
		[true, true, true],
	);
	check(
		"and the plugin tail is still excluded",
		seen.filter((s) => s.includes("hindsight_recall")),
		[],
	);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);

/**
 * Self-test for the bank-reminder cadence (run with bun or node).
 *   bun scripts/bank-reminder.test.ts
 *
 * Covers the whole risk of this feature: it must fire at session start when
 * memory itself stayed silent, again after N silent turns, never on a turn that
 * already carries a recall block, and never at all when the user switched
 * auto-recall off or the project has no declared bank.
 */

import {
	newReminderState,
	reminderDue,
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

const live = {
	enabled: true,
	everyTurns: 10,
	active: true,
	autoRecall: true,
	recalled: false,
};

/**
 * Fire pattern over `turns` consecutive turns of one session.
 * `recallOn(i)` says whether turn i injected a visible recall block.
 */
function pattern(
	turns: number,
	gate = live,
	sessionId: string | undefined = "s1",
	recallOn: (turn: number) => boolean = () => false,
): number[] {
	const state = newReminderState();
	const fired: number[] = [];
	for (let i = 0; i < turns; i += 1)
		if (reminderDue(state, sessionId, { ...gate, recalled: recallOn(i) }))
			fired.push(i);
	return fired;
}

check("fires at session start, then every N silent turns", pattern(25), [
	0, 10, 20,
]);

check("does not fire in between", pattern(10).length, 1);

check("a shorter interval is honored", pattern(10, { ...live, everyTurns: 3 }), [
	0, 3, 6, 9,
]);

// Defect 1: the old modulo fired on turn 0 — the very turn the task detector
// calls a boundary and injects a deep-recall briefing. A recall block IS the
// tools being mentioned, so that turn must stay quiet.
check(
	"silent on a turn that already injected a recall block",
	pattern(1, live, "s1", () => true),
	[],
);

check(
	"a recall block on turn 0 delays the nudge by a full interval",
	pattern(25, live, "s1", (i) => i === 0),
	[10, 20],
);

check(
	"a recall block mid-cadence re-arms the counter",
	pattern(30, live, "s1", (i) => i === 5),
	[0, 15, 25],
);

check(
	"a session where recall never stays silent never gets a nudge",
	pattern(50, live, "s1", () => true),
	[],
);

check("silent when auto-recall is off", pattern(30, { ...live, autoRecall: false }), []);

check("silent when the plugin is dormant", pattern(30, { ...live, active: false }), []);

check("silent when disabled by config", pattern(30, { ...live, enabled: false }), []);

check(
	"a non-positive interval disables it rather than firing every turn",
	pattern(30, { ...live, everyTurns: 0 }),
	[],
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

// The counter belongs to the session, not to the run of turns: a new session
// whose first turn carries a recall block is silent, and its cadence restarts
// from that block rather than from whatever the previous session was owed.
{
	const state = newReminderState();
	for (let i = 0; i < 9; i += 1) reminderDue(state, "s1", live);
	check(
		"a new session that opens with recall stays quiet",
		reminderDue(state, "s2", { ...live, recalled: true }),
		false,
	);
	const after: number[] = [];
	for (let i = 0; i < 11; i += 1)
		if (reminderDue(state, "s2", live)) after.push(i);
	check("and counts its silent turns from that block", after, [9]);
}

const text = reminderText("my-bank", { documents: 12, facts: 300 });
check("names the bank and its size", text.includes('"my-bank" holds 12 document(s) / 300 fact(s)'), true);
check("labels itself as plugin output", text.includes("not a user instruction"), true);
check("points at the tools", ["hindsight_recall", "hindsight_reflect", "hindsight_retain"].every((t) => text.includes(t)), true);
check("warns that reflect is slow", /reflect[^\n]*SLOW/.test(text), true);
check("stays short", text.split("\n").length <= 5, true);
check(
	"degrades without counts",
	reminderText("my-bank").includes('"my-bank" holds prior sessions'),
	true,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);

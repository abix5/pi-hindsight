/**
 * Self-test for the task-change detector (run with bun or node).
 *   bun scripts/task-detector.test.ts
 *
 * The detector is probabilistic at the model boundary, so everything AROUND
 * that boundary is pinned here: verdict parsing (including garbage), the
 * history truncation that happens on a task change, the past-title tail that
 * makes a RETURN recognisable, and the answer digest.
 *
 * Also covers `buildMessages`, so the widened `runModel` signature keeps
 * behaving exactly as before for the existing single-string callers.
 */

import type { HindsightConfig } from "../src/config.ts";
import { buildMessages } from "../src/model.ts";
import {
	applyVerdict,
	digestAssistant,
	newTaskState,
	parseTaskVerdict,
	recordTurn,
	renderHistory,
	type TaskState,
} from "../src/task-detector.ts";

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

const cfg = { taskHistoryTurns: 4, taskTitleTail: 2 } as HindsightConfig;

/* ---------- verdict parsing ---------- */

check(
	"a change verdict carries title and query",
	parseTaskVerdict(
		'{"changed":true,"title":"recall judge","query":"recall judge scoring recall.ts"}',
	),
	{
		changed: true,
		title: "recall judge",
		query: "recall judge scoring recall.ts",
		valid: true,
	},
);

check("an unchanged verdict parses", parseTaskVerdict('{"changed":false}'), {
	changed: false,
	valid: true,
});

check(
	"a change with no query degrades to unchanged (nothing to search for)",
	parseTaskVerdict('{"changed":true,"title":"something"}'),
	{ changed: false, valid: true },
);

check(
	"a titleless change falls back to the query as title",
	parseTaskVerdict('{"changed":true,"query":"config.ts CONFIG_ALLOW"}'),
	{
		changed: true,
		title: "config.ts CONFIG_ALLOW",
		query: "config.ts CONFIG_ALLOW",
		valid: true,
	},
);

// Garbage must never be able to trigger the expensive deep pass.
check("prose is invalid and unchanged", parseTaskVerdict("Sure — the topic changed!"), {
	changed: false,
	valid: false,
});
check("truncated JSON is invalid and unchanged", parseTaskVerdict('{"changed":tr'), {
	changed: false,
	valid: false,
});
check("JSON without the field is invalid", parseTaskVerdict('{"title":"x"}'), {
	changed: false,
	valid: false,
});
check("an empty answer is invalid", parseTaskVerdict("   "), {
	changed: false,
	valid: false,
});

/* ---------- history ---------- */

function seeded(): TaskState {
	const s = newTaskState();
	s.title = "recall judge";
	for (const n of ["one", "two", "three"]) {
		recordTurn(s, `did ${n}`, `message ${n}`, cfg);
		applyVerdict(s, { changed: false, valid: true }, '{"changed":false}', cfg);
	}
	return s;
}

check(
	"history keeps one entry per turn",
	seeded().turns.map((t) => t.user.split("USER: ")[1]),
	["message one", "message two", "message three"],
);

check(
	"the digest of the previous answer rides on the next user turn",
	seeded().turns[1].user,
	"PREVIOUS ANSWER: did two\n\nUSER: message two",
);

{
	const s = seeded();
	for (const n of ["four", "five", "six"]) recordTurn(s, "", `message ${n}`, cfg);
	check(
		"a task that never changes is still capped",
		s.turns.map((t) => t.user.split("USER: ")[1]),
		["message three", "message four", "message five", "message six"],
	);
}

{
	// The whole point of truncation: on a change the accumulated history is
	// dropped so the retained slice IS the description of the new task.
	const s = seeded();
	recordTurn(s, "did three", "now let's look at the widget", cfg);
	applyVerdict(
		s,
		{ changed: true, title: "status widget", query: "ui.ts widget", valid: true },
		'{"changed":true,"title":"status widget","query":"ui.ts widget"}',
		cfg,
	);
	check(
		"a change drops history down to the triggering message",
		s.turns.map((t) => t.user.split("USER: ")[1]),
		["now let's look at the widget"],
	);
	check("the finished task's title joins the tail", s.pastTitles, [
		"recall judge",
	]);
	check("the new title becomes current", s.title, "status widget");
}

{
	const s = newTaskState();
	s.pastTitles = ["alpha", "beta"];
	s.title = "gamma";
	recordTurn(s, "", "back to alpha please", cfg);
	applyVerdict(
		s,
		{ changed: true, title: "alpha", query: "alpha module", valid: true },
		'{"changed":true,"title":"alpha","query":"alpha module"}',
		cfg,
	);
	check("the title tail is capped, oldest first", s.pastTitles, [
		"beta",
		"gamma",
	]);
	check("returning to a past topic still changes the task", s.title, "alpha");
}

{
	const s = newTaskState();
	s.title = "dup";
	recordTurn(s, "", "x", cfg);
	applyVerdict(
		s,
		{ changed: true, title: "next", query: "next", valid: true },
		'{"changed":true,"title":"next","query":"next"}',
		cfg,
	);
	recordTurn(s, "", "y", cfg);
	applyVerdict(
		s,
		{ changed: true, title: "dup", query: "dup", valid: true },
		'{"changed":true,"title":"dup","query":"dup"}',
		cfg,
	);
	check("a title is never listed twice in the tail", s.pastTitles, [
		"dup",
		"next",
	]);
}

/* ---------- rendering ---------- */

{
	const s = seeded();
	s.pastTitles = ["morning topic"];
	const msgs = renderHistory(s);
	check(
		"roles alternate and no assistant turn trails",
		msgs.map((m) => m.role),
		["user", "assistant", "user", "assistant", "user"],
	);
	check(
		"past titles and the current task ride on the first message only",
		msgs[0].text,
		"PAST TASKS (earlier in this session):\n- morning topic\n\nCURRENT TASK: recall judge\n\nPREVIOUS ANSWER: did one\n\nUSER: message one",
	);
	check("later messages carry no header", msgs[2].text.startsWith("PREVIOUS"), true);
}

check("an empty state renders nothing to ask about", renderHistory(newTaskState()), []);

/* ---------- answer digest ---------- */

const entries = [
	{ id: "a", message: { role: "user", content: [{ type: "text", text: "go" }] } },
	{
		id: "b",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", text: "hmm" },
				{ type: "text", text: "Widened runModel to take a conversation. Then more prose." },
				{ type: "toolCall", name: "edit", arguments: { path: "src/model.ts" } },
				{ type: "toolCall", name: "read", arguments: { path: "src/recall.ts" } },
				{ type: "toolCall", name: "write", arguments: { path: "src/model.ts" } },
			],
		},
	},
];

check(
	"digest = first sentence + written files, deduped, reads only after the marker",
	digestAssistant(entries, "a"),
	"Widened runModel to take a conversation. | files: src/model.ts",
);
check("nothing after the marker digests to nothing", digestAssistant(entries, "b"), "");
check("an empty transcript digests to nothing", digestAssistant([], undefined), "");

/* ---------- runModel input shapes ---------- */

check(
	"a bare string is still exactly one user message",
	buildMessages("hello").map((m) => {
		const x = m as { role: string; content: Array<{ text: string }> };
		return [x.role, x.content[0].text];
	}),
	[["user", "hello"]],
);

check(
	"a conversation keeps its roles and order",
	buildMessages([
		{ role: "user", text: "u1" },
		{ role: "assistant", text: "a1" },
		{ role: "user", text: "u2" },
	]).map((m) => (m as { role: string }).role),
	["user", "assistant", "user"],
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);

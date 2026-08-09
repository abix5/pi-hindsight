/**
 * Self-test for `recallForTurn` — the one-turn contour that chooses between the
 * ordinary recall and the deep pass (run with bun or node).
 *   bun scripts/turn-recall.test.ts
 *
 * Two properties are pinned here, both of which were broken and measured:
 *   1. a DEEP pass injects prose, so its facts leave no bullets in the
 *      transcript; they must still reach the next turn's seen-set, or turn 2 of
 *      every session re-injects turn 1's knowledge as bullets;
 *   2. a boundary turn whose deep pass FAILS must degrade to the ordinary
 *      recall already in flight — never to nothing.
 */

import type { HindsightConfig } from "../src/config.ts";
import type { HindsightClient } from "../src/hindsight.ts";
import type { ModelChain } from "../src/model.ts";
import {
	type RecallInjectResult,
	recallForTurn,
	type runRecall,
} from "../src/recall.ts";
import { newTaskState } from "../src/task-detector.ts";
import type { TaskVerdict } from "../src/task-detector.ts";
import { recentContext } from "../src/recall-utils.ts";

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

const cfg = {
	taskDetect: true,
	taskHistoryTurns: 4,
	taskTitleTail: 2,
} as HindsightConfig;

const client = {} as HindsightClient;
const chain = { label: "fake" } as ModelChain;

/** A session with no entries at all: every turn looks like an ordinary one. */
function fakeCtx(entries: unknown[] = [{ id: "e1" }]) {
	return {
		cwd: "/tmp",
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "sess-1",
		},
	} as unknown as Parameters<typeof recallForTurn>[0]["ctx"];
}

function result(text: string, keys: string[], synthesized: boolean) {
	return {
		found: keys.length,
		injected: keys.length,
		skippedSeen: 0,
		skippedFiltered: 0,
		text,
		query: "q",
		operation: "recall",
		queried: true,
		reason: "bank recalled facts",
		rawHits: [],
		synthesized,
		injectedKeys: keys,
	} satisfies RecallInjectResult;
}

const changed: TaskVerdict = {
	changed: true,
	title: "new task",
	query: "new task",
	valid: true,
};
const unchanged: TaskVerdict = { changed: false, valid: true };

/* ---------- M1: a deep pass's facts reach the seen-set ---------- */
{
	const task = newTaskState();
	const seenPassedIn: string[][] = [];
	const run = (async (
		_ctx: unknown,
		_cfg: unknown,
		_client: unknown,
		_chain: unknown,
		_prompt: unknown,
		_signal: unknown,
		deep: unknown,
		priorSeen?: Iterable<string>,
	) => {
		seenPassedIn.push([...(priorSeen ?? [])]);
		// The deep pass returns a synthesized BRIEFING: prose, no bullets, so
		// nothing about it can be read back out of the transcript later.
		return deep
			? result(
					"Memory knows the widget is one fixed line and the fence closes it.",
					["the widget is one fixed line"],
					true,
				)
			: result("- something else", ["something else"], false);
	}) as unknown as typeof runRecall;
	const detect = async () => unchanged;

	// Turn 1 of a session is always a deep pass.
	const first = await recallForTurn({
		ctx: fakeCtx(),
		cfg,
		client,
		chain,
		prompt: "start",
		task,
		run,
		detect,
	});
	check("turn 1 is the deep pass", first.recall.synthesized, true);
	check(
		"a synthesized block's facts land in the seen-set",
		[...task.seenFacts],
		["the widget is one fixed line"],
	);

	// Turn 2 is ordinary — and must be told what turn 1 already injected.
	await recallForTurn({
		ctx: fakeCtx(),
		cfg,
		client,
		chain,
		prompt: "next",
		task,
		run,
		detect,
	});
	check(
		"turn 2 receives them, so the deep facts are not re-injected as bullets",
		seenPassedIn[1],
		["the widget is one fixed line"],
	);
}

/* ---------- M1b: a compaction drops the carried-forward set ---------- */
{
	const task = newTaskState();
	let turn = 0;
	const run = (async () =>
		result("briefing", [`fact ${++turn}`], true)) as unknown as typeof runRecall;
	const detect = async () => unchanged;
	await recallForTurn({
		ctx: fakeCtx(),
		cfg,
		client,
		chain,
		prompt: "start",
		task,
		run,
		detect,
	});
	check("seen after turn 1", [...task.seenFacts], ["fact 1"]);
	await recallForTurn({
		ctx: fakeCtx([{ id: "e1" }, { type: "compaction" }]),
		cfg,
		client,
		chain,
		prompt: "after compact",
		task,
		run,
		detect,
	});
	// The compaction wiped the transcript; the facts injected before it are no
	// longer in the agent's context, so the carried set must not keep suppressing
	// them — only what THIS turn injected survives.
	check("a compaction drops the carried set", [...task.seenFacts], ["fact 2"]);
	check("and the compaction turn is a deep pass", task.compactions, 1);
}

/* ---------- M2: a failing deep pass degrades to the ordinary result ---------- */
{
	const task = newTaskState();
	task.started = true;
	task.sessionId = "sess-1";
	const run = (async (
		_ctx: unknown,
		_cfg: unknown,
		_client: unknown,
		_chain: unknown,
		_prompt: unknown,
		_signal: unknown,
		deep: unknown,
	) => {
		if (deep) throw new Error("deep pass hit the 30s ceiling");
		return result("- the ordinary fact", ["the ordinary fact"], false);
	}) as unknown as typeof runRecall;

	const out = await recallForTurn({
		ctx: fakeCtx(),
		cfg,
		client,
		chain,
		prompt: "a brand new subject",
		task,
		run,
		detect: async () => changed,
	});
	check(
		"a thrown deep pass still injects the ordinary result",
		out.recall.text,
		"- the ordinary fact",
	);
	check("and the turn is still reported as a boundary", out.boundary, "task");

	// Both failing (an aborted turn takes down the ordinary call too) still throws:
	// the caller's own catch is what turns that into "no block this turn".
	const bothDead = (async () => {
		throw new Error("chain is dead");
	}) as unknown as typeof runRecall;
	let threw = false;
	try {
		await recallForTurn({
			ctx: fakeCtx(),
			cfg,
			client,
			chain,
			prompt: "x",
			task,
			run: bothDead,
			detect: async () => changed,
		});
	} catch {
		threw = true;
	}
	check("both recalls dead still surfaces the failure", threw, true);
}

/* ---------- m5: an injected recall block never feeds the query builder ---------- */
{
	// pi stores an injected block as a custom_message with `role: "custom"`, so it
	// is dropped with tool traffic. (The old `customType === "mem-recall"` check
	// sat BELOW the role filter and could never run.) The invariant is what
	// matters: feeding a recall block back would make the builder query the bank
	// for what was just recalled.
	const ctx = {
		sessionManager: {
			getEntries: () => [
				{ message: { role: "user", content: "fix the widget" } },
				{
					type: "custom_message",
					message: {
						role: "custom",
						customType: "mem-recall",
						content: "\uD83E\uDDE0 recall\n- Bank query: widget layout",
					},
				},
				{ message: { role: "assistant", content: "done" } },
			],
		},
	} as unknown as Parameters<typeof recentContext>[0];
	check(
		"an injected recall block stays out of the query builder's context",
		recentContext(ctx, 1000),
		"user: fix the widget\n\nassistant: done",
	);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);

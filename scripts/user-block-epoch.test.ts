/**
 * Self-test for the USER BLOCK in the system prompt (run with bun or node).
 *   bun scripts/user-block-epoch.test.ts
 *
 * The user bank holds what is true about the person in any repository. Putting
 * it in the SYSTEM PROMPT is what makes it always in force — and the system
 * prompt is the provider's cached prefix. Measured on real sessions, a cache
 * write costs 12-14x a cache read, so rewriting the prefix every turn multiplies
 * a session's price by 4.7-8.5. That single fact dictates the whole design and
 * therefore this file: the block is frozen for an EPOCH and re-emitted byte for
 * byte on every turn of it.
 *
 * Every check is named after the specification Scenario it measures, so a
 * failure points back at the requirement rather than at a line number. The
 * central one is "Bank content changes mid-epoch": it is written so that
 * removing the freeze — rebuilding the block per turn — makes it fail, and its
 * companion "Removing the freeze must break the test" proves the bank really
 * did move underneath it.
 */

import {
	BASE_URL,
	MARKER,
	agentsMd,
	bank,
	bankOf,
	blockOf,
	check,
	foreignBankCalls,
	hostPrompt,
	makeCwd,
	newHarness,
	replacements,
	report,
	userCalls,
	userReads,
	wire,
} from "./user-block-harness.ts";

const HOST = hostPrompt(agentsMd(1));
const FOUR = ["UB-ALPHA", "UB-BETA", "UB-GAMMA", "UB-DELTA"];

/** Occurrences of a fixture tag inside the assembled block. */
const count = (haystack: string, needle: string) =>
	haystack.split(needle).length - 1;

/** Fresh transport bookkeeping before each extension instance. */
function arm(items = bankOf(FOUR, ["UB-DEAD"])): void {
	wire.length = 0;
	bank.user.mode = "ok";
	bank.user.items = items;
	bank.project.mode = "ok";
}

// ============ Requirement: Marker-gated injection into the system prompt

// --- Scenario: Marker present and a block is available
arm();
const live = makeCwd("live", {});
/**
 * The control every negative check below leans on. A test that only proves
 * "nothing happened" also passes on a tree where the feature was never built,
 * so each of them carries this alongside its own assertion: here, with the
 * marker and the bank in place, something DID happen.
 */
const control = { injects: false, reads: 0 };
{
	const h = newHarness({ cwd: live });
	await h.start();
	const t = await h.turn(HOST);
	const block = blockOf(t, HOST);
	control.injects = t.returned && block.length > 0;
	control.reads = userReads().length;
	check(
		"Marker present and a block is available: the marker line — and only that line — is replaced",
		{
			returned: t.returned,
			everyOtherByteUnchanged: replacements(t.final, HOST) !== undefined,
			blockNonEmpty: block.length > 0,
			markerConsumed: !t.final.includes(MARKER),
		},
		{
			returned: true,
			everyOtherByteUnchanged: true,
			blockNonEmpty: true,
			markerConsumed: true,
		},
	);

	// --- Scenario: Composition
	check(
		"Composition: each distinct valid fact appears exactly once, the invalidated one not at all",
		{
			perFact: FOUR.map((t2) => count(block, t2)),
			invalidated: count(block, "UB-DEAD"),
		},
		{ perFact: [1, 1, 1, 1], invalidated: 0 },
	);

	// --- Scenario: No LLM traffic
	check(
		"No LLM traffic: the boundary read is a plain GET of the bank's list, and nothing reasons over it",
		{
			verbs: [...new Set(userCalls().map((c) => c.method))],
			listReads: userReads().length,
			recallOrReflect: wire.filter((c) => /recall|reflect/.test(c.url)).length,
		},
		{ verbs: ["GET"], listReads: 1, recallOrReflect: 0 },
	);

	// --- Scenario: Untouched contours
	check(
		"Untouched contours: the bank reminder still injects its own block alongside the new prompt",
		{
			reminderBlocks: t.messages.map((m) => m.customType),
			promptRewrittenInTheSameTurn: t.returned,
		},
		{ reminderBlocks: ["mem-reminder"], promptRewrittenInTheSameTurn: true },
	);
	h.done();
}

// --- Scenario: Marker occurs more than once
{
	arm();
	const many = hostPrompt(agentsMd(3));
	const h = newHarness({ cwd: makeCwd("many", {}, agentsMd(3)) });
	await h.start();
	const first = await h.turn(many);
	const second = await h.turn(many);
	const reps = replacements(first.final, many) ?? [];
	check(
		"Marker occurs more than once: every occurrence carries the same block, deterministically",
		{
			occurrences: reps.length,
			promptChanged: first.final !== many,
			allIdentical: reps.length > 0 && reps.every((r) => r === reps[0]),
			nonEmpty: (reps[0] ?? "").length > 0,
			markersLeft: (first.final.match(/<!-- hindsight:user -->/g) ?? []).length,
			stableAcrossTurns: first.final === second.final,
		},
		{
			occurrences: 3,
			promptChanged: true,
			allIdentical: true,
			nonEmpty: true,
			markersLeft: 0,
			stableAcrossTurns: true,
		},
	);
	h.done();
}

// --- Scenario: No marker anywhere in the instructions
{
	arm();
	const bare = hostPrompt(agentsMd(0));
	const h = newHarness({ cwd: makeCwd("nomarker", {}, agentsMd(0)) });
	await h.start();
	const t = await h.turn(bare);
	// The control is the live case above: the SAME bank and config inject there.
	check(
		"No marker anywhere in the instructions: no systemPrompt is returned and the prompt is byte-identical",
		{
			controlInjects: control.injects,
			returned: t.returned,
			byteIdentical: t.final === bare,
		},
		{ controlInjects: true, returned: false, byteIdentical: true },
	);
	check(
		"No marker anywhere in the instructions: no bank request is issued for injection purposes",
		{ controlReads: control.reads, readsHere: userReads().length },
		{ controlReads: 1, readsHere: 0 },
	);
	h.done();
}

// ==================== Requirement: Silence when no user bank is configured

// --- Scenario: Empty userBankId with a marker present
{
	arm();
	const h = newHarness({ cwd: makeCwd("nobank", { userBankId: "" }) });
	await h.start();
	const t = await h.turn(HOST);
	check(
		"Empty userBankId with a marker present: nothing is returned, the marker stays verbatim, no bank is asked",
		{
			controlInjects: control.injects,
			returned: t.returned,
			byteIdentical: t.final === HOST,
			markerIntact: t.final.includes(MARKER),
			foreignBankRequests: foreignBankCalls().length,
		},
		{
			controlInjects: true,
			returned: false,
			byteIdentical: true,
			markerIntact: true,
			foreignBankRequests: 0,
		},
	);
	h.done();
}

// ================= Requirement: Byte-identical block for the whole epoch

// --- Scenario: Bank content changes mid-epoch
// --- Scenario: No re-reads inside an epoch
// --- Scenario: Removing the freeze must break the test
// --- Scenario: Successful compaction
{
	arm();
	const h = newHarness({ cwd: makeCwd("epoch", {}) });
	await h.start();
	const opening = await h.turn(HOST);
	const readsAfterOpening = userReads().length;

	// The bank moves under the running epoch: facts added, facts retired, the
	// whole set replaced. None of it may reach the prefix before the next boundary.
	bank.user.items = bankOf(["UB-EPSILON", "UB-ZETA", "UB-ETA"], FOUR);
	const laterPrompts: string[] = [];
	for (let i = 0; i < 12; i += 1) laterPrompts.push((await h.turn(HOST)).final);

	check(
		"Bank content changes mid-epoch: every turn of the epoch returns the same bytes",
		{
			somethingWasFrozen: blockOf(opening, HOST).length > 0,
			turns: laterPrompts.length,
			allIdenticalToOpening: laterPrompts.every((p) => p === opening.final),
		},
		{ somethingWasFrozen: true, turns: 12, allIdenticalToOpening: true },
	);
	check(
		"No re-reads inside an epoch: the user bank is read once, at the boundary, and never from a turn",
		{ afterOpening: readsAfterOpening, afterTwelveMoreTurns: userReads().length },
		{ afterOpening: 1, afterTwelveMoreTurns: 1 },
	);

	// --- Scenario: Ordinary turn events
	await h.ordinary();
	await h.cancelledCompact();
	const afterNoise = await h.turn(HOST);
	check(
		"Ordinary turn events: turns, turn ends and a cancelled compaction open no epoch",
		{
			byteIdentical: afterNoise.final === opening.final,
			reads: userReads().length,
		},
		{ byteIdentical: true, reads: 1 },
	);

	// --- Scenario: Compaction that was cancelled
	check(
		"Compaction that was cancelled: the frozen block is unchanged and the previous epoch's prompt continues",
		{
			blockNonEmpty: blockOf(opening, HOST).length > 0,
			unchanged: blockOf(afterNoise, HOST) === blockOf(opening, HOST),
		},
		{ blockNonEmpty: true, unchanged: true },
	);

	// The mutation argument: the SAME changed bank, seen across a real boundary,
	// must produce different bytes. Without this, the identity above could be
	// measuring a bank that never moved instead of the freeze.
	await h.compact();
	const afterCompact = await h.turn(HOST);
	const newBlock = blockOf(afterCompact, HOST);
	check(
		"Removing the freeze must break the test: across a boundary the same changed bank yields different bytes",
		{
			differsFromFrozen: afterCompact.final !== opening.final,
			carriesTheNewFacts: ["UB-EPSILON", "UB-ZETA", "UB-ETA"].map((t) =>
				count(newBlock, t),
			),
			dropsTheRetiredOnes: FOUR.map((t) => count(newBlock, t)),
		},
		{
			differsFromFrozen: true,
			carriesTheNewFacts: [1, 1, 1],
			dropsTheRetiredOnes: [0, 0, 0, 0],
		},
	);

	// --- Scenario: Successful compaction
	const settled: string[] = [];
	for (let i = 0; i < 6; i += 1) settled.push((await h.turn(HOST)).final);
	check(
		"Successful compaction: the block is re-read exactly once and the new epoch is byte-identical again",
		{
			reads: userReads().length,
			allIdentical: settled.every((p) => p === afterCompact.final),
		},
		{ reads: 2, allIdentical: true },
	);
	h.done();
}

// ------------------------------------------------------------ Session start

// --- Scenario: Session start
{
	arm();
	const h = newHarness({ cwd: makeCwd("resumed", {}) });
	await h.start("resume");
	const t = await h.turn(HOST);
	check(
		"Session start: a resumed session opens the first epoch and reads its block once",
		{
			injected: blockOf(t, HOST).length > 0,
			reads: userReads().length,
		},
		{ injected: true, reads: 1 },
	);
	h.done();
}

// ========== Requirement: The inject-or-not decision is taken once per epoch

// --- Scenario: Bank becomes available mid-epoch
{
	arm();
	bank.user.mode = "error";
	const h = newHarness({ cwd: makeCwd("late-bank", {}) });
	await h.start();
	const dead = await h.turn(HOST);
	bank.user.mode = "ok";
	bank.user.items = bankOf(FOUR);
	const during: Array<{ returned: boolean; final: string }> = [];
	for (let i = 0; i < 6; i += 1) during.push(await h.turn(HOST));
	check(
		"Bank becomes available mid-epoch: no injection starts mid-epoch",
		{
			controlInjects: control.injects,
			firstTurnInjected: dead.returned,
			laterTurnsInjected: during.some((t) => t.returned),
			allByteIdentical: during.every((t) => t.final === HOST),
		},
		{
			controlInjects: true,
			firstTurnInjected: false,
			laterTurnsInjected: false,
			allByteIdentical: true,
		},
	);
	// The control that keeps the check honest: at the NEXT boundary it does inject.
	await h.compact();
	const after = await h.turn(HOST);
	check(
		"Bank becomes available mid-epoch: the decision is retaken at the next boundary, not before",
		blockOf(after, HOST).length > 0,
		true,
	);
	h.done();
}

// --- Scenario: Bank becomes empty mid-epoch
{
	arm();
	const h = newHarness({ cwd: makeCwd("emptied", {}) });
	await h.start();
	const opening = await h.turn(HOST);
	bank.user.items = [];
	const after: string[] = [];
	for (let i = 0; i < 5; i += 1) after.push((await h.turn(HOST)).final);
	check(
		"Bank becomes empty mid-epoch: injection continues with the frozen bytes",
		{
			injected: blockOf(opening, HOST).length > 0,
			allIdentical: after.every((p) => p === opening.final),
		},
		{ injected: true, allIdentical: true },
	);
	h.done();
}

// ======== Requirement: Deterministic, bounded block built from a plain GET

// --- Scenario: Determinism
{
	const shared = makeCwd("determinism", {});
	arm(bankOf(FOUR, ["UB-DEAD"]));
	const first = newHarness({ cwd: shared });
	await first.start();
	const a = await first.turn(HOST);
	first.done();

	arm([...bankOf(FOUR, ["UB-DEAD"])].reverse());
	const second = newHarness({ cwd: shared });
	await second.start();
	const b = await second.turn(HOST);
	second.done();

	check(
		"Determinism: the same records in a different server-side order assemble the same bytes",
		{
			injected: blockOf(a, HOST).length > 0,
			identical: blockOf(a, HOST) === blockOf(b, HOST),
		},
		{ injected: true, identical: true },
	);
}

// --- Scenario: Size ceiling
{
	const huge = Array.from({ length: 200 }, (_, i) => `UB-BULK-${i}`);
	const shared = makeCwd("ceiling", {});
	arm(bankOf(huge));
	const rawChars = bank.user.items.reduce((n, i) => n + i.text.length, 0);

	const h1 = newHarness({ cwd: shared });
	await h1.start();
	const t1 = await h1.turn(HOST);
	h1.done();
	const block = blockOf(t1, HOST);

	// A second epoch over the same oversized bank: whatever rule cut it must cut
	// it the same way, or the prefix changes for free at every boundary.
	arm(bankOf(huge));
	const h2 = newHarness({ cwd: shared });
	await h2.start();
	const t2 = await h2.turn(HOST);
	h2.done();

	check(
		"Size ceiling: an oversized bank is truncated by a deterministic rule and stays a well-formed block",
		{
			bankIsOversized: rawChars > 20000,
			blockNonEmpty: block.length > 0,
			blockWithinCeiling: block.length <= 20000,
			ceilingActuallyBit: block.length < rawChars,
			markerConsumed: !t1.final.includes(MARKER),
			sameCutTwice: block === blockOf(t2, HOST),
		},
		{
			bankIsOversized: true,
			blockNonEmpty: true,
			blockWithinCeiling: true,
			ceilingActuallyBit: true,
			markerConsumed: true,
			sameCutTwice: true,
		},
	);
}

// ========= Requirement: Generous boundary timeout with previous-block fallback

// --- Scenario: Server unreachable at a later boundary
for (const [label, mode] of [
	["an error status", "error"],
	["a refused connection", "reject"],
	["a server that never answers", "hang"],
] as Array<[string, "error" | "reject" | "hang"]>) {
	arm();
	const h = newHarness({ cwd: makeCwd(`fallback-${mode}`, {}) });
	await h.start();
	const opening = await h.turn(HOST);

	bank.user.items = bankOf(["UB-NEVER-SEEN"]);
	bank.user.mode = mode;
	const started = Date.now();
	await h.compact();
	const after = await h.turn(HOST);
	const elapsed = Date.now() - started;

	check(
		`Server unreachable at a later boundary (${label}): the previous block stays frozen`,
		{
			openingInjected: blockOf(opening, HOST).length > 0,
			byteIdentical: after.final === opening.final,
			leakedNewFacts: after.final.includes("UB-NEVER-SEEN"),
			withinGenerousTimeout: elapsed <= 16000,
		},
		{
			openingInjected: true,
			byteIdentical: true,
			leakedNewFacts: false,
			withinGenerousTimeout: true,
		},
	);
	h.done();
}

// --- Scenario: Server unreachable at the very first boundary
{
	arm();
	bank.user.mode = "reject";
	const h = newHarness({ cwd: makeCwd("first-boundary-down", {}) });
	await h.start();
	const t = await h.turn(HOST);
	check(
		"Server unreachable at the very first boundary: nothing is returned and the marker line is left intact",
		{
			controlInjects: control.injects,
			returned: t.returned,
			byteIdentical: t.final === HOST,
			markerIntact: t.final.includes(MARKER),
		},
		{
			controlInjects: true,
			returned: false,
			byteIdentical: true,
			markerIntact: true,
		},
	);
	// Control: the identical setup with a healthy bank does inject, so the check
	// above measures the failure path and not a feature that never ran.
	bank.user.mode = "ok";
	await h.compact();
	check(
		"Server unreachable at the very first boundary: a healthy later boundary still injects",
		(await h.turn(HOST)).returned,
		true,
	);
	h.done();
}

// --- Scenario: Hot path stays unblocked
{
	arm();
	const h = newHarness({ cwd: makeCwd("hotpath", {}) });
	await h.start();
	const opening = await h.turn(HOST);
	bank.user.mode = "hang";
	bank.project.mode = "hang";
	const started = Date.now();
	const turns: string[] = [];
	for (let i = 0; i < 20; i += 1) turns.push((await h.turn(HOST)).final);
	const elapsed = Date.now() - started;
	check(
		"Hot path stays unblocked: twenty turns against a dead bank never wait on it",
		{
			elapsedUnderASecond: elapsed < 2000,
			reads: userReads().length,
			allIdentical: turns.every((p) => p === opening.final),
			injected: blockOf(opening, HOST).length > 0,
		},
		{
			elapsedUnderASecond: true,
			reads: 1,
			allIdentical: true,
			injected: true,
		},
	);
	h.done();
}

// ================== Requirement: No regression in existing memory behaviour

// --- Scenario: Stand-down and tool-only mode
{
	arm();
	const pew = newHarness({
		cwd: makeCwd("pew", {}),
		sessionName: "deliver:test-author:attempt-1",
	});
	await pew.start();
	const t = await pew.turn(HOST);
	check(
		"Stand-down and tool-only mode: a PEW workflow-agent session injects nothing",
		{
			controlInjects: control.injects,
			returned: t.returned,
			byteIdentical: t.final === HOST,
			reads: userReads().length,
		},
		{
			controlInjects: true,
			returned: false,
			byteIdentical: true,
			reads: 0,
		},
	);
	pew.done();

	arm();
	const only = newHarness({ cwd: makeCwd("toolsonly", {}), toolsOnly: true });
	check(
		"Stand-down and tool-only mode: --mem-only-tools installs no prompt hook at all",
		{
			controlInjects: control.injects,
			beforeAgentStartHandlers: (only.handlers.get("before_agent_start") ?? [])
				.length,
			reads: userReads().length,
		},
		{ controlInjects: true, beforeAgentStartHandlers: 0, reads: 0 },
	);
	only.done();

	// Control for both: an ordinary host session in the same shape does inject.
	arm();
	const host = newHarness({ cwd: makeCwd("host-control", {}) });
	await host.start();
	check(
		"Stand-down and tool-only mode: an ordinary host session still injects, so the stand-downs above mean something",
		(await host.turn(HOST)).returned,
		true,
	);
	host.done();
}

// ========= Requirement: only the stated fact is cached, not the server's tail

// --- Scenario: A fact stored with a provenance tail, and one stored without
// The bank does not store the sentence it was given: retain appends
// " | Involving: … | <why this was kept>". Those bytes would live in the cached
// prefix for the whole epoch and be re-read every turn, so the block carries the
// fact and not the bookkeeping — while a text that has no such tail is untouched.
{
	arm([
		{
			id: "00000000-0000-4000-8000-000000000001",
			text: "UB-TAILED: the person treats another party's numbers as a claim until verified. | Involving: user | This is a standing principle of the user when judging information.",
			fact_type: "world",
			state: "valid",
		},
		{
			id: "00000000-0000-4000-8000-000000000002",
			text: "UB-PLAIN: the person prefers the shortest diff that actually works.",
			fact_type: "world",
			state: "valid",
		},
	]);
	const h = newHarness({ cwd: makeCwd("tail", {}) });
	await h.start();
	const t = await h.turn(HOST);
	const block = blockOf(t, HOST);
	h.done();
	check(
		"Provenance tail: a tailed fact keeps its statement and loses the bookkeeping, an untailed one is kept whole",
		{
			injected: block.length > 0,
			statementKept: block.includes(
				"UB-TAILED: the person treats another party's numbers as a claim until verified.",
			),
			separatorGone: block.includes("Involving"),
			rationaleGone: block.includes("standing principle"),
			untailedFactKeptWhole: block.includes(
				"UB-PLAIN: the person prefers the shortest diff that actually works.",
			),
		},
		{
			injected: true,
			statementKept: true,
			separatorGone: false,
			rationaleGone: false,
			untailedFactKeptWhole: true,
		},
	);
}

// A last sanity line on the transport: every byte these tests judged came from
// the stub, and the user bank really was consulted somewhere in this file.
check(
	"the whole file ran against the stubbed transport",
	{
		allStubbed: wire.every((c) => c.url.startsWith(BASE_URL)),
		liveEpochReadTheUserBank: control.reads,
	},
	{ allStubbed: true, liveEpochReadTheUserBank: 1 },
);

report();

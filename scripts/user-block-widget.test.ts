/**
 * Self-test for what the ONE-LINE widget says about the user block.
 *   bun scripts/user-block-widget.test.ts
 *
 * Visibility is a requirement here, not decoration: the block is frozen for a
 * whole epoch, so a person who edits the user bank and sees nothing change has
 * no way to tell whether the feature is broken or merely deferred. The widget
 * is where that is answered — and it is still the widget, so the invariant that
 * governs it holds: EXACTLY one line, never wider than 72 columns, whatever it
 * has to report.
 *
 * The lines are read out of the real extension driven end to end, not out of a
 * hand-built status object, so wording stays the implementation's business and
 * these checks stay about geometry, distinguishability and disclosure.
 */

import { HindsightStatus } from "../src/ui.ts";
import {
	BASE_URL,
	MARKER,
	PROJECT_BANK,
	THEME,
	agentsMd,
	bank,
	bankOf,
	check,
	cols,
	hostPrompt,
	makeCwd,
	newHarness,
	report,
	strip,
	wire,
} from "./user-block-harness.ts";

const HOST = hostPrompt(agentsMd(1));
const THREE = ["UB-ONE", "UB-TWO", "UB-THREE"];
const MAX_COLS = 72;

function arm(items = bankOf(THREE)): void {
	wire.length = 0;
	bank.user.mode = "ok";
	bank.user.items = items;
	bank.project.mode = "ok";
	bank.project.documents = 0;
	bank.project.nodes = 0;
}

/** Drive one session to its first turn and hand back the rendered widget. */
async function frame(
	cwd: string,
	host = HOST,
): Promise<{ lines: string[]; line: string; injected: boolean; final: string }> {
	const h = newHarness({ cwd });
	await h.start();
	const t = await h.turn(host);
	const lines = h.widget() ?? [];
	h.done();
	return { lines, line: lines[0] ?? "", injected: t.returned, final: t.final };
}

/** Geometry every state shares: one line, inside the budget, ANSI intact. */
function geometry(lines: string[]): {
	exactlyOneLine: boolean;
	withinBudget: boolean;
	intactAnsi: boolean;
} {
	const line = lines[0] ?? "";
	const plain = strip(line);
	return {
		exactlyOneLine: lines.length === 1 && !line.includes("\n"),
		withinBudget: cols(line) <= MAX_COLS,
		// Nothing survives stripping COMPLETE escapes: a line cut mid-sequence
		// leaves an ESC or a bare "[39m" behind.
		intactAnsi: !plain.includes("\x1b") && !/\[\d+(;\d+)*m/.test(plain),
	};
}

const ALL_GOOD = { exactlyOneLine: true, withinBudget: true, intactAnsi: true };

/**
 * The vocabulary that can carry "this changes only at the next boundary". The
 * exact wording is the implementation's to choose; what the specification
 * demands is that the deferral is said at all, in one of these registers.
 */
const DEFERRAL =
	/(next|later|pending|boundary|compact|freeze|frozen|restart|reload|epoch|след|позж|границ|компакт|заморож|отлож|⟳|↻|⟲|↦|⏳)/i;

// ================= Requirement: One-line widget disclosing the block's state

// --- Scenario: Block is injected
arm();
const injected = await frame(makeCwd("widget-on", {}));
check(
	"Block is injected: one line, inside 72 columns, stating that the user block is in the prompt with its count",
	{
		...geometry(injected.lines),
		promptWasRewritten: injected.injected,
		namesTheCount: /(^|[^0-9])3([^0-9]|$)/.test(strip(injected.line)),
	},
	{ ...ALL_GOOD, promptWasRewritten: true, namesTheCount: true },
);

// --- Scenario: No block
// A configured bank whose project instructions carry no marker: the epoch
// decided not to inject, and that is exactly what the person has to be able to
// see — otherwise a forgotten marker looks like a broken feature.
arm();
const absent = await frame(
	makeCwd("widget-off", {}, agentsMd(0)),
	hostPrompt(agentsMd(0)),
);
check(
	"No block: one line, inside 72 columns, saying the user block is absent instead of repeating the injected state",
	{
		...geometry(absent.lines),
		nothingWasInjected: absent.injected,
		distinguishableFromInjected: strip(absent.line) !== strip(injected.line),
		claimsNoCount: /(^|[^0-9])3([^0-9]|$)/.test(strip(absent.line)),
	},
	{
		...ALL_GOOD,
		nothingWasInjected: false,
		distinguishableFromInjected: true,
		claimsNoCount: false,
	},
);

// --- Scenario: Bank changed after the freeze
// Nothing re-reads the bank inside an epoch, so the widget cannot report the
// new content — it has to report the RULE instead: what you just wrote lands at
// the next boundary.
{
	arm();
	const h = newHarness({ cwd: makeCwd("widget-frozen", {}) });
	await h.start();
	const first = await h.turn(HOST);
	const before = (h.widget() ?? [])[0] ?? "";
	bank.user.items = bankOf(["UB-BRAND-NEW", "UB-ALSO-NEW"]);
	const later: string[] = [];
	for (let i = 0; i < 5; i += 1) {
		await h.turn(HOST);
		later.push((h.widget() ?? [])[0] ?? "");
	}
	const lines = h.widget() ?? [];
	h.done();
	check(
		"Bank changed after the freeze: one line, inside 72 columns, saying the change lands at the next boundary",
		{
			...geometry(lines),
			injected: first.returned,
			saysWhenItLands: DEFERRAL.test(strip(before)),
			steadyWhileFrozen: later.every((l) => l === before),
			doesNotShowTheUnreadFacts: strip(before).includes("BRAND-NEW"),
		},
		{
			...ALL_GOOD,
			injected: true,
			saysWhenItLands: true,
			steadyWhileFrozen: true,
			doesNotShowTheUnreadFacts: false,
		},
	);
}

// --- Scenario: Narrow budget
// The head already eats the line: a long bank id and six-figure counters. The
// block's state still has to fit next to them.
{
	arm();
	bank.project.documents = 12345;
	bank.project.nodes = 678901;
	const tightCfg = { bankId: "a-very-long-project-bank-identifier-indeed" };
	const tight = await frame(makeCwd("widget-tight", tightCfg));
	arm();
	bank.project.documents = 12345;
	bank.project.nodes = 678901;
	const tightNoBlock = await frame(
		makeCwd("widget-tight-off", tightCfg, agentsMd(0)),
		hostPrompt(agentsMd(0)),
	);
	check(
		"Narrow budget: still one line, still inside 72 columns, no truncated escape, block state still disclosed",
		{
			...geometry(tight.lines),
			injected: tight.injected,
			stillSaysSomethingAboutTheBlock:
				strip(tight.line) !== strip(tightNoBlock.line),
		},
		{ ...ALL_GOOD, injected: true, stillSaysSomethingAboutTheBlock: true },
	);
}

// ==================== Requirement: Silence when no user bank is configured

// --- Scenario: Empty userBankId with a marker present
// "No new widget state" is measurable: with no user bank declared the line must
// be exactly the one today's status object renders for the same session.
{
	arm();
	const silent = await frame(makeCwd("widget-silent", { userBankId: "" }));

	// The reference, built from the widget's own public API in the same order a
	// session start followed by a chainless turn drives it.
	const reference = new HindsightStatus();
	let refLines: string[] = [];
	reference.attach({
		setWidget: (_id: string, content: string[] | undefined) => {
			refLines = content ?? [];
		},
		setStatus: () => {},
		theme: THEME,
		// biome-ignore lint/suspicious/noExplicitAny: the slice of the UI the widget uses
	} as any);
	reference.setBank(PROJECT_BANK, BASE_URL);
	reference.recallOn();
	reference.memoOff();
	reference.bankChecking();
	reference.bankOk();
	reference.setBankCounts(0, 0);
	reference.recallDone(0);

	check(
		"Empty userBankId with a marker present: the widget gains no new state at all",
		{
			...geometry(silent.lines),
			controlLineDiffers: strip(injected.line) !== (strip(refLines[0] ?? "")),
			lineIsTodaysLine: silent.line === (refLines[0] ?? ""),
			injected: silent.injected,
			markerIntact: silent.final.includes(MARKER),
		},
		{
			...ALL_GOOD,
			controlLineDiffers: true,
			lineIsTodaysLine: true,
			injected: false,
			markerIntact: true,
		},
	);
}

// The marker constant these tests inject against is the one the specification
// fixes; a rename would silently turn every check above into a no-op.
check(
	"the marker under test is the literal the specification names",
	{ marker: MARKER, someStateWasEverInjected: injected.injected },
	{ marker: "<!-- hindsight:user -->", someStateWasEverInjected: true },
);

report();

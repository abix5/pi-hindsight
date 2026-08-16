/**
 * Self-test for the MARKER: the shapes people actually write, and what each one
 * asks the bank for.
 *   bun scripts/user-block-marker.test.ts
 *
 * The marker head names the bank, so no field repeats it, and exactly one
 * selector may follow it. Every check below drives the real extension and reads
 * the prompt it produced, so a passing line means the shipped parser and the
 * shipped fetch agreed — not that a helper function returned a nice object.
 */

import {
	agentsMd,
	bank,
	bankOf,
	check,
	hostPrompt,
	makeCwd,
	newHarness,
	report,
	userCalls,
	wire,
} from "./user-block-harness.ts";

const FACTS = ["UB-ONE", "UB-TWO", "UB-THREE"];
const MODEL_TEXT = "# Как работать\n\nПравило первое.\n\nПравило второе.";

/** An AGENTS.md whose standing-context section carries `marker` verbatim. */
function instructions(marker: string): string {
	return [
		"# Agent Instructions",
		"",
		"House conventions.",
		"",
		"## Standing context",
		"",
		marker,
		"",
		"## Commits",
		"",
		"- Commit messages are written in English.",
		"",
	].join("\n");
}

function arm(model = MODEL_TEXT): void {
	wire.length = 0;
	bank.user.mode = "ok";
	bank.user.items = bankOf(FACTS);
	bank.user.model = model;
	bank.project.mode = "ok";
}

/** Drive one session to its first turn against instructions carrying `marker`. */
async function run(
	name: string,
	marker: string,
): Promise<{ returned: boolean; final: string; block: string }> {
	const md = instructions(marker);
	const host = hostPrompt(md);
	const h = newHarness({ cwd: makeCwd(name, {}, md) });
	await h.start();
	const t = await h.turn(host);
	h.done();
	// What replaced the marker: everything the prompt gained over the original.
	const before = host.slice(0, host.indexOf(marker.split("\n")[0] ?? ""));
	const block = t.returned
		? t.final.slice(before.length, t.final.lastIndexOf("## Commits")).trim()
		: "";
	return { returned: t.returned, final: t.final, block };
}

const verbs = () => [...new Set(userCalls().map((c) => c.method))];
const asked = (fragment: string) =>
	userCalls().filter((c) => c.url.includes(fragment)).length;

// ============================ Requirement: both shapes of the same marker

// --- Scenario: the fields are written on their own lines
arm();
const multi = await run(
	"multi",
	["<!-- hindsight:user", "   model: user-profile", " -->"].join("\n"),
);
check(
	"A marker opened on one line and closed on another is read, and asks for that model",
	{
		injected: multi.returned,
		carriesTheModel: multi.block.includes("Правило первое."),
		askedForTheModel: asked("/mental-models/user-profile"),
		spentNoListRead: asked("/memories/list"),
		verbs: verbs(),
		// The needle is the marker's opening bytes, not the bare word: the block
		// itself carries `source="hindsight:user"`, so a looser check would report
		// the marker as surviving its own replacement.
		noMarkerLeft: multi.final.includes("<!-- hindsight:user"),
	},
	{
		injected: true,
		carriesTheModel: true,
		askedForTheModel: 1,
		spentNoListRead: 0,
		verbs: ["GET"],
		noMarkerLeft: false,
	},
);

// --- Scenario: the same marker written on one line
arm();
const inline = await run(
	"inline",
	"<!-- hindsight:user model: user-profile -->",
);
check(
	"The same marker written inline is read the same way",
	{
		injected: inline.returned,
		carriesTheModel: inline.block.includes("Правило первое."),
		askedForTheModel: asked("/mental-models/user-profile"),
		// The two shapes must not merely both work: they must produce the SAME
		// bytes, or a session's prefix would depend on how the marker was typed.
		sameBytesAsMultiline: inline.block === multi.block,
	},
	{
		injected: true,
		carriesTheModel: true,
		askedForTheModel: 1,
		sameBytesAsMultiline: true,
	},
);

// ================================ Requirement: the selector picks the source

// --- Scenario: a question instead of a model
arm();
const asks = await run(
	"query",
	[
		"<!-- hindsight:user",
		"  query: Как работать с этим человеком: чего он требует",
		"         от отчётов и от проверки фактов?",
		"  limit: 2",
		"-->",
	].join("\n"),
);
check(
	"A query marker recalls from the bank and honours the limit, counted in facts",
	{
		injected: asks.returned,
		recalled: asked("/memories/recall"),
		spentNoModelRead: asked("/mental-models/"),
		facts: (asks.block.match(/^- /gm) ?? []).length,
		// The wrapped continuation line belongs to the question, not to a field.
		questionWasSentWhole: wire.some((c) => c.url.includes("/memories/recall")),
	},
	{
		injected: true,
		recalled: 1,
		spentNoModelRead: 0,
		facts: 2,
		questionWasSentWhole: true,
	},
);

// --- Scenario: a bare marker still means what it always meant
arm();
const bare = await run("bare", "<!-- hindsight:user -->");
check(
	"A bare marker keeps its old meaning: the bank's stated facts",
	{
		injected: bare.returned,
		listed: asked("/memories/list"),
		askedNothingElse: asked("/mental-models/") + asked("/memories/recall"),
		facts: (bare.block.match(/^- /gm) ?? []).length,
	},
	{ injected: true, listed: 1, askedNothingElse: 0, facts: 3 },
);

// ==================================== Requirement: refuse what is not understood

// --- Scenario: a field nobody knows
arm();
const unknown = await run(
	"unknown-field",
	["<!-- hindsight:user", "  colour: blue", "-->"].join("\n"),
);
check(
	"An unknown field refuses the whole marker: nothing is injected and nothing is asked",
	{
		injected: unknown.returned,
		markerLeftIntact: unknown.final.includes("colour: blue"),
		requests: userCalls().length,
	},
	{ injected: false, markerLeftIntact: true, requests: 0 },
);

// --- Scenario: two selectors at once
arm();
const both = await run(
	"two-selectors",
	[
		"<!-- hindsight:user",
		"  model: user-profile",
		"  query: и заодно спроси",
		"-->",
	].join("\n"),
);
check(
	"Two selectors are two answers for one hole, so the marker is refused rather than guessed",
	{ injected: both.returned, requests: userCalls().length },
	{ injected: false, requests: 0 },
);

// --- Scenario: a marker that is never closed
arm();
const open = await run(
	"unclosed",
	["<!-- hindsight:user", "  model: user-profile"].join("\n"),
);
check(
	"A marker with no closing bytes is not a marker",
	{ injected: open.returned, requests: userCalls().length },
	{ injected: false, requests: 0 },
);

// ============================== Requirement: a model that is not ready yet

// --- Scenario: the server's generation placeholder
// A mental model answers 200 with this while it is being built. Freezing it
// would put "Generating content..." in the instructions for a whole epoch.
arm("Generating content...");
const pending = await run(
	"generating",
	"<!-- hindsight:user model: user-profile -->",
);
check(
	"A model still generating is not an answer: nothing is injected and the marker is blanked",
	{
		injected: pending.block.includes("Правило"),
		askedForIt: asked("/mental-models/user-profile"),
		// The marker goes even with nothing to put in its place: it is a note to
		// this extension, and the model must not be handed it to interpret.
		markerBlanked: pending.final.includes("<!-- hindsight:user"),
		placeholderLeaked: pending.final.includes("Generating content"),
	},
	{
		injected: false,
		askedForIt: 1,
		markerBlanked: false,
		placeholderLeaked: false,
	},
);

// --- Scenario: the control for every refusal above
// Each negative check would also pass on a tree where the feature never worked,
// so the same shape with a healthy model must inject.
arm();
const control = await run(
	"control",
	"<!-- hindsight:user model: user-profile -->",
);
check(
	"The control: the same shape with a ready model does inject",
	{ injected: control.returned, carries: control.block.includes("Правило") },
	{ injected: true, carries: true },
);

// ============================== Requirement: the person is told, the model is not

// --- Scenario: a marker that cannot be answered warns once, out of band
// The warning is not a toast: pi appends `Warning: …` to the chat container, so
// it stays in the scrollback. Repeating it at every boundary would litter the
// transcript, and putting it in the context would spend tokens asking the model
// to fix a file it did not write.
{
	arm();
	bank.user.mode = "error";
	const md = instructions("<!-- hindsight:user model: user-profile -->");
	const host = hostPrompt(md);
	const h = newHarness({ cwd: makeCwd("warned", {}, md) });
	await h.start();
	const first = await h.turn(host);
	const afterStart = h.notices().filter((n) => n.type === "warning");
	// A second boundary in the same session must not warn again.
	await h.compact();
	await h.turn(host);
	const afterCompact = h.notices().filter((n) => n.type === "warning");
	const messages = h.notices().map((n) => n.message);
	h.done();
	check(
		"A bank that does not answer warns the person once per session, never the model",
		{
			warnedOnce: afterStart.length,
			stillOnceAfterASecondBoundary: afterCompact.length,
			saysWhichBank: messages.some((m) => m.includes("user-bank")),
			saysNothingWasInjected: messages.some((m) =>
				/nothing injected/i.test(m),
			),
			// pi stamps the word itself, so the text must not stamp it again.
			noDoubleStamp: messages.some((m) => /warn/i.test(m)),
			// One line, no escapes: it lands in a single Text node.
			oneLine: messages.every((m) => !m.includes("\n") && !m.includes("\u001b")),
			nothingReachedTheModel: first.messages.some((m) =>
				/warn/i.test(String(m.customType ?? "")),
			),
		},
		{
			warnedOnce: 1,
			stillOnceAfterASecondBoundary: 1,
			saysWhichBank: true,
			saysNothingWasInjected: true,
			noDoubleStamp: false,
			oneLine: true,
			nothingReachedTheModel: false,
		},
	);
}

// --- Scenario: a marker nobody wrote stays silent
{
	arm();
	const md = instructions("nothing to see here");
	const h = newHarness({ cwd: makeCwd("silent", {}, md) });
	await h.start();
	await h.turn(hostPrompt(md));
	const notices = h.notices();
	h.done();
	check(
		"A project that never asked for a block is never warned about it",
		{
			// Scoped to warnings on purpose: the extension still says its ordinary
			// `bank ready` at startup, and silencing that is not what this asks for.
			warnings: notices.filter((n) => n.type === "warning").length,
			mentionsTheBlock: notices.some((n) => /block|marker/i.test(n.message)),
		},
		{ warnings: 0, mentionsTheBlock: false },
	);
}

report();

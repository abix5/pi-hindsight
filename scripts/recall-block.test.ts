/**
 * Self-test pinning the README's recall-block examples to the shipped
 * formatter (run with bun).
 *   bun scripts/recall-block.test.ts
 *
 * The README shows the memory block that `recallTrace` (src/index.ts) injects
 * into the conversation. Those examples are pasted from
 * `bun scripts/widget-shots.ts recall-block-*`, and this test keeps them
 * honest: each fenced example is re-parsed into a `RecallInjectResult` and fed
 * back through the REAL `recallTrace`, which must reproduce the README block
 * byte for byte. The invented fact text is read out of the README itself, so
 * what is really being compared is the structure — the 🧠 header, the three
 * counter lines, the untrusted-memory headers and the closing fence. Change
 * any of those in the formatter (or hand-edit an example) and this fails.
 */

import * as fs from "node:fs";
import { recallTrace } from "../src/index.ts";
import type { RecallInjectResult } from "../src/recall.ts";
import { DEEP_HEADER, FACTS_END, FACTS_HEADER } from "../src/recall-utils.ts";

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

const readme = fs.readFileSync(
	new URL("../README.md", import.meta.url),
	"utf8",
);
const start = readme.indexOf("## The recall block");
check("the README has a recall-block section", start >= 0, true);
const rest = readme.slice(Math.max(start, 0));
const end = rest.indexOf("\n## ");
const section = end < 0 ? rest : rest.slice(0, end);

// The fenced examples: the fact-list hit and the deep briefing.
const blocks = [...section.matchAll(/```text\n([\s\S]*?)\n```/g)].map(
	(m) => m[1],
);
check("the section fences a hit and a deep briefing", blocks.length, 2);

const base: RecallInjectResult = {
	found: 0,
	injected: 0,
	skippedSeen: 0,
	skippedFiltered: 0,
	text: "",
	query: "",
	operation: "recall",
	queried: true,
	reason: "",
	rawHits: [],
	injectedKeys: [],
};

/**
 * Read a fenced README example back into the result that would render it. Only
 * the structural lines are interpreted; the fact text between the header and
 * the fence is taken verbatim, whatever the README invented.
 */
function parse(block: string): RecallInjectResult | null {
	const lines = block.split("\n");
	const query = /^- Bank query: (.+)$/.exec(lines[1] ?? "")?.[1];
	const found = /^- Found in bank: (\d+) fact\(s\)$/.exec(lines[2] ?? "")?.[1];
	const injected = /^- Injected into context: (\d+) fact\(s\)$/.exec(
		lines[3] ?? "",
	)?.[1];
	const header = lines[5];
	const fence = lines.indexOf(FACTS_END);
	if (!query || !found || !injected || fence < 0) return null;
	if (header !== FACTS_HEADER && header !== DEEP_HEADER) return null;
	return {
		...base,
		query,
		found: Number(found),
		injected: Number(injected),
		text: lines.slice(6, fence).join("\n"),
		synthesized: header === DEEP_HEADER,
	};
}

const headers: string[] = [];
for (const [i, block] of blocks.entries()) {
	const parsed = parse(block);
	check(`example ${i + 1}: the structural lines parse`, parsed !== null, true);
	if (!parsed) continue;
	headers.push(block.split("\n")[5]);
	check(
		`example ${i + 1}: recallTrace reproduces the README block byte for byte`,
		recallTrace(parsed),
		block,
	);
}
check(
	"the two examples show the fact-list header and the deep header, in that order",
	headers,
	[FACTS_HEADER, DEEP_HEADER],
);

// The two shapes shown inline as prose must quote the formatter verbatim too.
const missLine = recallTrace({
	...base,
	query: "q",
	found: 5,
	reason: "recalled facts judged irrelevant",
})
	.split("\n")
	.at(-1) as string;
check(
	"the miss shape's none-line is the formatter's, quoted verbatim",
	missLine.startsWith("Injected facts: none") && section.includes(missLine),
	true,
);
const notSent = recallTrace({ ...base, queried: false, reason: "r" }).split(
	"\n",
)[1];
check(
	"the not-queried opener is the formatter's, quoted verbatim",
	notSent === "- Bank query: not sent" && section.includes(notSent),
	true,
);

// Behaviour prose: the fence's purpose and the examples' provenance are stated.
check(
	"the prose explains what the fence is for",
	/fence/.test(section) && /apart/.test(section),
	true,
);
check(
	"the prose says the examples come out of the running formatter",
	/widget-shots\.ts recall-block/.test(section) &&
		/never typed by hand/.test(section),
	true,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);

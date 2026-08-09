/**
 * Self-test for fact invalidation (run with bun or node).
 *   bun scripts/fact-invalidation.test.ts
 *
 * Three things must hold:
 *   1. extractHits carries the bank id/type through WITHOUT disturbing recall,
 *      which only ever reads `text`;
 *   2. no verifiable quote → no invalidation, whatever the model says;
 *   3. the PATCH the client sends is the shape the live server accepts.
 */

import { HindsightClient } from "../src/hindsight.ts";
import { extractHits, parseInvalidations } from "../src/recall-utils.ts";

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

// ---------------------------------------------------------------- extractHits

// Shape of a real `POST memories/recall` reply (fields trimmed to what we read).
const recallReply = {
	results: [
		{
			id: "c03dc710-bda8-4972-9b09-f1a80d9da15c",
			text: "review-server.ts serves the review UI on port 7788.",
			type: "world",
			scores: { final: 1.09 },
		},
		{
			id: "8b6e3038-ff01-4fb2-a86a-84bd799df326",
			text: "The taskflow engine runs steps from .pi/taskflows.",
			type: "observation",
		},
	],
	entities: {},
};

check("recall hits keep their id", extractHits(recallReply).map((h) => h.id), [
	"c03dc710-bda8-4972-9b09-f1a80d9da15c",
	"8b6e3038-ff01-4fb2-a86a-84bd799df326",
]);

check("recall hits keep their fact type", extractHits(recallReply).map((h) => h.type), [
	"world",
	"observation",
]);

// The recall contour reads nothing but `text`; the added fields must not shift it.
check("recall text is unchanged", extractHits(recallReply).map((h) => h.text), [
	"review-server.ts serves the review UI on port 7788.",
	"The taskflow engine runs steps from .pi/taskflows.",
]);

check(
	"memories/list rows expose fact_type as the type",
	extractHits({ items: [{ id: "x1", text: "a fact", fact_type: "experience" }] }),
	[{ text: "a fact", id: "x1", type: "experience" }],
);

check(
	"a hit without an id still recalls",
	extractHits({ memories: [{ content: "an id-less fact" }] }),
	[{ text: "an id-less fact", id: undefined, type: undefined }],
);

check("a prose response still recalls", extractHits("just prose"), [
	{ text: "just prose" },
]);

// ------------------------------------------------------- parseInvalidations

const TRANSCRIPT = [
	"user: what happened to the review server?",
	"assistant: I deleted src/review-server.ts entirely; the review UI is gone.",
	"user: and the port config?",
	"assistant: port 7788 moved to 9100.",
].join("\n");

const IDS = ["fact-review", "fact-port"];

function kills(raw: string) {
	return parseInvalidations(raw, { allowedIds: IDS, transcript: TRANSCRIPT });
}

check(
	"a quoted, known id is invalidated",
	kills(
		'{"verdicts":[{"verdict":"contradicts","id":"fact-review","quote":"I deleted src/review-server.ts entirely"}]}',
	),
	[
		{
			id: "fact-review",
			quote: "I deleted src/review-server.ts entirely",
		},
	],
);

check(
	"whitespace and case differences still match the transcript",
	kills(
		'{"verdicts":[{"verdict":"contradicts","id":"fact-review","quote":"I DELETED   src/review-server.ts\\n entirely"}]}',
	).map((k) => k.id),
	["fact-review"],
);

check(
	"no quote blocks the invalidation",
	kills('{"verdicts":[{"verdict":"contradicts","id":"fact-review"}]}'),
	[],
);

check(
	"an empty quote blocks the invalidation",
	kills(
		'{"verdicts":[{"verdict":"contradicts","id":"fact-review","quote":"   "}]}',
	),
	[],
);

// The whole point of the safety catch: a plausible-sounding quote that is not in
// the transcript is a fabrication, and fabricated evidence must not kill a fact.
check(
	"a quote absent from the transcript blocks the invalidation",
	kills(
		'{"verdicts":[{"verdict":"contradicts","id":"fact-review","quote":"the review server was removed last week"}]}',
	),
	[],
);

check(
	"an unknown id is ignored",
	kills(
		'{"verdicts":[{"verdict":"contradicts","id":"fact-nope","quote":"I deleted src/review-server.ts entirely"}]}',
	),
	[],
);

check(
	"the new/duplicate verdicts carry no action",
	kills(
		'{"verdicts":[{"verdict":"duplicate","id":"fact-review","quote":"I deleted src/review-server.ts entirely"},{"verdict":"new","id":"fact-port","quote":"port 7788 moved to 9100."}]}',
	),
	[],
);

check("the empty verdict list is honored", kills('{"verdicts":[]}'), []);

check("garbage output kills nothing", kills("Sure! I would retire fact-review."), []);

check("a missing verdicts field kills nothing", kills('{"ok":true}'), []);

check(
	"a non-array verdicts field kills nothing",
	kills('{"verdicts":"fact-review"}'),
	[],
);

check(
	"the same id is reported once",
	kills(
		'{"verdicts":[{"verdict":"contradicts","id":"fact-review","quote":"I deleted src/review-server.ts entirely"},{"verdict":"contradicts","id":"fact-review","quote":"the review UI is gone"}]}',
	).length,
	1,
);

// ------------------------------------------------------- client PATCH shape

const calls: Array<{ url: string; method: string; body: unknown }> = [];
let nextStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
	calls.push({
		url: String(url),
		method: init.method ?? "GET",
		body: JSON.parse(String(init.body)),
	});
	return {
		ok: nextStatus < 400,
		status: nextStatus,
		text: async () => (nextStatus < 400 ? '{"state":"invalidated"}' : '{"detail":"nope"}'),
	};
	// biome-ignore lint/suspicious/noExplicitAny: minimal fetch stub for the shape assertion
}) as any;

const client = new HindsightClient({
	baseUrl: "http://localhost:8888",
	namespace: "default",
	bankId: "throwaway bank",
	// biome-ignore lint/suspicious/noExplicitAny: only the three fields above are read
} as any);

await client.invalidate("mem-1", 'quote: "I deleted src/review-server.ts"');

check("PATCHes the memory by id", [calls[0]?.method, calls[0]?.url], [
	"PATCH",
	// The bank id is URL-encoded, as everywhere else in the client.
	"http://localhost:8888/v1/default/banks/throwaway%20bank/memories/mem-1",
]);

// Verified against the live server (Hindsight 0.9.0): the request field is
// `reason`; `invalidation_reason` is what the row reads back as.
check(
	"sends state=invalidated plus the quote as `reason`",
	calls[0]?.body,
	{ state: "invalidated", reason: 'quote: "I deleted src/review-server.ts"' },
);

// A 400 means the id is an observation (derived, not curatable) and a 404 means
// the fact is already gone. Neither may break the write that triggered it.
for (const status of [400, 404]) {
	nextStatus = status;
	let threw = false;
	try {
		await client.invalidate("mem-2", "reason");
	} catch {
		threw = true;
	}
	check(`HTTP ${status} is swallowed`, threw, false);
}

nextStatus = 500;
let threw500 = false;
try {
	await client.invalidate("mem-3", "reason");
} catch {
	threw500 = true;
}
check("a real server error still surfaces", threw500, true);

globalThis.fetch = realFetch;

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);

/**
 * Self-test for the per-query judge verdict parser (run with bun or node).
 *   bun scripts/recall-judge.test.ts
 *
 * Covers score clamping, out-of-range fact numbers, the empty verdict, and the
 * unparseable-output signal the caller uses to fall back instead of dropping.
 */

import { parseJudge } from "../src/recall-utils.ts";

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

function verdict(raw: string, max: number) {
	const v = parseJudge(raw, max);
	return { score: v.score, keep: [...v.keep], valid: v.valid };
}

check("keeps the listed facts", verdict('{"score":80,"keep":[1,3]}', 4), {
	score: 80,
	keep: [1, 3],
	valid: true,
});

check("drops out-of-range numbers", verdict('{"score":50,"keep":[1,9,0]}', 3), {
	score: 50,
	keep: [1],
	valid: true,
});

check("empty keep forces score 0", verdict('{"score":90,"keep":[]}', 3), {
	score: 0,
	keep: [],
	valid: true,
});

check("clamps an out-of-range score", verdict('{"score":900,"keep":[2]}', 3), {
	score: 100,
	keep: [2],
	valid: true,
});

check("a junk verdict is honored", verdict('{"score":0,"keep":[]}', 5), {
	score: 0,
	keep: [],
	valid: true,
});

check("prose output is reported invalid", verdict("Sure! Facts 1 and 2.", 3), {
	score: 0,
	keep: [],
	valid: false,
});

check("missing keep is invalid", verdict('{"score":70}', 3), {
	score: 0,
	keep: [],
	valid: false,
});

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);

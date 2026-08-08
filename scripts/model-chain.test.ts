/**
 * Self-test for the model chain resolver (run with bun or node).
 *   bun scripts/model-chain.test.ts
 *   node --experimental-strip-types scripts/model-chain.test.ts
 *
 * Covers ordering, dedup, unknown-id tolerance, and the session-model tail.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "../src/config.ts";
import { resolveChain } from "../src/model.ts";

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

/** A registry that only knows the ids we list here. */
function fakeCtx(known: string[], session?: string): ExtensionContext {
	return {
		cwd: "/tmp",
		model: session
			? { provider: session.split("/")[0], id: session.split("/")[1] }
			: undefined,
		modelRegistry: {
			find: (provider: string, id: string) =>
				known.includes(`${provider}/${id}`) ? { provider, id } : undefined,
		},
	} as unknown as ExtensionContext;
}

function cfg(over: Partial<HindsightConfig>): HindsightConfig {
	return {
		recallModelChain: [],
		retainModelChain: [],
		...over,
	} as HindsightConfig;
}

const ctx = fakeCtx(["a/one", "b/two", "c/three"], "z/session");

check(
	"primary first, then chain, then session",
	resolveChain(
		ctx,
		cfg({ recallModelId: "a/one", recallModelChain: ["b/two", "c/three"] }),
		"recall",
	)?.candidates.map((c) => c.label),
	["a/one", "b/two", "c/three", "z/session"],
);

check(
	"unknown ids are skipped",
	resolveChain(
		ctx,
		cfg({ recallModelId: "nope/x", recallModelChain: ["b/two", "gone/y"] }),
		"recall",
	)?.candidates.map((c) => c.label),
	["b/two", "z/session"],
);

check(
	"duplicates collapse, session not repeated",
	resolveChain(
		ctx,
		cfg({ recallModelId: "a/one", recallModelChain: ["a/one", "z/session"] }),
		"recall",
	)?.candidates.map((c) => c.label),
	["a/one", "z/session"],
);

check(
	"retain role reads the retain keys",
	resolveChain(
		ctx,
		cfg({
			recallModelId: "a/one",
			retainModelId: "b/two",
			retainModelChain: ["c/three"],
		}),
		"retain",
	)?.candidates.map((c) => c.label),
	["b/two", "c/three", "z/session"],
);

check(
	"legacy modelId is used when the role key is unset",
	resolveChain(ctx, cfg({ modelId: "c/three" }), "recall")?.candidates.map(
		(c) => c.label,
	),
	["c/three", "z/session"],
);

check(
	"no models at all → undefined",
	resolveChain(fakeCtx([]), cfg({ recallModelId: "a/one" }), "recall"),
	undefined,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

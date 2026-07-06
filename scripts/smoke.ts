/** Standalone smoke test for the Hindsight REST client (run with bun). */
import { loadConfig } from "../src/config.ts";
import { HindsightClient } from "../src/hindsight.ts";

const cfg = loadConfig(process.cwd());
cfg.bankId = "pi-hindsight-smoke";
const c = new HindsightClient(cfg);

console.log("config:", {
	baseUrl: cfg.baseUrl,
	namespace: cfg.namespace,
	bankId: cfg.bankId,
});

console.log("health:", await c.health());
console.log("ensureBank:", await c.ensureBank());
const marker = `smoke-${Date.now()}`;
console.log(
	"retain:",
	await c.retain(`Test fact: the smoke marker is ${marker}.`, {
		context: "smoke",
		tags: ["smoke"],
	}),
);

// Recall may need a moment for indexing; try immediately.
const recall = await c.recall("smoke marker", { maxTokens: 512 });
console.log(
	"recall keys:",
	recall && typeof recall === "object" ? Object.keys(recall as object) : recall,
);
console.log("recall:", JSON.stringify(recall).slice(0, 1200));

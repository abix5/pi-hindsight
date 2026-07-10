/**
 * Fact-category configurator for the memorize (retain) contour.
 *
 * The user decides WHAT kinds of durable knowledge get harvested from a
 * transcript. Each category is TRI-STATE:
 *   - "on"  → extract it: its heading + guidance + example go into the prompt;
 *   - "off" → neutral: not mentioned at all (neither asked for nor forbidden);
 *   - "ban" → explicitly forbidden: listed in a "do NOT extract" section.
 *
 * The catalog below is the default set; users add their own via /mem-types.
 * Everything is persisted to `.pi/hindsight.json` under `factCategories`.
 *
 * All text is English (TUI style, no emoji): clauses/examples steer the
 * extractor prompt (Hindsight still stores facts in the input language), and
 * labels are shown in the /mem-types picker with plain ASCII state markers.
 */

import type { HindsightConfig } from "./config.ts";

export type CatState = "on" | "off" | "ban";

export interface CategoryDef {
	key: string;
	/** Label shown in the /mem-types picker (English, no emoji). */
	label: string;
	/** English heading used in the harvested report (kept stable for dedup). */
	heading: string;
	/** What to extract — injected as the heading's guidance. */
	clause: string;
	/** A concrete example bullet, shown to anchor the extractor. */
	example: string;
	/** Default tri-state when the user has not overridden it. */
	def: CatState;
	/** True for user-defined categories loaded from config. */
	custom?: boolean;
}

export type ResolvedCategory = CategoryDef & { state: CatState };

/** A user-defined category as stored in `.pi/hindsight.json`. */
export interface CustomCategory {
	key: string;
	label: string;
	heading?: string;
	clause: string;
	example?: string;
	state?: CatState;
}

export const DEFAULT_CATEGORIES: CategoryDef[] = [
	{
		key: "goal",
		label: "Goal",
		heading: "Goal",
		clause: "The objective being pursued and its definition of done.",
		example:
			"Goal: give the agent long-term memory over Hindsight; done when recall and memorize work end-to-end.",
		def: "on",
	},
	{
		key: "decisions",
		label: "Decisions",
		heading: "Decisions",
		clause:
			"Choices that were made and the rationale / trade-off behind them (why this over the alternative).",
		example:
			"Memory engine is inline: extract→verify→retain runs in-process with the small model.",
		def: "on",
	},
	{
		key: "constraints",
		label: "Constraints & preferences",
		heading: "Constraints and preferences",
		clause:
			"Standing user rules and preferences that persist across tasks (style, 'always/never', tooling choices).",
		example: "Never store secret values — only record WHERE a secret lives.",
		def: "on",
	},
	{
		key: "knowhow",
		label: "Know-how",
		heading: "Know-how",
		clause:
			"Verified procedures that worked: exact commands, configs, and fixes — the steps, not the diff.",
		example:
			"Rebuild Hindsight with `make restart` in the hindsight repo; verify health in the /mem dashboard Status tab.",
		def: "on",
	},
	{
		key: "pitfalls",
		label: "Pitfalls",
		heading: "Pitfalls",
		clause:
			"Approaches that were tried and FAILED, and why — dead-ends not to repeat.",
		example:
			"deliverAs:nextTurn fires no turn, so the flow hung; fixed with triggerTurn:true.",
		def: "on",
	},
	{
		key: "facts",
		label: "Facts & locations",
		heading: "Facts and locations",
		clause:
			"Non-obvious project facts: endpoints, ports, versions, env-var NAMES, config paths, where secrets live (never their values).",
		example:
			"Hindsight bank runs at localhost:8888, prefix /v1/default; config in .pi/hindsight.json.",
		def: "on",
	},
	{
		key: "code",
		label: "Code map",
		heading: "Code map",
		clause:
			"Code-internal locations: which file/symbol holds what, module responsibilities, signatures.",
		example:
			"The dedup step lives in src/memorize.ts; seenInjectedFacts lives in src/recall-utils.ts.",
		def: "off",
	},
	{
		key: "domain",
		label: "Domain knowledge",
		heading: "Domain knowledge",
		clause: "External / business domain facts, terminology, and references.",
		example:
			"A Hindsight 'harness' is a wrapper integration (claude-code, cursor, …).",
		def: "off",
	},
];

/** Read the raw `factCategories` block from config as a loose record. */
function rawBlock(cfg: HindsightConfig): Record<string, unknown> {
	const b = (cfg as { factCategories?: unknown }).factCategories;
	return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
}

function asState(v: unknown, fallback: CatState): CatState {
	return v === "on" || v === "off" || v === "ban" ? v : fallback;
}

/**
 * Merge the default catalog with the user's config overrides and any custom
 * categories, returning every category with its effective tri-state.
 */
export function resolveCategories(cfg: HindsightConfig): ResolvedCategory[] {
	const block = rawBlock(cfg);
	const out: ResolvedCategory[] = DEFAULT_CATEGORIES.map((d) => ({
		...d,
		state: asState(block[d.key], d.def),
	}));
	const custom = Array.isArray(block.custom)
		? (block.custom as CustomCategory[])
		: [];
	for (const c of custom) {
		if (!c || typeof c.key !== "string" || !c.key.trim()) continue;
		if (out.some((o) => o.key === c.key)) continue; // custom cannot shadow a default
		out.push({
			key: c.key,
			label: c.label || c.key,
			heading: c.heading || c.label || c.key,
			clause: c.clause || "",
			example: c.example || "",
			def: "on",
			custom: true,
			state: asState(c.state, "on"),
		});
	}
	return out;
}

/**
 * Build the two prompt sections the extractor needs:
 *   - `headings`: the enabled categories, each as a heading + guidance + example;
 *   - `bans`: the explicitly-forbidden category headings (empty when none).
 * "off" categories appear in neither — they are simply not steered.
 */
export function extractionSections(cfg: HindsightConfig): {
	headings: string;
	bans: string;
	enabledHeadings: string[];
} {
	const cats = resolveCategories(cfg);
	const on = cats.filter((c) => c.state === "on" && c.clause.trim());
	const ban = cats.filter((c) => c.state === "ban");
	const headings = on
		.map((c) => {
			const ex = c.example.trim() ? `\n  Example: ${c.example.trim()}` : "";
			return `${c.heading}: ${c.clause}${ex}`;
		})
		.join("\n\n");
	const bans = ban.map((c) => c.heading).join("; ");
	return { headings, bans, enabledHeadings: on.map((c) => c.heading) };
}

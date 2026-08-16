/**
 * Prints REAL widget / panel lines for the README screenshots (run with bun).
 *   bun scripts/widget-shots.ts <shot>     one shot, ANSI-coloured, for freeze
 *   bun scripts/widget-shots.ts --list     all shot names
 *
 * Every line comes out of src/ui.ts (and src/mem-panel.ts) driven exactly like
 * the extension drives them — nothing is hand-drawn, so the pictures in
 * README.md are regenerated with `make shots` and can never drift from the code.
 *
 * The `recall-block-*` shots are different: they are plain text, not pictures.
 * They print the REAL output of `recallTrace` (src/index.ts) — the memory block
 * the extension injects into the conversation — and their output is pasted
 * verbatim into the README's fenced examples, which scripts/recall-block.test.ts
 * pins against the formatter.
 */

import { HindsightStatus } from "../src/ui.ts";

// ANSI stand-ins for the theme roles pi's default theme resolves.
const SGR: Record<string, string> = {
	accent: "\x1b[36m",
	warning: "\x1b[33m",
	error: "\x1b[31m",
	muted: "\x1b[37m",
	dim: "\x1b[90m",
	success: "\x1b[32m",
};
const theme = {
	fg: (c: string, s: string) => `${SGR[c] ?? ""}${s}\x1b[39m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
};

let line = "";
const ui = {
	setWidget: (_id: string, content: string[] | undefined) => {
		line = content?.[0] ?? "";
	},
	setStatus: () => {},
	theme,
};

/**
 * The recall block injected into the turn's context, straight from the shipped
 * formatter. Plain text — this is what a person reads in the chat, not a widget
 * line. Loaded lazily so the picture shots never pay for src/index.ts.
 */
async function recallBlock(
	shape: Partial<import("../src/recall.ts").RecallInjectResult>,
): Promise<string[]> {
	const { recallTrace } = await import("../src/index.ts");
	return recallTrace({
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
		...shape,
	}).split("\n");
}

/** A connected widget on the bank the README examples use. */
function fresh(): HindsightStatus {
	const s = new HindsightStatus();
	s.attach(ui);
	s.setBank("pi-hindsight", "http://localhost:8888");
	s.bankOk();
	s.setBankCounts(16, 153);
	return s;
}

const recall = (s: HindsightStatus, found: number, injected: number) =>
	s.recallOutcome({
		op: "recall",
		query: "how do we run the db migrations?",
		found,
		injected,
		queried: true,
		reason: "",
	});

/** The /mem panel's Status tab, rendered offline against a healthy bank. */
async function memStatus(): Promise<string[]> {
	process.env.HOME = "~"; // so the shot shows `~/…` instead of a real home dir
	const { openMemPanel } = await import("../src/mem-panel.ts");
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme();
	let panel!: { render(w: number): string[] };
	const ctx = {
		ui: {
			custom: async (factory: (...a: unknown[]) => unknown) => {
				panel = factory({ requestRender() {} }, theme, {}, () => {}) as never;
			},
		},
	};
	await openMemPanel(ctx as never, {
		cwd: "~/projects/my-app",
		loadCfg: () =>
			({
				bankId: "my-app",
				active: true,
				baseUrl: "http://localhost:8888",
				namespace: "default",
				autoRecall: true,
				autoMemorize: true,
				recallEffort: "normal",
				recallMaxLines: 8,
				recallModelChain: [],
				retainModelChain: [],
				memoryLanguage: "en",
				logPath: ".pi/hindsight/log.jsonl",
			}) as never,
		client: {
			health: async () => ({ status: "ok" }),
			stats: async () => ({ documents: 16, facts: 153 }),
		} as never,
		modelChains: () => ({
			recall: "openai/gpt-5.6-luna",
			retain: "openai/gpt-5.6-luna",
		}),
	});
	await new Promise((r) => setTimeout(r, 10)); // let refreshStatus settle
	return panel.render(72);
}

const shots: Record<string, () => string[] | Promise<string[]>> = {
	"widget-idle": () => {
		fresh();
		return [line];
	},
	"widget-recall-injected": () => {
		recall(fresh(), 12, 3);
		return [line];
	},
	"widget-recall-nothing": () => {
		recall(fresh(), 0, 0);
		return [line];
	},
	"widget-writing": () => {
		const s = fresh();
		s.memoCollecting(3, "compaction");
		s.memoWriting();
		return [line];
	},
	"widget-stored": () => {
		fresh().memoDone(2, 9);
		return [line];
	},
	"widget-write-error": () => {
		fresh().memoError("retain model unavailable");
		return [line];
	},
	"widget-retired": () => {
		const s = fresh();
		s.memoRetired(3);
		s.memoDone(1, 4);
		return [line];
	},
	"widget-user-block": () => {
		const out: string[] = [];
		for (const st of [
			{ injected: true, facts: 4, stale: false },
			{ injected: true, facts: 4, stale: true },
			{ injected: false, blank: true, facts: 0, stale: false },
			{ injected: false, facts: 0, stale: false },
		]) {
			fresh().userBlock(st);
			out.push(line);
		}
		return out;
	},
	"widget-paused": () => {
		const s = fresh();
		s.recallOff();
		s.memoOff();
		return [line];
	},
	session: () => {
		const out: string[] = [];
		const cap = (t: string) => out.push(`\x1b[90m${t}\x1b[39m`);
		const s = new HindsightStatus();
		s.attach(ui);
		s.setBank("pi-hindsight", "http://localhost:8888");
		cap("── session start: the widget appears, the bank answers ──");
		s.bankChecking();
		out.push(line);
		s.bankOk();
		s.setBankCounts(16, 153);
		out.push(line);
		cap("── you ask a question: recall finds 12 facts, injects 3 ──");
		recall(s, 12, 3);
		out.push(line);
		cap("── the context compacts: memorize writes in the background ──");
		s.memoCollecting(3, "compaction");
		s.memoWriting();
		out.push(line);
		s.memoDone(2, 9);
		s.setBankCounts(18, 162);
		out.push(line);
		return out;
	},
	"mem-status": memStatus,
	"recall-block-hit": () =>
		recallBlock({
			query: "how do we run the db migrations?",
			found: 12,
			injected: 2,
			reason: "bank recalled facts",
			text: [
				"- Migrations run with `make db-migrate`; the app container must be up first.",
				"- Never edit an applied migration — add a new one instead (decision, 2026-03).",
			].join("\n"),
		}),
	"recall-block-miss": () =>
		recallBlock({
			query: "what colour should the new settings button be?",
			found: 5,
			injected: 0,
			reason: "recalled facts judged irrelevant",
		}),
	"recall-block-deep": () =>
		recallBlock({
			query: "publish a new release of the plugin",
			found: 9,
			injected: 6,
			synthesized: true,
			reason: "bank recalled facts",
			text: [
				"Releases go through `make check` and `npm publish` from a clean tree; the",
				"version in package.json is the only source of the version and the tag follows it.",
			].join("\n"),
		}),
};

const name = process.argv[2] ?? "";
if (name === "--list") {
	console.log(Object.keys(shots).join("\n"));
	process.exit(0);
}
const shot = shots[name];
if (!shot) {
	console.error(`unknown shot "${name}"; try --list`);
	process.exit(1);
}
console.log((await shot()).join("\n"));

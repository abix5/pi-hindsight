/**
 * Self-test for the /mem panel's navigation model (run with bun or node).
 *   bun scripts/mem-panel.test.ts
 *
 * The panel is a two-level focus surface: the tab strip owns ←/→/Tab and Esc,
 * the active tab's content owns ↑/↓/Enter. This test pins the invariant that
 * broke once already — Tab must ALWAYS cycle tabs, even while a list child has
 * focus, so the panel can never trap the user on one tab.
 */

import { initTheme } from "@earendil-works/pi-coding-agent";
import type { HindsightConfig } from "../src/config.ts";
import type { HindsightClient } from "../src/hindsight.ts";
import { openMemPanel } from "../src/mem-panel.ts";

initTheme(); // SettingsList's theme helper reads the global theme.
// The panel only needs `fg`/`bold` from the theme it is handed; a plain stub
// keeps the rendered lines free of ANSI so the assertions stay readable.
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

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

const cfg = {
	bankId: "test",
	active: true,
	baseUrl: "http://localhost:1",
	namespace: "default",
	autoRecall: true,
	autoMemorize: true,
	recallEffort: "normal",
	recallOperation: "recall",
	recallFilter: "model",
	recallMaxLines: 8,
	recallModelChain: [],
	retainModelChain: [],
	memoryLanguage: "en",
	logPath: ".pi/hindsight/log.jsonl",
} as unknown as HindsightConfig;

// A client that never answers: the panel must render regardless of bank health.
const client = {
	health: () => Promise.reject(new Error("offline")),
	stats: () => Promise.reject(new Error("offline")),
} as unknown as HindsightClient;

let panel!: { render(w: number): string[]; handleInput(d: string): void };
let closed = false;
const ctx = {
	ui: {
		custom: async (factory: (...a: unknown[]) => unknown) => {
			panel = factory({ requestRender() {} }, theme, {}, () => {
				closed = true;
			}) as typeof panel;
		},
	},
};

await openMemPanel(ctx as never, {
	cwd: "/tmp",
	loadCfg: () => cfg,
	client,
	modelChains: () => ({ recall: "a/b", retain: "a/b" }),
});

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** The tab currently marked active in the rendered tab strip. */
function activeTab(): string {
	const header = strip(panel.render(100)[1] ?? "");
	return /\[(\w+)]/.exec(header)?.[1] ?? "(none)";
}
/** True when the rendered content shows the settings-list cursor. */
function inSettingsList(): boolean {
	return panel.render(100).some((l) => strip(l).trimStart().startsWith("→"));
}

check("opens on Status", activeTab(), "Status");

panel.handleInput("\t");
check("Tab moves to Settings", activeTab(), "Settings");
panel.handleInput("\t");
panel.handleInput("\t");
check("Tab keeps cycling past Review to Log", activeTab(), "Log");
panel.handleInput("\t");
check("Tab wraps around to Status", activeTab(), "Status");
panel.handleInput("\x1b[Z");
check("Shift+Tab goes back to Log", activeTab(), "Log");
panel.handleInput("\x1b[D");
check("Left arrow steps back to Review", activeTab(), "Review");

// The regression: entering a list must not swallow the tab keys.
panel.handleInput("\x1b[D"); // -> Settings
panel.handleInput("\r"); // descend into the settings list
check("Enter descends into the settings list", inSettingsList(), true);
panel.handleInput("\t");
check("Tab from INSIDE the list still switches tab", activeTab(), "Review");

panel.handleInput("\x1b[D"); // back to Settings (focus reset to tabs)
panel.handleInput("\r");
panel.handleInput("\x1b");
check("Esc leaves the list without closing the panel", closed, false);
check("…and the tab is unchanged", activeTab(), "Settings");
panel.handleInput("\x1b");
check("Esc on the tab strip closes the panel", closed, true);

// Height guard: the panel renders INLINE, so everything it returns is appended
// to the live buffer. It must claim a CONSTANT number of rows — overflowing the
// viewport pushed the chat transcript into scrollback, and a height that varied
// with the content made the panel jump on every keystroke.
function openAt(
	rows: number,
	columns: number,
): { render(w: number): string[]; handleInput(d: string): void } {
	let made!: { render(w: number): string[]; handleInput(d: string): void };
	const c = {
		ui: {
			custom: async (factory: (...a: unknown[]) => unknown) => {
				made = factory(
					{ requestRender() {}, terminal: { rows, columns } },
					theme,
					{},
					() => {},
				) as typeof made;
			},
		},
	};
	void openMemPanel(c as never, {
		cwd: "/tmp",
		loadCfg: () => cfg,
		client,
		modelChains: () => ({ recall: "a/b", retain: "a/b" }),
	});
	return made;
}

for (const [rows, columns] of [
	[24, 100],
	[40, 100],
	[40, 60], // narrow: setting descriptions wrap onto extra lines
] as const) {
	const p = openAt(rows, columns);
	const heights = new Set<number>();
	for (let tab = 0; tab < 4; tab += 1) {
		heights.add(p.render(columns).length);
		p.handleInput("\t");
	}
	// Walk the whole settings list — the view whose content varies the most.
	p.handleInput("\t");
	p.handleInput("\r");
	for (let i = 0; i < 22; i += 1) {
		heights.add(p.render(columns).length);
		p.handleInput("\x1b[B");
	}
	const height = [...heights][0];
	check(`${rows}x${columns}: height never changes`, [...heights], [height]);
	check(`${rows}x${columns}: height fits the terminal`, height <= rows, true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

/**
 * The /mem dashboard, rendered inline in the TUI (no HTTP server, no browser).
 *
 * Four tabs, switched with ←/→ or Tab:
 *   Status   — bank health, counts, resolved config, model chains;
 *   Settings — every switch (bank id, auto-recall/memorize, effort, models,
 *              language, fact categories), written to the global or project
 *              override file;
 *   Review   — the global review queue: approve / edit / delete stored documents;
 *   Log      — recent recall/retain operations from the JSONL log.
 *
 * Settings is the ONLY way to declare a bank id, so this panel must work even
 * when the plugin is inactive (`cfg.active === false`).
 *
 * Text edits (model ids, bank id, a document's body) are handled by INLINE
 * sub-components rather than nested `ctx.ui.*` dialogs, which would replace this
 * component and fight over input focus. The panel bounds its own height (see
 * `viewportRows`) because everything it renders is appended to the live buffer.
 */

import type {
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	Input,
	matchesKey,
	type SettingItem,
	SettingsList,
} from "@earendil-works/pi-tui";
import { resolveCategories } from "./categories.ts";
import {
	type HindsightConfig,
	globalConfigPath,
	patchConfigFile,
	projectConfigPath,
	readProjectOverrides,
} from "./config.ts";
import type { HindsightClient } from "./hindsight.ts";
import { type HindsightLogEntry, appendLog, readLog } from "./log.ts";
import {
	type ReviewDoc,
	approveDoc,
	deleteDoc,
	editDoc,
	loadReviewDocs,
} from "./review-docs.ts";

const TABS = ["Status", "Settings", "Review", "Log"] as const;
type Tab = (typeof TABS)[number];

export interface PanelDeps {
	cwd: string;
	/** Re-read the resolved config so edits show up immediately. */
	loadCfg: () => HindsightConfig;
	/** Client bound to the active bank, for health/stats. */
	client: HindsightClient;
	/** Model chain labels for the Status tab. */
	modelChains: () => { recall: string; retain: string };
	/**
	 * The current session's model registry, offered as input assistance on the two
	 * model rows. OPTIONAL on purpose: the panel writes GLOBAL config while the
	 * registry belongs to THIS session, so an id this session cannot resolve is
	 * still a legal value — and a caller with no registry at all (tests, shots)
	 * must still get a working panel, degraded to plain text entry.
	 */
	models?: {
		/** Selectable ids, each as `provider/id`. */
		options: () => string[];
		/** Whether this session's registry can resolve the id. */
		resolves: (id: string) => boolean;
	};
}

/**
 * Emitted AFTER the panel closes, on the warning channel. It has to be a warning:
 * pi routes an "info" notice to a chat node that the next notice overwrites in
 * place, so the one message that must survive the rest of the turn cannot be one.
 *
 * Every clause is backed by the code: the file was patched (`patchConfigFile`
 * returned ok), this process still runs what `init()` read at the last
 * `session_start` (src/index.ts), and `/reload` re-runs `session_start` — which
 * disposes this instance and calls `init()` again, re-reading every key the panel
 * can write. Nothing here promises a restart, because none is needed.
 */
export const RELOAD_WARNING =
	"\uD83E\uDDE0 Memory settings saved. This session is still running the config it loaded at startup — run /reload to apply them.";

/** Marker appended to a model id the session's registry cannot resolve. */
const UNKNOWN_MODEL = "(unknown)";

/** Keys edited through a text prompt rather than a value cycle. */
const TEXT_KEYS = new Set([
	"bankId",
	"recallModelId",
	"retainModelId",
	"recallModelChain",
	"retainModelChain",
	"memoryLanguage",
]);

/** Settings written to the project layer; everything else is a global preference. */
const PROJECT_KEYS = new Set(["bankId"]);

function clip(s: string, w: number): string {
	return s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s;
}

function oneLine(s: string | undefined, max: number): string {
	return s ? clip(s.replace(/\s+/g, " ").trim(), max) : "";
}

function time(ts: string): string {
	const d = new Date(ts);
	return Number.isNaN(d.getTime())
		? ts
		: d.toLocaleString([], {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			});
}

function logRow(e: HindsightLogEntry, w: number): string {
	if (e.type === "retain")
		return `↗ ${time(e.ts)} retain  ${e.documents ?? 0} doc · ${e.lines ?? 0} lines  ${oneLine(e.reason, w)}`;
	if (e.type === "reflect")
		return `↙ ${time(e.ts)} reflect ${oneLine(e.query, w)}`;
	if (e.type === "recall")
		return `↙ ${time(e.ts)} recall  ${e.injected ?? 0}/${e.found ?? 0}  ${oneLine(e.query, w)}`;
	if (e.type === "invalidate") return retireRow(e, w);
	if (e.type === "restore") return restoreRow(e, w);
	return `! ${time(e.ts)} ${e.stage ?? "error"} ${oneLine(e.message, w)}`;
}

/**
 * A kill is the only log entry that DESTROYS knowledge, so it gets its own row
 * shape instead of falling through to the error line.
 */
function retireRow(e: HindsightLogEntry, w: number): string {
	const n = e.kills?.length ?? 0;
	return `\u2193 ${time(e.ts)} retire  ${n} fact${n === 1 ? "" : "s"}  ${oneLine(e.kills?.[0]?.text, w)}`;
}

/**
 * The undo of a kill, drawn as its mirror image — same shape, arrow pointing back
 * up — so a retire and its restore read as one movement when they sit next to
 * each other in the list.
 */
function restoreRow(e: HindsightLogEntry, w: number): string {
	const n = e.kills?.length ?? 0;
	return `\u2191 ${time(e.ts)} restore ${n} fact${n === 1 ? "" : "s"}  ${oneLine(e.kills?.[0]?.text, w)}`;
}

function logDetail(e: HindsightLogEntry): string[] {
	const out: string[] = [logRow(e, 200), ""];
	if (e.user) out.push("User:", e.user, "");
	if (e.query) out.push("Bank query:", e.query, "");
	if (e.reason) out.push(`Reason: ${e.reason}`, "");
	if (e.injectedText) out.push("Injected / answer:", e.injectedText, "");
	if (e.documentText) out.push("Document sent to bank:", e.documentText, "");
	if (e.rawHits?.length)
		out.push("Raw hits:", ...e.rawHits.map((h, i) => `${i + 1}. ${h}`));
	// Both halves matter: the fact that died, and the quote that condemned it.
	// Showing only one leaves a kill unjudgeable after the fact.
	if (e.kills?.length)
		for (const k of e.kills)
			out.push(
				`${e.type === "restore" ? "Restored" : "Retired"} ${k.id}:`,
				k.text || "(text unavailable)",
				`Evidence: "${k.quote}"`,
				"",
			);
	return out;
}

/** The current text value behind a text-edited setting id. */
function textValue(deps: PanelDeps, id: string): string {
	const cfg = deps.loadCfg();
	switch (id) {
		case "bankId":
			return String(readProjectOverrides(deps.cwd).bankId ?? "");
		case "recallModelChain":
			return cfg.recallModelChain.join(", ");
		case "retainModelChain":
			return cfg.retainModelChain.join(", ");
		case "memoryLanguage":
			return cfg.memoryLanguage;
		case "recallModelId":
			return cfg.recallModelId ?? "";
		default:
			return cfg.retainModelId ?? "";
	}
}

/**
 * How a model id is shown. The marker is recomputed on every render instead of
 * being stored, so it survives a rebuild of the list (`r`) and disappears by
 * itself once the id resolves.
 */
function modelDisplay(deps: PanelDeps, id: string): string {
	const value = textValue(deps, id);
	if (!value) return "(inherited)";
	return deps.models && !deps.models.resolves(value)
		? `${value}  ${UNKNOWN_MODEL}`
		: value;
}

/** The submenu factories the Settings items are built from. */
interface Submenus {
	/** Free-text edit of one key. */
	text: (id: string) => SettingItem["submenu"];
	/** Text edit with the session's models offered as a list. */
	model: (id: string) => SettingItem["submenu"];
	/** A nested list of related settings, collapsed behind one row. */
	group: (
		build: () => SettingItem[],
		summary: () => string,
	) => SettingItem["submenu"];
}

function textItem(
	deps: PanelDeps,
	mk: Submenus,
	id: string,
	label: string,
	description: string,
): SettingItem {
	return {
		id,
		label,
		currentValue: textValue(deps, id) || "(inherited)",
		description: `${description} Enter to edit.`,
		submenu: mk.text(id),
	};
}

/** Recall tuning: the three knobs that shape ONE recall. */
function tuningItems(cfg: HindsightConfig): SettingItem[] {
	return [
		{
			id: "recallEffort",
			label: "Recall effort",
			currentValue: cfg.recallEffort,
			values: ["light", "normal", "thorough"],
			description:
				"Ceiling on how many separate bank queries one recall may build: light = 2, normal = 3, thorough = 5. The model still uses as few as the request needs.",
		},
		{
			id: "recallFilter",
			label: "Recall filter",
			currentValue: cfg.recallFilter,
			values: ["model", "off"],
			description:
				"model = each query's hits are scored by a small model and irrelevant ones dropped (a junk query is discarded whole); off = inject the top candidates as-is.",
		},
		{
			id: "recallMaxLines",
			label: "Max injected facts",
			currentValue: String(cfg.recallMaxLines),
			values: ["4", "6", "8", "12", "16"],
			description: "Upper bound on facts injected into one turn.",
		},
	];
}

function tuningSummary(cfg: HindsightConfig): string {
	return `${cfg.recallEffort} · filter ${cfg.recallFilter} · max ${cfg.recallMaxLines}`;
}

function chainItems(deps: PanelDeps, mk: Submenus): SettingItem[] {
	return [
		textItem(
			deps,
			mk,
			"recallModelChain",
			"Recall fallbacks",
			"Comma-separated models tried when the recall model fails; the session model is always the last resort.",
		),
		textItem(
			deps,
			mk,
			"retainModelChain",
			"Retain fallbacks",
			"Comma-separated models tried when the retain model fails; the session model is always the last resort.",
		),
	];
}

function chainSummary(cfg: HindsightConfig): string {
	const r = cfg.recallModelChain.length;
	const t = cfg.retainModelChain.length;
	return r + t === 0 ? "(none)" : `${r} recall · ${t} retain`;
}

type Category = ReturnType<typeof resolveCategories>[number];

function categoryItems(cats: Category[]): SettingItem[] {
	return cats.map((c) => ({
		id: `cat:${c.key}`,
		label: c.label,
		currentValue: c.state,
		values: ["on", "off", "ban"],
		description: c.clause,
	}));
}

function categorySummary(cats: Category[]): string {
	const n = (state: string) => cats.filter((c) => c.state === state).length;
	const banned = n("ban");
	return `${n("on")} on · ${n("off")} off${banned ? ` · ${banned} ban` : ""}`;
}

/**
 * Build the Settings tab's items. Each item writes ONE key to ONE layer: the
 * bank id is project-scoped (it activates the plugin HERE), everything else is
 * global so the preference follows the user across projects.
 *
 * Related keys are collapsed into nested lists so the top level stays a fixed
 * nine rows: the fact categories alone are eight rows that GROW with the
 * project's own catalog, which is what made this tab a scrolling wall. Each
 * group row carries a summary of what is behind it, so nothing is hidden — only
 * moved one Enter away.
 */
function settingItems(deps: PanelDeps, mk: Submenus): SettingItem[] {
	const cfg = deps.loadCfg();
	const project = readProjectOverrides(deps.cwd);
	const cats = resolveCategories(cfg);

	return [
		{
			...textItem(
				deps,
				mk,
				"bankId",
				"Bank id (project)",
				cfg.active
					? `Active — this project's memory goes to bank "${cfg.bankId}".`
					: 'Inactive: no bank declared here. Set a name (or "auto") to activate memory in this project.',
			),
			currentValue: project.bankId ? String(project.bankId) : "(none)",
		},
		{
			id: "autoRecall",
			label: "Auto recall",
			currentValue: cfg.autoRecall ? "on" : "off",
			values: ["on", "off"],
			description:
				"Query the bank before every turn and inject relevant facts. Off = memory is read only via /mem-recall and the hindsight_recall tool.",
		},
		{
			id: "autoMemorize",
			label: "Auto memorize",
			currentValue: cfg.autoMemorize ? "on" : "off",
			values: ["on", "off"],
			description:
				"Write the session to memory on compaction and shutdown. Off = only /mem-save writes.",
		},
		{
			id: "group:recallTuning",
			label: "Recall tuning",
			currentValue: tuningSummary(cfg),
			description:
				"Effort, hit filtering and the cap on injected facts. Enter to open.",
			submenu: mk.group(
				() => tuningItems(deps.loadCfg()),
				() => tuningSummary(deps.loadCfg()),
			),
		},
		{
			...textItem(
				deps,
				mk,
				"recallModelId",
				"Recall model",
				"Model that rewrites your message into bank queries and judges the hits.",
			),
			currentValue: modelDisplay(deps, "recallModelId"),
			submenu: mk.model("recallModelId"),
		},
		{
			...textItem(
				deps,
				mk,
				"retainModelId",
				"Retain model",
				"Model that distils the transcript into stored notes.",
			),
			currentValue: modelDisplay(deps, "retainModelId"),
			submenu: mk.model("retainModelId"),
		},
		{
			id: "group:modelChains",
			label: "Model fallbacks",
			currentValue: chainSummary(cfg),
			description:
				"Models tried when the recall/retain model fails. Enter to open.",
			submenu: mk.group(
				() => chainItems(deps, mk),
				() => chainSummary(deps.loadCfg()),
			),
		},
		textItem(
			deps,
			mk,
			"memoryLanguage",
			"Memory language",
			"Language every stored memory is written in.",
		),
		{
			id: "group:factCategories",
			label: "Fact categories",
			currentValue: categorySummary(cats),
			description:
				"What may be remembered, per category: on, off, or banned. Enter to open.",
			submenu: mk.group(
				() => categoryItems(resolveCategories(deps.loadCfg())),
				() => categorySummary(resolveCategories(deps.loadCfg())),
			),
		},
	];
}

class MemPanel implements Component {
	private tab: Tab = "Status";
	/**
	 * Which level owns ↑/↓/Enter: the tab strip, or the active tab's content.
	 * ←/→/Tab always belong to the panel, so a list child can never trap the user.
	 */
	private focus: "tabs" | "content" = "tabs";
	private readonly border = new DynamicBorder((s) =>
		this.theme.fg("borderAccent", s),
	);
	private health: boolean | undefined;
	private counts: { documents: number; facts: number } | undefined;
	private docs: ReviewDoc[] = [];
	private docIndex = 0;
	private docScroll = 0;
	private log: HindsightLogEntry[] = [];
	private logIndex = 0;
	private showLogDetail = false;
	/** Sticky one-line message under the tab bar (last action / error). */
	private message = "";
	/** Set after a settings write: the change applies on the next /reload. */
	private needsReload = false;
	private settings: SettingsList;
	/** Inline sub-component (text edit / confirm) that owns the input while set. */
	private modalChild: Component | undefined;

	constructor(
		private readonly deps: PanelDeps,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (wrote: boolean) => void,
	) {
		this.settings = this.buildSettings();
		void this.refreshStatus();
	}

	/**
	 * Close the panel, reporting whether anything was written. The caller (not the
	 * panel) raises the reload warning, which is what puts it AFTER the panel is
	 * gone instead of in a row nobody reads.
	 */
	private close(): void {
		this.done(this.needsReload);
	}

	private rerender(): void {
		this.tui.requestRender();
	}

	private buildSettings(): SettingsList {
		return new SettingsList(
			settingItems(this.deps, {
				text: (id) => this.textSubmenu(id),
				model: (id) => this.modelSubmenu(id),
				group: (build, summary) => this.groupSubmenu(build, summary),
			}),
			// Beyond the rows themselves SettingsList draws a scroll indicator, a blank
			// line, the selected item's description and a hint line — 5 rows of its own
			// chrome. Reserve exactly that so the list fills the fixed body without
			// overflowing it.
			this.listRows(),
			getSettingsListTheme(),
			(id, value) => this.onSettingChange(id, value),
			() => this.close(),
		);
	}

	private listRows(): number {
		return Math.max(4, this.bodyRows() - 5);
	}

	/**
	 * Track how deep the Settings list is nested, because the panel intercepts Esc
	 * before SettingsList ever sees it. Without this, Esc inside a submenu would
	 * jump out to the tab strip and leave the submenu open underneath, rendering
	 * over the tab the user thinks they returned to.
	 */
	private submenuDepth = 0;

	private enter(close: (value?: string) => void): (value?: string) => void {
		this.submenuDepth += 1;
		return (value) => {
			this.submenuDepth = Math.max(0, this.submenuDepth - 1);
			close(value);
		};
	}

	/**
	 * A SettingsList submenu for a free-text key: the list renders and feeds input
	 * to whatever component we return, and closes it when `close()` is called.
	 */
	private textSubmenu(id: string): SettingItem["submenu"] {
		return (_current, close) => {
			const done = this.enter(close);
			return new ExtensionInputComponent(
				`Memory · ${id}`,
				undefined,
				(value) => {
					this.commitText(id, value);
					done(this.displayValue(id));
				},
				() => done(undefined),
				{ tui: this.tui },
			);
		};
	}

	/**
	 * The model rows: the same free-text commit, with this session's registered
	 * models offered as a list. Without a registry there is nothing to offer, so
	 * the row degrades to the plain text prompt rather than showing an empty list.
	 */
	private modelSubmenu(id: string): SettingItem["submenu"] {
		const models = this.deps.models;
		if (!models) return this.textSubmenu(id);
		return (_current, close) => {
			const done = this.enter(close);
			return new ModelPickerChild(
				this.theme,
				`Memory · ${id}`,
				models.options(),
				this.listRows(),
				(value) => {
					this.commitText(id, value);
					done(this.displayValue(id));
				},
				() => done(undefined),
			);
		};
	}

	/**
	 * A group of related settings as a nested list. The children write their own
	 * config directly; closing the group only refreshes the summary shown on the
	 * parent row.
	 */
	private groupSubmenu(
		build: () => SettingItem[],
		summary: () => string,
	): SettingItem["submenu"] {
		return (_current, close) => {
			const done = this.enter(close);
			return new SettingsList(
				build(),
				this.listRows(),
				getSettingsListTheme(),
				(id, value) => this.onSettingChange(id, value),
				() => done(summary()),
			);
		};
	}

	/** What the Settings row should show after a text edit. */
	private displayValue(id: string): string {
		if (id === "bankId")
			return (
				String(readProjectOverrides(this.deps.cwd).bankId ?? "") || "(none)"
			);
		if (id === "recallModelId" || id === "retainModelId")
			return modelDisplay(this.deps, id);
		return textValue(this.deps, id) || "(inherited)";
	}

	/** Persist a free-text setting, splitting the chain keys into lists. */
	private commitText(id: string, raw: string): void {
		const value = raw.trim();
		const scope = PROJECT_KEYS.has(id) ? "project" : "global";
		if (id === "recallModelChain" || id === "retainModelChain") {
			const list = value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			this.write({ [id]: list }, scope);
			return;
		}
		// An empty bank id means "deactivate here", so it is written as-is rather
		// than skipped — the key must actually change in the file.
		const ok = this.write({ [id]: value }, scope);
		// A model id this session cannot resolve is still WRITTEN — the config is
		// global and the id may well exist on another machine — but it must not be
		// swallowed: the resolver would silently fall through to the chain, which is
		// exactly how a typo used to disappear without a trace.
		if (
			ok &&
			value &&
			(id === "recallModelId" || id === "retainModelId") &&
			this.deps.models &&
			!this.deps.models.resolves(value)
		) {
			this.message = `"${value}" is not in this session's model registry — saved anyway`;
			this.rerender();
		}
	}

	private onSettingChange(id: string, value: string): void {
		if (TEXT_KEYS.has(id)) return; // handled by the submenu's own commit
		// A group row carries a summary, not a value: its children already wrote
		// their own keys. Writing this id would put a display string like
		// "normal · filter model · max 8" into the config under a key nothing reads.
		if (id.startsWith("group:")) return;
		// Fact categories live inside one nested `factCategories` object, so they are
		// merged into the current block instead of written as a top-level key.
		if (id.startsWith("cat:")) {
			const cfg = this.deps.loadCfg();
			const block = { ...(cfg.factCategories ?? {}), [id.slice(4)]: value };
			this.write({ factCategories: block }, "project");
			return;
		}
		const patch: Record<string, unknown> =
			id === "autoRecall" || id === "autoMemorize"
				? { [id]: value === "on" }
				: id === "recallMaxLines"
					? { [id]: Number.parseInt(value, 10) }
					: { [id]: value };
		this.write(patch, "global");
	}

	/** Persist one patch and surface the outcome in the message line. */
	private write(
		patch: Record<string, unknown>,
		scope: "project" | "global",
	): boolean {
		const ok = patchConfigFile(this.deps.cwd, patch, scope);
		this.message = ok
			? `saved to ${scope} config`
			: `could not write the ${scope} config file`;
		this.needsReload = this.needsReload || ok;
		this.rerender();
		return ok;
	}

	private async refreshStatus(): Promise<void> {
		try {
			await this.deps.client.health();
			this.health = true;
		} catch {
			this.health = false;
		}
		try {
			this.counts = await this.deps.client.stats();
		} catch {
			this.counts = undefined;
		}
		this.rerender();
	}

	private async refreshDocs(): Promise<void> {
		this.message = "loading review queue…";
		this.rerender();
		this.docs = await loadReviewDocs();
		this.docIndex = Math.min(this.docIndex, Math.max(0, this.docs.length - 1));
		this.docScroll = 0;
		this.message = `${this.docs.length} document(s) pending review`;
		this.rerender();
	}

	private refreshLog(): void {
		this.log = readLog(this.deps.cwd, this.deps.loadCfg().logPath, 200);
		this.logIndex = 0;
		this.showLogDetail = false;
	}

	/**
	 * Undo the kill the selected row records, for every fact in it at once.
	 *
	 * Row granularity, not per-fact: one log entry is one decision the write path
	 * made about one delta, so the unit a user judges is the entry. Offering a
	 * sub-selection would ask them to re-litigate a verdict they can already read in
	 * the detail view.
	 *
	 * The undo is APPENDED, never subtracted — the original kill entry stays exactly
	 * as written, because the point of that log is to show what the mechanism did,
	 * including the parts that were reversed.
	 */
	private async restoreSelected(): Promise<void> {
		const entry = this.log[this.logIndex];
		const kills = entry?.type === "invalidate" ? entry.kills : undefined;
		if (!kills?.length) return;

		const restored: NonNullable<HindsightLogEntry["kills"]> = [];
		let failure = "";
		for (const k of kills) {
			try {
				await this.deps.client.restore(k.id);
				restored.push(k);
			} catch (err) {
				// Stop at the first refusal: the bank is not answering, so the remaining
				// ids would fail the same way. What did come back is still logged.
				failure = (err as Error).message;
				break;
			}
		}
		if (restored.length)
			appendLog(this.deps.cwd, this.deps.loadCfg().logPath, {
				type: "restore",
				kills: restored,
			});
		this.message = failure
			? `restored ${restored.length}/${kills.length} — ${failure}`
			: `restored ${restored.length} fact${restored.length === 1 ? "" : "s"}`;
		this.refreshLog();
		this.rerender();
	}

	private currentDoc(): ReviewDoc | undefined {
		return this.docs[this.docIndex];
	}

	/** Drop the actioned document from the local list and keep the cursor sane. */
	private dropCurrentDoc(): void {
		this.docs.splice(this.docIndex, 1);
		this.docIndex = Math.min(this.docIndex, Math.max(0, this.docs.length - 1));
		this.docScroll = 0;
	}

	private approve(): void {
		const doc = this.currentDoc();
		if (!doc) return;
		approveDoc(doc);
		this.dropCurrentDoc();
		this.message = "approved — kept in the bank, removed from the queue";
		this.rerender();
	}

	/** Delete needs a confirmation, so it opens an inline yes/no child. */
	private confirmDelete(): void {
		const doc = this.currentDoc();
		if (!doc) return;
		this.modalChild = new ConfirmChild(
			`Delete document ${doc.docId.slice(0, 12)}… and its facts from bank "${doc.bank}"?`,
			(ok) => {
				this.modalChild = undefined;
				if (ok) void this.performDelete(doc);
				else this.rerender();
			},
		);
		this.rerender();
	}

	private async performDelete(doc: ReviewDoc): Promise<void> {
		try {
			await deleteDoc(doc);
			this.dropCurrentDoc();
			this.message = "deleted from the bank";
		} catch (err) {
			this.message = `delete failed: ${(err as Error).message}`;
		}
		this.rerender();
	}

	/** A stored note is multi-line prose, so editing uses the full editor child. */
	private editDocument(): void {
		const doc = this.currentDoc();
		if (!doc || doc.unreachable) return;
		this.modalChild = new ExtensionEditorComponent(
			this.tui,
			this.keybindings,
			"Edit memory document (Enter save · Esc cancel)",
			doc.text,
			(value) => {
				this.modalChild = undefined;
				if (value.trim()) void this.performEdit(doc, value);
				else this.rerender();
			},
			() => {
				this.modalChild = undefined;
				this.rerender();
			},
		);
		this.rerender();
	}

	private async performEdit(doc: ReviewDoc, text: string): Promise<void> {
		try {
			// A queue entry can belong to ANOTHER project, and the bank's language is
			// a per-project setting: re-extracting a foreign bank's document in THIS
			// project's language would silently rewrite it. The language recorded on
			// the entry at enqueue time wins; this project's is only the last resort.
			await editDoc(
				doc,
				text,
				doc.language || this.deps.loadCfg().memoryLanguage,
			);
			doc.text = text;
			this.message = "saved — the bank is re-extracting the facts";
		} catch (err) {
			this.message = `save failed: ${(err as Error).message}`;
		}
		this.rerender();
	}

	private switchTab(delta: number): void {
		const i = TABS.indexOf(this.tab);
		this.tab = TABS[(i + delta + TABS.length) % TABS.length];
		this.message = "";
		// Switching tabs always returns focus to the tab bar, so ↑/↓ never silently
		// drives a list the user cannot see they are inside of.
		this.focus = "tabs";
		if (this.tab === "Review" && this.docs.length === 0)
			void this.refreshDocs();
		if (this.tab === "Log") this.refreshLog();
		if (this.tab === "Status") void this.refreshStatus();
		this.rerender();
	}

	/**
	 * Two-level focus. The tab bar owns ←/→/Tab and Esc; Enter descends INTO the
	 * tab's content, Esc climbs back out. Without this split, a list child (which
	 * legitimately wants ↑/↓, Enter and Tab) would swallow the tab keys and the
	 * panel would get stuck on one tab.
	 */
	handleInput(data: string): void {
		// An inline child (text edit / confirm) owns input until it closes itself.
		if (this.modalChild) {
			this.modalChild.handleInput?.(data);
			this.rerender();
			return;
		}
		// Tab keys work from BOTH levels, so the panel can never trap the user.
		if (matchesKey(data, "right") || matchesKey(data, "tab"))
			return this.switchTab(1);
		if (matchesKey(data, "left") || matchesKey(data, "shift+tab"))
			return this.switchTab(-1);

		if (this.focus === "tabs") {
			if (matchesKey(data, "escape") || data === "q") return this.close();
			if (
				matchesKey(data, "enter") ||
				matchesKey(data, "down") ||
				matchesKey(data, "up")
			) {
				this.focus = "content";
				// Fall through so the first ↑/↓ also moves the cursor instead of being
				// spent purely on entering the content.
				if (matchesKey(data, "enter")) return this.rerender();
			} else if (data === "r") {
				return this.refreshCurrentTab();
			} else {
				return;
			}
		}

		// --- content level ---
		if (matchesKey(data, "escape")) {
			// An open Settings submenu owns Esc: leaving the tab while it is open would
			// hide the tab behind a child that keeps rendering over it.
			if (this.tab === "Settings" && this.submenuDepth > 0) {
				this.settings.handleInput(data);
				return this.rerender();
			}
			this.focus = "tabs";
			this.showLogDetail = false;
			return this.rerender();
		}
		if (this.tab === "Settings") {
			// SettingsList's own cancel would close the whole panel, so Esc is handled
			// above and never reaches it.
			this.settings.handleInput(data);
			return this.rerender();
		}
		if (this.tab === "Review") return this.reviewInput(data);
		if (this.tab === "Log") return this.logInput(data);
		if (data === "r") void this.refreshStatus();
	}

	/** `r` reloads whatever the active tab shows. */
	private refreshCurrentTab(): void {
		if (this.tab === "Review") return void this.refreshDocs();
		if (this.tab === "Log") {
			this.refreshLog();
			return this.rerender();
		}
		if (this.tab === "Status") return void this.refreshStatus();
		this.settings = this.buildSettings();
		this.rerender();
	}

	private reviewInput(data: string): void {
		if (data === "r") return void this.refreshDocs();
		if (data === "a") return this.approve();
		if (data === "e") return this.editDocument();
		if (data === "d") return this.confirmDelete();
		if (matchesKey(data, "up")) {
			this.docIndex = Math.max(0, this.docIndex - 1);
			this.docScroll = 0;
		} else if (matchesKey(data, "down")) {
			this.docIndex = Math.min(
				Math.max(0, this.docs.length - 1),
				this.docIndex + 1,
			);
			this.docScroll = 0;
		} else if (matchesKey(data, "pageDown")) this.docScroll += 10;
		else if (matchesKey(data, "pageUp"))
			this.docScroll = Math.max(0, this.docScroll - 10);
		this.rerender();
	}

	private logInput(data: string): void {
		if (data === "r") this.refreshLog();
		else if (data === "u") void this.restoreSelected();
		else if (matchesKey(data, "enter"))
			this.showLogDetail = !this.showLogDetail;
		else if (matchesKey(data, "up"))
			this.logIndex = Math.max(0, this.logIndex - 1);
		else if (matchesKey(data, "down"))
			this.logIndex = Math.min(
				Math.max(0, this.log.length - 1),
				this.logIndex + 1,
			);
		this.rerender();
	}

	invalidate(): void {
		this.settings.invalidate();
		this.modalChild?.invalidate?.();
	}

	render(width: number): string[] {
		// Inline rendering: everything this returns is appended to the live buffer,
		// so the panel MUST claim the same number of rows on every frame. A body that
		// grows and shrinks with its content (a settings description wrapping onto a
		// second line, a shorter log page) makes the whole panel jump on screen, so
		// the body is both clipped AND padded to exactly `bodyRows`.
		const w = Math.max(40, width - 2);
		const accent = (s: string) => this.theme.fg("accent", s);
		const budget = this.bodyRows();
		const body: string[] = [];

		if (this.modalChild) {
			body.push(...this.modalChild.render(w));
		} else {
			if (this.message)
				body.push(this.theme.fg("muted", clip(this.message, w)), "");
			if (this.tab === "Status") body.push(...this.renderStatus(w));
			else if (this.tab === "Settings") body.push(...this.settings.render(w));
			else if (this.tab === "Review") body.push(...this.renderReview(w));
			else body.push(...this.renderLog(w));
		}

		const view = body.slice(0, budget);
		if (body.length > budget)
			view[budget - 1] = this.theme.fg(
				"dim",
				`… ${body.length - budget + 1} more line(s)`,
			);
		while (view.length < budget) view.push("");

		return [
			...this.border.render(width),
			` ${accent(this.theme.bold("\uD83E\uDDE0 Memory"))}   ${this.renderTabs()}`,
			"",
			...view.map((l) => ` ${l}`),
			"",
			` ${this.theme.fg("dim", clip(this.footer(), w))}`,
			...this.border.render(width),
		];
	}

	/** Rows of chrome the panel always draws: 2 borders + tabs + 2 blanks + footer. */
	private static readonly CHROME_ROWS = 6;

	/**
	 * Fixed number of body rows: roughly half the terminal, clamped to 8..15.
	 * The clamp is what keeps the panel calm — a fixed size means it never jumps
	 * as content changes, the lower bound keeps it usable in a short window, and
	 * the upper bound leaves the conversation above it visible. The fallback
	 * covers a TUI stub with no terminal attached (tests).
	 */
	private bodyRows(): number {
		const rows = (this.tui as { terminal?: { rows?: number } }).terminal?.rows;
		const half = Math.floor((rows ?? 40) / 2) - MemPanel.CHROME_ROWS;
		return Math.max(8, Math.min(15, half));
	}

	/** The tab strip; the active tab is highlighted, dimmed while content has focus. */
	private renderTabs(): string {
		return TABS.map((t) => {
			if (t !== this.tab) return this.theme.fg("dim", ` ${t} `);
			const label = `[${t}]`;
			return this.focus === "tabs"
				? this.theme.fg("accent", this.theme.bold(label))
				: this.theme.fg("accent", label);
		}).join(" ");
	}

	private footer(): string {
		if (this.modalChild) return "Esc cancel";
		const nav = "←/→ or Tab: switch tab";
		if (this.focus === "tabs")
			return `${nav} · ↓/Enter enter · r reload · Esc close`;
		const back = "Esc back to tabs";
		if (this.tab === "Settings")
			return `↑/↓ select · Enter/Space change · ${back} · ${nav}`;
		if (this.tab === "Review")
			return `↑/↓ doc · PgUp/PgDn scroll · a approve · e edit · d delete · r reload · ${back}`;
		if (this.tab === "Log")
			return `↑/↓ entry · Enter details · u restore · r reload · ${back}`;
		return `r refresh · ${back}`;
	}

	private renderStatus(w: number): string[] {
		const cfg = this.deps.loadCfg();
		const chains = this.deps.modelChains();
		const health =
			this.health === undefined
				? "checking…"
				: this.health
					? "reachable"
					: "unreachable";
		const counts = this.counts
			? `${this.counts.documents} documents · ${this.counts.facts} facts`
			: "—";
		// One row per QUESTION the user asks, not one per config key: "which bank and
		// is it working", "where does it live", "what happens on read", "on write".
		// The chains and the two paths keep their own rows because they are long —
		// merging them would only produce clipped ellipses, which hides facts instead
		// of condensing them.
		const rows: Array<[string, string]> = [
			[
				"Bank",
				`${cfg.bankId}${cfg.active ? "" : "  (INACTIVE)"} · ${health} · ${counts}`,
			],
			["Endpoint", `${cfg.baseUrl}  ns=${cfg.namespace}`],
			[
				"Recall",
				`auto ${cfg.autoRecall ? "on" : "off"} · effort ${cfg.recallEffort}`,
			],
			[
				"Retain",
				`auto ${cfg.autoMemorize ? "on" : "off"} · language ${cfg.memoryLanguage}`,
			],
			["Recall chain", chains.recall],
			["Retain chain", chains.retain],
			["Project config", projectConfigPath(this.deps.cwd)],
			["Global config", globalConfigPath()],
		];
		const pad = Math.max(...rows.map(([k]) => k.length));
		const out = rows.map(
			([k, v]) =>
				`${this.theme.fg("muted", k.padEnd(pad))}  ${clip(v, w - pad - 2)}`,
		);
		if (!cfg.active)
			out.push(
				"",
				this.theme.fg(
					"warning",
					'No bank declared here. Open Settings → "Bank id" to activate memory in this project.',
				),
			);
		return out;
	}

	private renderReview(w: number): string[] {
		const doc = this.currentDoc();
		if (!doc)
			return ["Nothing pending review.", "", "Press r to reload the queue."];
		const head = this.theme.fg(
			"muted",
			clip(
				`${this.docIndex + 1}/${this.docs.length}  ${doc.project} · bank ${doc.bank} · ${doc.factCount} fact(s) · ${time(doc.ts)}`,
				w,
			),
		);
		if (doc.unreachable)
			return [
				head,
				"",
				this.theme.fg(
					"error",
					`Bank ${doc.baseUrl} is unreachable — cannot show this document.`,
				),
			];
		const body = doc.text
			? doc.text.split("\n")
			: ["(the bank is still extracting this document — press r to reload)"];
		const rows = Math.max(4, this.bodyRows() - 3); // header + reason + blank
		const view = body
			.slice(this.docScroll, this.docScroll + rows)
			.map((l) => clip(l, w));
		const rest = body.length - this.docScroll - rows;
		return [
			head,
			this.theme.fg("dim", `reason: ${doc.reason}`),
			"",
			...view,
			...(rest > 0 ? [this.theme.fg("dim", `… ${rest} more line(s)`)] : []),
		];
	}

	private renderLog(w: number): string[] {
		if (this.log.length === 0) return ["No operations logged yet."];
		if (this.showLogDetail)
			return logDetail(this.log[this.logIndex]).flatMap((l) =>
				l.split("\n").map((x) => clip(x, w)),
			);
		const rows = Math.max(4, this.bodyRows());
		const start = Math.max(0, this.logIndex - Math.floor(rows / 2));
		return this.log.slice(start, start + rows).map((e, i) => {
			const selected = start + i === this.logIndex;
			const row = clip(`${selected ? "›" : " "} ${logRow(e, w - 4)}`, w);
			return selected ? this.theme.fg("accent", row) : row;
		});
	}
}

/**
 * Text entry for a model id, with the session's registered models offered as a
 * list. Picking is assistance, never a gate: the panel writes GLOBAL config and
 * the registry is per-session, so an id this machine does not know is still a
 * legal thing to type, and Enter on a typed value commits it verbatim.
 */
class ModelPickerChild implements Component {
	private readonly input = new Input();
	/** -1 = "use what is typed"; otherwise an index into the filtered options. */
	private highlight = -1;

	constructor(
		private readonly theme: Theme,
		private readonly title: string,
		private readonly options: string[],
		private readonly maxVisible: number,
		private readonly onSubmit: (value: string) => void,
		private readonly onCancel: () => void,
	) {}

	/** Options narrowed by what has been typed so far. */
	private matches(): string[] {
		const q = this.input.getValue().trim().toLowerCase();
		return q ? this.options.filter((o) => o.toLowerCase().includes(q)) : this.options;
	}

	handleInput(data: string): void {
		const list = this.matches();
		if (matchesKey(data, "escape")) return this.onCancel();
		if (matchesKey(data, "enter") || data === "\n") {
			const picked = this.highlight >= 0 ? list[this.highlight] : undefined;
			return this.onSubmit(picked ?? this.input.getValue());
		}
		if (matchesKey(data, "down")) {
			this.highlight = Math.min(list.length - 1, this.highlight + 1);
			return;
		}
		if (matchesKey(data, "up")) {
			this.highlight = Math.max(-1, this.highlight - 1);
			return;
		}
		this.input.handleInput(data);
		// Typing changes the candidate set, so a stale index would point at a
		// different model than the highlighted row.
		this.highlight = -1;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const list = this.matches();
		// Keep the highlighted row on screen; the panel clips, and a clipped picker
		// cannot be scrolled to the option it is highlighting.
		const rows = Math.max(1, this.maxVisible - 4);
		const start = Math.max(0, Math.min(this.highlight - rows + 2, list.length - rows));
		const view = list.slice(Math.max(0, start), Math.max(0, start) + rows);
		const hidden = list.length - view.length;
		return [
			this.theme.fg("accent", clip(this.title, width)),
			...this.input.render(width),
			...view.map((o) => {
				const i = list.indexOf(o);
				const row = clip(`${i === this.highlight ? "›" : " "} ${o}`, width);
				return i === this.highlight ? this.theme.fg("accent", row) : row;
			}),
			...(list.length === 0
				? [this.theme.fg("dim", "  no registered model matches — Enter uses what you typed")]
				: []),
			...(hidden > 0 ? [this.theme.fg("dim", `  … ${hidden} more`)] : []),
			this.theme.fg(
				"dim",
				clip("↑/↓ pick a registered model · Enter use it (or the typed id) · Esc cancel", width),
			),
		];
	}
}

/** Minimal inline yes/no prompt, so delete never needs a nested dialog. */
class ConfirmChild implements Component {
	constructor(
		private readonly question: string,
		private readonly answer: (ok: boolean) => void,
	) {}

	handleInput(data: string): void {
		if (data === "y" || data === "Y" || data === "\r" || data === "\n")
			return this.answer(true);
		if (data === "n" || data === "N" || data === "\x1b") this.answer(false);
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [
			`  ${clip(this.question, Math.max(20, width - 2))}`,
			"",
			"  y confirm · n / Esc cancel",
		];
	}
}

/**
 * Open the /mem dashboard. Resolves when the user closes it.
 *
 * Deliberately NOT an overlay: `compositeOverlays` pads the render buffer up to
 * the terminal height so overlays get screen-relative coordinates, which pushes
 * the chat transcript and the other extensions' widgets up into the scrollback.
 * Rendering inline — the way pi's own selectors and dialogs do it — leaves the
 * conversation untouched; the panel just replaces the editor row while open.
 */
export async function openMemPanel(
	ctx: ExtensionContext,
	deps: PanelDeps,
): Promise<void> {
	// The panel reports whether it wrote anything, and the warning is raised HERE,
	// after `ctx.ui.custom` has resolved — which it only does once the component
	// called `done()`. The ordering is therefore structural, not a convention: the
	// notice cannot be emitted while the panel is still on screen. One flag means
	// one warning, however many settings were changed.
	const wrote = await ctx.ui.custom<boolean>(
		(tui, theme, keybindings, done) =>
			new MemPanel(deps, tui, theme, keybindings, (w) => done(w)),
	);
	if (wrote) ctx.ui.notify(RELOAD_WARNING, "warning");
}

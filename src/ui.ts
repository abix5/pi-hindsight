/**
 * Persistent status surface for pi-hindsight.
 *
 * A single widget block above the editor (same primitive todo/plan-mode use)
 * shows bank connection + live recall/memorize state on exactly ONE line, plus
 * a retired-facts badge when the bank has killed anything this session. There
 * is deliberately no status-bar strip: it duplicated the widget's dot. Any strip
 * left by an older version is cleared on the next render.
 *
 * Everything is fire-and-forget and guarded, so a missing UI is a no-op.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "hindsight";

type Theme = {
	fg: (color: ThemeColor, s: string) => string;
	bold: (s: string) => string;
};
type Ui = {
	setWidget?: (id: string, content: string[] | undefined) => void;
	setStatus?: (id: string, text: string | undefined) => void;
	theme?: Theme;
};

type BankState = "unknown" | "checking" | "ok" | "error";
type MemoPhase =
	| "idle"
	| "collecting"
	| "extracting"
	| "writing"
	| "done"
	| "blocked"
	| "error";

function trunc(s: string, n: number): string {
	if (n <= 1) return "";
	// A newline inside a bank error message would render as a SECOND widget row,
	// so every variable fragment is flattened here, on the one path they share.
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/**
 * Visible columns of a plain (un-styled) fragment. The brain glyph is the only
 * double-width character the widget emits; everything else is 1 column.
 */
function width(s: string): number {
	return [...s].length + (s.includes("🧠") ? 1 : 0);
}

/**
 * Hard cap on the rendered line. The widget must occupy the SAME number of rows
 * on every frame or the TUI flickers; with one emitted line the only way the
 * height can still change is the host wrapping it, so the line is kept short
 * enough to fit a narrow terminal instead of relying on the terminal width
 * (which setWidget does not expose).
 */
const MAX_COLS = 72;

export class HindsightStatus {
	private ui: Ui | undefined;
	/**
	 * Rolling "last action", stored as PLAIN text plus a tone. Styling is applied
	 * at render time, after truncation — pre-styled strings cannot be shortened
	 * without an ANSI-aware cutter that would otherwise corrupt the colour codes.
	 */
	private lastAction: { text: string; tone: ThemeColor } = {
		text: "",
		tone: "dim",
	};
	private bank = {
		id: "",
		host: "",
		state: "unknown" as BankState,
		detail: "",
		documents: -1,
		facts: -1,
	};
	private recall = {
		off: false,
		active: false,
		lastCount: 0,
		session: 0,
		lastQuery: "",
	};
	private memo = {
		off: false,
		phase: "idle" as MemoPhase,
		queue: 0,
		lastDocs: 0,
		lastLines: 0,
		frag: 0,
		reason: "",
		detail: "",
		session: 0,
		/**
		 * Facts invalidated this SESSION, not this write. A kill is rare and the
		 * write that caused it scrolls out of the transcript within a turn; the
		 * widget's job is to answer "has memory retired anything here?" for as long
		 * as the session lives. A transient badge would be gone before it was read.
		 */
		retired: 0,
	};

	/** Point at the current UI (call on each event; the reference can change). */
	attach(ui: Ui | undefined): void {
		if (!ui) return;
		this.ui = ui;
		this.render();
	}

	clear(): void {
		this.ui?.setWidget?.(WIDGET_ID, undefined);
		this.ui?.setStatus?.(WIDGET_ID, undefined);
	}

	// --- bank ---------------------------------------------------------------
	setBank(id: string, baseUrl: string): void {
		this.bank.id = id;
		this.bank.host = baseUrl.replace(/^https?:\/\//, "");
		this.render();
	}
	bankChecking(): void {
		this.bank.state = "checking";
		this.render();
	}
	bankOk(): void {
		this.bank.state = "ok";
		this.bank.detail = "";
		this.render();
	}
	bankError(msg: string): void {
		this.bank.state = "error";
		this.bank.detail = msg;
		this.render();
	}
	/** Bank size counters (documents stored, facts/units extracted). */
	setBankCounts(documents: number, facts: number): void {
		this.bank.documents = documents;
		this.bank.facts = facts;
		this.render();
	}

	// --- recall (read) ------------------------------------------------------
	recallOff(): void {
		this.recall.off = true;
		this.render();
	}
	recallOn(): void {
		this.recall.off = false;
		this.render();
	}
	recallStart(): void {
		this.recall.off = false;
		this.recall.active = true;
		// Explicit that the wait is uninterruptible: Esc cannot cancel the preflight
		// bank call, so it only clears once the bank actually answers.
		this.lastAction = { text: "↙ waiting for bank… (clears on reply)", tone: "dim" };
		this.render();
	}
	recallDone(count: number): void {
		this.recall.active = false;
		this.recall.lastCount = count;
		if (count > 0) this.recall.session += 1;
		this.render();
	}
	/**
	 * Final recall result: the op, the query sent to the bank, and how many facts
	 * it found vs. how many were injected (fresh) into context. This is the "what
	 * did memory look up / what did it inject" the user wants to see.
	 */
	recallOutcome(info: {
		op: "recall" | "reflect";
		query: string;
		found: number;
		injected: number;
		queried: boolean;
		reason: string;
	}): void {
		this.recall.active = false;
		this.recall.lastCount = info.injected;
		if (info.injected > 0) this.recall.session += 1;
		if (info.query.trim()) this.recall.lastQuery = info.query.trim();
		this.lastAction = { text: this.recallLine(info), tone: "dim" };
		this.render();
	}

	private recallLine(info: {
		op: "recall" | "reflect";
		query: string;
		found: number;
		injected: number;
		queried: boolean;
		reason: string;
	}): string {
		if (!info.queried) return `↙ skipped (${trunc(info.reason, 30)})`;
		// The outcome comes BEFORE the query so that when the line budget bites it
		// eats the query text — found→injected is the part that says whether memory
		// actually contributed anything.
		const outcome =
			info.op === "reflect"
				? info.injected > 0
					? "answered"
					: "no answer"
				: info.found === 0
					? "nothing found"
					: `${info.found}→${info.injected}`;
		return `↙ ${info.op} · ${outcome} · ${trunc(info.query || "(empty)", 40)}`;
	}

	// --- memorize (write) ---------------------------------------------------
	memoOff(): void {
		this.memo.off = true;
		this.render();
	}
	memoOn(): void {
		this.memo.off = false;
		this.render();
	}
	setQueue(waiting: number): void {
		this.memo.queue = Math.max(0, waiting);
		this.render();
	}
	memoCollecting(frag: number, reason: string): void {
		this.memo.off = false;
		this.memo.phase = "collecting";
		this.memo.frag = frag;
		this.memo.reason = reason;
		this.lastAction = { text: `↗ ${reason} → memory`, tone: "dim" };
		this.render();
	}
	memoExtracting(): void {
		this.memo.phase = "extracting";
		this.render();
	}
	memoWriting(): void {
		this.memo.phase = "writing";
		this.render();
	}
	memoDone(documents: number, lines: number): void {
		this.memo.phase = "done";
		this.memo.lastDocs = documents;
		this.memo.lastLines = lines;
		this.memo.session += 1;
		this.lastAction = { text: `↗ stored ${this.memoLast()}`, tone: "dim" };
		this.render();
	}
	memoBlocked(): void {
		this.memo.phase = "blocked";
		this.lastAction = { text: "↗ nothing new to store", tone: "dim" };
		this.render();
	}
	memoError(msg: string): void {
		this.memo.phase = "error";
		this.memo.detail = msg;
		this.lastAction = { text: `↗! ${msg}`, tone: "error" };
		this.render();
	}
	/** Facts the bank retired as contradicted; accumulated over the session. */
	memoRetired(count: number): void {
		if (count < 1) return;
		this.memo.retired += count;
		this.render();
	}

	// --- rendering ----------------------------------------------------------
	private c(color: ThemeColor, s: string): string {
		return this.ui?.theme?.fg ? this.ui.theme.fg(color, s) : s;
	}
	// The theme's "success" hue reads yellow-green (salad) in some terminals, so
	// the healthy dot is forced to a true green via a raw truecolor SGR, resetting
	// only the foreground (\x1b[39m) afterwards so no other styling leaks.
	private static readonly GREEN_DOT = "\u001b[38;2;46;204;64m●\u001b[39m";
	private dot(): string {
		switch (this.bank.state) {
			case "ok":
				return this.ui?.theme?.fg ? HindsightStatus.GREEN_DOT : "●";
			case "error":
				return this.c("error", "●");
			case "checking":
				return this.c("warning", "◐");
			default:
				return this.c("dim", "○");
		}
	}

	/** Bank size, compact: the widget has one line to spend on everything. */
	private counts(): string {
		return this.bank.documents >= 0
			? `${this.bank.documents}d ${this.bank.facts}f`
			: "—d —f";
	}

	private memoLast(): string {
		return `${this.memo.lastDocs} doc${this.memo.lastDocs === 1 ? "" : "s"} · ${this.memo.lastLines} lines`;
	}

	private working(): boolean {
		return (
			this.recall.active ||
			this.memo.phase === "collecting" ||
			this.memo.phase === "extracting" ||
			this.memo.phase === "writing"
		);
	}

	/**
	 * Compact auto-mode cue: ↙ = recall, ↗ = retain.
	 *
	 * Tone is coupled to "both contours on", not to the individual glyphs: fully-on
	 * is the state worth seeing at a glance, so it is the bright one. The earlier
	 * mapping had it backwards — healthy whispered in `dim` while a switched-off
	 * contour shouted in `warning`, which reads as a fault rather than a choice.
	 */
	private autoMode(): { text: string; tone: ThemeColor } {
		const tone: ThemeColor = this.autoOn() ? "accent" : "dim";
		if (this.recall.off && this.memo.off) return { text: "auto off", tone };
		if (this.recall.off) return { text: "↗", tone };
		if (this.memo.off) return { text: "↙", tone };
		return { text: "↙↗", tone };
	}

	/** Automatic memory is fully on only when BOTH contours are. */
	private autoOn(): boolean {
		return !this.recall.off && !this.memo.off;
	}

	/**
	 * The variable right-hand part: what the bank is doing right now, or its
	 * complaint. Plain text — the caller styles it after truncating.
	 */
	private tail(): { text: string; tone: ThemeColor } {
		if (this.bank.state === "error")
			return { text: this.bank.detail || "bank unreachable", tone: "error" };
		if (this.bank.state === "checking")
			return { text: "checking…", tone: "dim" };
		return this.lastAction;
	}

	/**
	 * The whole widget: bank dot · name · auto cue · size · last action, on one
	 * line. Everything is assembled in PLAIN text first so the budget arithmetic
	 * is honest, and each fragment is coloured only after it has been cut.
	 */
	private widgetLine(): string {
		const icon = this.working() ? this.c("warning", "⟳") : this.dot();
		const name = trunc(this.bank.id || "(none)", 20);
		const mode = this.autoMode();
		const counts = this.bank.state === "ok" ? this.counts() : "";
		// Kills ride WITH the fact count (`153f↓3` = three of them retired this
		// session), in the fixed head rather than the tail: three columns, and the
		// thing that gives way when the line is tight is the last action, which
		// repeats every turn and is the cheapest thing on the line to lose.
		const kills = this.memo.retired > 0 ? `\u2193${this.memo.retired}` : "";
		const sizePlain = `${counts}${kills}`;
		const size = `${counts ? this.c("muted", counts) : ""}${kills ? this.c("warning", kills) : ""}`;
		// Every state icon (● ◐ ○ ⟳) is one column, so one stands in for all of
		// them while measuring.
		const headPlain = `🧠 ● ${name} ${mode.text}${sizePlain ? ` ${sizePlain}` : ""}`;
		const head =
			`${this.c("accent", "🧠")} ${icon} ${this.c(mode.tone, name)}` +
			` ${this.c(mode.tone, mode.text)}${sizePlain ? ` ${size}` : ""}`;

		const tail = this.tail();
		const text = trunc(tail.text, MAX_COLS - width(headPlain) - 3);
		if (!text) return head;
		return `${head} ${this.c("dim", "·")} ${this.c(tail.tone, text)}`;
	}

	private render(): void {
		if (!this.ui?.setWidget) return;
		// EXACTLY one line, always — that is what keeps the height stable and kills
		// the "second line keeps coming back" flicker. The only remaining way the
		// height could change is the host wrapping an over-long line, hence the
		// MAX_COLS budget enforced in widgetLine().
		this.ui.setWidget(WIDGET_ID, [this.widgetLine()]);
		// No footer strip: the widget is the single source of truth. Clear any strip
		// a previous version may have left in the status bar.
		this.ui.setStatus?.(WIDGET_ID, undefined);
	}
}

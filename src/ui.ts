/**
 * Persistent status surface for pi-hindsight.
 *
 * A single widget block above the editor (same primitive todo/plan-mode use)
 * shows bank connection + live recall/memorize state on exactly two lines. There
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
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

export class HindsightStatus {
	private ui: Ui | undefined;
	/**
	 * Stable "last action" text for the widget's second line. It is only ever
	 * UPDATED, never cleared, so the second line never flickers in/out (which was
	 * the blinking bug caused by conditionally clearing the recall query).
	 */
	private lastAction = "";
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
		this.render();
	}
	recallDone(count: number): void {
		this.recall.active = false;
		this.recall.lastCount = count;
		if (count > 0) this.recall.session += 1;
		this.render();
	}
	/**
	 * Final recall result on line 2: the op, the exact query sent to the bank, and
	 * how many facts it found vs. how many were injected (fresh) into context. This
	 * is the "what did memory look up / what did it inject" the user wants to see.
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
		this.lastAction = this.recallLine(info);
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
		const dim = (t: string) => this.c("dim", t);
		if (!info.queried) return dim(`↙ skipped (${trunc(info.reason, 50)})`);
		const q = trunc(info.query || "(empty)", 56);
		const head = dim(`↙ ${info.op} · ${q}`);
		if (info.op === "reflect")
			return `${head} ${dim(info.injected > 0 ? "· answered" : "· no answer")}`;
		if (info.found === 0) return `${head} ${dim("· nothing found")}`;
		// found → injected (some may be dropped as already-seen this session).
		return `${head} ${dim(`· ${info.found}→${info.injected}`)}`;
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
		this.lastAction = this.c("dim", `↗ ${reason} → memory`);
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
		this.lastAction = this.c("dim", `↗ ${this.memoLast()}`);
		this.render();
	}
	memoBlocked(): void {
		this.memo.phase = "blocked";
		this.lastAction = this.c("dim", "↗ nothing new to store");
		this.render();
	}
	memoError(msg: string): void {
		this.memo.phase = "error";
		this.memo.detail = msg;
		this.lastAction = `${this.c("error", "↗!")} ${this.c("dim", trunc(msg, 60))}`;
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

	private counts(): string {
		return this.bank.documents >= 0
			? `${this.bank.documents} docs · ${this.bank.facts} facts`
			: "— docs · — facts";
	}

	private memoLast(): string {
		return `${this.memo.lastDocs} doc${this.memo.lastDocs === 1 ? "" : "s"} · ${this.memo.lastLines} lines`;
	}

	/** The label shown while memory is actively working, or undefined when idle. */
	private busyLabel(): string | undefined {
		if (this.recall.active) return "recalling…";
		if (
			this.memo.phase === "collecting" ||
			this.memo.phase === "extracting" ||
			this.memo.phase === "writing"
		)
			return "storing…";
		return undefined;
	}

	/**
	 * Line 1 = bank connection + size only (dot · name · counts), plus a single
	 * spinner label while working. All action/step detail lives on line 2, so this
	 * line is calm and stable (no ↙0 / ↗— noise).
	 */
	private widgetLine(): string {
		const brain = this.c("accent", "🧠");
		const name = this.c("dim", this.bank.id || "(none)");
		const counts = this.c("muted", this.counts());

		const mode = this.autoMode();

		if (this.bank.state === "error")
			return `${brain} ${this.c("error", "●")} ${name} · ${mode} · ${this.c("error", trunc(this.bank.detail, 40))}`;
		if (this.bank.state === "checking")
			return `${brain} ${this.c("warning", "◐")} ${name} · ${mode} · ${this.c("dim", "checking…")}`;

		const busy = this.busyLabel();
		if (busy)
			return `${brain} ${this.c("warning", "⟳")} ${name} · ${mode} · ${counts} · ${this.c("warning", busy)}`;
		return `${brain} ${this.dot()} ${name} · ${mode} · ${counts}`;
	}

	/** Compact auto-mode cue: ↙ = recall, ↗ = retain. */
	private autoMode(): string {
		if (this.recall.off && this.memo.off) return this.c("warning", "auto off");
		if (this.recall.off) return this.c("warning", "auto ↗");
		if (this.memo.off) return this.c("warning", "auto ↙");
		return this.c("dim", "auto ↙↗");
	}

	private render(): void {
		if (!this.ui?.setWidget) return;
		// Line 2 is ALWAYS present (a neutral placeholder before any action), so the
		// widget height never changes — that is what killed the "second line keeps
		// coming back" flicker. It is a rolling history of the last memory action.
		// lastAction is already fully styled by its setter (colors baked in), so we
		// emit it verbatim — no dim re-wrap, no ANSI-unaware trunc that would corrupt
		// the color codes. The strings are bounded by construction.
		const line2 = this.lastAction || this.c("dim", "· ready");
		this.ui.setWidget(WIDGET_ID, [this.widgetLine(), line2]);
		// No footer strip: the 2-line widget is the single source of truth. Clear any
		// strip a previous version may have left in the status bar.
		this.ui.setStatus?.(WIDGET_ID, undefined);
	}
}

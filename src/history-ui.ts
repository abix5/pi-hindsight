import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { readLog, type HindsightLogEntry } from "./log.ts";

function oneLine(s: string | undefined, max = 62): string {
	if (!s) return "";
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

function time(ts: string): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function row(e: HindsightLogEntry): string {
	if (e.type === "retain")
		return `↗ ${time(e.ts)} retain  ${e.reason ?? ""}  ${e.documents ?? 0} doc · ${e.lines ?? 0} lines`;
	if (e.type === "reflect")
		return `↙ ${time(e.ts)} reflect ${oneLine(e.query)} → ${oneLine(e.injectedText, 34)}`;
	if (e.type === "recall")
		return `↙ ${time(e.ts)} recall  ${e.injected ?? 0}/${e.found ?? 0}  ${oneLine(e.query)}`;
	return `! ${time(e.ts)} ${e.stage ?? "error"} ${oneLine(e.message)}`;
}

function detail(e: HindsightLogEntry): string[] {
	const out = [row(e), ""];
	if (e.user) out.push("User:", e.user, "");
	if (e.query) out.push("Bank query:", e.query, "");
	if (e.injectedText) out.push("Injected / answer:", e.injectedText, "");
	if (e.documentText) out.push("Document sent to bank:", e.documentText, "");
	if (e.rawHits?.length)
		out.push("Raw hits:", ...e.rawHits.map((h, i) => `${i + 1}. ${h}`));
	return out;
}

class HistoryPanel implements Component {
	private selected = 0;
	private showDetail = false;
	constructor(
		private readonly entries: HindsightLogEntry[],
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		if (data === "\x1b" || data === "q") return this.done();
		if (data === "\r" || data === "\n") {
			this.showDetail = !this.showDetail;
			return;
		}
		if (data === "\x1b[A") this.selected = Math.max(0, this.selected - 1);
		if (data === "\x1b[B")
			this.selected = Math.min(this.entries.length - 1, this.selected + 1);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(30, width - 4);
		const clip = (s: string) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);
		const lines = [
			"🧠 Hindsight history  ↑/↓ select · Enter details · Esc/q close",
			"",
		];
		if (this.entries.length === 0)
			return ["🧠 Hindsight history", "", "No operations logged yet."];
		if (this.showDetail)
			return detail(this.entries[this.selected]).flatMap((l) =>
				clip(l).split("\n"),
			);
		return lines.concat(
			this.entries
				.slice(0, 30)
				.map((e, i) => clip(`${i === this.selected ? "›" : " "} ${row(e)}`)),
		);
	}
}

export async function openHistory(
	ctx: ExtensionContext,
	logPath: string,
): Promise<void> {
	const entries = readLog(ctx.cwd ?? process.cwd(), logPath, 200);
	await ctx.ui.custom<void>(
		(_tui, _theme, _kb, done) => new HistoryPanel(entries, done),
		{
			overlay: true,
			overlayOptions: { width: "85%", maxHeight: "80%", anchor: "center" },
		},
	);
}

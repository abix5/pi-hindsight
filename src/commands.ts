import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { openHistory } from "./history-ui.ts";
import { appendDebug } from "./log.ts";
import { resolveModel, runModel } from "./model.ts";
import type { HindsightConfig } from "./config.ts";
import type { HindsightClient } from "./hindsight.ts";
import type { Memorizer } from "./memorize.ts";
import type { HindsightStatus } from "./ui.ts";

function preview(value: unknown, max = 800): string {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	if (!s) return "(empty)";
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

type State = { cfg: HindsightConfig; client: HindsightClient } | undefined;

export function registerCommands(
	pi: ExtensionAPI,
	getState: () => State,
	getMemorizer: () => Memorizer | undefined,
	status: HindsightStatus,
): void {
	pi.registerCommand("hindsight-flush", {
		description: "Hindsight: flush accumulated context into memory now",
		handler: async (_args, ctx) => {
			appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-flush");
			const memorizer = getMemorizer();
			if (!memorizer)
				return ctx.ui.notify("[hindsight] not initialized", "error");
			status.attach(ctx.ui);
			memorizer.schedule(ctx, "manual");
			ctx.ui.notify("[hindsight] flush scheduled", "info");
		},
	});

	pi.registerCommand("hindsight-rememorize", {
		description:
			"Hindsight: re-collect the WHOLE session into memory (ignore watermark)",
		handler: async (_args, ctx) => {
			appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-rememorize");
			const memorizer = getMemorizer();
			if (!memorizer)
				return ctx.ui.notify("[hindsight] not initialized", "error");
			status.attach(ctx.ui);
			memorizer.schedule(ctx, "rememorize", { fromStart: true });
			ctx.ui.notify("[hindsight] re-collecting the whole session", "info");
		},
	});

	pi.registerCommand("hindsight-log", {
		description: "Hindsight: open memory operation history",
		handler: async (_args, ctx) => openLog(ctx, getState()),
	});
	pi.registerShortcut("alt+h", {
		description: "Open Hindsight history",
		handler: async (ctx) => openLog(ctx, getState()),
	});

	pi.registerCommand("hindsight-ping", {
		description: "Hindsight: health check + list banks + ensure project bank",
		handler: async (_args, ctx) => {
			appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-ping.start");
			const s = getState();
			if (!s) return ctx.ui.notify("[hindsight] not initialized", "error");
			try {
				const health = await s.client.health(ctx.signal);
				const banks = await s.client.listBanks(ctx.signal);
				await s.client.ensureBank();
				ctx.ui.notify(`[hindsight] ok — bank "${s.cfg.bankId}"`, "info");
				console.log("[hindsight] health:", preview(health));
				console.log("[hindsight] banks:", preview(banks));
				appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-ping.done", {
					health,
					banks,
				});
			} catch (err) {
				appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-ping.error", {
					error: (err as Error).message,
				});
				ctx.ui.notify(
					`[hindsight] ping failed: ${(err as Error).message}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("hindsight-recall", {
		description:
			"Hindsight: search memories (usage: /hindsight-recall <query>)",
		handler: async (args, ctx) => {
			appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-recall.start", {
				args,
			});
			const s = getState();
			if (!s) return ctx.ui.notify("[hindsight] not initialized", "error");
			const query = args.trim();
			if (!query)
				return ctx.ui.notify("Usage: /hindsight-recall <query>", "error");
			try {
				const res = await s.client.recall(query, {}, ctx.signal);
				appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-recall.done", {
					response: res,
				});
				ctx.ui.notify("[hindsight] recall done (see log)", "info");
				console.log("[hindsight] recall ->", preview(res, 2000));
			} catch (err) {
				appendDebug(
					ctx.cwd ?? process.cwd(),
					"command.hindsight-recall.error",
					{ error: (err as Error).message },
				);
				ctx.ui.notify(
					`[hindsight] recall failed: ${(err as Error).message}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("hindsight-model", {
		description: "Hindsight: resolve small model + run a tiny completion",
		handler: async (args, ctx: ExtensionContext) => {
			appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-model.start", {
				args,
			});
			const s = getState();
			if (!s) return ctx.ui.notify("[hindsight] not initialized", "error");
			const resolved = resolveModel(ctx, s.cfg);
			if (!resolved)
				return ctx.ui.notify("[hindsight] no model available", "error");
			const prompt = args.trim() || "Reply with exactly: OK";
			try {
				const out = await runModel(
					ctx,
					resolved,
					"You are terse. Follow the instruction literally.",
					prompt,
					{ maxTokens: 64, signal: ctx.signal },
				);
				appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-model.done", {
					model: resolved.label,
					output: out,
				});
				ctx.ui.notify(
					`[hindsight] model ${resolved.label}: ${preview(out, 120)}`,
					"info",
				);
			} catch (err) {
				appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-model.error", {
					error: (err as Error).message,
				});
				ctx.ui.notify(
					`[hindsight] model failed: ${(err as Error).message}`,
					"error",
				);
			}
		},
	});
}

async function openLog(ctx: ExtensionContext, s: State): Promise<void> {
	appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-log.start", {
		initialized: !!s,
	});
	if (!s) return ctx.ui.notify("[hindsight] not initialized", "error");
	try {
		await openHistory(ctx, s.cfg.logPath);
		appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-log.done");
	} catch (err) {
		appendDebug(ctx.cwd ?? process.cwd(), "command.hindsight-log.error", {
			error: (err as Error).message,
		});
		throw err;
	}
}

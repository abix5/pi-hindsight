import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { openHistory } from "./history-ui.ts";
import {
	isReviewServerRunning,
	startReviewServer,
	stopReviewServer,
} from "./review-server.ts";
import { appendDebug } from "./log.ts";
import { resolveModel, runModel } from "./model.ts";
import {
	type HindsightConfig,
	patchConfigFile,
	parseEffort,
} from "./config.ts";
import { type CatState, resolveCategories } from "./categories.ts";
import type { HindsightClient } from "./hindsight.ts";
import type { Memorizer } from "./memorize.ts";
import { loadState, readDispatchDocIds, saveState } from "./state.ts";
import type { HindsightStatus } from "./ui.ts";

/** Brain-prefixed toast, keeping the backend name out of the UI. */
const TAG = "\uD83E\uDDE0";

function preview(value: unknown, max = 800): string {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	if (!s) return "(empty)";
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

type State = { cfg: HindsightConfig; client: HindsightClient } | undefined;

/** Session-level switches + pending /mem-remember capture, shared with index.ts. */
type Runtime = {
	autoRecall: boolean;
	autoMemorize: boolean;
	pendingRemember?: { startId: string };
};

export function registerCommands(
	pi: ExtensionAPI,
	getState: () => State,
	getMemorizer: () => Memorizer | undefined,
	status: HindsightStatus,
	runtime: Runtime,
): void {
	// --- write now ----------------------------------------------------------
	pi.registerCommand("mem-save", {
		description: "Memory: save the accumulated context to memory now",
		handler: async (_args, ctx) => {
			appendDebug(ctx.cwd ?? process.cwd(), "command.mem-save");
			const memorizer = getMemorizer();
			if (!memorizer) return ctx.ui.notify(`${TAG} not initialized`, "error");
			status.attach(ctx.ui);
			memorizer.schedule(ctx, "manual");
			ctx.ui.notify(`${TAG} save scheduled`, "info");
		},
	});

	pi.registerCommand("mem-resave", {
		description:
			"Memory: re-collect the WHOLE session into memory (ignore the pointer)",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			appendDebug(cwd, "command.mem-resave");
			const memorizer = getMemorizer();
			if (!memorizer) return ctx.ui.notify(`${TAG} not initialized`, "error");
			status.attach(ctx.ui);
			const s = getState();
			// Delete documents this session previously stored so the fromStart
			// re-collect does not pile duplicates on top of them. Best-effort: read the
			// append-only dispatch log, keep docIds for THIS session, delete each
			// (tolerates 404). Old/stale entries are harmless. We do NOT rewrite the log.
			if (s) {
				const sessionId = ctx.sessionManager.getSessionId() ?? "default";
				const docIds = readDispatchDocIds(
					cwd,
					s.cfg.dispatchLogPath,
					sessionId,
				);
				appendDebug(cwd, "command.mem-resave.delete", {
					sessionId,
					docs: docIds.length,
				});
				for (const docId of docIds) {
					try {
						await s.client.deleteDocument(docId, ctx.signal);
						appendDebug(cwd, "command.mem-resave.deleted", { docId });
					} catch (err) {
						appendDebug(cwd, "command.mem-resave.delete_error", {
							docId,
							error: (err as Error).message,
						});
					}
				}
			}
			memorizer.schedule(ctx, "resave", { fromStart: true });
			ctx.ui.notify(`${TAG} re-collecting the whole session`, "info");
		},
	});

	// --- agent-driven remember ---------------------------------------------
	pi.registerCommand("mem-remember", {
		description:
			"Memory: have the agent study something and store it (usage: /mem-remember <what to learn>)",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			appendDebug(cwd, "command.mem-remember", { args });
			const prompt = args.trim();
			if (!prompt)
				return ctx.ui.notify(
					"Usage: /mem-remember <what to study and remember>",
					"error",
				);
			status.attach(ctx.ui);
			// Record the entry id BEFORE the study turn. index.ts's turn_end handler
			// records the end id, so this whole block is marked ALREADY-SAVED at the
			// next memorize and its facts are not extracted a second time.
			const entries = ctx.sessionManager.getEntries();
			const startId = entries[entries.length - 1]?.id;
			if (startId) runtime.pendingRemember = { startId };
			pi.sendMessage(
				{
					customType: "mem-remember",
					content:
						`${TAG} Memory task: ${prompt}\n\n` +
						"Study or gather exactly what is needed for this task, then store the " +
						"durable, reusable facts you found into long-term memory by calling the " +
						"hindsight_retain tool (one concise call with the key facts). Keep it " +
						"factual and specific; do not store chatter, and record only WHERE " +
						"secrets live, never their values. After storing, briefly confirm what " +
						"you saved.",
					display: true,
				},
				{ triggerTurn: true },
			);
			ctx.ui.notify(`${TAG} memory task sent to the agent`, "info");
		},
	});

	// --- pointer control ----------------------------------------------------
	pi.registerCommand("mem-mark", {
		description:
			"Memory: mark everything up to now as already processed (move the pointer, write nothing)",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			appendDebug(cwd, "command.mem-mark");
			const entries = ctx.sessionManager.getEntries();
			const lastId = entries[entries.length - 1]?.id;
			if (!lastId) return ctx.ui.notify(`${TAG} nothing to mark yet`, "info");
			saveState(pi, { watermark: lastId });
			status.attach(ctx.ui);
			ctx.ui.notify(
				`${TAG} pointer moved to now — earlier context will not be memorized`,
				"info",
			);
		},
	});

	pi.registerCommand("mem-auto", {
		description:
			"Memory: toggle auto-recall & auto-retain for this session. /mem-auto on|off flips both; /mem-auto recall|retain on|off flips one; /mem-auto shows state",
		handler: async (args, ctx) => {
			appendDebug(ctx.cwd ?? process.cwd(), "command.mem-auto", { args });
			status.attach(ctx.ui);
			const show = () =>
				ctx.ui.notify(
					`${TAG} auto-recall: ${runtime.autoRecall ? "on" : "off"} · auto-retain: ${
						runtime.autoMemorize ? "on" : "off"
					}`,
					"info",
				);
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			if (parts.length === 0) return show();
			let target: "recall" | "retain" | "both" = "both";
			let val: string | undefined = parts[0];
			if (parts[0] === "recall" || parts[0] === "retain") {
				target = parts[0];
				val = parts[1];
			}
			if (val !== "on" && val !== "off")
				return ctx.ui.notify(
					"Usage: /mem-auto on|off  (or: /mem-auto recall|retain on|off)",
					"error",
				);
			const on = val === "on";
			if (target === "recall" || target === "both") {
				runtime.autoRecall = on;
				on ? status.recallOn() : status.recallOff();
			}
			if (target === "retain" || target === "both") {
				runtime.autoMemorize = on;
				on ? status.memoOn() : status.memoOff();
			}
			show();
		},
	});

	// --- extraction categories (retain: what to store) ----------------------
	pi.registerCommand("mem-types", {
		description:
			"Memory: choose which fact categories to extract (\u2705 extract \u00b7 \u2b1c neutral \u00b7 \u274c exclude)",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			appendDebug(cwd, "command.mem-types", { args });
			const s = getState();
			if (!s) return ctx.ui.notify(`${TAG} not initialized`, "error");
			status.attach(ctx.ui);
			const cfg = s.cfg;
			// Tri-state markers: crisp symbols (not emoji). The selector colours whole
			// rows, so embedded ANSI would fight the selection highlight — the glyph
			// shape carries the meaning instead. ✓ extract, ○ neutral, ✗ exclude.
			const box = (st: CatState) =>
				st === "on" ? "\u2713" : st === "ban" ? "\u2717" : "\u25cb";
			const setState = (key: string, st: CatState) => {
				const fc = { ...(cfg.factCategories ?? {}) };
				fc[key] = st;
				cfg.factCategories = fc;
				patchConfigFile(cwd, { factCategories: fc });
			};
			// Non-interactive form: /mem-types <key> on|off|ban
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (
				parts.length === 2 &&
				(parts[1] === "on" || parts[1] === "off" || parts[1] === "ban")
			) {
				setState(parts[0], parts[1]);
				return ctx.ui.notify(`${TAG} ${parts[0]} \u2192 ${parts[1]}`, "info");
			}
			// Interactive checklist: each pick cycles ○ -> ✓ -> ✗. Order is STATIC (the
			// catalog never reshuffles) — only the marker changes between reopens.
			for (;;) {
				const cats = resolveCategories(cfg);
				const options = cats.map(
					(c) => `${box(c.state)} ${c.label}${c.custom ? " (custom)" : ""}`,
				);
				const ADD = "+ Add custom type";
				const DONE = "Done";
				options.push(ADD, DONE);
				const choice = await ctx.ui.select(
					"Memory categories - pick to cycle   \u2713 extract   \u25cb neutral   \u2717 exclude",
					options,
				);
				if (!choice || choice === DONE) break;
				if (choice === ADD) {
					const key = (
						await ctx.ui.input("Category key (letters, no spaces)", "security")
					)?.trim();
					if (!key) continue;
					const label =
						(await ctx.ui.input("Display name", key))?.trim() || key;
					const clause =
						(
							await ctx.ui.input(
								"What to extract (one sentence)",
								"Security-relevant findings: auth flows, where secrets live",
							)
						)?.trim() || "";
					const fc = { ...(cfg.factCategories ?? {}) };
					const custom = Array.isArray(fc.custom)
						? [...(fc.custom as unknown[])]
						: [];
					custom.push({ key, label, clause, state: "on" });
					fc.custom = custom;
					cfg.factCategories = fc;
					patchConfigFile(cwd, { factCategories: fc });
					continue;
				}
				const idx = options.indexOf(choice);
				const c = cats[idx];
				if (!c) continue;
				const next: CatState =
					c.state === "off" ? "on" : c.state === "on" ? "ban" : "off";
				setState(c.key, next);
			}
			const enabled = resolveCategories(cfg)
				.filter((c) => c.state === "on")
				.map((c) => c.label);
			ctx.ui.notify(
				`${TAG} extracting: ${enabled.join(", ") || "(none)"}`,
				"info",
			);
		},
	});

	// --- recall effort (how thorough retrieval is) --------------------------
	pi.registerCommand("mem-effort", {
		description:
			"Memory: how thorough recall is \u2014 light | normal | thorough",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			appendDebug(cwd, "command.mem-effort", { args });
			const s = getState();
			if (!s) return ctx.ui.notify(`${TAG} not initialized`, "error");
			status.attach(ctx.ui);
			let val = args.trim().toLowerCase();
			if (val !== "light" && val !== "normal" && val !== "thorough") {
				const choice = await ctx.ui.select(
					`Recall effort (now: ${s.cfg.recallEffort})`,
					[
						"light - one quick lookup (1 query)",
						"normal - a few angles, one pass (2-3 queries)",
						"thorough - iterative, multiple rounds",
					],
				);
				if (!choice) return;
				val = choice.split(" ")[0];
			}
			const effort = parseEffort(val, s.cfg.recallEffort);
			s.cfg.recallEffort = effort;
			patchConfigFile(cwd, { recallEffort: effort });
			ctx.ui.notify(`${TAG} recall effort: ${effort}`, "info");
		},
	});

	// --- browser review -----------------------------------------------------
	pi.registerCommand("mem-review", {
		description:
			"Memory: review stored documents in the browser (approve / edit / delete)",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			appendDebug(cwd, "command.mem-review", { args });
			status.attach(ctx.ui);
			// `/mem-review stop` tears the server down; a bare call starts it (or
			// re-opens the existing one) and always notifies the URL.
			if (args.trim().toLowerCase() === "stop") {
				if (isReviewServerRunning()) {
					stopReviewServer();
					ctx.ui.notify(`${TAG} review server stopped`, "info");
				} else {
					ctx.ui.notify(`${TAG} review server is not running`, "info");
				}
				return;
			}
			try {
				const url = await startReviewServer();
				ctx.ui.notify(`${TAG} review open: ${url}`, "info");
			} catch (err) {
				appendDebug(cwd, "command.mem-review.error", {
					error: (err as Error).message,
				});
				ctx.ui.notify(
					`${TAG} could not start review server: ${(err as Error).message}`,
					"error",
				);
			}
		},
	});

	// --- history / status ---------------------------------------------------
	pi.registerCommand("mem-log", {
		description: "Memory: open the operation history",
		handler: async (_args, ctx) => openLog(ctx, getState()),
	});
	pi.registerShortcut("alt+h", {
		description: "Open memory history",
		handler: async (ctx) => openLog(ctx, getState()),
	});

	pi.registerCommand("mem-status", {
		description: "Memory: health check, bank, and pointer position",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			appendDebug(cwd, "command.mem-status.start");
			const s = getState();
			if (!s) return ctx.ui.notify(`${TAG} not initialized`, "error");
			try {
				const health = await s.client.health(ctx.signal);
				const banks = await s.client.listBanks(ctx.signal);
				await s.client.ensureBank();
				const st = loadState(ctx.sessionManager.getEntries());
				const saved = st.savedRanges?.length ?? 0;
				ctx.ui.notify(
					`${TAG} ok — bank "${s.cfg.bankId}" · pointer ${
						st.watermark ? "set" : "unset"
					} · recall ${runtime.autoRecall ? "on" : "off"} · retain ${
						runtime.autoMemorize ? "on" : "off"
					}${saved ? ` · ${saved} saved range(s)` : ""}`,
					"info",
				);
				console.log(`${TAG} health:`, preview(health));
				console.log(`${TAG} banks:`, preview(banks));
				appendDebug(cwd, "command.mem-status.done", { health, banks });
			} catch (err) {
				appendDebug(cwd, "command.mem-status.error", {
					error: (err as Error).message,
				});
				ctx.ui.notify(
					`${TAG} status failed: ${(err as Error).message}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("mem-recall", {
		description: "Memory: search memories (usage: /mem-recall <query>)",
		handler: async (args, ctx) => {
			appendDebug(ctx.cwd ?? process.cwd(), "command.mem-recall.start", {
				args,
			});
			const s = getState();
			if (!s) return ctx.ui.notify(`${TAG} not initialized`, "error");
			const query = args.trim();
			if (!query) return ctx.ui.notify("Usage: /mem-recall <query>", "error");
			try {
				const res = await s.client.recall(query, {}, ctx.signal);
				appendDebug(ctx.cwd ?? process.cwd(), "command.mem-recall.done", {
					response: res,
				});
				ctx.ui.notify(`${TAG} recall done (see log)`, "info");
				console.log(`${TAG} recall ->`, preview(res, 2000));
			} catch (err) {
				appendDebug(ctx.cwd ?? process.cwd(), "command.mem-recall.error", {
					error: (err as Error).message,
				});
				ctx.ui.notify(
					`${TAG} recall failed: ${(err as Error).message}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("mem-model", {
		description: "Memory: resolve the small model + run a tiny completion",
		handler: async (args, ctx: ExtensionContext) => {
			appendDebug(ctx.cwd ?? process.cwd(), "command.mem-model.start", {
				args,
			});
			const s = getState();
			if (!s) return ctx.ui.notify(`${TAG} not initialized`, "error");
			const resolved = resolveModel(ctx, s.cfg);
			if (!resolved) return ctx.ui.notify(`${TAG} no model available`, "error");
			const prompt = args.trim() || "Reply with exactly: OK";
			try {
				const out = await runModel(
					ctx,
					resolved,
					"You are terse. Follow the instruction literally.",
					prompt,
					{ maxTokens: 64, signal: ctx.signal },
				);
				appendDebug(ctx.cwd ?? process.cwd(), "command.mem-model.done", {
					model: resolved.label,
					output: out,
				});
				ctx.ui.notify(
					`${TAG} model ${resolved.label}: ${preview(out, 120)}`,
					"info",
				);
			} catch (err) {
				appendDebug(ctx.cwd ?? process.cwd(), "command.mem-model.error", {
					error: (err as Error).message,
				});
				ctx.ui.notify(
					`${TAG} model failed: ${(err as Error).message}`,
					"error",
				);
			}
		},
	});
}

async function openLog(ctx: ExtensionContext, s: State): Promise<void> {
	appendDebug(ctx.cwd ?? process.cwd(), "command.mem-log.start", {
		initialized: !!s,
	});
	if (!s) return ctx.ui.notify(`${TAG} not initialized`, "error");
	try {
		await openHistory(ctx, s.cfg.logPath);
		appendDebug(ctx.cwd ?? process.cwd(), "command.mem-log.done");
	} catch (err) {
		appendDebug(ctx.cwd ?? process.cwd(), "command.mem-log.error", {
			error: (err as Error).message,
		});
		throw err;
	}
}

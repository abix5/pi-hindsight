import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { openMemPanel } from "./mem-panel.ts";
import { appendDebug } from "./log.ts";
import { type HindsightConfig, loadConfig } from "./config.ts";
import type { HindsightClient } from "./hindsight.ts";
import type { Memorizer } from "./memorize.ts";
import { resolveChain } from "./model.ts";
import { readDispatchDocIds, saveState } from "./state.ts";
import type { HindsightStatus } from "./ui.ts";

/** Brain-prefixed toast, keeping the backend name out of the UI. */
const TAG = "\uD83E\uDDE0";

/**
 * Shown when a memory command runs in a project with no declared bank. The whole
 * plugin is gated on `cfg.active`; the ONE way to activate is the /mem panel's
 * Settings tab, so every command except /mem points the user there.
 */
const INACTIVE = `${TAG} no memory bank configured for this project — run /mem and set a bank id in Settings to activate`;

function preview(value: unknown, max = 800): string {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	if (!s) return "(empty)";
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

type State = { cfg: HindsightConfig; client: HindsightClient } | undefined;

/** Session-level switches + pending /mem-retain capture, shared with index.ts. */
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
	// --- dashboard hub ------------------------------------------------------
	// The single entry to Status / Settings / Review / Log. This is the ONLY
	// command that must work while the plugin is inactive: its Settings tab is
	// exactly where the user declares a bank id to activate the plugin, so it
	// deliberately never checks `cfg.active`.
	pi.registerCommand("mem", {
		description:
			"Memory: open the dashboard (status \u00b7 settings \u00b7 review \u00b7 log)",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			appendDebug(cwd, "command.mem", { args });
			status.attach(ctx.ui);
			const s = getState();
			if (!s) return ctx.ui.notify(`${TAG} not initialized`, "error");
			try {
				await openMemPanel(ctx, {
					cwd,
					loadCfg: () => loadConfig(cwd),
					client: s.client,
					modelChains: () => ({
						recall: resolveChain(ctx, s.cfg, "recall")?.label ?? "(none)",
						retain: resolveChain(ctx, s.cfg, "retain")?.label ?? "(none)",
					}),
				});
			} catch (err) {
				appendDebug(cwd, "command.mem.error", {
					error: (err as Error).message,
				});
				ctx.ui.notify(
					`${TAG} could not open the panel: ${(err as Error).message}`,
					"error",
				);
			}
		},
	});

	// --- write now ----------------------------------------------------------
	pi.registerCommand("mem-save", {
		description:
			"Memory: save the accumulated context to memory now (/mem-save all re-collects the WHOLE session)",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			appendDebug(cwd, "command.mem-save", { args });
			const s = getState();
			if (!s) return ctx.ui.notify(`${TAG} not initialized`, "error");
			if (!s.cfg.active) return ctx.ui.notify(INACTIVE, "info");
			const memorizer = getMemorizer();
			if (!memorizer) return ctx.ui.notify(`${TAG} not initialized`, "error");
			status.attach(ctx.ui);
			// `/mem-save all` = re-collect the whole session ignoring the pointer.
			// Delete documents this session previously stored so the fromStart
			// re-collect does not pile duplicates on top of them. Best-effort: read the
			// append-only dispatch log, keep docIds for THIS session, delete each
			// (tolerates 404). Old/stale entries are harmless. We do NOT rewrite the log.
			if (args.trim().toLowerCase() === "all") {
				const sessionId = ctx.sessionManager.getSessionId() ?? "default";
				const docIds = readDispatchDocIds(
					cwd,
					s.cfg.dispatchLogPath,
					sessionId,
				);
				appendDebug(cwd, "command.mem-save.all.delete", {
					sessionId,
					docs: docIds.length,
				});
				for (const docId of docIds) {
					try {
						await s.client.deleteDocument(docId, ctx.signal);
						appendDebug(cwd, "command.mem-save.all.deleted", { docId });
					} catch (err) {
						appendDebug(cwd, "command.mem-save.all.delete_error", {
							docId,
							error: (err as Error).message,
						});
					}
				}
				memorizer.schedule(ctx, "resave", { fromStart: true });
				return ctx.ui.notify(`${TAG} re-collecting the whole session`, "info");
			}
			memorizer.schedule(ctx, "manual");
			ctx.ui.notify(`${TAG} save scheduled`, "info");
		},
	});

	// --- agent-driven retain ------------------------------------------------
	pi.registerCommand("mem-retain", {
		description:
			"Memory: have the agent study something and store it (usage: /mem-retain <what to learn>)",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			appendDebug(cwd, "command.mem-retain", { args });
			const s = getState();
			if (!s) return ctx.ui.notify(`${TAG} not initialized`, "error");
			if (!s.cfg.active) return ctx.ui.notify(INACTIVE, "info");
			const prompt = args.trim();
			if (!prompt)
				return ctx.ui.notify(
					"Usage: /mem-retain <what to study and remember>",
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
					customType: "mem-retain",
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
			const s = getState();
			if (!s || !s.cfg.active) return ctx.ui.notify(INACTIVE, "info");
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

	// --- recall -------------------------------------------------------------
	pi.registerCommand("mem-recall", {
		description: "Memory: search memories (usage: /mem-recall <query>)",
		handler: async (args, ctx) => {
			appendDebug(ctx.cwd ?? process.cwd(), "command.mem-recall.start", {
				args,
			});
			const s = getState();
			if (!s) return ctx.ui.notify(`${TAG} not initialized`, "error");
			if (!s.cfg.active) return ctx.ui.notify(INACTIVE, "info");
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

	// --- history (fast in-terminal view) ------------------------------------
	// alt+h jumps straight to the panel's Log tab equivalent without leaving the
	// keyboard; the same content also lives in /mem.
	pi.registerShortcut("alt+h", {
		description: "Open memory history",
		handler: async (ctx) => openLog(ctx, getState()),
	});
}

async function openLog(ctx: ExtensionContext, s: State): Promise<void> {
	appendDebug(ctx.cwd ?? process.cwd(), "command.mem-log.start", {
		initialized: !!s,
	});
	if (!s) return ctx.ui.notify(`${TAG} not initialized`, "error");
	const cwd = ctx.cwd ?? process.cwd();
	await openMemPanel(ctx, {
		cwd,
		loadCfg: () => loadConfig(cwd),
		client: s.client,
		modelChains: () => ({
			recall: resolveChain(ctx, s.cfg, "recall")?.label ?? "(none)",
			retain: resolveChain(ctx, s.cfg, "retain")?.label ?? "(none)",
		}),
	});
	appendDebug(cwd, "command.mem-log.done");
}

/** pi-hindsight: long-term project memory over local Hindsight. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type HindsightConfig, homeDir, loadConfig } from "./config.ts";
import { registerCommands } from "./commands.ts";
import { HindsightClient } from "./hindsight.ts";
import { appendDebug, appendLog, setDebugEnabled } from "./log.ts";
import { Memorizer } from "./memorize.ts";
import { resolveChain } from "./model.ts";
import { recallForTurn, type RecallInjectResult } from "./recall.ts";
import { DEEP_HEADER, FACTS_END, FACTS_HEADER } from "./recall-utils.ts";
import {
	forgetFullText,
	newReminderState,
	type Nudge,
	type ReminderGate,
	reminderDue,
	reminderLine,
	reminderStandalone,
	reminderTail,
	reminderText,
} from "./reminder.ts";
import { loadState, saveState } from "./state.ts";
import { newTaskState, type TaskState } from "./task-detector.ts";
import { registerTools } from "./tools.ts";
import { HindsightStatus } from "./ui.ts";
import {
	applyUserBlock,
	buildModelBlock,
	buildUserBlock,
	findMarkers,
	hasMarker,
	type MarkerSpec,
} from "./user-block.ts";

export function recallTrace(recall: RecallInjectResult, tail = ""): string {
	if (!recall.queried)
		return `\uD83E\uDDE0 recall\n- Bank query: not sent\n- Reason: ${recall.reason}`;
	const lines = [
		"\uD83E\uDDE0 recall",
		`- Bank query: ${recall.query || "(empty)"}`,
		`- Found in bank: ${recall.found} fact(s)`,
		`- Injected into context: ${recall.injected} fact(s)`,
	];
	// The fact text is UNTRUSTED memory (it may include text that originated from
	// past user/session content). Frame it so the main agent treats it as reference
	// data, never as instructions to follow.
	if (recall.text)
		lines.push(
			"",
			recall.synthesized ? DEEP_HEADER : FACTS_HEADER,
			recall.text,
			FACTS_END,
		);
	else lines.push("", `Injected facts: none (${recall.reason})`);
	if (tail) lines.push("", tail);
	return lines.join("\n");
}

/**
 * True when this pi process is an ephemeral subagent (e.g. a spawned agent phase),
 * which is always spawned with `--no-session`. In that mode we do not want the
 * memory extension at all: it has no UI, no session to memorize, and its hooks
 * and timers only add latency and lifecycle hazards to a throwaway process.
 */
function isEphemeralSubagent(): boolean {
	const argv = process.argv;
	return argv.includes("--no-session") || !!process.env.PI_TASKFLOW_NODE_ID;
}

/**
 * True when THIS module is the globally-installed / published copy (its file
 * lives under a `node_modules` tree), as opposed to a working-tree checkout.
 */
function isInstalledCopy(): boolean {
	try {
		return import.meta.url.includes("/node_modules/");
	} catch {
		return false;
	}
}

/**
 * True when this run asked for TOOLS-ONLY mode (`--mem-only-tools`).
 *
 * Read straight off argv rather than through `pi.getFlag`: flag VALUES are
 * applied by the runner AFTER every extension factory has run, so at load time
 * `getFlag` still returns undefined — and the whole point of this flag is to
 * decide, at load time, whether to install hooks and the widget at all.
 */
function onlyToolsRequested(): boolean {
	return process.argv.includes("--mem-only-tools");
}

/**
 * True when the current project is a DEV checkout of this plugin that loads its
 * own working-tree source via a local `.pi/extensions/hindsight.ts` loader.
 * Used so the globally-installed copy stands down here and the dev source wins,
 * instead of both loading and fighting over the widget (mode toggle: `make dev`
 * keeps the loader, `make global` renames it away).
 */
function localDevLoaderPresent(cwd: string): boolean {
	try {
		return (
			fs.existsSync(path.join(cwd, ".pi", "extensions", "hindsight.ts")) &&
			fs.existsSync(path.join(cwd, "src", "index.ts")) &&
			fs.existsSync(path.join(cwd, "src", "memorize.ts"))
		);
	} catch {
		return false;
	}
}

/**
 * Process-global disposer for the previous instance. pi can run this extension's
 * factory more than once in the SAME process (a stale copy after `/reload`, or
 * two discovery paths resolving to different file paths). Each run owns its own
 * status + background timer; without disposing the old one, the old timer keeps
 * rendering an OLD widget and the two fight = the widget "jumps" between
 * versions. We stash a disposer on globalThis so every new HOST run tears the
 * previous one down first, guaranteeing a single live widget writer.
 *
 * The handshake happens at session_start (not factory time): pi-extensible-
 * workflows runs its workflow agents as IN-PROCESS sessions that load
 * extensions again inside the host's process, and an agent instance must never
 * dispose the host's timer/widget/Memorizer. Only a session that decided it IS
 * the host (see isWorkflowAgentSession) touches this handle.
 */
type HindsightGlobal = {
	__piHindsightDispose?: () => void;
	/**
	 * Which FILE the instance holding the process was loaded from.
	 *
	 * A reload swaps the module but keeps the path; a second COPY of the
	 * extension has a different one. The two are indistinguishable from the
	 * disposer handle alone, and they need opposite treatment: a reload should
	 * take over, a second copy is a misconfiguration that no takeover can fix,
	 * because pi has no way to unregister the loser's hooks. It keeps answering
	 * events with its own code — which is how one project ended up writing memory
	 * twice per compaction and printing a message from a version that had been
	 * fixed weeks earlier.
	 */
	__piHindsightHome?: string;
};

/**
 * The tail of a module URL — enough to tell two copies apart in one line.
 *
 * The full `file:///Users/…/node_modules/@abix5/pi-hindsight/src/index.ts` would
 * wrap the notification into a paragraph, and the only part that distinguishes
 * the copies is the end of the path.
 */
function short(url: string): string {
	return url.split("/").slice(-3).join("/");
}

/**
 * True when this SESSION is an in-process workflow agent run from
 * pi-extensible-workflows (PEW). PEW labels every agent session
 * `${workflowName}:${label}:attempt-${n}` and installs the label via
 * `manager.appendSessionInfo()` BEFORE extensions load, so it is readable at
 * session_start through `ctx.sessionManager.getSessionName()` (also on resume:
 * the label persists in the session file).
 *
 * These sessions run in the HOST's own process — not a subprocess — so
 * argv/env checks (`--no-session`, `--mem-only-tools`) cannot see them. In
 * such a session the extension stands down: no widget, no timers, no
 * Memorizer, no automatic recall/retain — a workflow agent sees only a
 * fragment of the work, does not know the outcome, and runs again on every
 * retry, so automatic writes would poison the bank. The hindsight_* tools stay
 * registered so agents can still deliberately read (or write) memory.
 */
export function isWorkflowAgentSession(name: string | undefined): boolean {
	return typeof name === "string" && /^.+:.+:attempt-\d+$/.test(name);
}

export default function (pi: ExtensionAPI) {
	let cfg: HindsightConfig | undefined;
	let client: HindsightClient | undefined;
	const getState = () => (cfg && client ? { cfg, client } : undefined);

	// The second client exists only when a user bank was declared, so the default
	// config makes no extra client, no extra tool and no extra request. It is handed
	// straight to registerTools and nowhere else — in particular the Memorizer never
	// sees it, which is why the automatic write path cannot address the user bank.
	const userBankOf = (c: HindsightConfig | undefined) =>
		c?.userBankId
			? { cfg: c, client: new HindsightClient({ ...c, bankId: c.userBankId }) }
			: undefined;

	// Mode guard: when pi opens THIS plugin's own dev checkout, the project's
	// local `.pi/extensions/hindsight.ts` loads the working-tree source. If the
	// published package is ALSO installed globally, both copies would load in the
	// same process and fight over the widget. So the globally-installed copy
	// stands down whenever a local dev loader is present — the dev source wins.
	// (`make global` renames the loader away to force the published copy instead.)
	//
	// This runs BEFORE `registerFlag`: registering the same flag from two copies
	// is itself a hard load error, so standing down after registration is too late.
	if (isInstalledCopy() && localDevLoaderPresent(process.cwd())) {
		return;
	}

	// `--mem-only-tools` (and the ephemeral-subagent case below) select TOOLS-ONLY
	// mode. Read off argv rather than `pi.getFlag`, so registration order does not
	// matter for the checks below.
	pi.registerFlag("mem-only-tools", {
		description:
			"Memory: register the hindsight_* tools only — no widget, hooks, commands, timers, or automatic recall/retain",
		type: "boolean",
	});

	// Tools-only mode. Two ways in:
	//   * `--mem-only-tools` — explicit, for workflow subtasks and scripted runs.
	//   * an ephemeral subagent (`pi --no-session`) — a throwaway process with no
	//     UI and no session to memorize.
	// Either way the process gets the bank tools and NOTHING else: no widget, no
	// background timers, no session hooks, no commands, no singleton guard. The
	// tools still read the normal config layers, so a declared bank is used when
	// there is one (and they report "not initialized" when there is not).
	if (onlyToolsRequested() || isEphemeralSubagent()) {
		try {
			cfg = loadConfig(process.cwd());
			client = new HindsightClient(cfg);
			setDebugEnabled(cfg.debug);
		} catch {
			/* getState stays undefined; tools then report "not initialized" */
		}
		registerTools(pi, getState, userBankOf(cfg));
		return;
	}

	// Stand-down state for in-process PEW workflow agent sessions. Decided at
	// session_start (the earliest point where the session label is readable);
	// every auto hook checks it first. Per-instance closure state on purpose:
	// the module may be cached and shared between the host's loader and an
	// agent's loader, so a truly module-global flag could leak the agent's
	// stand-down into the host's hooks.
	let standDown = false;

	let memorizer: Memorizer | undefined;
	let countsTimer: ReturnType<typeof setInterval> | undefined;
	const status = new HindsightStatus();

	// Task-detector state: extension memory, never the pi session file. Held in
	// this instance's closure and keyed by session id, so it cannot leak between
	// sessions and a `/reload` (fresh instance) simply starts a fresh history —
	// which reads as "first turn of a session" and does one deep pass.
	const task: TaskState = newTaskState();

	// Bank-reminder state, same per-instance/per-session discipline as `task`.
	const reminder = newReminderState();
	const reminderGate = (
		config: HindsightConfig,
		recalled: boolean,
	): ReminderGate => ({
		enabled: config.bankReminder,
		everyTurns: config.bankReminderTurns,
		active: config.active,
		autoRecall: runtime.autoRecall,
		recalled,
	});
	const nudgeText = (config: HindsightConfig, kind: Nudge): string => {
		if (kind === "full")
			return reminderText(config.bankId, bankCounts, config.memoryLanguage);
		if (kind === "short")
			return reminderLine(config.bankId, config.memoryLanguage);
		return "";
	};
	// Explicit hand-off between the two before_agent_start handlers below. The
	// runner awaits handlers in registration order, so the recall one has already
	// decided by the time the reminder one runs: an injected recall block IS the
	// tools being mentioned, and the reminder must not stack a nudge on top of it.
	let recallInjected = false;
	// Last successful stats poll, so the reminder can say how big the bank is
	// without a request of its own — it must never touch the network.
	let bankCounts: { documents: number; facts: number } | undefined;

	// --- the user-profile epoch --------------------------------------------
	//
	// The user block is injected into the SYSTEM PROMPT, whose prefix the provider
	// caches: rewriting it costs an order of magnitude more than reading it, so the
	// block is read ONCE at an epoch boundary, frozen, and re-emitted byte for byte
	// on every turn of that epoch. There are exactly two boundaries — session start
	// and a SUCCESSFUL compaction. `session_before_compact` is not one: it can be
	// cancelled by any handler returning {cancel:true}, and a boundary that may not
	// happen would change the prompt mid-epoch.
	//
	// Closure state, not a file and not the session: an epoch lasts exactly as long
	// as this extension instance, so `/reload` correctly starts a fresh one.
	let userBlock: string | undefined;
	let userBlockFacts = 0;
	// Raised by a write to the user bank inside the epoch: the frozen block and the
	// bank have diverged. It changes nothing in the prompt — swapping the block in
	// now is exactly the mid-epoch rewrite this design exists to avoid — but the
	// user is owed the fact that what they just stored lands at the next boundary.
	let userBlockStale = false;
	/**
	 * The epoch's answer to "does this session inject at all", and whether it has
	 * been taken yet.
	 *
	 * Taken on the epoch's FIRST turn, because a boundary has no prompt to look at,
	 * and then held. The bytes of the block are frozen; the decision to use them has
	 * to be frozen with them, or a marker that appears mid-epoch would add the block
	 * to the cached prefix between two turns — the rewrite this whole contour exists
	 * to avoid, arriving through the one door left open.
	 */
	let epochDecided = false;
	let epochInjects = false;

	/**
	 * Has this session already been told the user block is not working?
	 *
	 * Once per session, not once per epoch. `notify(_, "warning")` is not a toast:
	 * pi appends it to the chat container as `Warning: …`, so it stays in the
	 * scrollback, and repeating it at every compaction would litter the very
	 * transcript the person is reading. The widget is what keeps saying it, every
	 * turn, for free.
	 */
	let userBlockWarned = false;

	type NotifyUi = {
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};

	/**
	 * Tell the PERSON, once, and never the model.
	 *
	 * A marker that could not be answered is a human mistake or a server that is
	 * down; either way the model can do nothing about it, and putting it in the
	 * context would spend tokens asking it to fix a file it did not write. It is
	 * always a warning and never an error: the session continues, just without the
	 * block. pi stamps the word `Warning:` itself, so the text carries only the
	 * substance — one line, no ANSI, no newlines.
	 */
	const warnUser = (ui: NotifyUi | undefined, what: string): void => {
		if (userBlockWarned) return;
		userBlockWarned = true;
		ui?.notify?.(
			`pi-hindsight: ${what} \u2014 nothing injected this session`,
			"warning",
		);
	};
	// Rows the bank may return for the block. Generous next to the size ceiling that
	// actually bounds it, so the ceiling — not the page size — decides what is kept.
	const USER_BLOCK_LIMIT = 200;
	// Deliberately long. An instructions block that silently comes up empty is worse
	// than a slow session start, and this wait happens twice a session at most.
	const USER_BLOCK_CEILING_MS = 12000;

	/**
	 * The spec of the last marker seen in a system prompt of this session.
	 *
	 * Set from the turn hook, read at the next boundary. It is what keeps the file
	 * probe below from being a trap: a marker that arrives from anywhere the probe
	 * does not know about costs one boundary of delay, not the feature.
	 */
	let markerSeen: MarkerSpec | undefined;

	/**
	 * What the instructions ask for, including the case where they ask badly.
	 *
	 * `broken` is not the same answer as `none`: one is a person who wrote a marker
	 * and deserves to be told it was not understood, the other is a project that
	 * never asked for anything and must be left in silence.
	 */
	type Ask =
		| { kind: "none" }
		| { kind: "broken"; where: string }
		| { kind: "ask"; spec: MarkerSpec };

	/**
	 * What, if anything, this session's instructions ask for.
	 *
	 * A boundary has no prompt yet — it happens before the first turn — so the only
	 * way to answer is the instruction files whose text pi inlines verbatim: the
	 * project's own AGENTS.md and the global ~/.pi/agent/AGENTS.md. This does NOT
	 * move the substitution: that still keys on the assembled prompt, which is what
	 * makes the marker work wherever it ends up. It decides two things — whether to
	 * spend a bank request at all, and which of the bank's answers to ask for.
	 *
	 * The first parsed marker wins. Several markers with different selectors would
	 * be several different blocks, and this contour freezes exactly one per epoch;
	 * answering the first is predictable, while merging them would not be.
	 */
	const markerAsk = (cwd: string): Ask => {
		if (markerSeen) return { kind: "ask", spec: markerSeen };
		let broken: { kind: "broken"; where: string } | undefined;
		for (const file of [
			path.join(cwd, "AGENTS.md"),
			path.join(homeDir(), ".pi", "agent", "AGENTS.md"),
		]) {
			try {
				const hits = findMarkers(fs.readFileSync(file, "utf8"));
				const good = hits.find((h) => h.spec);
				if (good?.spec) return { kind: "ask", spec: good.spec };
				// Remembered, not returned yet: a later file may still carry a marker
				// that works, and a working marker beats a broken one anywhere else.
				const bad = hits.find((h) => !h.spec);
				if (bad && !broken)
					broken = { kind: "broken", where: `${file}:${bad.from + 1}` };
			} catch {
				/* absent or unreadable: no marker to be had here */
			}
		}
		return broken ?? { kind: "none" };
	};

	/**
	 * Open an epoch: read the user bank once and freeze what it yields.
	 *
	 * A failed, timed-out or erroring read assigns NOTHING, so the previous epoch's
	 * block simply stays in force; when there is no previous block, the state stays
	 * "no block" and the prompt is left untouched, marker and all.
	 */
	const openUserEpoch = async (
		cwd: string,
		reason: string,
		ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void },
	) => {
		// A new epoch retakes the decision — including after a failed read, where the
		// previous block stays in force but this session may now carry the marker.
		epochDecided = false;
		if (standDown) return;
		const ub = userBankOf(cfg);
		if (!ub) return; // no user bank declared: no request, no widget, no injection
		const ask = markerAsk(cwd);
		if (ask.kind === "none") {
			appendDebug(cwd, "userblock.epoch.nomarker", { reason });
			return;
		}
		if (ask.kind === "broken") {
			appendDebug(cwd, "userblock.epoch.badmarker", { reason, at: ask.where });
			warnUser(ui, `marker at ${ask.where} was not understood`);
			return;
		}
		const { spec } = ask;
		try {
			let block: { text: string; facts: number } | undefined;
			if (spec.model) {
				// One GET of an answer the server already assembled and keeps fresh on
				// its own trigger. Nothing reasons here, so the boundary pays a request
				// and not a generation.
				block = buildModelBlock(
					await ub.client.mentalModel(
						spec.model,
						undefined,
						USER_BLOCK_CEILING_MS,
					),
				);
				if (!block)
					warnUser(ui, `mental model "${spec.model}" has no content yet`);
			} else if (spec.query) {
				block = buildUserBlock(
					await ub.client.recall(spec.query, {}, undefined),
					spec.limit,
				);
			} else {
				block = buildUserBlock(
					await ub.client.listMemories(
						USER_BLOCK_LIMIT,
						undefined,
						USER_BLOCK_CEILING_MS,
					),
				);
			}
			userBlock = block?.text;
			userBlockFacts = block?.facts ?? 0;
			userBlockStale = false; // the frozen block and the bank agree again
			const from = spec.model ? "model" : spec.query ? "query" : "facts";
			appendDebug(cwd, "userblock.epoch", {
				reason,
				from,
				facts: userBlockFacts,
				chars: userBlock?.length ?? 0,
			});
		} catch (err) {
			// Nothing is assigned, so a block from an earlier boundary of THIS session
			// stays in force — a stale answer beats an empty one, and the widget says
			// it is stale. A fresh process has no such cache, and then the marker is
			// simply blanked and the person told once.
			appendDebug(cwd, "userblock.epoch.error", {
				reason,
				error: (err as Error).message,
				kept: userBlockFacts,
			});
			if (userBlock) userBlockStale = true;
			else
				warnUser(
					ui,
					`bank "${cfg?.userBankId}" did not answer (${(err as Error).message})`,
				);
		}
	};

	const onUserBankWrite = () => {
		if (standDown || !cfg?.userBankId) return;
		userBlockStale = true;
		status.userBlock({
			injected: !!userBlock,
			facts: userBlockFacts,
			stale: true,
		});
	};

	// Recall runs in `before_agent_start` so its result can be injected as a VISIBLE
	// custom_message block (the only entry type that both renders in the TUI and
	// reaches the model). That phase is pre-turn/preflight: the agent loop has not
	// started, so `ctx.signal` is NOT wired to Esc here and `emitBeforeAgentStart`
	// swallows handler errors — i.e. Esc CANNOT cancel the bank call mid-flight; the
	// widget says so ("waiting for bank… (until it answers)"). The ceiling only stops
	// a stuck bank from hanging the turn start forever.
	const RECALL_CEILING_MS = 30000;
	// Session-level runtime state that commands can flip WITHOUT editing config:
	// the auto-recall / auto-memorize switches (default from config), and the
	// pending /mem-retain capture (set by the command, closed on the next
	// turn_end to record the stored range).
	const runtime = {
		autoRecall: true,
		autoMemorize: true,
		pendingRemember: undefined as { startId: string } | undefined,
	};

	// THIS instance's disposer. Registered on globalThis only once this instance
	// has decided it is a HOST session (in session_start), so a workflow agent
	// instance never overwrites — or triggers — the host's disposer.
	const disposeSelf = () => {
		if (countsTimer) clearInterval(countsTimer);
		countsTimer = undefined;
		memorizer?.dispose();
		status.clear();
	};

	// Refresh the widget doc/fact counters in the background. retain is async on
	// the server, so counts settle a little after a write — poll instead of blocking.
	const refreshCounts = async () => {
		// Inactive projects have no declared bank; skip so a failed stats call cannot
		// flip the (hidden) widget back on.
		if (!client || !cfg?.active) return;
		try {
			const s = await client.stats();
			// A successful stats call proves the bank is reachable, so keep the resting
			// dot green even if the initial ensureBank was slow or briefly failed.
			status.bankOk();
			bankCounts = { documents: s.documents, facts: s.facts };
			status.setBankCounts(s.documents, s.facts);
		} catch {
			/* counts are best-effort */
		}
	};

	const init = (cwd: string) => {
		cfg = loadConfig(cwd);
		client = new HindsightClient(cfg);
		setDebugEnabled(cfg.debug);
		// Retire the previous Memorizer before creating a new one.
		memorizer?.dispose();
		// The automatic write path is handed a config with the user bank BLANKED
		// out, so there is nothing there to address it with — the ban is structural,
		// not a convention. Blanking the field beats narrowing MemorizeDeps to a
		// subset type: the Memorizer reads a dozen config keys, and a narrower type
		// would ripple through every helper signature in memorize.ts for the same
		// guarantee.
		const autoCfg: HindsightConfig = { ...cfg, userBankId: "" };
		memorizer = new Memorizer({ pi, cfg: autoCfg, client, status });
		// Gate the widget on activation: with no declared bank, keep the row hidden so
		// unrelated projects are not cluttered by a memory widget.
		if (cfg.active) status.setBank(cfg.bankId, cfg.baseUrl);
		else status.clear();
		runtime.autoRecall = cfg.autoRecall;
		runtime.autoMemorize = cfg.autoMemorize;
		runtime.autoRecall ? status.recallOn() : status.recallOff();
		if (!runtime.autoMemorize) status.memoOff();
		if (countsTimer) clearInterval(countsTimer);
		countsTimer = setInterval(refreshCounts, cfg.countsRefreshMs);
		// unref: a background timer must NEVER keep the host process alive. Without
		// this, any pi subprocess that loads this extension (e.g. a spawned subagent)
		// cannot exit after finishing its turn — it hangs until the idle-timeout kill.
		countsTimer.unref?.();
	};

	// Resolved at load time from the launch cwd: the tool list is fixed before the
	// first session starts, so it cannot be rebuilt from the session's config later.
	let loadCfg: HindsightConfig | undefined;
	try {
		loadCfg = loadConfig(process.cwd());
	} catch {
		/* no config readable here; the user tool simply is not offered */
	}
	registerTools(pi, getState, userBankOf(loadCfg), onUserBankWrite);
	registerCommands(pi, getState, () => memorizer, status, runtime);

	pi.on("session_start", async (_event, ctx) => {
		const sessionName = ctx.sessionManager?.getSessionName?.();
		standDown = isWorkflowAgentSession(sessionName);
		if (standDown) {
			// In-process workflow agent: initialize NOTHING (no widget, no timers,
			// no Memorizer) and leave the host's global disposer untouched. Load
			// config + client only, so the registered hindsight_* tools still work
			// (agents may read memory deliberately via hindsight_recall).
			try {
				cfg = loadConfig(ctx.cwd ?? process.cwd());
				client = new HindsightClient(cfg);
				setDebugEnabled(cfg.debug);
			} catch {
				/* getState stays undefined; tools then report "not initialized" */
			}
			appendDebug(ctx.cwd ?? process.cwd(), "event.session_start.standdown", {
				sessionName,
			});
			return;
		}
		// Host session: tear down any previous HOST instance still alive in this
		// process, then take over the global disposer handle.
		const g = globalThis as unknown as HindsightGlobal;
		// Two COPIES of the extension in one process (typically a project-local
		// loader plus the globally installed package) both register hooks, and pi
		// offers no way to unregister the loser's. Taking over would hide that: the
		// loser keeps writing memory and printing its own, possibly ancient, output
		// while the widget shows the winner. Nothing in code can fix it, so say it
		// out loud instead of leaving the person to explain a ghost.
		const home = import.meta.url;
		if (g.__piHindsightHome && g.__piHindsightHome !== home) {
			appendDebug(ctx.cwd ?? process.cwd(), "event.session_start.duplicate", {
				mine: home,
				other: g.__piHindsightHome,
			});
			ctx.ui?.notify?.(
				`\uD83E\uDDE0 two copies of pi-hindsight are loaded in this session (${short(g.__piHindsightHome)} and ${short(home)}) \u2014 memory is written twice; disable one (make global, or pi remove npm:@abix5/pi-hindsight)`,
				"warning",
			);
		}
		g.__piHindsightHome = home;
		if (g.__piHindsightDispose && g.__piHindsightDispose !== disposeSelf) {
			try {
				g.__piHindsightDispose();
			} catch {
				/* best effort */
			}
		}
		g.__piHindsightDispose = disposeSelf;
		init(ctx.cwd ?? process.cwd());
		appendDebug(ctx.cwd ?? process.cwd(), "event.session_start", {
			cwd: ctx.cwd ?? process.cwd(),
			bankId: cfg?.bankId,
			autoRecall: cfg?.autoRecall,
			autoMemorize: cfg?.autoMemorize,
		});
		status.attach(ctx.ui);
		if (!cfg || !client) return;
		// First epoch boundary. Awaited: the runner awaits session_start handlers, so
		// the block is frozen before the session's first turn can ask for it. It runs
		// before the activation check on purpose — what the user bank knows about the
		// person holds in every repository, including one with no project bank.
		await openUserEpoch(ctx.cwd ?? process.cwd(), "session_start", ctx.ui);
		// Inactive project (no declared bank): do NOT ensureBank / sync missions /
		// count / notify. Just hide the widget and bail — this is not an error.
		if (!cfg.active) {
			status.clear();
			return;
		}
		status.bankChecking();
		try {
			await client.ensureBank();
			status.bankOk();
			// Best-effort: sync the bank's extraction levers to our config. A failure
			// must never break init, so the whole sync is wrapped in try/catch.
			try {
				const bankCfg = (await client.getBankConfig(ctx.signal)) as
					| { overrides?: Record<string, unknown> }
					| undefined;
				const overrides = bankCfg?.overrides ?? {};
				const updates: Record<string, unknown> = {};
				if (overrides.retain_mission !== cfg.retainMission)
					updates.retain_mission = cfg.retainMission;
				if (overrides.observations_mission !== cfg.observationsMission)
					updates.observations_mission = cfg.observationsMission;
				if (Object.keys(updates).length > 0) {
					await client.updateBankConfig(updates, ctx.signal);
					appendDebug(ctx.cwd ?? process.cwd(), "bank.mission.sync", {
						updated: Object.keys(updates),
					});
				}
			} catch (err) {
				appendDebug(ctx.cwd ?? process.cwd(), "bank.mission.error", {
					error: (err as Error).message,
				});
			}
			try {
				const s = await client.stats(ctx.signal);
				bankCounts = { documents: s.documents, facts: s.facts };
				status.setBankCounts(s.documents, s.facts);
			} catch {
				/* counts are best-effort */
			}
			ctx.ui?.notify?.(`\uD83E\uDDE0 bank "${cfg.bankId}" ready`, "info");
		} catch (err) {
			status.bankError((err as Error).message);
			ctx.ui?.notify?.(
				`\uD83E\uDDE0 bank ensure failed: ${(err as Error).message}`,
				"warning",
			);
		}
	});

	// The second epoch boundary: a compaction that actually happened. Its cancellable
	// sibling `session_before_compact` is deliberately not used — a handler can still
	// return {cancel:true} there, and re-reading the bank for a compaction that never
	// occurs would swap the block in the middle of a live epoch.
	pi.on("session_compact", async (event, ctx) => {
		if (standDown) return;
		await openUserEpoch(
			ctx.cwd ?? process.cwd(),
			`compact:${event.reason}`,
			ctx.ui,
		);
	});

	// Inject the frozen user block into the system prompt.
	//
	// Pure local string work: the bank is never read here, only at a boundary, so
	// the turn path waits on nothing. It returns ONLY a systemPrompt and never a
	// message, which is what keeps "at most one 🧠 block per turn" intact.
	//
	// Its own handler rather than a branch inside the recall one below: recall bows
	// out when auto-recall is off, when the project declares no bank, or when no
	// model chain resolves — and none of those should decide whether the person's
	// standing facts are in the prompt.
	pi.on("before_agent_start", async (event, _ctx) => {
		if (standDown || !cfg?.userBankId) return;
		// Remembered for the NEXT boundary, never acted on here: reading the bank
		// now is the mid-epoch prompt rewrite this whole design exists to avoid. The
		// spec is kept, not just the fact that a marker exists, so a marker reaching
		// the prompt from somewhere the file probe cannot see still says WHICH answer
		// it wants.
		const asked = findMarkers(event.systemPrompt ?? "").find((h) => h.spec)?.spec;
		if (asked) markerSeen = asked;
		if (!epochDecided) {
			epochDecided = true;
			// The decision is only whether this epoch OWNS the marker, not whether it
			// has anything to put there. A marker with no answer is still ours: it gets
			// blanked, so the model never reads a note addressed to this extension.
			epochInjects = hasMarker(event.systemPrompt ?? "");
		}
		const next = epochInjects
			? applyUserBlock(event.systemPrompt ?? "", userBlock)
			: undefined;
		// The widget reports what actually happened to THIS prompt, not what was read
		// at the boundary: a marker the epoch answered with nothing is a different
		// state from a project that never asked, and saying otherwise would be a lie
		// the user cannot check.
		status.userBlock({
			injected: next !== undefined && !!userBlock,
			blank: next !== undefined && !userBlock,
			facts: userBlockFacts,
			stale: userBlockStale,
		});
		// No marker in the instructions means no opinion about the prompt: returning
		// nothing leaves the host's own string in place, byte for byte.
		return next === undefined ? undefined : { systemPrompt: next };
	});

	// Pre-turn recall: query the bank and return a VISIBLE recall block that both
	// renders in the TUI and reaches the model (a custom_message). This runs in
	// preflight, so Esc does NOT cancel the bank call here — the widget says the
	// wait clears only when the bank answers. The ceiling stops a stuck bank from
	// hanging the turn start forever.
	pi.on("before_agent_start", async (event, ctx) => {
		if (standDown) return;
		recallInjected = false; // this turn, until proven otherwise below
		appendDebug(ctx.cwd ?? process.cwd(), "event.before_agent_start", {
			promptChars: event.prompt.length,
			autoRecall: cfg?.autoRecall,
			hasClient: !!client,
		});
		status.attach(ctx.ui);
		if (!runtime.autoRecall || !cfg || !client || !cfg.active) {
			status.recallOff();
			return;
		}
		const chain = resolveChain(ctx, cfg, "recall");
		if (!chain) {
			status.recallDone(0);
			return;
		}
		status.recallStart(); // widget: "waiting for bank… (clears when it answers)"
		const cwd = ctx.cwd ?? process.cwd();
		// Best-effort abort wiring + hard ceiling. Esc is not reliably delivered in
		// preflight, so the ceiling is the real guard against a stuck bank.
		const ac = new AbortController();
		const onAbort = () => ac.abort();
		ctx.signal?.addEventListener("abort", onAbort, { once: true });
		const ceiling = setTimeout(() => ac.abort(), RECALL_CEILING_MS);
		try {
			const { recall, boundary } = await recallForTurn({
				ctx,
				cfg,
				client,
				chain,
				prompt: event.prompt,
				signal: ac.signal,
				task,
			});
			status.recallOutcome({
				op: recall.operation,
				query: recall.query,
				found: recall.found,
				injected: recall.injected,
				queried: recall.queried,
				reason: recall.reason,
			});
			const skipped = recall.skippedSeen + recall.skippedFiltered;
			appendLog(cwd, cfg.logPath, {
				type: recall.operation === "reflect" ? "reflect" : "recall",
				user: event.prompt,
				query: recall.query,
				operation: recall.operation,
				filter: cfg.recallFilter,
				found: recall.found,
				injected: recall.injected,
				skipped,
				reason: recall.reason,
				injectedText: recall.text,
				rawHits: recall.rawHits,
			});
			if (recall.queried && recall.text) {
				recallInjected = true;
				// The nudge rides in this block's tail, so it can never become a
				// second one.
				const tail = reminderTail(
					reminder,
					ctx.sessionManager?.getSessionId?.(),
					reminderGate(cfg, true),
					boundary,
				);
				return {
					message: {
						customType: "mem-recall",
						content: recallTrace(recall, nudgeText(cfg, tail)),
						display: true,
					},
				};
			}
		} catch (err) {
			appendDebug(cwd, "event.before_agent_start.error", {
				error: (err as Error).message,
				aborted: ac.signal.aborted,
			});
			status.recallDone(0);
		} finally {
			clearTimeout(ceiling);
			ctx.signal?.removeEventListener("abort", onAbort);
		}
	});

	// The standalone nudge — the ONE case a tail cannot cover: recall stayed
	// silent this turn, so there was no block to ride in. Its own handler on
	// purpose: the runner collects a message from EVERY before_agent_start handler,
	// so it can still fire on turns where the recall handler returned nothing — and
	// it is pure local string work, so it adds nothing to the hot path.
	//
	// `recalled: recallInjected` is what makes two 🧠 blocks impossible: the turn
	// that injected a recall block can never also owe a standalone one.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (standDown || !cfg) return;
		const due = reminderDue(
			reminder,
			ctx.sessionManager?.getSessionId?.(),
			reminderGate(cfg, recallInjected),
		);
		if (!due) return;
		return {
			message: {
				customType: "mem-reminder",
				content: `\uD83E\uDDE0 ${nudgeText(cfg, reminderStandalone(reminder))}`,
				display: true,
			},
		};
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (standDown) return;
		// The transcript is about to be replaced: any full reminder text upstream
		// goes with it, so the next nudge must carry it again rather than abbreviate.
		forgetFullText(reminder);
		const cwd = ctx.cwd ?? process.cwd();
		// firstKeptEntryId marks the compaction boundary: everything BEFORE it is
		// summarized away, the tail from it onward stays live. We memorize exactly
		// that discarded window so the still-live tail is not ingested now (and then
		// re-ingested, paraphrased, on the next compaction).
		const boundaryId = event.preparation?.firstKeptEntryId;
		appendDebug(cwd, "event.session_before_compact", {
			autoMemorize: cfg?.autoMemorize,
			hasMemorizer: !!memorizer,
			boundaryId,
			reason: event.reason,
		});
		status.attach(ctx.ui);
		// Fire-and-forget: schedule() snapshots the pre-compaction delta synchronously,
		// and the bank write runs server-side async, so compaction never waits on us.
		if (runtime.autoMemorize && cfg?.active)
			memorizer?.schedule(ctx, "compact", { boundaryId });
		appendDebug(cwd, "event.session_before_compact.done");
	});

	// Close out a /mem-retain capture: the command recorded the entry id BEFORE
	// its study turn; when that turn ends we record (start, end] as a saved range so
	// the next memorize wraps it in ALREADY-SAVED markers and does not re-extract it.
	pi.on("turn_end", async (_event, ctx) => {
		if (standDown) return;
		if (!runtime.pendingRemember) return;
		const { startId } = runtime.pendingRemember;
		runtime.pendingRemember = undefined;
		const cwd = ctx.cwd ?? process.cwd();
		try {
			const entries = ctx.sessionManager.getEntries();
			const endId = entries[entries.length - 1]?.id;
			if (!endId || endId === startId) return; // nothing was added
			const ranges = loadState(entries).savedRanges ?? [];
			ranges.push({ start: startId, end: endId });
			saveState(pi, { savedRanges: ranges });
			appendDebug(cwd, "memremember.range", {
				startId,
				endId,
				ranges: ranges.length,
			});
		} catch (err) {
			appendDebug(cwd, "memremember.range.error", {
				error: (err as Error).message,
			});
		}
	});

	// Last-chance memory write on session teardown, so the un-memorized tail is not
	// lost when a session is quit or replaced by /new WITHOUT a compaction.
	// session_shutdown handlers are awaited before process exit (runner.emit), so
	// the async write completes first — bounded by a 60s cap so quitting can
	// never hang.
	pi.on("session_shutdown", async (event, ctx) => {
		if (standDown) return;
		const cwd = ctx.cwd ?? process.cwd();
		appendDebug(cwd, "event.session_shutdown", {
			reason: event.reason,
			autoMemorize: cfg?.autoMemorize,
			hasMemorizer: !!memorizer,
		});
		// Only when the tail is actually abandoned. reload keeps the same transcript
		// (nothing lost); resume/fork continue it elsewhere.
		if (event.reason !== "quit" && event.reason !== "new") return;
		if (!runtime.autoMemorize || !memorizer || !client || !cfg?.active) return;
		// On quit the TUI is already stopped, so the widget and message blocks cannot
		// render — print one plain line so the user knows a write is in progress.
		if (event.reason === "quit") {
			try {
				process.stdout.write("\uD83E\uDDE0 saving memory before exit\u2026\n");
			} catch {
				/* stdout may be gone on a dead terminal */
			}
		}
		try {
			status.attach(ctx.ui);
		} catch {
			/* UI may already be torn down */
		}
		const CAP_MS = 60_000;
		let capTimer: ReturnType<typeof setTimeout> | undefined;
		const cap = new Promise<void>((resolve) => {
			capTimer = setTimeout(() => {
				appendDebug(cwd, "event.session_shutdown.timeout", { capMs: CAP_MS });
				resolve();
			}, CAP_MS);
		});
		try {
			await Promise.race([
				memorizer.schedule(ctx, `shutdown:${event.reason}`),
				cap,
			]);
		} catch (err) {
			appendDebug(cwd, "event.session_shutdown.error", {
				error: (err as Error).message,
			});
		} finally {
			if (capTimer) clearTimeout(capTimer);
		}
		appendDebug(cwd, "event.session_shutdown.done", { reason: event.reason });
	});
}

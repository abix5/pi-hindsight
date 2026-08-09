/**
 * Bank reminder.
 *
 * The main agent is the best judge of when it needs memory — it reads the whole
 * conversation — but it forgets the hindsight_* tools exist after a dozen turns,
 * and an unremembered tool is a dead tool. So a nudge rides along periodically.
 *
 * ONE 🧠 block per turn, ever. The nudge is therefore not a block of its own by
 * default: it rides in the TAIL of the recall block, which is the only place it
 * cannot become a second block. A standalone block survives for exactly the case
 * a tail cannot cover — recall stayed silent, so there was no block to attach to.
 *
 *   session start / after a compaction → recall block + FULL text in its tail
 *   task boundary (detector verdict)   → recall block + one SHORT line
 *   ordinary turn                      → recall block alone
 *   N consecutive turns, no block      → standalone block (short if the full text
 *                                        is still upstream, full if not)
 *
 * Forgetting is a function of turns since the tools were last MENTIONED, not of
 * task identity — so the counter is not reset on the task-detector's boundary.
 * An injected recall block re-arms the counter anyway, and deliberately: it does
 * NOT name the tools (it carries a query trace and bank facts, never
 * `hindsight_recall` / `hindsight_retain`), but it is a visible 🧠 block, and the
 * one-block-per-turn invariant is worth more than a nudge that would have to
 * become a second block to be delivered. So the counter measures CONSECUTIVE
 * turns with NO memory block of any kind; when a recall block IS injected, the
 * tail rides inside it and that is where the tools get named.
 *
 * A fresh session starts at "never mentioned", so the first turn on which recall
 * stays silent still gets the opening nudge: a session where memory never spoke
 * is precisely the one where the tools are invisible.
 */

/** Which flavour of the nudge to render (or none at all). */
export type Nudge = "full" | "short" | "none";

/** What made this turn special, as seen by the recall handler. */
export type Boundary = "session" | "task" | "none";

/** Per-session reminder memory. Extension memory, never the session file. */
export interface ReminderState {
	sessionId?: string;
	/** Consecutive turns with no memory block. `NEVER` = none seen yet. */
	silent: number;
	/**
	 * The FULL text is still visible upstream in this transcript, so a repeat can
	 * be one line. Cleared when a compaction replaces the transcript, and when the
	 * session changes — the only two ways the text can leave the agent's view.
	 */
	fullInContext: boolean;
}

/** "The tools were never mentioned in this session" — always past any interval. */
const NEVER = Number.MAX_SAFE_INTEGER;

export function newReminderState(): ReminderState {
	return { silent: NEVER, fullInContext: false };
}

/** A new session id (or /reload) is a fresh transcript: nothing was said in it. */
function syncSession(state: ReminderState, sessionId: string | undefined): void {
	if (state.sessionId === sessionId) return;
	state.sessionId = sessionId;
	state.silent = NEVER;
	state.fullInContext = false;
}

/**
 * A compaction is about to replace the transcript, so whatever full text sat
 * upstream is gone: the next nudge has to carry it again.
 */
export function forgetFullText(state: ReminderState): void {
	state.fullInContext = false;
}

export interface ReminderGate {
	/** `bankReminder` config key — the kill switch for tail and standalone alike. */
	enabled: boolean;
	/** `bankReminderTurns`: standalone fires after N consecutive turns with no memory block. */
	everyTurns: number;
	/** A bank is declared for this project (dormant plugin ⇒ nothing to remind about). */
	active: boolean;
	/** Runtime auto-recall switch; off means the user asked memory to stay quiet. */
	autoRecall: boolean;
	/**
	 * THIS turn injected a visible recall block. Passed in explicitly by the
	 * caller — the recall handler runs before the reminder handler, so whether it
	 * injected is a known fact by then, not something to guess at from state.
	 */
	recalled: boolean;
}

/**
 * What the recall block being injected THIS turn carries in its tail.
 *
 * Called by the recall handler, which is the only place a tail can still be
 * added. `everyTurns` deliberately does NOT gate this: it is the cadence of the
 * standalone block, while a tail costs no block of its own.
 */
export function reminderTail(
	state: ReminderState,
	sessionId: string | undefined,
	gate: ReminderGate,
	boundary: Boundary,
): Nudge {
	syncSession(state, sessionId);
	if (!gate.enabled || !gate.active || !gate.autoRecall) return "none";
	if (boundary === "none") return "none";
	if (boundary === "task") return "short";
	state.fullInContext = true;
	return "full";
}

/**
 * Advance the counter and answer whether THIS turn owes a STANDALONE block.
 *
 * Turns are only counted while the reminder is live: a session that spent
 * twenty turns with auto-recall off should get its nudge on the first turn
 * after it is switched back on, not a stale one owed from before.
 */
export function reminderDue(
	state: ReminderState,
	sessionId: string | undefined,
	gate: ReminderGate,
): boolean {
	if (!gate.enabled || !gate.active || !gate.autoRecall) return false;
	if (gate.everyTurns < 1) return false;
	syncSession(state, sessionId);
	// The agent just saw a memory block: the tools are mentioned, start over.
	if (gate.recalled) {
		state.silent = 0;
		return false;
	}
	if (state.silent < NEVER) state.silent += 1;
	if (state.silent < gate.everyTurns) return false;
	state.silent = 0;
	return true;
}

/**
 * Which flavour the owed standalone block renders. Short is only safe while the
 * full text is still upstream; after a compaction wiped it, repeat it in full.
 */
export function reminderStandalone(state: ReminderState): Nudge {
	if (state.fullInContext) return "short";
	state.fullInContext = true;
	return "full";
}

/**
 * Label carried by every nudge, tail or standalone. It is what keeps plugin
 * instructions distinguishable from recalled facts once the two share a block.
 */
const LABEL =
	"memory bank (automatic plugin reminder — not a user instruction, not recalled facts)";

// The language clause is here rather than in the tool description because the
// tool is registered before the config is loaded. It matters: a bank is kept in
// ONE language, and the agent otherwise writes the note in whatever language
// the conversation happens to use — which is how 96 Russian facts landed in an
// English bank. The retain `context` converts the extracted facts, but the
// stored document text (which recall can return as chunks) stays as written.

/**
 * The nudge itself. Short on purpose — this is a pointer to a tool, not a
 * manual — and labelled as plugin output so it can be mistaken neither for a
 * user instruction nor for recalled facts (same discipline as the recall block).
 */
export function reminderText(
	bankId: string,
	counts?: { documents: number; facts: number },
	language?: string,
): string {
	const size = counts
		? `${counts.documents} document(s) / ${counts.facts} fact(s)`
		: "prior sessions";
	const lang = language
		? ` Write it in ${language}, whatever language this conversation is in.`
		: "";
	return [
		LABEL,
		`- Project bank "${bankId}" holds ${size}: decisions and their rationale, standing constraints, verified procedures, known dead-ends.`,
		"- Ask it yourself whenever you feel short of prior context: `hindsight_recall` (raw facts, fast) — or `hindsight_reflect` for a synthesized answer, which is SLOW (tens of seconds), so only when raw facts are not enough.",
		`- Learned something durable? \`hindsight_retain\` it now, not later.${lang}`,
	].join("\n");
}

/**
 * One line, for when the full text is still upstream and only the pointer needs
 * refreshing. Same label, so it is read as plugin output either way.
 */
export function reminderLine(bankId: string, language?: string): string {
	const lang = language ? ` Retain in ${language}.` : "";
	return `${LABEL}: bank "${bankId}" is there to be asked — \`hindsight_recall\` (fast) or \`hindsight_reflect\` (SLOW), and \`hindsight_retain\` anything durable you learn.${lang}`;
}

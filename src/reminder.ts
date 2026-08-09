/**
 * Periodic bank reminder.
 *
 * The main agent is the best judge of when it needs memory — it reads the whole
 * conversation — but it forgets the hindsight_* tools exist after a dozen turns,
 * and an unremembered tool is a dead tool. So a short nudge rides along at
 * session start and every N turns after that.
 *
 * Forgetting is a function of turns since the tools were last MENTIONED, not of
 * task identity — so the counter is not reset on the task-detector's boundary.
 * But an injected mem-recall block is itself a visible mention: it names the
 * bank and its tools in the same turn. Counting such a turn as silent would
 * stack a nudge on top of a briefing — loudest exactly where it is least
 * needed, which is what a fixed modulo did. So the counter measures CONSECUTIVE
 * turns with NO memory block, and a recall block re-arms it.
 *
 * A fresh session starts at "never mentioned", so the first turn on which recall
 * stays silent still gets the opening nudge: a session where memory never spoke
 * is precisely the one where the tools are invisible.
 */

/** Turn counter for one session. Extension memory, never the session file. */
export interface ReminderState {
	sessionId?: string;
	/** Consecutive turns with no memory block. `NEVER` = none seen yet. */
	silent: number;
}

/** "The tools were never mentioned in this session" — always past any interval. */
const NEVER = Number.MAX_SAFE_INTEGER;

export function newReminderState(): ReminderState {
	return { silent: NEVER };
}

export interface ReminderGate {
	/** `bankReminder` config key. */
	enabled: boolean;
	/** `bankReminderTurns`: fire after N consecutive turns with no memory block. */
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
 * Advance the counter and answer whether THIS turn gets a reminder.
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
	if (state.sessionId !== sessionId) {
		state.sessionId = sessionId;
		state.silent = NEVER;
	}
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
 * The nudge itself. Short on purpose — this is a pointer to a tool, not a
 * manual — and labelled as plugin output so it can be mistaken neither for a
 * user instruction nor for recalled facts (same discipline as the mem-recall
 * block).
 */
export function reminderText(
	bankId: string,
	counts?: { documents: number; facts: number },
	language?: string,
): string {
	const size = counts
		? `${counts.documents} document(s) / ${counts.facts} fact(s)`
		: "prior sessions";
	// The language clause is here rather than in the tool description because the
	// tool is registered before the config is loaded. It matters: a bank is kept in
	// ONE language, and the agent otherwise writes the note in whatever language
	// the conversation happens to use — which is how 96 Russian facts landed in an
	// English bank. The retain `context` converts the extracted facts, but the
	// stored document text (which recall can return as chunks) stays as written.
	const lang = language
		? ` Write it in ${language}, whatever language this conversation is in.`
		: "";
	return [
		"\uD83E\uDDE0 memory bank (automatic plugin reminder — not a user instruction, not recalled facts)",
		`- Project bank "${bankId}" holds ${size}: decisions and their rationale, standing constraints, verified procedures, known dead-ends.`,
		"- Ask it yourself whenever you feel short of prior context: `hindsight_recall` (raw facts, fast) — or `hindsight_reflect` for a synthesized answer, which is SLOW (tens of seconds), so only when raw facts are not enough.",
		`- Learned something durable? \`hindsight_retain\` it now, not later.${lang}`,
	].join("\n");
}

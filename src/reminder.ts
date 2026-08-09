/**
 * Periodic bank reminder.
 *
 * The main agent is the best judge of when it needs memory — it reads the whole
 * conversation — but it forgets the hindsight_* tools exist after a dozen turns,
 * and an unremembered tool is a dead tool. So a short nudge rides along at
 * session start and every N turns after that.
 *
 * Deliberately a blind turn counter, NOT a reset on the task-detector's
 * boundary: forgetting is a function of turns since the tools were last
 * mentioned, not of task identity, and a boundary already injects a visible
 * mem-recall briefing that reminds the model by itself. Coupling the two would
 * fire the reminder most often exactly where it is least needed, and make the
 * cadence depend on a probabilistic component.
 */

/** Turn counter for one session. Extension memory, never the session file. */
export interface ReminderState {
	sessionId?: string;
	turns: number;
}

export function newReminderState(): ReminderState {
	return { turns: 0 };
}

export interface ReminderGate {
	/** `bankReminder` config key. */
	enabled: boolean;
	/** `bankReminderTurns`: fire on turn 0, then every N turns. */
	everyTurns: number;
	/** A bank is declared for this project (dormant plugin ⇒ nothing to remind about). */
	active: boolean;
	/** Runtime auto-recall switch; off means the user asked memory to stay quiet. */
	autoRecall: boolean;
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
		state.turns = 0;
	}
	const due = state.turns % gate.everyTurns === 0;
	state.turns += 1;
	return due;
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

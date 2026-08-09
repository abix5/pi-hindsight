/**
 * The `context` and `metadata` every write to the bank carries.
 *
 * Three code paths store documents — the automatic session note (memorize.ts),
 * the agent's deliberate `hindsight_retain` (tools.ts), and a user-edited
 * document re-sent from the review tab (review-docs.ts). They used to disagree:
 * one had a long genre blurb, one had a short one, one had nothing. This module
 * is the single source for all three, because `context` is not decoration — the
 * server splices it straight into the fact-extraction prompt.
 *
 * Two things it must do, both measured against the live server (0.9.0):
 *
 * 1. NAME THE SPEAKER. `fact_type` is decided by who is talking: a first-person
 *    statement from the bank's own agent becomes an `experience`, everything
 *    else a `world` fact. Feeding the SAME note with a context reading "The
 *    assistant is speaking" turned 40% of the extracted facts into `experience`;
 *    with the third-person wording below it stays at 0%. We want `world`: these
 *    notes are knowledge ABOUT a project, not a diary of what an agent did.
 *    (0.9.0 deprecates the `agent_name` narrator override in favour of exactly
 *    this — the speaker is set through `context`.)
 *
 * 2. PIN THE LANGUAGE. The server's extraction prompt orders the model to detect
 *    the input language and FORBIDS translating, so a Russian note yields Russian
 *    facts no matter what the bank is supposed to hold — that is how one bank
 *    ended up 96 ru / 286 en. There is no per-bank language setting and no
 *    language field on `retain`; the only lever on that request is `context`.
 *    An IMPERATIVE there does work: the same Russian note extracted 78% Cyrillic
 *    facts without it and 0% with it. (The old wording, "The note is written in
 *    ru", was a description, not an instruction, and steered nothing.)
 *
 * `metadata` is sent for the same reason twice over: it is fed into the
 * extraction prompt AND stored on every unit the document produces, so it comes
 * back with each recalled fact. Keep it to fields worth reading back later —
 * every key lands in the prompt, so noise here costs quality.
 */

/** Which of the three write paths produced the document. */
export type RetainSource = "session-note" | "agent-note" | "user-edit";

export interface RetainProvenance {
	/** Project the note is about — the working directory's name, not the path. */
	project: string;
	/** The one language this bank is kept in (`cfg.memoryLanguage`). */
	language: string;
	/** pi session that produced the note, when the path knows it. */
	session?: string;
}

/** What each source is, in the third person, for the extraction prompt. */
const WHAT: Record<RetainSource, string> = {
	"session-note":
		"a distilled note of durable engineering knowledge that surfaced while the project was being worked on",
	"agent-note":
		"one durable fact, decision, procedure or dead-end recorded the moment it was learned",
	"user-edit":
		"a distilled note of durable engineering knowledge, reviewed and corrected by hand by the project's owner",
};

/**
 * The `context` string for one write.
 *
 * Deliberately short. The bank already carries `retain_mission` (what to keep);
 * repeating it here would only spend prompt budget twice. Context answers the
 * two questions the mission cannot: who is speaking, and in what language the
 * result must be written.
 */
export function retainContext(
	source: RetainSource,
	p: RetainProvenance,
): string {
	return [
		`Knowledge base of the software project "${p.project}": ${WHAT[source]}.`,
		"SPEAKER: the project's memory keeper, writing in the third person about the project itself.",
		"The AI coding assistant is NOT the speaker and no conversation is being reported, so nothing here is an experience of the assistant — every line is an established fact about the project or a standing preference of its owner.",
		`LANGUAGE: write every extracted fact in ${p.language}, whatever language this note happens to be in. Keep code identifiers, paths and commands verbatim.`,
	].join(" ");
}

/**
 * The `metadata` for one write. Four fields, each earning its place:
 *   source   — which of our three write paths produced it, so a quality problem
 *              can be traced to the writer that caused it;
 *   project  — the project the note is about (a bank may outlive one checkout,
 *              and `bank_id` is a slug, not a name);
 *   session  — the pi session, which is also what the document_id hashes, so a
 *              recalled fact leads back to the conversation that produced it;
 *   language — the language we ASKED for. Without it, drift (config flipped
 *              between two languages mid-life) is invisible after the fact.
 */
export function retainMetadata(
	source: RetainSource,
	p: RetainProvenance,
): Record<string, string> {
	const meta: Record<string, string> = {
		source: `pi-hindsight/${source}`,
		project: p.project,
		language: p.language,
	};
	if (p.session) meta.session = p.session;
	return meta;
}

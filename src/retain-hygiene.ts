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
 * The optional USER bank shares those two disciplines and nothing else. Its
 * frame is its own (`userRetainContext` below): a cross-project fact about the
 * person, handed to the extractor as "knowledge base of the software project X",
 * comes back rewritten into a rule about that one repository — observed on the
 * first live seeding of the user bank. Speaker and language stay; the project
 * frame goes.
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

/** What a user-bank write knows about itself. It has no project, by design. */
export interface UserRetainProvenance {
	/** The one language this bank is kept in (`cfg.memoryLanguage`). */
	language: string;
	/** pi session that produced the note, when the path knows it. */
	session?: string;
	/**
	 * Accepted so a caller may pass a full `RetainProvenance`, and deliberately
	 * ignored: naming a checkout here is exactly the defect this frame fixes.
	 */
	project?: string;
}

/**
 * The `context` for one write into the optional user bank.
 *
 * Same two levers as `retainContext` — the speaker in the third person, and an
 * imperative pinning the language — around a different frame. What is stored
 * here is true of the PERSON in every repository they open, so the frame must
 * not name one; see the module header for what happens when it does.
 */
export function userRetainContext(p: UserRetainProvenance): string {
	return [
		"Permanent profile of the person this AI coding assistant works with: one durable fact, decision, procedure or dead-end about how that person works, recorded the moment it was learned.",
		"This knowledge holds across every project the person opens; it is not about one repository.",
		"SPEAKER: the assistant's memory keeper, writing in the third person about the person it works with.",
		"The AI coding assistant is NOT the speaker and no conversation is being reported, so nothing here is an experience of the assistant — every line is an established fact about the person or a standing preference of theirs.",
		`LANGUAGE: write every extracted fact in ${p.language}, whatever language this note happens to be in. Keep code identifiers, paths and commands verbatim.`,
	].join(" ");
}

/**
 * The `metadata` for one user-bank write.
 *
 * `scope: "user"` stands where the project write puts `project`. Every metadata
 * key is fed to the extractor and comes back attached to each recalled fact, so
 * `project: <current checkout>` would assert the opposite of what this bank is
 * for: the knowledge is deliberately not bound to the checkout that happened to
 * be open when it was learned. `scope` says the one true thing instead.
 *
 * `source` is its own value rather than `agent-note`, because this is a fourth
 * write path: if the quality of these records ever drops, the label has to name
 * one writer, not two.
 */
export function userRetainMetadata(
	p: UserRetainProvenance,
): Record<string, string> {
	const meta: Record<string, string> = {
		source: "pi-hindsight/user-note",
		scope: "user",
		language: p.language,
	};
	if (p.session) meta.session = p.session;
	return meta;
}

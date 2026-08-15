/**
 * Agent-facing tools: retain, recall, reflect.
 *
 * Thin wrappers over the REST client so the agent can consciously store memory,
 * pull raw facts, or ask Hindsight for a grounded reflection. No auto-gates here:
 * these are direct tools for deliberate agent use.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";
import type { HindsightConfig } from "./config.ts";
import type { HindsightClient } from "./hindsight.ts";
import { appendDebug } from "./log.ts";
import { formatRecallHits } from "./recall.ts";
import { retainContext, retainMetadata } from "./retain-hygiene.ts";

const RetainParams = Type.Object({
	content: Type.String({
		description:
			"One self-contained fact / decision / procedure / pitfall worth remembering later.",
	}),
	kind: Type.Optional(
		StringEnum(["fact", "decision", "knowhow", "pitfall"] as const, {
			description:
				"fact = static truth; decision = choice+rationale; knowhow = procedure/steps; pitfall = what did NOT work.",
		}),
	),
});

const RecallParams = Type.Object({
	query: Type.String({
		description: "What raw facts to look up in project memory.",
	}),
});

const ReflectParams = Type.Object({
	query: Type.String({
		description: "Question for Hindsight to answer from project memory.",
	}),
});

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: null };
}
function fail(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: null,
		isError: true,
	};
}

export function registerTools(
	pi: ExtensionAPI,
	getState: () => { cfg: HindsightConfig; client: HindsightClient } | undefined,
	// The user bank arrives as a resolved client, not as a lookup: it is reachable
	// from exactly this one closure, which is what keeps every automatic write path
	// structurally unable to address it. Undefined when no user bank is declared,
	// and then the tool below does not exist at all.
	userBank?: { cfg: HindsightConfig; client: HindsightClient },
): void {
	pi.registerTool({
		name: "hindsight_retain",
		label: "Retain",
		description:
			"Store a reusable fact, decision, operational procedure, or dead-end (pitfall) in long-term project memory.",
		promptGuidelines: [
			"Recognize the moment worth remembering: a task that worked only after several tries, a non-obvious command, a project fact learned mid-task, a recurring workflow, or when the user says 'remember this'. Call hindsight_retain right then — do not wait.",
			"Capture the reusable PROCEDURE (the steps that worked), and record any dead-end that did NOT work as kind=pitfall so it is not retried.",
			"Store the general rule and rationale — not code diffs, concrete edits, or raw tool output.",
		],
		parameters: RetainParams,
		async execute(_id, params, signal) {
			const s = getState();
			appendDebug(process.cwd(), "tool.retain.start", {
				initialized: !!s,
				contentChars: params.content.length,
				kind: params.kind ?? "fact",
			});
			if (!s) return fail("hindsight not initialized");
			const kind = params.kind ?? "fact";
			const cwd = process.cwd();
			try {
				const provenance = {
					project: path.basename(cwd),
					language: s.cfg.memoryLanguage,
				};
				await s.client.retain(
					params.content,
					{
						tags: [s.cfg.bankId, "agent-manual", kind],
						// This path used to send bare content. It is also the path the
						// agent writes in whatever language the CONVERSATION is in, which
						// is how a single-language bank ended up bilingual — the language
						// line in the context is what converts such a note on extraction.
						context: retainContext("agent-note", provenance),
						metadata: retainMetadata("agent-note", provenance),
					},
					signal,
				);
				appendDebug(process.cwd(), "tool.retain.done", { kind });
				return ok("retained");
			} catch (err) {
				appendDebug(process.cwd(), "tool.retain.error", {
					error: (err as Error).message,
				});
				return fail(`retain failed: ${(err as Error).message}`);
			}
		},
	});

	if (userBank) {
		pi.registerTool({
			name: "hindsight_retain_user",
			label: "Retain (user)",
			description:
				"Store a standing fact about the USER — how this person works — in cross-project user memory, separate from the project bank. Goes here: standing instructions that hold everywhere (e.g. 'always start from a fresh master'), tool and model preferences, communication and report-language rules, goals and intent that explain WHY things are asked for, prohibitions and boundaries, and habitual procedures repeated from project to project. Does NOT go here: anything bound to one repository — paths, filenames, versions, commit ids, branch names, build layout, this project's error text — all of which belong to the project bank even when they come up in a conversation about habits. One-sentence test: would this still be true when the person opens a completely different repository? Yes → user bank. No → project bank.",
			promptGuidelines: [
				"When the user states something about how THEY work rather than about this code — a standing instruction, a preference, a goal, a prohibition, a habitual procedure — call hindsight_retain_user; project facts still go to hindsight_retain.",
				"Apply the one-sentence test before writing: would this still be true in a completely different repository? If no, it belongs in the project bank.",
				"Phrase it as a rule with its reason, not as a retelling of a remark. Bad: 'the user said to work from master'. Good: 'Start any work from a fresh origin/HEAD, because a branch cut from a stale base drags unrelated changes into its diff'.",
			],
			parameters: RetainParams,
			async execute(_id, params, signal) {
				const kind = params.kind ?? "fact";
				const cwd = process.cwd();
				try {
					// Same hygiene as the project retain — context, metadata and memory
					// language all come from the shared module, so the two write paths
					// differ in their bank and tags and in nothing else.
					const provenance = {
						project: path.basename(cwd),
						language: userBank.cfg.memoryLanguage,
					};
					await userBank.client.retain(
						params.content,
						{
							tags: [userBank.cfg.userBankId, "user-manual", kind],
							context: retainContext("agent-note", provenance),
							metadata: retainMetadata("agent-note", provenance),
						},
						signal,
					);
					appendDebug(cwd, "tool.retain-user.done", { kind });
					return ok("retained");
				} catch (err) {
					appendDebug(cwd, "tool.retain-user.error", {
						error: (err as Error).message,
					});
					return fail(`retain failed: ${(err as Error).message}`);
				}
			},
		});
	}

	pi.registerTool({
		name: "hindsight_recall",
		label: "Recall",
		description:
			"Directly search long-term project memory and return raw recalled facts (no gate, no rewrite).",
		promptGuidelines: [
			"Before a non-trivial task, call hindsight_recall to load prior decisions and operational know-how (how to run/test, where creds/configs live).",
			"Do not guess what may have been discovered earlier — ask memory first.",
		],
		parameters: RecallParams,
		async execute(_id, params, signal) {
			const s = getState();
			appendDebug(process.cwd(), "tool.recall.start", {
				initialized: !!s,
				query: params.query,
			});
			if (!s) return fail("hindsight not initialized");
			try {
				const res = await s.client.recall(
					params.query,
					{ maxTokens: s.cfg.recallMaxTokens, budget: s.cfg.recallBudget },
					signal,
				);
				appendDebug(process.cwd(), "tool.recall.done", { response: res });
				const hits = formatRecallHits(res);
				return ok(hits || "(no relevant memory)");
			} catch (err) {
				appendDebug(process.cwd(), "tool.recall.error", {
					error: (err as Error).message,
				});
				return fail(`recall failed: ${(err as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "hindsight_reflect",
		label: "Reflect",
		description:
			"Ask Hindsight to synthesize a grounded answer from long-term project memory (direct reflect, no gate).",
		promptGuidelines: [
			"Use hindsight_reflect when raw facts are not enough and you need a concise answer synthesized from project memory.",
			"Use hindsight_recall instead when you need to inspect the raw underlying facts.",
		],
		parameters: ReflectParams,
		async execute(_id, params, signal) {
			const s = getState();
			appendDebug(process.cwd(), "tool.reflect.start", {
				initialized: !!s,
				query: params.query,
			});
			if (!s) return fail("hindsight not initialized");
			try {
				const res = await s.client.reflect(params.query, signal);
				const obj = res as Record<string, unknown>;
				const text =
					(typeof obj?.text === "string" && obj.text) ||
					(typeof obj?.answer === "string" && obj.answer) ||
					JSON.stringify(res);
				appendDebug(process.cwd(), "tool.reflect.done", { response: res });
				return ok(text || "(no answer)");
			} catch (err) {
				appendDebug(process.cwd(), "tool.reflect.error", {
					error: (err as Error).message,
				});
				return fail(`reflect failed: ${(err as Error).message}`);
			}
		},
	});
}

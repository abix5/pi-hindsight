/**
 * Once-per-version release notice, shown to the PERSON after an upgrade.
 *
 * The whole contour is advisory: it reads two small local files, may call
 * `ui.notify` once, and writes one small state file. Every failure — a missing
 * or garbled CHANGELOG.md, an unreadable package.json, an unwritable state
 * path — is a silent no-op, because a release note is never worth breaking a
 * session start for. A failed state write merely repeats the notice next time,
 * which is the cheaper of the two mistakes.
 *
 * Nothing here may reach the model: the notice goes through `ui.notify`, which
 * pi renders into the chat container only. That is a standing rule of this
 * extension (see the user-block warning in index.ts), not a preference.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir } from "./config.ts";

export interface ChangelogEntry {
	version: string;
	body: string;
}

// A runaway changelog must not flood the chat; the full file ships in the
// package for anyone who wants the rest.
const MAX_NOTICE_CHARS = 6_000;

/**
 * Entries keyed by `## <version>` heading, file order (newest first by
 * convention). An `Unreleased` heading is skipped; text before the first
 * version heading belongs to no entry.
 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
	const entries: ChangelogEntry[] = [];
	let current: ChangelogEntry | undefined;
	for (const line of markdown.split(/\r?\n/)) {
		const heading = /^##\s+(?:\[([^\]\r\n]+)\]|(\S+))(?:\s+-.*)?\s*$/.exec(
			line,
		);
		if (heading) {
			const version = (heading[1] ?? heading[2] ?? "").trim();
			current = undefined;
			if (version && version.toLowerCase() !== "unreleased") {
				current = { version, body: "" };
				entries.push(current);
			}
			continue;
		}
		if (current) current.body = current.body ? `${current.body}\n${line}` : line;
	}
	return entries;
}

/**
 * The entries a person upgrading from `previousVersion` has not seen yet:
 * everything BETWEEN the last-announced version and the current one, so
 * skipping two releases shows both. An unknown previous version (including a
 * fresh install with no state file) shows only the current entry — the one
 * upgrade that actually just happened — rather than the whole history.
 */
export function releaseEntries(
	entries: ChangelogEntry[],
	currentVersion: string,
	previousVersion: string | undefined,
): ChangelogEntry[] {
	if (previousVersion === currentVersion) return [];
	const currentIndex = entries.findIndex((e) => e.version === currentVersion);
	const current = entries[currentIndex];
	if (!current || current.body.trim() === "") return [];
	const previousIndex =
		previousVersion === undefined
			? -1
			: entries.findIndex((e) => e.version === previousVersion);
	const selected =
		previousIndex > currentIndex
			? entries.slice(currentIndex, previousIndex)
			: [current];
	return selected.filter((e) => e.body.trim() !== "");
}

/** The chat message: first line names the upgrade, then the unseen notes. */
export function noticeText(
	version: string,
	entries: ChangelogEntry[],
): string {
	const notes = entries
		.map((e) => `## ${e.version}\n${e.body.trim()}`)
		.join("\n\n");
	const bounded =
		notes.length > MAX_NOTICE_CHARS
			? `${notes.slice(0, MAX_NOTICE_CHARS).trimEnd()}\n…`
			: notes;
	return `pi-hindsight updated to ${version}\n\n${bounded}`;
}

/**
 * Next to the other per-user state (the review queue). Through homeDir(), not
 * os.homedir(): under Bun the latter ignores $HOME, which is what lets the
 * self-tests redirect this file away from the developer's real ~/.pi.
 */
export function changelogStatePath(): string {
	return path.join(homeDir(), ".pi", "hindsight", "changelog-state.json");
}

function lastNotifiedVersion(statePath: string): string | undefined {
	try {
		const v = (
			JSON.parse(fs.readFileSync(statePath, "utf8")) as {
				lastNotifiedVersion?: unknown;
			}
		).lastNotifiedVersion;
		return typeof v === "string" && v.trim() ? v : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Show the unseen release notes once per version, then remember the version.
 *
 * `packageDir`/`statePath` exist for the self-tests; real callers take the
 * defaults, which resolve to this installed copy's own package root.
 */
export function showChangelogNotice(
	notify: ((message: string, type: "info") => void) | undefined,
	packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
	statePath = changelogStatePath(),
): void {
	// No UI, no notice — and no state write either, so a session that could not
	// show it does not swallow it for the session that can.
	if (!notify) return;
	try {
		const version = (
			JSON.parse(
				fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
			) as { version?: unknown }
		).version;
		if (typeof version !== "string" || !version.trim()) return;
		const previous = lastNotifiedVersion(statePath);
		const entries = releaseEntries(
			parseChangelog(
				fs.readFileSync(path.join(packageDir, "CHANGELOG.md"), "utf8"),
			),
			version,
			previous,
		);
		if (entries.length === 0) return;
		notify(noticeText(version, entries), "info");
		try {
			// Write-temp-then-rename into the same directory, like the review queue:
			// a torn state file would misread as "never announced" and repeat the
			// notice, so the swap is atomic.
			fs.mkdirSync(path.dirname(statePath), { recursive: true });
			const tmp = `${statePath}.${process.pid}.tmp`;
			fs.writeFileSync(
				tmp,
				`${JSON.stringify({ lastNotifiedVersion: version })}\n`,
			);
			fs.renameSync(tmp, statePath);
		} catch {
			/* advisory: an unwritable state file just repeats the notice next start */
		}
	} catch {
		/* changelog data is optional and must never break a session start */
	}
}

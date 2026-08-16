/**
 * Self-test: the once-per-version upgrade notice.
 *
 * The main scenarios drive the REAL extension through the shared user-block
 * harness (which redirects $HOME to a fixture, stubs the bank transport, and
 * records everything said through ctx.ui.notify), so a pass means the shipped
 * wiring showed the notice — not that a helper would have. The edge cases that
 * need a broken package on disk call showChangelogNotice directly with fixture
 * paths, because the harness always runs against this repo's real files.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	agentsMd,
	check,
	hostPrompt,
	makeCwd,
	newHarness,
	report,
} from "./user-block-harness.ts";
import { showChangelogNotice } from "../src/changelog.ts";

const FIRST_LINE = "pi-hindsight updated to 0.5.1";
const repoRoot = path.join(import.meta.dir, "..");
const pkg = JSON.parse(
	fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
) as { version: string; files: string[] };
// The harness redirected $HOME before anything else loaded, so this is the
// fixture home — the same file the extension's default state path resolves to.
const statePath = path.join(
	process.env.HOME as string,
	".pi",
	"hindsight",
	"changelog-state.json",
);
const seedState = (version: string) => {
	fs.mkdirSync(path.dirname(statePath), { recursive: true });
	fs.writeFileSync(
		statePath,
		`${JSON.stringify({ lastNotifiedVersion: version })}\n`,
	);
};
const upgrades = (h: { notices(): Array<{ message: string }> }) =>
	h.notices().filter((n) => n.message.startsWith("pi-hindsight updated to"));

// The notice is only honest if these two hold for the release itself.
check("package.json version is the announced one", pkg.version, "0.5.1");
check(
	"CHANGELOG.md ships in the npm package",
	pkg.files.includes("CHANGELOG.md"),
	true,
);

// --- upgrade 0.5.0 → 0.5.1: announced once, model context untouched ---------

console.log("\n== first session after the upgrade announces 0.5.1 ==");
seedState("0.5.0");
const h1 = newHarness({ cwd: makeCwd("clog-a", {}) });
await h1.start();
const first = upgrades(h1);
check("exactly one upgrade notice", first.length, 1);
check(
	"its first line names the version",
	first[0]?.message.split("\n")[0],
	FIRST_LINE,
);
check(
	"it carries the 0.5.1 notes",
	first[0]?.message.includes("once per\nversion") ||
		first[0]?.message.includes("once per version"),
	true,
);
check(
	"it does NOT replay the already-seen 0.5.0 entry",
	first[0]?.message.includes("## 0.5.0"),
	false,
);
check(
	"the bookmark advanced to 0.5.1",
	JSON.parse(fs.readFileSync(statePath, "utf8")).lastNotifiedVersion,
	"0.5.1",
);

console.log("\n== nothing of it reaches the model ==");
const host = hostPrompt(agentsMd(1));
const turn = await h1.turn(host);
check(
	"turn output (prompt + messages) never mentions the notice",
	JSON.stringify(turn).includes("pi-hindsight updated"),
	false,
);
h1.done();

console.log("\n== a second session after the same upgrade stays silent ==");
const h2 = newHarness({ cwd: makeCwd("clog-b", {}) });
await h2.start();
check("no second notice", upgrades(h2).length, 0);
h2.done();

// --- skipped a release: both unseen entries arrive in one notice ------------

console.log("\n== upgrading straight from 0.4.1 shows 0.5.0 and 0.5.1 ==");
seedState("0.4.1");
const h3 = newHarness({ cwd: makeCwd("clog-c", {}) });
await h3.start();
const skipped = upgrades(h3);
check("one notice for the whole gap", skipped.length, 1);
check(
	"it opens with the current version",
	skipped[0]?.message.split("\n")[0],
	FIRST_LINE,
);
check(
	"the skipped 0.5.0 entry is included",
	skipped[0]?.message.includes("## 0.5.0") === true &&
		skipped[0]?.message.includes("user bank"),
	true,
);
check(
	"the already-seen 0.4.1 entry is not",
	skipped[0]?.message.includes("## 0.4.1"),
	false,
);
h3.done();

console.log("\n== a fresh install is not spammed with the whole history ==");
fs.rmSync(statePath, { force: true });
const h4 = newHarness({ cwd: makeCwd("clog-d", {}) });
await h4.start();
const fresh = upgrades(h4);
check("one notice with no prior state", fresh.length, 1);
check(
	"it carries only the current entry, not the back catalogue",
	fresh[0]?.message.includes("## 0.5.0") ||
		fresh[0]?.message.includes("## 0.4.1"),
	false,
);
h4.done();

// --- broken worlds are silent no-ops ----------------------------------------

const said: string[] = [];
const record = (m: string) => {
	said.push(m);
};
const fixture = (changelog: string | undefined): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-clog-"));
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ version: "9.9.9" }),
	);
	if (changelog !== undefined)
		fs.writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
	return dir;
};

console.log("\n== a package without CHANGELOG.md is silent ==");
const bare = fixture(undefined);
const bareState = path.join(bare, "state.json");
showChangelogNotice(record, bare, bareState);
check("no notice", said.length, 0);
check("no state written for a notice never shown", fs.existsSync(bareState), false);

console.log("\n== an unparseable CHANGELOG.md is silent ==");
showChangelogNotice(
	record,
	fixture("release notes\n\njust prose, no version headings\n"),
	path.join(os.tmpdir(), "hs-clog-none.json"),
);
showChangelogNotice(
	record,
	fixture("## 1.0.0\nan entry for some OTHER version\n"),
	path.join(os.tmpdir(), "hs-clog-none.json"),
);
check("still no notice", said.length, 0);

console.log("\n== an unwritable state file does not throw, notice may repeat ==");
const good = fixture("## 9.9.9\nthe notes for 9.9.9\n");
// A regular file where a directory is needed: mkdir/write must fail.
const plug = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hs-clog-ro-")), "plug");
fs.writeFileSync(plug, "");
const jammed = path.join(plug, "deeper", "state.json");
showChangelogNotice(record, good, jammed);
showChangelogNotice(record, good, jammed);
check("the notice was shown despite the jammed state", said.length, 2);
check("both carry the version line", said[1]?.split("\n")[0], "pi-hindsight updated to 9.9.9");

console.log("\n== no UI: no notice, and the notice is not swallowed ==");
const uiless = path.join(os.tmpdir(), `hs-clog-uiless-${process.pid}.json`);
showChangelogNotice(undefined, good, uiless);
check("no state written without a UI", fs.existsSync(uiless), false);
showChangelogNotice(record, good, uiless);
check("the next session with a UI still gets it", said.length, 3);

report();

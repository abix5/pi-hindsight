/**
 * Standalone unit test for the three-layer config merge + bank-gated activation
 * (run with bun or node).
 *
 *   bun scripts/config-merge.test.ts
 *   node --experimental-strip-types scripts/config-merge.test.ts
 *
 * Points HOME at a throwaway dir so `globalConfigPath()` resolves under a temp
 * tree, writes temp global/project override files, and asserts the precedence
 * env(base) → global → project plus the activation rules.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Redirect HOME (used by os.homedir() → globalConfigPath()) and clear any env
// bank so the base layer stays neutral BEFORE importing the module.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-home-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.HINDSIGHT_BANK;

const { loadConfig, globalConfigPath, readProjectOverrides, CONFIG_ALLOW } =
	await import("../src/config.ts");

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failures++;
}

function writeGlobal(obj: Record<string, unknown> | null): void {
	const file = globalConfigPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (obj === null) fs.rmSync(file, { force: true });
	else fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function makeCwd(name: string, obj: Record<string, unknown> | null): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cfg-${name}-`));
	if (obj !== null) {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "hindsight.json"),
			JSON.stringify(obj, null, 2),
		);
	}
	return cwd;
}

const cleanup: string[] = [tmpHome];
function slugOf(cwd: string): string {
	return (cwd.split("/").filter(Boolean).pop() ?? "default")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

// (a) project overrides global overrides base ------------------------------
{
	writeGlobal({ namespace: "global-ns", memoryLanguage: "fr" });
	const cwd = makeCwd("a", { namespace: "project-ns" });
	cleanup.push(cwd);
	const cfg = loadConfig(cwd);
	check(
		"(a) project wins: namespace = project-ns",
		cfg.namespace === "project-ns",
	);
	check(
		"(a) global fills gap: memoryLanguage = fr",
		cfg.memoryLanguage === "fr",
	);
	check(
		"(a) base default kept: baseUrl",
		cfg.baseUrl === "http://localhost:8888",
	);
}

// (b) global "auto" activates with folder-slug bank ------------------------
{
	writeGlobal({ bankId: "auto" });
	const cwd = makeCwd("b", null);
	cleanup.push(cwd);
	const cfg = loadConfig(cwd);
	check("(b) global auto → active", cfg.active === true);
	check("(b) global auto → folder-slug bank", cfg.bankId === slugOf(cwd));
}

// (c) global concrete bankId does NOT activate -----------------------------
{
	writeGlobal({ bankId: "shared-bank" });
	const cwd = makeCwd("c", null);
	cleanup.push(cwd);
	const cfg = loadConfig(cwd);
	check("(c) global concrete bank → inactive", cfg.active === false);
	check(
		"(c) global concrete bank ignored → folder slug",
		cfg.bankId === slugOf(cwd),
	);
}

// (d) project concrete bankId activates ------------------------------------
{
	writeGlobal({ bankId: "shared-bank" });
	const cwd = makeCwd("d", { bankId: "My Project Bank" });
	cleanup.push(cwd);
	const cfg = loadConfig(cwd);
	check("(d) project concrete bank → active", cfg.active === true);
	check("(d) project bank slugified", cfg.bankId === "my-project-bank");
}

// (e) no bank anywhere → active=false --------------------------------------
{
	writeGlobal(null);
	const cwd = makeCwd("e", { namespace: "x" });
	cleanup.push(cwd);
	const cfg = loadConfig(cwd);
	check("(e) no bank declared → inactive", cfg.active === false);
	check("(e) inactive still has folder-slug bank", cfg.bankId === slugOf(cwd));
}

// (f) HINDSIGHT_AUTO_OFF overrides every layer -----------------------------
{
	writeGlobal({ bankId: "auto", autoRecall: true, autoMemorize: true });
	const cwd = makeCwd("f", {
		bankId: "proj",
		autoRecall: true,
		autoMemorize: true,
	});
	cleanup.push(cwd);
	const on = loadConfig(cwd);
	check("(f) without the flag, config layers win", on.autoRecall === true);

	process.env.HINDSIGHT_AUTO_OFF = "1";
	const off = loadConfig(cwd);
	delete process.env.HINDSIGHT_AUTO_OFF;
	check("(f) auto-off beats project autoRecall", off.autoRecall === false);
	check("(f) auto-off beats project autoMemorize", off.autoMemorize === false);
	check("(f) auto-off leaves the bank active", off.active === true);
}

// (g) `recallOperation` is gone, not merely ignored -------------------------
{
	// It was a documented, /mem-settable, persisted switch that NOTHING read:
	// parseQueryPlan hard-codes op:"recall" and runRecall never looked at it. A
	// user flipped it and nothing happened, so the key must not survive anywhere
	// — including as an accepted config-file key that gets written back to
	// .pi/hindsight.json.
	process.env.HINDSIGHT_RECALL_OPERATION = "reflect";
	writeGlobal({ bankId: "g" });
	const cwd = makeCwd("g", { recallOperation: "reflect" } as never);
	cleanup.push(cwd);
	const cfg = loadConfig(cwd) as Record<string, unknown>;
	delete process.env.HINDSIGHT_RECALL_OPERATION;
	check("(g) recallOperation is not a config key", !("recallOperation" in cfg));
	check(
		"(g) a recallOperation in the project file is not accepted",
		!("recallOperation" in readProjectOverrides(cwd)),
	);
	check("(g) CONFIG_ALLOW has dropped it", !CONFIG_ALLOW.has("recallOperation" as never));
}

for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

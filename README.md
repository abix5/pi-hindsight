# pi-hindsight

Long-term project memory for the [pi coding-agent](https://github.com/earendil-works/pi),
backed by a local [Hindsight](https://github.com/threadway/hindsight) instance.

> **Need Hindsight running first?** On macOS the fastest way to spin up a local
> instance is [**hindsight-setup**](https://github.com/abix5/hindsight-setup) —
> simple and quick.

pi-hindsight gives the agent a durable memory of your project that survives across
sessions and context compaction. It works in two directions:

- **Recall** — before each turn it searches the memory bank and injects the few
  most relevant facts into the agent's context, so past decisions, pitfalls and
  project facts are not forgotten or re-derived.
- **Memorize** — when the conversation is compacted (or on demand), it extracts
  the durable *system knowledge* from the slice that is about to be discarded,
  de-duplicates it against what the bank already knows, and stores only what is
  new — all in the background, without blocking the agent.

A small status widget shows both contours live:

```
🧠 pi-hindsight · 16 docs · 153 facts
↙ recall · db migration command · found→injected
```

---

## How it works

### Recall (read path — inline)

Runs on the `before_agent_start` hook. A cheap model turns the recent
conversation into a bank query and decides whether a lookup is even worth it
(meta-questions and chit-chat are skipped). Matching facts are fetched, de-duped
against facts already injected this session, and returned as an *untrusted
reference* block for the current turn. Nothing is rewritten or invented — facts
are injected verbatim and the main model weaves them in.

Two operations are supported:

- `recall` (default) — return the raw relevant facts.
- `reflect` — ask Hindsight to compose a direct answer from the bank, used only
  for self-contained factual questions.

### Memorize (write path — taskflow)

Triggered **only** on context compaction and the manual `/hindsight-flush`
command — never on shutdown or reload (nothing is lost there, so there is
nothing to save). It is strictly fire-and-forget: the agent never waits.

The write is a deterministic [taskflow](https://github.com/earendil-works/pi)
(`taskflows/memory-fill.json`) with four phases:

1. **build** *(agent)* — reads the compacted delta and writes a short, extractive
   *report* of durable knowledge (decisions + rationale, constraints, verified
   know-how, pitfalls, facts & locations). Emits `NONE` if nothing is durable.
2. **stage** *(script)* — writes the report to a per-run file and queries the
   bank via `curl` for anything already stored on the topic.
3. **dedup** *(agent)* — drops every bullet already present in the bank, keeps
   only what is new or changed.
4. **store** *(script)* — `curl`-POSTs the surviving report to the bank
   (`async`), then deletes the scratch file.

Bank I/O lives in the **script** phases (plain `curl`), not in subagents — so it
never depends on a subagent having the right tools, and no model sits in the
write path to derail it.

---

## Requirements

- **pi coding-agent** (provides the extension runtime and model registry).
- A running **Hindsight** HTTP API — by default `http://localhost:8888`,
  namespace `default`. On macOS, the easiest way to get one is
  [**hindsight-setup**](https://github.com/abix5/hindsight-setup).
- **bun** — the extension runs as TypeScript.
- **jq** and **curl** on `PATH` — used by the memorize taskflow's script phases.
- **Two models** available in your pi model registry (one cheap for
  recall/build, one slightly stronger for dedup). See *Configuration*.

---

## Install

pi auto-discovers `.pi/extensions/*.ts` in a trusted project. To add pi-hindsight
to a project:

1. **Clone this repo** somewhere stable:

   ```bash
   git clone https://github.com/abix5/pi-hindsight.git ~/tools/pi-hindsight
   ```

2. **Add a loader** in your project at `.pi/extensions/hindsight.ts`:

   ```ts
   export { default } from "/absolute/path/to/pi-hindsight/src/index.ts";
   ```

   (Running pi *inside this repo* works out of the box — a loader is already
   present.)

3. **Register the taskflow.** Copy `taskflows/memory-fill.json` into your
   project's `.pi/taskflows/`, or point your `package.json` at it:

   ```json
   { "pi": { "taskflows": ["./taskflows"] } }
   ```

4. **Set your models** in `taskflows/memory-fill.json`. The `build` and `dedup`
   phases have `"model": "..."` fields — change them to models you actually have.

5. **Create `.pi/hindsight.json`** (see below), trust the project, then
   `/reload` in pi.

6. Verify the bank connection with `/hindsight-ping`.

---

## Configuration

Settings are read from environment variables, then overridden by
`.pi/hindsight.json` in the project (handy for hot `/reload`). A typical config:

```json
{
  "autoRecall": true,
  "autoMemorize": true,
  "memorizeEngine": "taskflow",
  "retainModelId": "your/build-model",
  "recallModelId": "your/recall-model",
  "recallOperation": "recall",
  "recallFilter": "model",
  "recallMaxLines": 8,
  "recallContextTokens": 5000
}
```

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | `HINDSIGHT_BASE_URL` | `http://localhost:8888` | Hindsight API base URL |
| `namespace` | `HINDSIGHT_NAMESPACE` | `default` | API namespace (path after `/v1`) |
| `bankId` | `HINDSIGHT_BANK` | project folder slug | Memory bank id |
| `autoRecall` | `HINDSIGHT_AUTO_RECALL` | `true` | Search memory before each turn |
| `autoMemorize` | `HINDSIGHT_AUTO_MEMORIZE` | `true` | Write memory on compaction |
| `memorizeEngine` | `HINDSIGHT_MEMORIZE_ENGINE` | `inline` | `taskflow` (recommended) or `inline` |
| `recallModelId` | `HINDSIGHT_RECALL_MODEL` | pi default | Cheap model for query-building / filtering |
| `retainModelId` | `HINDSIGHT_RETAIN_MODEL` | pi default | Model for the inline write pipeline |
| `recallOperation` | `HINDSIGHT_RECALL_OPERATION` | `recall` | `recall` (facts) or `reflect` (answer) |
| `recallFilter` | `HINDSIGHT_RECALL_FILTER` | `model` | `model` (LLM-picked) or `off` |
| `recallMaxLines` | `HINDSIGHT_RECALL_MAX_LINES` | `8` | Max facts injected per turn |
| `recallContextTokens` | `HINDSIGHT_RECALL_CONTEXT_TOKENS` | `5000` | Recent context budget for the query |
| `countsRefreshMs` | `HINDSIGHT_COUNTS_REFRESH_MS` | `20000` | Widget counter refresh interval |
| `debug` | `HINDSIGHT_DEBUG` | `false` | Verbose logging (full prompts/bodies) — **may leak sensitive data** |

> The `taskflow` engine uses the models set inside `memory-fill.json`, not
> `retainModelId`. `retainModelId` only applies to the `inline` engine.

---

## Commands & shortcuts

| Command | What it does |
| --- | --- |
| `/hindsight-flush` | Write accumulated context into memory right now |
| `/hindsight-rememorize` | Re-collect the **whole** session (ignore the watermark) |
| `/hindsight-log` · `alt+h` | Open the memory operation history |
| `/hindsight-ping` | Health check, list banks, ensure the project bank exists |
| `/hindsight-recall <query>` | Ad-hoc search of the memory bank |
| `/hindsight-model [prompt]` | Resolve the small model and run a tiny completion |

### Agent tools

The extension also registers tools the agent (and subagents) can call directly:
`hindsight_recall`, `hindsight_reflect`, `hindsight_retain`.

---

## What gets stored

Memory is **facts only, never invented** — extractive from the actual
conversation. Stored: goals, decisions with their rationale, standing
constraints/preferences, verified know-how, pitfalls (what was tried and
failed), and non-obvious facts & locations (paths, endpoints, env-var *names*,
ports).

Never stored: code diffs or raw tool output, assistant chatter, unexecuted
plans, transient details (line numbers, timestamps, run ids), or **secret
values** — only *where* a secret lives (env-var name, config path) is kept.

The `dedup` phase means the same fact is not stored twice, even across sessions.

---

## Widget legend

Two fixed lines. Line 1 is the bank and its counts; line 2 is the live
lifecycle of the current operation.

```
↙ recall · <query> · found→injected      memory found and injected this turn
↙ recall · <query> · nothing found        looked, bank had nothing relevant
↙ reflect · <query> · answered            bank composed a direct answer
↙ skipped (reason)                         no lookup (meta-question / chit-chat)

building doc…                              memorize: extracting the report
doc ✓ · dedup -2 · sending to bank…        2 known bullets dropped, storing rest
doc ✓ · dedup ✓ · bank ✓ · +1              stored one new document
doc ✓ · dedup ✓ · nothing new (all known)  everything was already remembered
doc ✗ (nothing durable to store)           the slice had no reusable knowledge
```

---

## Development

```bash
bun install          # dev types only; pi provides the runtime packages
npx tsc --noEmit     # type-check
```

Source lives in `src/`; the runtime entry is `.pi/extensions/hindsight.ts`
(a 3-line re-export). After editing `src/`, just `/reload` in pi — no build step.

---

## License

MIT — see [LICENSE](./LICENSE).

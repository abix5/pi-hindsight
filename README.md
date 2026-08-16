# pi-hindsight

Long-term memory for the [pi coding-agent](https://github.com/earendil-works/pi),
backed by a local [Hindsight](https://github.com/threadway/hindsight) instance.

> **Need Hindsight running first?** On macOS the fastest way to spin up a local
> instance is [**hindsight-setup**](https://github.com/abix5/hindsight-setup) —
> simple and quick.

The extension gives the agent a durable memory of your project that survives
sessions and context compaction. Before each turn it searches the memory bank
and injects the few most relevant facts (**recall**); when the conversation is
compacted, saved on demand, or the session ends, it extracts the durable
knowledge from the slice about to be discarded, de-duplicates it against the
bank, and stores only what is new — in the background, never blocking the agent
(**memorize**). A one-line widget shows both contours live:

```
🧠 ● pi-hindsight ↙↗ 16d 153f · ↙ recall · 12→3 · db migration command
```

## The two banks

Memory lives in a **project bank** and, optionally, a shared **user bank**.

The project bank holds knowledge about the repository you are in: decisions and
their rationale, constraints, verified know-how, pitfalls, concrete locations.
Both the automatic write path and the agent's `hindsight_retain` tool write
here, and per-turn recall reads from here.

The user bank holds standing facts about the **person** — facts that stay true
in any repository: how you like to work, your tools, your prohibitions. Enable
it with `userBankId` (or `HINDSIGHT_USER_BANK`); an empty value keeps the
single-bank behaviour exactly as before. When set, the agent gains a dedicated
write tool, `hindsight_retain_user`. The automatic capture pipeline is wired to
the project bank only and structurally cannot reach the user bank — nothing
lands there unless the tool is called deliberately.

## The user block in the system prompt

What the user bank knows can be placed straight into the agent's instructions.
Put a marker in an `AGENTS.md` the agent already loads (the global
`~/.pi/agent/AGENTS.md` is the natural home) and the extension replaces it with
a `<user_profile>` block built from the user bank.

The multi-line and single-line forms produce identical bytes. Exactly one
selector is allowed; a marker with anything unparsed in it is refused whole and
left in the file exactly as written, so the mistake stays where its author can
see it.

```markdown
<!-- hindsight:user -->                        bare: the bank's stated facts

<!-- hindsight:user model: user-profile -->    a Hindsight mental model,
                                               fetched with one plain GET

<!-- hindsight:user
  query: how does this person prefer to receive reports?
  limit: 5
-->                                            a live recall; limit caps the
                                               facts kept (only with query:)
```

The block is frozen byte-for-byte for a whole **epoch**, and there are exactly
two epoch boundaries: session start and a completed compaction. The reason is
cost: the provider caches the system-prompt prefix, and content that changed
between turns would invalidate that cache on every turn and multiply the price
of a long session several-fold.

When a parsed marker cannot be answered — no server, an empty bank, a mental
model still generating — the marker is **removed** from the prompt rather than
left in it: it is a note addressed to the extension, not to the model. Nothing
about the failure reaches the model's context; you are warned once per session
instead. Within a session, a block built at an earlier boundary survives a
failed one as a stale cache.

The widget reports the block's state: `≡ 4 facts in prompt this epoch` (frozen
and injected), `≡ 4 facts · update next epoch` (the bank moved on; the prompt
follows at the next boundary — writing with `hindsight_retain_user` never
changes the current prompt), `≡ user block unavailable` (asked for and not
delivered), and `≡ no user block` (nothing was asked for). The widget head
compresses the same four readings to `≡4`, `≡4→`, `≡!`, and `≡–`.

## How it works

### Recall (read path)

Recall runs before each agent turn on a cheap model: it distils the message
plus recent context into a few standalone bank queries, runs them in parallel,
has the model judge each query's hits for relevance, and injects the surviving
facts verbatim as an untrusted-reference block — capped at `recallMaxLines`,
de-duplicated against what this session already saw. When nothing relevant is
found, nothing is injected. At a task boundary (a separate detector notices the
subject changed) a deeper pass runs a wider recall and injects one coherent
briefing instead of loose bullets.

### Memorize (write path)

Memorize fires on compaction, on `/mem-save`, and as a safety net when a
session quits. The whole pipeline — extract, merge, verify, bank-aware dedup,
store — runs inside the extension via isolated model calls; no agent turn, no
context pollution. Every write carries a deterministic `document_id`, so a
retried write upserts instead of duplicating.

### Letting a fact die

A bank that only grows eventually asserts things that stopped being true, so
the write path may retire a bank fact (`factInvalidation`, on by default) —
but only an orphan that consolidation can never fix, such as a duplicate or a
fact about deleted code, and only with a verbatim transcript quote as
evidence, re-checked in code before the kill. A failure here never costs the
write itself. Every kill is auditable: `/mem` → Log shows it as a `↓ … retire`
row with the quote that condemned it, and pressing `u` on that row puts every
fact the entry killed back into the bank and into recall — one keypress,
row-granular — while a `restore` entry is appended to the log so the history
stays honest. Set `HINDSIGHT_FACT_INVALIDATION=0` if you would rather your
facts never die.

### Review (`/mem` → Review tab)

Every stored document also lands in a global review queue. The `/mem` panel's
Review tab walks pending documents so you can approve, edit (re-stored under
the same id, replacing the old facts), or delete them. An entry nobody touches
for 7 days is approved automatically (`reviewAutoApproveDays`; `0` keeps
everything pending). That costs nothing: the document was already stored in
the bank the moment it was enqueued, so approval leaves the bank untouched —
delete is the only action that removes anything. The review log records who
ended a review: an entry without a name means a person did it, `expiry` or
`auto` means the machinery did. Since 0.4.1 the memory-collection notice in
the chat also no longer doubles its 🧠 emoji next to the widget's.

## Requirements

- **pi coding-agent** and **bun** (the extension runs as TypeScript).
- A running **Hindsight** HTTP API — by default `http://localhost:8888`,
  namespace `default`. On macOS, use
  [**hindsight-setup**](https://github.com/abix5/hindsight-setup); v0.8.4+ is
  recommended.
- A small model in your pi registry for the recall/write pipeline; one cheap
  model for both roles is enough.

## Install

```bash
pi install npm:@abix5/pi-hindsight
```

The package declares `pi.extensions`, so this registers the extension
automatically. (Manual alternative: `npm install -D @abix5/pi-hindsight` and a
one-line loader at `.pi/extensions/hindsight.ts` re-exporting the package.)

Then set your models once in the global `~/.pi/agent/hindsight.json`, declare a
bank in the project's `.pi/hindsight.json`, and `/reload`. Without a project
bank the plugin stays **dormant** — no recall, no widget — so the extension is
safe to keep installed globally and only wakes in projects that opt in. Open
`/mem` → Status to confirm the connection; the Settings tab edits everything
visually and writes each preference to the right file.

## Configuration

Config merges three layers, later wins: env defaults → global
`~/.pi/agent/hindsight.json` → project `.pi/hindsight.json`. Keep shared
settings global; keep only the bank (and project-specific overrides) in the
project file.

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `bankId` | `HINDSIGHT_BANK` | — (dormant) | Project bank id; set it (or `"auto"` for a folder-derived id) to activate the plugin |
| `userBankId` | `HINDSIGHT_USER_BANK` | `""` (off) | User bank; adds `hindsight_retain_user` and enables the user block |
| `baseUrl` | `HINDSIGHT_BASE_URL` | `http://localhost:8888` | Hindsight API base URL |
| `namespace` | `HINDSIGHT_NAMESPACE` | `default` | API namespace |
| `autoRecall` | `HINDSIGHT_AUTO_RECALL` | `true` | Search memory before each turn |
| `autoMemorize` | `HINDSIGHT_AUTO_MEMORIZE` | `true` | Write memory on compaction and session close |
| `recallModelId` | `HINDSIGHT_RECALL_MODEL` | `openai/gpt-5.6-luna` | Model for the read pipeline |
| `retainModelId` | `HINDSIGHT_RETAIN_MODEL` | `openai/gpt-5.6-luna` | Model for the write pipeline |
| `memoryLanguage` | `HINDSIGHT_MEMORY_LANGUAGE` | `en` | Language all stored memory is written in |
| `recallMaxLines` | `HINDSIGHT_RECALL_MAX_LINES` | `8` | Max facts injected per turn |
| `factInvalidation` | `HINDSIGHT_FACT_INVALIDATION` | `true` | Let the write path retire provably obsolete facts |
| `reviewAutoApproveDays` | `HINDSIGHT_REVIEW_AUTO_APPROVE_DAYS` | `7` | Days before a pending review entry auto-approves; `0` disables |
| — | `HINDSIGHT_AUTO_OFF` | `false` | Kill switch for spawned processes: forces both contours off over every layer |
| `debug` | `HINDSIGHT_DEBUG` | `false` | Verbose logging — may leak sensitive data |

Everything else — fact categories, recall effort and budgets, model fallback
chains, missions, the task detector, the bank reminder — has sensible defaults
and is edited in the `/mem` panel's Settings tab.

Keep `memoryLanguage` in agreement with the server, which has its own two
language switches: `HINDSIGHT_API_LLM_OUTPUT_LANGUAGE` forces the language of
all LLM artifacts the server produces, and
`HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE` sets the PostgreSQL
full-text-search dictionary (default `english` — a Russian bank must set it,
or Russian facts are never stemmed and full-text search under-recalls). The
extension cannot verify the agreement: `GET /v1/{ns}/banks/{bank}/config`
returns no language key at all, so keeping the three settings in agreement is
left to the reader.

## Commands & shortcuts

| Command | What it does |
| --- | --- |
| `/mem` | Open the panel: Status · Settings · Review · Log. The single place for configuration, review, history and health. `alt+h` opens it too. |
| `/mem-save [all]` | Save the accumulated context now; `all` re-collects the whole session cleanly. |
| `/mem-retain <prompt>` | Have the agent study something and store it immediately. |
| `/mem-recall <query>` | Ad-hoc search of the project bank. |
| `/mem-mark` | Mark everything up to now as processed without writing. |
| `/mem-auto [on\|off\|recall\|retain]` | Toggle the automatic contours for this session only. |

The agent itself gets `hindsight_recall`, `hindsight_reflect`,
`hindsight_retain`, and — with a user bank — `hindsight_retain_user`. For
spawned agents that must stay silent, the `--mem-only-tools` CLI flag registers
the tools and nothing else: no widget, no hooks, no automatic memory.

## What gets stored

Facts only, extracted from the actual conversation and never invented: goals,
decisions with rationale, standing constraints, verified know-how, pitfalls,
and non-obvious facts and locations. Never stored: code diffs, raw tool
output, chatter, unexecuted plans, transient details, or secret values — only
where a secret lives. Every candidate must pass a future-value test: kept only
if a future agent knowing it would act differently. All memory is written in
one configured language regardless of the conversation's language, so the same
fact never exists in two tongues.

## Widget legend

One fixed line: `🧠` · bank dot (`●` connected, `◐` checking, `○` not yet,
`⟳` working) · bank id · auto-mode · bank size (`16d` documents, `153f` facts)
· user-block state (see above; only with a `userBankId`) · last action. The
auto-mode markers `↙` (recall) and `↗` (retain) are bright while both contours
are on and dim as soon as either is off. The action tail reads like
`↙ recall · 12→3 · <query>` (found 12, injected 3), `↗ stored 1 doc · 9 lines`,
`↗ nothing new to store`, or `↗! <error>` when a write failed.

## Development

```bash
bun install     # dev types only; pi provides the runtime packages
make check      # typecheck + self-tests
```

Source lives in `src/`; after editing, `/reload` in pi — no build step.

## License

MIT — see [LICENSE](./LICENSE).

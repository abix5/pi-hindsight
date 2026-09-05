# Two memories, and a librarian to search them

## Why

The extension holds one undifferentiated memory and answers every question with
a single `POST /recall` whose hits reach the agent as bare sentences — no date,
no type, no tags, no indication of which bank they came from. Facts about the
person ("never amend a pushed commit") and facts about this project ("the gate
is `make check`") are stored, recalled and reasoned about as if they were the
same kind of thing, and the agent is never told that two banks exist or when to
write to which.

## What Changes

- Every recalled fact carries its provenance inline: which bank answered, when
  the fact was recorded, its type, its tags and its entities.
- The block built from the user bank is signed with the bank's name, so a person
  reading the transcript can tell which memory produced it.
- The agent is given a standing two-memory contract in its system prompt — what
  the project bank is for, what the user bank is for, the one-sentence test that
  separates them, and the instruction to ask memory before non-trivial work. It
  is injected once per epoch and is byte-identical between epochs, so the prompt
  cache is never invalidated mid-session.
- The user half of that contract, and the tool that writes to the user bank,
  appear only when a user bank is configured.
- `hindsight_recall` stops being one request and becomes a delegation: a small
  fast model with its own bank tools drafts, searches, reads a source document
  when a fact is cut off, and returns a built answer with the facts it relied
  on. It runs under a step limit, a time limit and a model fallback chain.
- Automatic recall gains three modes and retreats to epoch boundaries by
  default, because the contract now tells the agent to ask for itself.
  **BREAKING** in configuration only: `autoRecall` becomes a three-valued
  setting; existing `true`/`false` values keep their present meaning through a
  migration, so no configured installation changes behaviour.
- While a delegation runs the person sees one line saying so; when it ends they
  see the answer and the facts. The librarian's individual steps and its cost go
  to the journal, not into the conversation.

## Capabilities

### New Capabilities

- `memory-banks`: which memory holds what, how the agent is told, and how every
  block the extension puts in front of the model declares its origin.
- `memory-recall`: how a question addressed to memory is answered — the
  delegation, its limits, its fallback, and the shape of a returned fact.
- `memory-auto`: when memory injects itself without being asked.
- `memory-ui`: what the person sees while memory works and after it answers.

### Modified Capabilities

- none — `openspec/specs/` is empty; this change establishes the first four.

## Impact

- `src/recall.ts`, `src/recall-utils.ts`, `src/hindsight.ts` — the fact format
  and the metadata that survives extraction.
- `src/recall-agent.ts` (new) and `src/tools.ts` — the delegation and its four
  internal tools.
- `src/prompts.ts`, `src/index.ts`, `src/user-block.ts` — the contract and the
  epoch boundary that carries it.
- `src/config.ts`, `src/commands.ts`, `src/mem-panel.ts` — the three-valued
  setting and the surfaces that show it.
- `src/log.ts` — steps and cost per delegation.
- `README.md`, `CHANGELOG.md` — the two-memory contract, the delegation, and the
  migration note; release 0.6.0.
- Anyone who set `autoRecall` explicitly: the value keeps working, the meaning is
  now named rather than boolean.

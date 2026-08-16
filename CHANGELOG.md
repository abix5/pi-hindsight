# Changelog

Each `## <version>` entry below is what the extension shows you, once, the
first time a session starts after an upgrade to that version.

## 0.5.1

The extension now tells you what changed after an upgrade. The first session
started on a new version prints that release's notes into the chat — once per
version, never again for the same one, and never into the model's context. If
you skipped releases, every entry between your last-seen version and the
current one is shown. The bookmark lives at
`~/.pi/hindsight/changelog-state.json`; delete it to see the latest notes
again.

## 0.5.0

Two additions carry this release, and both are about knowledge that is not
about the repository you happen to be in.

**The user bank** is an optional second bank holding standing facts about the
PERSON — how they work, what they forbid, which tools they use — true in any
project. Enable it by setting `userBankId` in your config. It is written only
through the deliberate `hindsight_retain_user` tool; the automatic capture
path structurally cannot reach it.

**The user block** puts what that bank knows into the agent's instructions.
Put the `<!-- hindsight:user -->` marker in your AGENTS.md and it is replaced
by a block built from the bank, a mental model, or a live recall. The block is
frozen byte-for-byte for an epoch (session start → completed compaction), so
it never invalidates the provider's cached prompt prefix mid-session —
measured, an unfrozen block costs 4.7–8.5× on a long session. A marker that
cannot be answered is taken out of the prompt rather than left for the model
to puzzle over, and you are warned once per session.

Also here: the doubled 🧠 in the memory-collection notice is fixed; aged
review entries approve themselves after `reviewAutoApproveDays` (default 7,
`0` waits for you forever); the review log records who ended a review, so a
missing name now always means a human; a killed fact can be restored from the
`/mem` Log tab with one keypress (`u` on a retire row); and the README was
rewritten as a short user-facing guide.

## 0.4.1

Fact invalidation is ON by default: when the transcript proves a fact died (a
deleted file, a reversed decision), the write path retires it instead of
letting the bank grow stale forever. Every kill is reversible from the `/mem`
Log tab, and `HINDSIGHT_FACT_INVALIDATION=0` keeps facts immortal. The
blocked-window notice now points at `/mem-save`, and an idle session is no
longer mistaken for an unsaved watermark.

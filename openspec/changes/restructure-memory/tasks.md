# Tasks

Each group is one slice of the approved plan and one beads issue; the beads
issue is the state of record, these checkboxes are the apply-phase progress
marker. The full delegation brief for each slice lives in
`docs/specs/memory-restructure/`.

## 1. Fact provenance and the signed block (bead pi-hindsight-8bk.1)

- [ ] 1.1 Keep the bank's metadata through extraction — date recorded, date
      referred to, tags, entities, source document — and verify with a test that
      feeds a live-shaped response and asserts each field survives, absent
      fields staying absent rather than becoming empty strings
- [ ] 1.2 Add one exported fact formatter rendering bank, date, type, tags,
      entities and text, with a placeholder for every field the bank did not
      supply; verify with tests for a fully-populated fact, a text-only fact,
      and a fact carrying both dates
- [ ] 1.3 Route both printing paths — the explicit question and the automatic
      injection — through that single formatter, and verify with a test that the
      same fact renders identically through both
- [ ] 1.4 Sign the user-bank block with its bank name as the first line, and
      verify with tests that the line is present, that the block including it
      stays within its size limit, and that two assemblies of the same content
      are byte-identical
- [ ] 1.5 Update the README recall-block examples to the new line shape and
      verify `make check` stays at 0 FAIL with the README test passing
- [ ] 1.6 Prove the tests bite: remove the date from the formatter, then the
      block's signature line, confirming each injection reached the file and
      recording the FAIL count before reverting
- [ ] 1.7 Run one live question against the real bank with debug on and confirm
      the injected block shows provenance on every line

## 2. The two-memory contract (bead pi-hindsight-8bk.2)

- [ ] 2.1 Add the contract builder taking the project bank and the optional user
      bank, and verify with a test that the returned text names the banks it was
      given
- [ ] 2.2 Place the contract at the epoch boundary and verify with a test
      running ten turns without compaction that the instruction text is
      byte-identical throughout and appears exactly once
- [ ] 2.3 Re-decide the contract after a successful compaction and verify with a
      test that a bank renamed between epochs is reflected in the next one
- [ ] 2.4 Make the user half conditional on a configured user bank and verify
      with tests that without one there is no user paragraph and no user write
      tool, and that an inactive project gets no contract at all
- [ ] 2.5 Shorten the three memory tool descriptions to defer to the contract so
      the rule has one home, and verify the write-hygiene tests still pass
- [ ] 2.6 Prove the tests bite: make the contract rebuild with a changing value
      per turn, then make the user paragraph unconditional, recording FAIL
      counts before reverting
- [ ] 2.7 Run a live session and confirm from the debug journal that the prompt
      length is identical on consecutive turns

## 3. The librarian (bead pi-hindsight-8bk.3)

- [ ] 3.1 Extend the bank client with the request fields the librarian needs —
      tag matching and a time window — and verify against the live server's
      published schema that each field is accepted
- [ ] 3.2 Build the delegated search on the harness's own agent loop with its
      four tools, and verify with a scripted stub model that a draft, a targeted
      search and an answer produce the written answer plus formatted facts
- [ ] 3.3 Enforce one draft per bank and the scope the asker chose, and verify
      with tests that a second draft and an out-of-scope search are both refused
      without reaching the server
- [ ] 3.4 Enforce the step limit and the time limit, returning the last search's
      facts marked as lacking a summary, and verify with a test that the step
      beyond the limit never executes
- [ ] 3.5 Retry down the model chain on failure and stop promptly on
      cancellation, verifying with tests that the second candidate can succeed,
      that an all-fail error names every candidate, and that cancellation issues
      no further request
- [ ] 3.6 Record every step for the journal and the debug log, and verify with a
      test that a three-step search records three steps
- [ ] 3.7 Register the new test file in the Makefile and confirm it actually
      runs by observing the PASS count rise
- [ ] 3.8 Prove the tests bite: remove the step-limit check, then collapse the
      model chain to a single attempt, recording FAIL counts before reverting
- [ ] 3.9 Run the delegation live and confirm the debug journal shows the
      searcher's steps and its answer
- [ ] 3.10 Measure ten real questions, reporting steps, tokens and cost per
      delegation and the median — this number decides task 4.1

## 4. Modes of automatic recall (bead pi-hindsight-8bk.5)

- [ ] 4.1 Choose the shipped default from the measured median in 3.10, stating
      the number and the resulting choice in the task's completion note
- [ ] 4.2 Replace the boolean setting with the three named modes and a parser
      accepting the legacy booleans from every configuration source, verifying
      with tests that the enabled form still injects every turn, the disabled
      form never injects, and an unrecognised value falls back to the default
- [ ] 4.3 Inject at boundaries only in the boundaries mode, and verify with a
      test spanning a session start, several turns, a compaction and several
      more turns that injection happens on exactly the two boundary turns
- [ ] 4.4 Keep the periodic reminder appearing on turns with no injection, and
      verify with a test in boundaries mode
- [ ] 4.5 Report the mode by name on the settings surface, the command and the
      status line, verifying with tests that the setting cycles all three values
      and the command both reports and sets
- [ ] 4.6 Prove the tests bite: make the turn gate ignore the mode, then drop
      the legacy mapping, recording FAIL counts before reverting
- [ ] 4.7 Run live in boundaries mode and confirm from the debug journal that
      only the first turn carries an injection

## 5. What the person sees (bead pi-hindsight-8bk.4)

- [ ] 5.1 Show the running search in the activity line and restore the harness
      default afterwards, verifying with a test across all four outcomes —
      answered, limited, failed, cancelled — that the restore is the last thing
      that happens in each
- [ ] 5.2 Render the result closed and opened per the specification, and verify
      with tests on exact strings that the closed form is one line and the
      opened form names no individual step
- [ ] 5.3 Distinguish the limited and failed outcomes in the rendered result,
      verifying with tests that each is recognisable and a failure names its
      error
- [ ] 5.4 Record steps and cost in the journal entry, and verify with a test
      that a missing usage report yields a placeholder rather than a wrong number
- [ ] 5.5 Show the step count and cost in the journal row and one line per step
      on expansion, verifying with a test driven from a fixture entry
- [ ] 5.6 Prove the tests bite: remove the activity-line restore, then print the
      steps into the opened result, recording FAIL counts before reverting
- [ ] 5.7 Regenerate the documentation screenshots and confirm the working line
      and the journal expansion appear as specified

## 6. Documentation and release (bead pi-hindsight-8bk.6)

- [ ] 6.1 Document the two banks, the one-sentence test and how the agent is
      told, verifying `make check` stays at 0 FAIL after the README edit
- [ ] 6.2 Document asking memory — the delegation, the activity line, the result
      and where the steps live — verifying the README tests still pass
- [ ] 6.3 Document the three recall modes and the migration in the settings
      table, verifying the README tests still pass
- [ ] 6.4 Write the 0.6.0 release notes covering both banks, the librarian, the
      fact format and the migration, and verify the packaged file list still
      contains them
- [ ] 6.5 Set the version to 0.6.0 and verify by resetting the notice state and
      observing the notes shown once on the next start

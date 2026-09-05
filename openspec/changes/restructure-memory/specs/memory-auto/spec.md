## Purpose

Defines when memory injects itself into a conversation without being asked, the
modes that govern it, and how an existing configuration keeps its present
behaviour when the setting changes shape.

## ADDED Requirements

### Requirement: Three named modes of automatic recall

Automatic recall SHALL be governed by a setting with exactly three values: at
epoch boundaries only, on every turn, or never. The value SHALL be settable in
configuration and readable on every surface that reports the extension's state.

#### Scenario: Boundaries only

- **WHEN** the mode is boundaries and a session starts, runs several turns,
  compacts, and runs several more
- **THEN** memory is injected on the first turn of the session and on the first
  turn after the compaction
- **AND** on no other turn

#### Scenario: Every turn

- **WHEN** the mode is every turn
- **THEN** memory is injected before each turn, as before

#### Scenario: Never

- **WHEN** the mode is never
- **THEN** memory is never injected automatically, at a boundary or otherwise

### Requirement: An existing setting keeps its meaning

Loading SHALL accept the previous boolean form of the setting from every source
that could carry it and map it to the named mode with the same behaviour: the
enabled form to every turn, the disabled form to never. An unrecognised value
SHALL fall back to the default mode rather than disabling the feature silently.

#### Scenario: Previously enabled

- **WHEN** a configuration carries the old enabled value
- **THEN** the resolved mode injects memory on every turn, exactly as before

#### Scenario: Previously disabled

- **WHEN** a configuration carries the old disabled value
- **THEN** the resolved mode never injects memory

#### Scenario: Unrecognised value

- **WHEN** a configuration carries a value that is neither a mode nor a boolean
- **THEN** the default mode is used

### Requirement: The reminder survives the quiet turns

The periodic reminder that tells the agent a bank exists and how to ask it
SHALL continue to appear on turns where no memory was injected, in every mode
that permits injection at all.

#### Scenario: Reminder on a quiet turn

- **WHEN** the mode is boundaries and a turn passes with no injection
- **THEN** the reminder still appears on its usual schedule

### Requirement: Every surface reports the mode by name

Every surface that shows the extension's state SHALL name the current mode
rather than describing it as on or off, and every surface that can change it
MUST offer all three modes.

#### Scenario: Settings cycle through all three

- **WHEN** the person changes the setting from the settings surface repeatedly
- **THEN** the three modes are offered in turn and the chosen one is written to
  configuration

#### Scenario: The command reports and sets

- **WHEN** the person asks for the current mode through the command surface
- **THEN** the mode is reported by name
- **AND** naming a mode sets it

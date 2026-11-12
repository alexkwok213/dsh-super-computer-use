# Observed Drawing Implementation Plan

**Goal:** Make Freeform drawing use visible, genuinely dispatched brush strokes with color and canvas feedback at bounded checkpoints.

**Architecture:** Keep native input and the existing authenticated plugin lifecycle. Native stroke events report actual dispatched pointer positions to the session overlay. A bounded drawing operation first tests a small stroke, checks captured canvas evidence against the selected color, and stops on uncertainty; subsequent chunks require fresh observations. The agent workflow plans recognizable contours and color regions and does not describe raster scanning as semantic understanding.

**Tech Stack:** Node.js, Swift/CoreGraphics, macOS Freeform, isolated node:test and real desktop acceptance.

**Spec:** User-approved description in this chat, 2026-11-12.

## Global Constraints

Preserve existing unrelated work; no image import as artwork; do not modify DSH app.asar or add unauthenticated services. Verify native helper, Host and Client identities before claiming activation. Release via repository workflow when acceptance succeeds.

## Review Focus

- Different target/window or moved geometry must not reuse evidence.
- Wrong color, inactive brush, missing capture, obscured canvas, or unchanged pixels must stop painting, never assert success.
- Pause or interrupted drag must release the mouse and stop subsequent strokes.
- Virtual cursor events must correspond to actually dispatched points and never suggest background events moved the system pointer.
- Complex reference detail and perceptual similarity require real observation; a posterized preview is not final evidence.

### Task 1: Pointer evidence

**Files:** `engine/Sources/main.swift`, `lib/core.mjs`, `test/visual_feedback.mjs`, native event tests.

- [ ] Write and run failing tests for paint pointer event delivery and failure/dry-run behavior.
- [ ] Emit actual dispatched stroke positions; update visible cursor from those events without claiming independent hardware input.
- [ ] Verify event tests and native behavior.

### Task 2: Bounded, observed strokes

**Files:** `lib/index.mjs`, native capture/inspection and drawing tests as necessary.

- [ ] Write failing tests for color mismatch, inactive brush/no visible canvas change, missing/stale capture, bounded continuation, pause and geometry drift.
- [ ] Implement minimal, fail-closed visual checks using real before/after canvas evidence; ensure test marks and recoverable continuation are clear.
- [ ] Verify correct-color, wrong-color and no-mark cases in isolated tests and Freeform.

### Task 3: Drawing strategy and user-facing behavior

**Files:** `skill/SKILL.md`, `lib/app-playbooks.mjs`, related tests and documentation.

- [ ] Write failing tests for the Freeform route requiring reference analysis, foreground brush and observation checkpoints, rather than unconditional whole-layer execution.
- [ ] Update routing and tool descriptions to prefer deliberate contours, regions and small verified strokes; explicitly state limits.
- [ ] Run focused and full isolated test suites.

### Task 4: Real acceptance and release

- [ ] Use a disposable Freeform board to demonstrate cursor-to-stroke correspondence, correct/wrong colors, disabled brush and stop; inspect the result against a reference without hiding failures.
- [ ] Review changes and preserve pre-existing unrelated work and artifacts.
- [ ] Follow `npm run release -- minor`, verify running identities, Actions and Release; only claim full completion on `[release] RELEASE OK`.

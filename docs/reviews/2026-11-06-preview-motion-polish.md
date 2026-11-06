# Native preview motion polish — 2026-11-06

## Reference and scope

Compared the supplied 57.71-second `Screen Recording 2026-11-06 at 09.13.13.mov` with current 0.5.1 sources. The reference shows a compact picture-only preview, restrained window chrome and transitions. The user's priority is smooth, polished Computer Use effects. This pass retains the existing target/ownership architecture and concentrates on native preview presentation. Timing constants below are implementation choices, not claims about Codex internals or measured exact parity.

## Changes

- Aspect-fit preview within 200 × 150 points (previously 320 × 240), with compact non-overlapping initial slots, an 8-point corner radius and native window shadow.
- Reveal after the first frame or an explicit unavailable status, avoiding the initial blank black panel. A 220 ms opacity/4% scale entrance; 160 ms exit. Native capture cap rises from 15 to 30 fps; the compositor animates separately from capture.
- Hover-only dark material controls, accessible Stop/Close symbols and tooltips; 160 ms reversible hover transition. Stop closes target input immediately; Close only dismisses the preview.
- Pointer position retargets from the presentation layer with bounded latest-wins animations; a click ring expands/fades at the destination. Fading pointers can be interrupted without jumping. Stale/unavailable status clears feedback. Runtime Reduce Motion skips movement/scale effects.
- Host EOF allows a bounded 500 ms exit grace. The cleanup timer remains referenced until native exit or termination, including when the host itself is draining; old-incarnation events remain rejected.

## Verification

- Regression tests cover graceful EOF, an EOF-unresponsive child during host exit, interrupted pointer targets, stale-frame clearing and Reduce Motion. Native view tests compile the real Swift view into an isolated temporary harness.
- Read-only independent review identified the exit timer lifetime and interrupted fade issues; both were corrected before final build.
- Runtime and UI results are recorded below after verification. Source review and offscreen checks alone do not establish exact visual parity with Codex.

### Completed checks before release

- `npm run dev:sync`: exit 0, **284 tests passed / 0 failed**, real config/pause unchanged, universal helper built and signed.
- Actual DSH host hash `f079b05cd835…`; unchanged executed client rev `fab75ae7e804`; helper PID 28390, build `3f4ebe3f8670…`, old PID 25239 exited; no leftover helper/build process reported.
- The first manual build was interrupted by a source edit and correctly failed; the subsequent dev-sync built the final unchanged source successfully. Existing Swift concurrency warnings in capture code remain outside this change.
- Actual DSH conversation invoked `cu_windows`, `cu_session start`, and `cu_status` on an already-open TextEdit window. Its tool-state summary reported native preview window 1950, 181 × 150, visible/live, background-safe with no target activation or modification. The DSH settings UI subsequently showed idle / 0 targets after the turn ended.
- Built-in Computer Use could not select the standalone `cu-preview` executable as an app. Actual hover/drag interaction and frame-by-frame perception of animation therefore remain unverified; no exact Codex parity claim. Stop/Close semantics and exit lifetime are covered by automated checks; drag code itself is unchanged.

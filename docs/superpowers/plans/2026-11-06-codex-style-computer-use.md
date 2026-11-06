# Codex-style Computer Use Implementation Plan

**Goal:** Correct target halo occlusion and deliver draggable, target-scoped native previews with accurate action feedback.

**Architecture:** Preserve plugin-managed session ownership, route native preview lifecycle and actions by target identity, and avoid drawing feedback unless frame geometry matches. Verify actual WindowServer ordering before relying on cross-process placement. Degrade honestly if ordering or capture is unavailable.

**Tech Stack:** Swift/AppKit/ScreenCaptureKit, Node.js plugin, DSH client, isolated node and native tests.

**Spec:** `docs/superpowers/specs/2026-11-06-codex-style-computer-use-design.md`

## Tasks

1. Establish reproducible cross-process occlusion behavior with fixture windows. Implement safe halo positioning or conservative hiding and regression-test foreground occlusion, movement and cleanup.
2. Establish target-scoped preview lifecycle in host and native helper: start, close, targeted stop, ownership, crashes and cleanup. Test concurrent targets and stale identities before implementation.
3. Render a borderless draggable native preview; preserve aspect ratio, surface unavailable or stale frames, and test capture/drag/visibility behavior in real windows.
4. Route target-specific action feedback with frame and geometry identity checks; test mapping, stale-event rejection and reduced motion.
5. Integrate DSH controls without duplicate capture; run relevant isolated tests, `npm run dev:sync`, and live multi-target, foreground-occlusion, drag, stop and cleanup checks. Report limitations honestly.

## Constraints

Preserve uncommitted changes; no DSH app.asar changes, unauthenticated ports or unmanaged services. No git commit/push without request. Do not equate source changes or tests with live DSH acceptance.

## Execution ledger

- 2026-11-06: Implemented target-scoped native preview ownership (`lib/native-previews.mjs`), pipe-bound output routing, stale-process event rejection, per-target close/stop, and host disposal cleanup. Two real child-process regression checks pass; existing multi-target checks pass (11 checks combined).
- Native card now has hover controls, picture-only geometry, nonactivating floating placement, and explicit static-fallback labeling. Candidate arm64 helper compiled successfully. Actual dragging and hover interaction remain unverified.
- Full suite attempts currently end with SIGTERM in the core live-test sequence; running its plugin integration test alone in a new process session and temporary CU_STATE_DIR passes. Do not report the full suite green until the termination is diagnosed.
- One direct, unisolated diagnostic invocation overwrote dev-sync runtime metadata with a test Host PID. DSH Host 5222 remained alive; the dead reported PID is not evidence of a DSH crash. Added a CU_STATE_DIR guard to core native tests. Real loaded identity must be republished by the actual host; never reconstruct or spoof it from source files.
- Remaining: true frame/event geometry binding and preview effects, close/stop GUI acceptance, independent target placement/drag limits, Space/minimize/restore halo behavior, full tests and supported real DSH update/identity verification. Goal remains active.
- Follow-up: Added explicit native drag handling, non-key panels, per-preview initial slots, and display-boundary clamping. Geometry test now covers negative-origin displays, letterbox mapping and rejection after a one-pixel window move; it passes.
- Added pipe-routed preview cursor/click rendering tied to a target's current observation generation and bounds; native display rejects mismatched bounds, old messages, missing/recent-frame failures and static fallback. Candidate arm64 helper compiles. Visual effect accuracy is still pending real UI acceptance.
- Traced an additional suite hang to `plugin_lifecycle.mjs` launching real native previews for invented WindowServer ids. Its mocked layout tests now resolve no real binary; focused native-preview/layout checks pass (13). Terminated only the verified orphan test runner and its two preview children after the old runner timed out.
- Full suite still exits 143 during core live-test cleanup. A temporary ChildProcess.kill trace found only positive child PIDs, not a group kill; source of SIGTERM remains unproven. Do not call this a passing full suite.

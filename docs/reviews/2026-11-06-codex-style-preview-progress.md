# Codex-style preview: implementation and verification progress

## Verified on 2026-11-06

- Target-scoped native preview processes, pipe-bound ownership, stale-incarnation rejection, hover Stop/Close controls, and per-target Halo Stop routing are implemented.
- Native previews use borderless non-key panels, explicit image drag handling, screen-boundary clamping, distinct initial slots, rounded image clipping and shadows. Capture failures and stale/unavailable images have visible labels.
- Feedback maps SCK frame `screenRect` and `contentRect` through buffer pixels and letterboxing, verifies current observation bounds and target identity, and rejects delayed/unknown-clock messages. Idle heartbeat preserves valid stationary images. Default native-preview sessions no longer start the unrelated desktop cursor overlay.
- `npm test`: **259 passed, 0 failed** after native test executables were isolated by copying their unchanged bytes into the temporary state directory. The core plugin integration now targets an owned fixture instead of an arbitrary user window. Copying the signed helper to a private path also made the previously terminating core test pass; the precise macOS mechanism behind the shared-path termination has not been proven.
- `npm run build:bin`: Universal Binary built and signed.
- `npm run dev:sync`: exit **0**, output **OK**. Actual DSH Host **5222**, Host source hash **e2225d79fbe8…**, executed Client rev **fb98bc35c966**, actual native helper **11366**, build **fd20479312b0…**. Prior helper **10986** exited; the update reported no leftover helper/build processes.
- The stale runtime report produced by an unisolated diagnostic was replaced by the actual Host through DSH's normal plugin disable/enable UI. DSH was not force-restarted, app.asar was only read for inspection, and no unmanaged permanent service was added. Earlier HMR-unavailable conclusions based on the overwritten report are superseded by this real successful update.
- Actual background TextEdit frame metadata probe: screen rect `(185,83,586,488)`, content pixel rect `(0,0,586,488)`, first frame **91 ms**, **13** valid frames, exit 0.
- `engine/tests/halo_occlusion.py`: target hide/restore and WindowServer ordering against a covering fixture pass. Target and blocker belong to one fixture application; cross-application and Space behavior remain separate acceptance items.
- `engine/tests/preview_placement.py`: negative-origin screen clamping, letterbox/content-rect mapping and moved-window rejection pass.

## Real two-target acceptance probe

Ran `engine/tests/multi_target_acceptance.mjs` with private copies of the built signed helpers. Background AX clicks and text writes were verified on two owned fixture apps; per-target tokens, concurrent reads, target-bound previews, Stop A / continue B, rejection after Stop A, and stop-all were verified. Frontmost application and clipboard were unchanged. The cursor-position comparison was **false** (before `(972.29,463.34)`, after `(973.08,446.39)`); there is insufficient evidence to attribute that movement to the plugin versus concurrent physical input. The script therefore returned exit 1. Do not present this run as a completely passing acceptance test.

## Still required for completion

- Actual dragging and hover Stop/Close interaction of the loaded DSH preview, including Close leaving the target controllable.
- Visual point accuracy and reduced-motion behavior in the real popup, plus simultaneous native preview behavior during user work in a third app.
- Cross-application partial/full occlusion and Space/minimize/restore acceptance; current fixture test covers ordering and hide/restore but not all these cases.
- Resolve the cursor-comparison discrepancy with attributable input evidence; verify final native process cleanup and no target cross-talk during real UI interactions.

The goal is still active. Successful dev-sync proves the code is loaded, not that every visual acceptance criterion has passed.

## Follow-up after repeat verification

A second dev-sync exposed an idempotency defect: its plan compared the Host's earlier loaded disk hash with the new disk binary, set `requireNative`, and then required the already-correct live helper PID to exit. Live helper 11366 and disk both had build `fd20479312b0…`; this was a verifier failure, not evidence that the native update had reverted. The CLI now derives replacement necessity from the actual helper build, and Host verification distinguishes legitimate reuse from an old helper that needed replacement. A regression check covers matching, mismatching and absent helpers.

Preview placement also now chooses a free slot after one target closes; a new regression ensures adding C after closing A does not overlap B's initial slot.

The latest full test run passes **261 / 261**. Applying these final Host-side corrections is deferred by the real active TextEdit CU session (window 449, pid 5897); dev-sync waits up to 30 seconds rather than interrupting it. The earlier successful runtime update remains verified, but the new verifier/slot corrections are not yet claimed loaded. User feedback has been requested for actual dragging/Close behavior and for ending the active session before the final safe reload.

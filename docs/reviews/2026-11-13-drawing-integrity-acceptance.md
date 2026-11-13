# Drawing integrity acceptance — 2026-11-13

This is a workflow/engine validation, not a completed reproduction of 大肥鱼2.png.

## Managed path

Codex's previous `computer-use` MCP entry was disabled and referred to SkyComputerUseClient, not this plugin. Added a separate `dsh-super-computer-use` entry using the bundled stdio adapter. The adapter neither starts a Host nor invokes native commands; it authenticates to the plugin-owned Unix socket. Live tools/list reported 20 tools. Actual cu_status/call responses came from DSH Host PID 25094, canonical lib/index.mjs, with matching disk/running native identity. This chat's hot-loading of the new MCP namespace is not established; acceptance used the exact same adapter in one-shot diagnostic mode, not raw drawing CLI.

External image delivery was observed via real MCP image payloads and inspected locally. The plugin explicitly cannot establish the external model's identity or comprehension from that transport capability.

## Freeform, disposable Untitled 13

The existing Untitled 12 artwork was left intact. All strokes used managed cu_paint through the authenticated adapter.

- Medium Monoline calibration: requested 3 logical points, actual mark measured 5. Returned paint_not_verified, no nextOffset; only the first of two strokes dispatched.
- Attempted continuation after that failed stroke: paint_review_required; no input.
- Two new horizontal test strokes with measured width 5: each returned matched color, actual width 5 and contained region. The second required a reviewToken and concrete visual review of the returned image. Both results remained artworkComplete:false.
- Intentionally declared red while black remained selected: paint_color_not_verified before dispatch.
- Intended region excluding the supplied path: stroke_outside_paint_region before dispatch.
- Long test stroke interrupted by terminating the adapter: bridge_call_aborted with actionReplaySafe:false. A follow-up screenshot showed a partial line, shorter than the planned 400 points. A screen capture during dispatch showed the blue virtual cursor at the advancing line endpoint. Native cancellation/release is also covered by isolated cancellation tests.
- Stopped target through cu_session. Returned remainingTargets:0, inputGateClosed:true, cleanupState:unknown; no claim of full cleanup or restored window layout.

Local raw evidence is in /tmp/drawing-acceptance, including width-rejected.json, verified-first.json, second-success.json, wrong-color.json, region-rejected.json, interrupted-response.json, cursor-midstroke.png and screenshot results. Those may be temporary; do not package full desktop screenshots or transport credentials into the release.

## Automated evidence

Focused Swift tests check actual changed-pixel width 1/6/18, missing marks, and paint outside an allowed region. Geometry tests cover concave/narrow cutouts and brush-footprint overflow. Bridge tests cover authorization, image payloads, disconnect cancellation, lifecycle cleanup and stdio protocol behavior. Observed-paint tests cover missing vision/capture/image delivery, color, width, region and single-use review continuation. Full isolated run after review fixes: 392 passed, zero failed; real ~/.cu config and pause were unchanged during tests. Final release reruns the complete suite and verifies all runtime identities.

## Limits

Region geometry is declared from visual inspection; these checks do not prove the declared region is the correct semantic object. Width measurement can be unobservable over existing marks, in which case painting stops. No result from these checks proves final artistic likeness or filled-area completeness. The old raw native CLI remains a development interface; the skill prohibits substituting it for the managed path, but shell access is not sandboxed by this plugin.


## Review fixes and real retest

An independent source review found four issues before release: failure paths dropping the review gate, explicit stop queued behind paint, expired review deadlock, and short-segment width false rejection. Added regressions and fixed all four; a second review found no remaining important issue.

After managed dev:sync reloaded the new Host/helper:

- Wrong-width input followed by a fresh offset0/source received paint_recovery_review_required with a fresh image/token and no input. After inspecting that new image, the reviewed new stroke passed with actual width5.
- Explicit cu_session stop sent while a slow stroke was running returned in1.016 seconds with cancelledActions:1, remainingTargets:0 and inputGateClosed:true. The paint result was cancelled, outcomeUnknown:true, actionReplaySafe:false and artworkComplete:false. It did not wait for the planned long stroke to finish.
- Cropped evidence of the actual blue cursor at the progressing stroke endpoint is preserved as [drawing cursor](2026-11-13-drawing-cursor.png); other desktop windows are excluded. This earlier capture predates the final action-label update, which replaces the stale click caption with brush color/width/stroke index.

The final release pipeline reruns the suite and checks Host/Client/helper identities. The terminal RELEASE OK and GitHub release assets are authoritative publication evidence; this report does not pre-claim that gate.

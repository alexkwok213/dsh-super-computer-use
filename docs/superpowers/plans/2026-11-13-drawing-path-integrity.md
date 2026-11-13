# Drawing Path Integrity Implementation Plan

Goal: Make the real Codex-to-DSH drawing path observed and reviewable, reject strokes outside intended subject regions including brush width, and report partial/blocked results honestly.

Approved scope: User requested execution after the five-point diagnosis in this chat. Preserve the DSH plugin boundary and authenticated lifecycle. No standalone shadow Host, app.asar edits or unauthenticated control service.

1. [x] Establish the actual Codex connection to the managed DSH tool surface. Prevent silent fallback to raw multi-stroke CLI. Verify authenticated tool invocation reaches the live plugin and pointer events reach its cursor surface.
2. [x] Add per-stroke intended-region and brush-width contracts. Fail before dispatch on invalid geometry, segment crossings or brush-footprint overflow. Compare requested width to real marks; matching a requested region alone does not prove semantic accuracy.
3. [x] Require canvas/reference review between strokes. Return explicitly limited verification and incomplete artwork status; capture failures and interruption never authorize continuation or completion. Fix conflicting skill guidance and document model/image routing limits.
4. [x] Run focused failure/recovery tests and isolated full suite. Use a disposable Freeform board to verify in-bounds/wrong-region, colors, width, cursor correspondence and interruption on the actual path, without touching the existing artwork.
5. Release via npm run release -- minor, verify Host/Client/helper identities and RELEASE OK. Audit all above before declaring goal complete.

First regression: an L-shaped allowed region contains both supplied endpoints, but a diagonal between them crosses the excluded corner. Testing vertices alone must not pass. A stroke whose centerline fits but whose brush footprint crosses a border must also fail.

## Checkpoint

- Added polygon containment with full segment-distance/brush-radius checks, including concave and narrow cutouts; integrated required paintRegion/brushWidth in cu_paint.
- Return artworkComplete:false, requiresVisualReview:true and semanticAccuracy:not_verified on successful pixel checks.
- Fixed skill instructions that silently encouraged allLayers batch painting and forbid raw CLI fallback when plugin tools are missing.
- Verified 14 focused cases and full isolated suite: 383 pass, 0 fail; real ~/.cu config/pause unchanged. Historical /tmp/stage3_red.json is rejected at stroke 0 against the visible inner-flesh boundary.
- Actual Codex config has no DSH MCP entry. Its disabled computer-use entry points to SkyComputerUseClient, a different product; enabling it would not repair this plugin connection. Do not repurpose it.
- Live DSH profile symlink targets /Users/johnkwok/Downloads/work/dsh-super-computer-use; that checkout is clean at 5c9deb3, the same base as this worktree. dev:sync check-only correctly refuses the worktree path. Integrate deliberately before release; do not silently repoint the live link.
- Still required: managed Codex adapter/connection, actual-width evidence (declared width currently only constrains geometry), continuation binding to observed frames, real Freeform acceptance, release/runtime/remote verification. Goal remains active.


## Implementation and desktop checkpoint

- Implemented plugin-owned authenticated Unix socket and bundled stdio client; Codex has a separate MCP entry. Live tools/list sees20 tools. Real calls reach canonical DSH Host and deliver MCP images. This existing chat's new-tool hot-load remains unverified; use next client reload to discover the configured namespace.
- Native changed-pixel checks now measure actual brush width and inspect region spill. Continuation requires a single-use token, concrete review, unchanged captured frame and matching source/offset. Every cu_paint result remains explicitly incomplete.
- Full isolated suite389 passed. Native CLI fixture independently verified measured width6 and wrong-width refusal against generated pixels.
- Real Freeform acceptance: color/region refused before input, width3 vs measured5 refused after first mark, measured5 strokes pass, reviewed continuation succeeds, interrupted long stroke remains partial with blue cursor visible at the dispatched endpoint. See docs/reviews/2026-11-13-drawing-integrity-acceptance.md.
- Test target was stopped; cleanupState remains unknown. Still required: independent review, final release/tests/reload/runtime and GitHub verification.


Final pre-release checkpoint: four important review findings were reproduced with failing tests, fixed, and re-reviewed. Full isolated suite392 passed. Managed dev:sync verified Host/client/helper; real failure-recovery and concurrent explicit-stop acceptance passed (stop1.016s, cancelledActions1). Final label unit test passes. Publication remains governed by the release command terminal result and remote readback, rather than editing this plan after publishing.

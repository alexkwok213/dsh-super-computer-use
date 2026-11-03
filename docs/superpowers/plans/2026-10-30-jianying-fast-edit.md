# Jianying Fast Editing Implementation Plan

> **For agentic workers:** Use executing-plans to implement and verify each task in this session.

**Goal:** Run select material → add to timeline → position playhead → split → verify in an independent Jianying test draft, with measured timings and fewer model round trips.

**Architecture:** Preserve the Swift engine and its safety checks. Extend the existing Python MCP batch boundary only where the real editing experiment proves a need: local state checks and bounded execution with per-step timing. Prefer existing AX actions and verified keyboard shortcuts; use scoped screenshots for custom timeline rendering.

**Tech Stack:** Swift/AppKit, Python standard library, existing MCP server.

**Spec:** User-approved chat scope (2026-10-30): fast human-like Jianying GUI editing; independent test draft; preserve existing drafts. This plan records that scope without adding draft-file editing.

## Global Constraints
- Preserve pre-existing uncommitted changes; do not deploy or restart services just to benchmark.
- GUI tests use an independently created test draft; no edits to the current 10月30日 draft.
- Verify results from UI state; a sent input is not a successful edit.
- Do not retry an action whose outcome is unknown.
- Existing MCP tool compatibility and safety checks remain intact.

## Review Focus
- Delayed UI changes must be polled without replaying the action.
- Missing/ambiguous targets must stop execution before subsequent edits.
- Invalid later batch steps must be rejected before any earlier action.
- Deadline expiry must stop further dispatch; in-flight calls cannot be cancelled by Python alone.
- Failure must preserve completed-step evidence and timing.

### Task 1: Establish real GUI editing route
- [ ] Inspect current controls and create an independent test draft using Jianying UI.
- [ ] Verify add-to-timeline, positioning and split route, recording observable postconditions.
- [ ] Measure baseline call counts/timings and retain screenshot evidence.

### Task 2: Implement the smallest supported fast execution improvement
**Files:** mcp/server.py, mcp/tools.json, tests/batch_units.py, tests/run_all.sh.
**Interface:** Extend existing batch arguments with bounded deadline/timing; use existing expect for local assertions where it can express the real UI postcondition.
- [ ] Add failing tests for upfront validation, deadline, timing and stop-on-failure; run and inspect failures.
- [ ] Implement compatible local execution improvements with no action retries.
- [ ] Regenerate tool schema and pass the quick regression suite.

### Task 3: Verify real editing and document limits
- [ ] Run the verified chain through the local MCP code against the test draft.
- [ ] Record result, timings, before/after scope and remaining limits in a focused report.
- [ ] Obtain independent code review, resolve actionable findings, run affected tests.

## Execution ledger
- Baseline workspace is branch cu-execution-prototypes with pre-existing local edits. Ruling: retain this workspace and avoid commits containing others' work; implementation touches Python batch/tests/docs only unless evidence justifies a scoped change.
- User approved implementation and real editing in an independent draft; no further design gate required.

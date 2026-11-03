# Computer Use Performance Implementation Plan

**Goal:** Reduce measured latency without changing action semantics or sacrificing safety isolation.

**Architecture:** Keep the existing authenticated service and CLI as the compatibility boundary. Dispatch a narrowly audited set of read-only, short-lived queries within the service and leave all actions in their existing isolated subprocesses. Reduce repeated accessibility IPC by caching each root child's sort key for one sort only. Use before/after integration measurements; defer a persistent screen stream until its authorization, freshness, and lifecycle can be verified.

**Tech Stack:** Swift, AppKit, Accessibility, Python unittest-style integration harness.

**Context:** `性能与体验改造方案.md`; `协作记录.md`.

## Constraints

- Preserve CLI and MCP responses and authorization; do not replay actions on uncertain results.
- Do not modify the user's existing local changes, deploy, or restart their running service during verification.
- Keep `snapshot` action metadata, stable ref ordering, and scoped window selection.
- Performance goals are targets, not measured promises.

## Tasks

1. **Read-only fast path.** In `Sources/main.swift`, share the implementation of `frontmost` and `cursor` between CLI and service; allow only exact argument arrays for direct dispatch, with the existing exitCode and audit log semantics. Unknown commands and commands with arguments continue through `runEngine`. Add `tests/service_fast_path.py` to launch an isolated temporary compiled service on a spare port and compare CLI and service responses and authorization, while measuring latency.
2. **Verify and document.** Run the quick suite and Swift compilation; run the isolated service integration and record before/after results and limitations in `协作记录.md` without disturbing existing content. Do not claim whole-product goals met absent end-to-end evidence.

AX root sorting was considered but is deferred: a safe change requires evidence for duplicate sort keys, window churn, and ref resolution against real accessibility trees. The broader app migration, capture stream, and preview experience remain future work, not outcomes of this plan.

# bench

Two separate measurements. Do not mix them into one "speed" number.

## 1. Local execution micro-benchmark — `node bench/run.mjs`

Runs a fixed, local task set against the engine's own demo window (no model, no
host). Every round is retained as a sample:

```
{ scenario, buildId, ok, timings, evidence, error }
```

Rules (enforced by `bench/results.mjs`, unit-tested in `test/benchmark_results.mjs`):

- A missing measurement is `null`, never `0 ms`. In particular `firstVisibleMs`
  is only set when a real on-screen frame was observed.
- "tool returned ok" is not success. A click round must move the demo counter; a
  type round must contain a per-round **unique** token that was absent before.
- Any failed round makes the process exit non-zero.

```
node bench/run.mjs                     # 20 runs per task, printed + summary
node bench/run.mjs --runs 5 --json out.json
node bench/run.mjs --task click_ref
```

This measures the local execution path only. Its tool-level success is not a
business success rate, and it never calls a model; it cannot be used to compare
models or hosts.

## 2. Visible-feedback latency — `node bench/visual-latency.mjs`

Three distinct numbers, never substituted for each other:

- `commandWrittenMs` — action start → overlay command written to the helper stdin.
- `renderCommittedMs` — overlay transaction committed (needs a RenderAck; null today).
- `firstVisibleMs` — first real on-screen frame containing the test marker (needs
  screen-capture + frame analysis).

It does **not** screenshot every frame. When the capture/analysis facility is
unavailable it reports `firstVisibleMs: null` and `support.firstVisible: false`
— i.e. **untested, not 0 ms**.

```
node bench/visual-latency.mjs --runs 20 --json visual.json
```

## Baseline

Run both, keep the full JSON, and record `buildId` + display config alongside it.
A new baseline replaces the old only when every round is honest: failures kept,
missing values kept null.

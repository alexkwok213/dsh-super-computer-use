# Execution-loop benchmark

`npm run bench` runs a fixed, local task set against the demo window and prints
per-task success, P50/P95 latency and the first-feedback latency. The numbers
come from the tools' own `timings`, so a regression in the adapter shows up here
without any external instrumentation.

```bash
npm run bench                       # 20 runs per task
npm run bench -- --runs 5           # quicker pass while iterating
npm run bench -- --task click_ref   # one task
npm run bench -- --json out.json    # machine-readable report
```

Tasks: `snapshot`, `click_ref`, `type_expect`, `batch_flow`, `preview`, `stop`.
The set is deliberately small and needs no third-party app, so it can run in CI
on any Mac with the engine installed.

## Baseline — 2026-11-03, this Mac

12 runs per task, `docs/bench/baseline.json`:

| Task | Success | P50 | P95 | First feedback P50 |
|---|---|---|---|---|
| AX snapshot of a native window | 12/12 | 97 ms | 183 ms | — |
| Click by snapshot ref + observation | 12/12 | 287 ms | 335 ms | 0 ms |
| Type + explicit post-condition | 12/12 | 487 ms | 573 ms | — |
| Batch: click → wait → key | 12/12 | 524 ms | 690 ms | — |
| Screenshot preview (cold daemon) | 12/12 | 346 ms | 398 ms | — |
| Stop a session | 12/12 | 0 ms | 1 ms | — |

First feedback is 0 ms by construction: the cursor hint is written to the overlay
before the engine call, so the person watching sees the agent move before any
result exists.

## What these numbers replaced

Same machine, measured while fixing the loop:

| Path | Before | After |
|---|---|---|
| Capture daemon shot | 8116 ms, `ok:false`, every time | 111–118 ms warm, 346 ms cold |
| Engine `shot` fallback | 4376 ms | 414 ms |
| `cu_session start` with preview | 2653 ms (degraded preview) | 564 ms (with image) |
| Status query during a 3 s action | ~3 s | 8 ms |
| Cursor glide / ripple | 280 ms / 500 ms | 140 ms / 240 ms |

## Comparing models or hosts

The tasks are fixed and the tools are fixed, so a run can be attributed. To
compare models, keep `npm run bench` unchanged and record, per run: the model,
the number of tool calls, and the image bytes delivered (`lastImage.bytes` in
`cu_status`). To compare engine builds, keep the model and prompt fixed and
compare two `baseline.json` files.

Not part of the set on purpose: Finder file dialogs, Electron search boxes,
browser forms and Jianying timeline work all depend on a human-prepared app
state, so they are recorded by hand in the review document rather than asserted
here.

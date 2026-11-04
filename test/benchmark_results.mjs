// F5: the benchmark must report what was measured, and fail honestly.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeSample,
  judgeClick,
  judgeTyped,
  aggregate,
  exitCodeFor,
} from "../bench/results.mjs";

test("a missing first-visible frame stays null, never 0 ms", () => {
  const sample = makeSample({ scenario: "click", ok: true, timings: { actionMs: 120 } });
  assert.equal(sample.firstVisibleMs, null);
  assert.equal(sample.timings.actionMs, 120);
  const agg = aggregate([sample, makeSample({ scenario: "click", ok: true, timings: null })]);
  assert.equal(agg.firstVisibleP50, null, "no measured frame → null aggregate");
});

test("a click whose counter did not move is a failure even when the tool said ok", () => {
  assert.deepEqual(judgeClick({ toolOk: true, counterBefore: 3, counterAfter: 3 }), {
    ok: false,
    reason: "counter_unchanged",
  });
  assert.equal(judgeClick({ toolOk: false, counterBefore: 3, counterAfter: 4 }).ok, false);
  assert.equal(judgeClick({ toolOk: true, counterBefore: 3, counterAfter: 4 }).ok, true);
});

test("a unique input is not satisfied by text that was already there", () => {
  // The old bug: "bench" was typed repeatedly and query=bench matched leftover text.
  assert.deepEqual(judgeTyped({ expectQuery: "bench-r7", textBefore: "bench-r7 leftover", textAfter: "bench-r7 leftover" }), {
    ok: false,
    reason: "stale_text",
  });
  assert.equal(judgeTyped({ expectQuery: "bench-r7", textBefore: "previous", textAfter: "previous bench-r7" }).ok, true);
  assert.equal(judgeTyped({ expectQuery: "bench-r7", textBefore: "previous", textAfter: "previous" }).ok, false);
});

test("a single failed round makes the process exit non-zero", () => {
  assert.equal(exitCodeFor([{ ok: true }, { ok: true }]), 0);
  assert.equal(exitCodeFor([{ ok: true }, { ok: false }]), 1);
  assert.equal(exitCodeFor([]), 1, "an empty run is not a success");
  const agg = aggregate([
    makeSample({ scenario: "a", ok: true, timings: { totalMs: 100 } }),
    makeSample({ scenario: "a", ok: false, timings: { totalMs: 200 }, error: "boom" }),
  ]);
  assert.equal(agg.ok, false);
  assert.equal(agg.success, "1/2");
  assert.equal(agg.failures.length, 1);
});

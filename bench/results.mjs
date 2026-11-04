// Pure result-processing for the benchmark. Kept separate from bench/run.mjs so
// F5's rules can be unit-tested without launching a demo:
//   * a missing measurement is null, NEVER 0 ms;
//   * "tool ok" is not "did something": a click must move the counter;
//   * a unique input is only satisfied if the exact value was absent BEFORE;
//   * any failed round makes the process exit non-zero.

export function isMeasuredNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function percentile(values, p) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(1));
}

/**
 * One per-round sample. `firstVisibleMs` is null unless a real first-visible
 * frame was measured — never coerced from null.
 */
export function makeSample({ scenario, buildId = null, ok, timings = null, evidence = null, error = null }) {
  const t = timings && typeof timings === "object" ? timings : null;
  return {
    scenario: String(scenario),
    buildId: buildId == null ? null : String(buildId),
    ok: ok === true,
    timings: t,
    firstVisibleMs: t && isMeasuredNumber(t.firstVisibleMs) ? t.firstVisibleMs : null,
    evidence: evidence ?? null,
    error: error == null ? null : String(error).slice(0, 300),
  };
}

/** A click succeeds only if the engine said ok AND the demo counter advanced by one. */
export function judgeClick({ toolOk, counterBefore, counterAfter }) {
  const both = Number.isInteger(counterBefore) && Number.isInteger(counterAfter);
  const changed = both && counterAfter === counterBefore + 1;
  if (toolOk !== true) return { ok: false, reason: "tool_error" };
  if (!both) return { ok: false, reason: "counter_unmeasured" };
  if (!changed) return { ok: false, reason: "counter_unchanged" };
  return { ok: true, reason: null };
}

/** A unique token is only proof it landed if it was absent from the field before. */
export function judgeTyped({ expectQuery, textBefore, textAfter }) {
  const query = String(expectQuery ?? "");
  const before = String(textBefore ?? "");
  const after = String(textAfter ?? "");
  if (!query) return { ok: false, reason: "no_unique_token" };
  if (before.includes(query)) return { ok: false, reason: "stale_text" };
  if (!after.includes(query)) return { ok: false, reason: "not_typed" };
  return { ok: true, reason: null };
}

export function aggregate(samples) {
  const list = Array.isArray(samples) ? samples : [];
  const failures = list.filter((sample) => sample.ok !== true);
  const totals = list
    .map((sample) => Number(sample.timings?.totalMs ?? sample.timings?.actionMs ?? NaN))
    .filter((value) => Number.isFinite(value));
  const firsts = list.map((sample) => sample.firstVisibleMs).filter(isMeasuredNumber);
  return {
    runs: list.length,
    success: `${list.length - failures.length}/${list.length}`,
    ok: failures.length === 0,
    totalP50: percentile(totals, 50),
    totalP95: percentile(totals, 95),
    // null when no round actually observed a first frame — do not print 0.
    firstVisibleP50: percentile(firsts, 50),
    firstVisibleP95: percentile(firsts, 95),
    failures: failures.map((sample) => ({
      scenario: sample.scenario,
      error: sample.error,
      evidence: sample.evidence,
    })),
  };
}

/** Non-zero if ANY round failed. */
export function exitCodeFor(samples) {
  const list = Array.isArray(samples) ? samples : [];
  return list.length > 0 && list.every((sample) => sample.ok === true) ? 0 : 1;
}

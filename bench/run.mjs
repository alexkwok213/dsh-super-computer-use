// A repeatable task set for the execution loop, deliberately small and local.
// F5 fixes: every round is kept as a sample {scenario,buildId,timings,evidence,
// error}; a missing measurement stays null (never 0 ms); a click must move the
// demo counter; typed text must be a per-round unique token; a session stop is
// measured against an actual in-flight task; and any failed round exits non-zero.
//
//   node bench/run.mjs                    # 20 runs per task
//   node bench/run.mjs --runs 5 --json out.json
//   node bench/run.mjs --task click_ref   # one task
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CuSessionManager } from "../lib/core.mjs";
import { registerCuTools } from "../lib/index.mjs";
import { makeSample, judgeClick, judgeTyped, aggregate, exitCodeFor } from "./results.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const RUNS = Math.max(1, Number(flag("runs", 20)));
const ONLY = flag("task", null);
const JSON_OUT = flag("json", null);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeHarness() {
  const tools = new Map();
  const attachments = {
    imageLimits: { mediaTypes: ["image/png", "image/jpeg", "image/webp"], maxImageBytes: 1e7, maxMessageImageBytes: 1e7 },
    async saveImage({ data, mediaType, name }) {
      return { attachmentId: `att-${data.length}`, mediaType, bytes: data.byteLength, width: 0, height: 0, name };
    },
  };
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(name) {
      if (name === "attachments") return attachments;
      if (name === "llm") return { async resolveModelInfo() { return { inputModalities: ["text", "image"] }; } };
      return undefined;
    },
  };
  const homeState = join(process.env.HOME ?? tmpdir(), ".cu");
  let serviceUrl;
  let token;
  if (process.env.CU_SERVICE_PORT) {
    serviceUrl = `http://127.0.0.1:${process.env.CU_SERVICE_PORT}`;
    token = process.env.CU_TOKEN || "";
  } else {
    try {
      const config = JSON.parse(readFileSync(join(homeState, "config.json"), "utf8"));
      serviceUrl = `http://127.0.0.1:${config.port}`;
      token = config.token;
    } catch {
      // Fall back to the manager's discovery.
    }
  }
  const stateDir = mkdtempSync(join(tmpdir(), "cu-bench-"));
  const manager = new CuSessionManager({ stateDir, serviceUrl, token });
  const overlay = [];
  const cursorWrite = manager._cursorWrite.bind(manager);
  manager._cursorWrite = (command) => {
    overlay.push({ command, at: Date.now() }); // live array — tasks read it, not a stale slice
    return cursorWrite(command);
  };
  manager.writeActivity = () => {};
  registerCuTools({ ctx, manager, config: { autoSession: false } });
  const run = { signal: new AbortController().signal, agent: { options: { provider: "bench", model: "bench" } } };
  const call = (name, toolArgs = {}) => tools.get(name).execute(toolArgs, run);
  return { manager, stateDir, overlay, call };
}

async function startDemo(manager) {
  const demo = spawn(manager.resolveBinaryPath(), ["demo", "--seconds", "900"], { stdio: "ignore" });
  let window = null;
  // A window-scoped snapshot needs the demo's AX window frame to agree with its
  // CGWindow frame. A freshly shown window can lag a frame or two, which made the
  // first snapshot fail with `window_scope_unavailable` (that is an engine
  // readiness condition, not a benchmark result). Only accept the window once the
  // engine can actually address THIS process's window, and never borrow a
  // same-titled window from another instance.
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    const out = await manager.exec(["windows"]).catch(() => null);
    const candidate = (out?.windows ?? []).find((entry) =>
      entry.title === "cu demo window" && entry.pid === demo.pid
      && Number(entry.windowId) > 0 && entry.offStage !== true);
    if (!candidate) continue;
    const probe = await manager.exec([
      "snapshot", "--pid", String(candidate.pid), "--window", String(candidate.windowId),
    ]).catch(() => null);
    if (probe?.ok === true && Number(probe.count) > 0) { window = candidate; break; }
  }
  if (!window) throw new Error("the demo window never became addressable");
  return { demo, window };
}

const snapshotText = (snap) => (Array.isArray(snap?.lines) ? snap.lines.join("\n") : JSON.stringify(snap ?? {}));
const demoCounter = (snap) => {
  const match = /Demo Button (\d+)/.exec(snapshotText(snap));
  return match ? Number(match[1]) : null;
};

const TASKS = {
  snapshot: {
    label: "AX snapshot of a native window",
    async run({ call, demoWindow }) {
      const started = Date.now();
      const result = await call("cu_snapshot", { pid: demoWindow.pid, windowId: demoWindow.windowId, full: true });
      return { ok: result?.ok === true, timings: { totalMs: Date.now() - started },
               evidence: { nodes: result?.count ?? 0, error: result?.error ?? null } };
    },
  },
  click_ref: {
    label: "click by ref: engine ok AND the counter moved",
    async run({ call, demoWindow, overlay, runIndex }) {
      const before = await call("cu_snapshot", { pid: demoWindow.pid, windowId: demoWindow.windowId, full: true });
      const line = (before.lines ?? []).find((entry) => entry.includes("Demo Button"));
      if (!line) {
        return { ok: false, timings: null,
                 error: `no Demo Button in the tree (snapshot ok=${before?.ok} count=${before?.count ?? 0} error=${before?.error ?? "-"})` };
      }
      const ref = line.split(" ")[0];
      const counterBefore = demoCounter(before);
      const started = Date.now();
      const result = await call("cu_click", { pid: demoWindow.pid, windowId: demoWindow.windowId, ref });
      const firstVisual = overlay.find((entry) => entry.at >= started);
      const after = await call("cu_snapshot", { pid: demoWindow.pid, windowId: demoWindow.windowId, full: true });
      const verdict = judgeClick({ toolOk: result?.ok === true, counterBefore, counterAfter: demoCounter(after) });
      const visible = firstVisual ? firstVisual.at - started : null;
      return {
        ok: verdict.ok,
        timings: { ...(result?.timings ?? {}), firstVisibleMs: visible },
        evidence: { runIndex, ref, counterBefore, counterAfter: demoCounter(after), firstVisualCmd: firstVisual?.command?.cmd ?? null },
        ...(verdict.ok ? {} : { error: verdict.reason }),
      };
    },
  },
  type_expect: {
    label: "type a unique token + exact post-condition",
    async run({ call, demoWindow, runIndex }) {
      const token = `bench-${runIndex}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const before = await call("cu_snapshot", { pid: demoWindow.pid, windowId: demoWindow.windowId, full: true });
      const result = await call("cu_type", {
        pid: demoWindow.pid,
        windowId: demoWindow.windowId,
        text: token,
        mode: "type",
        expect: { query: token, timeoutMs: 1500 },
      });
      const after = await call("cu_snapshot", { pid: demoWindow.pid, windowId: demoWindow.windowId, full: true });
      const verdict = judgeTyped({ expectQuery: token, textBefore: snapshotText(before), textAfter: snapshotText(after) });
      return {
        ok: result?.ok === true && result?.verified === true && verdict.ok,
        timings: result?.timings ?? null,
        evidence: { runIndex, token, verified: result?.verified, judge: verdict.reason },
      };
    },
  },
  batch_flow: {
    label: "batch: click → key (one roundtrip)",
    async run({ call, demoWindow }) {
      const result = await call("cu_batch", {
        pid: demoWindow.pid,
        windowId: demoWindow.windowId,
        steps: [
          { action: "click", x: demoWindow.bounds.x + 140, y: demoWindow.bounds.y + 60 },
          { action: "key", name: "tab" },
        ],
        preview: false,
        observe: false,
      });
      return {
        ok: result?.ok === true && !result?.budgetExceeded,
        timings: { ...(result?.timings ?? {}), totalMs: result?.durationMs ?? null },
        evidence: { settleMs: result?.timings?.settleMs ?? null },
      };
    },
  },
  preview: {
    label: "screenshot preview of the target window",
    async run({ call, demoWindow }) {
      const result = await call("cu_screenshot", { windowId: demoWindow.windowId, maxDimension: 960 });
      return {
        ok: result?.ok === true && Boolean(result?.image || result?.path),
        timings: { totalMs: result?.ms ?? null, captureMs: result?.captureMs ?? null },
        evidence: { via: result?.via, byteSize: result?.byteSize ?? 0 },
      };
    },
  },
  stop: {
    label: "stop an in-flight task: acceptance + cleanupState",
    async run({ call, demoWindow, runIndex }) {
      await call("cu_session", {
        action: "start", windowId: demoWindow.windowId, pid: demoWindow.pid,
        appName: "CU Bench", dockDsh: false, splitScreen: false, preview: false,
      });
      // A real in-flight read-only wait on the demo window.
      const inflight = call("cu_expect", {
        pid: demoWindow.pid, windowId: demoWindow.windowId, query: `never-${runIndex}-${Date.now()}`, timeoutMs: 2400,
      }).catch(() => null);
      await sleep(250);
      const acceptStart = Date.now();
      const result = await call("cu_session", { action: "stop" });
      const acceptanceMs = Date.now() - acceptStart;
      await inflight;
      return {
        ok: result?.ok === true,
        timings: { totalMs: acceptanceMs },
        evidence: {
          acceptanceMs,
          paused: result?.paused ?? null,
          cleanupState: result?.cleanupState ?? "unknown",
          note: result?.cleanupState ? null : "service did not report cleanupState",
        },
      };
    },
  },
};

const selected = ONLY ? Object.entries(TASKS).filter(([name]) => name === ONLY) : Object.entries(TASKS);
if (selected.length === 0) {
  console.error(`unknown task ${ONLY}; known: ${Object.keys(TASKS).join(", ")}`);
  process.exit(2);
}

const harness = makeHarness();
let demo = null;
const allSamples = [];
const summaries = [];
try {
  const started = await startDemo(harness.manager);
  demo = started.demo;
  const demoWindow = started.window;
  const status = await harness.call("cu_status").catch(() => null);
  const buildId = status?.buildId ?? null;
  console.log(`demo window ${demoWindow.windowId} pid=${demoWindow.pid} buildId=${buildId}`);
  console.log(`runs per task: ${RUNS}\n`);

  for (const [name, task] of selected) {
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
      try {
        const outcome = await task.run({
          call: harness.call,
          demoWindow,
          overlay: harness.overlay,
          manager: harness.manager,
          runIndex: i + 1,
        });
        samples.push(makeSample({
          scenario: name,
          buildId,
          ok: outcome.ok === true,
          timings: outcome.timings ?? null,
          evidence: outcome.evidence ?? null,
          error: outcome.error ?? null,
        }));
      } catch (error) {
        samples.push(makeSample({
          scenario: name, buildId, ok: false, timings: null,
          error: `threw: ${String(error?.message ?? error).slice(0, 120)}`,
        }));
      }
      if (name !== "stop") await harness.call("cu_session", { action: "stop" }).catch(() => null);
    }
    allSamples.push(...samples);
    const summary = { task: name, label: task.label, buildId, ...aggregate(samples) };
    summaries.push(summary);
  }
} finally {
  await harness.call("cu_session", { action: "stop" }).catch(() => null);
  demo?.kill("SIGTERM");
  rmSync(harness.stateDir, { recursive: true, force: true });
}

console.log("task".padEnd(44), "ok".padEnd(8), "p50".padEnd(9), "p95".padEnd(9), "1st-visible p50");
for (const row of summaries) {
  console.log(
    row.label.padEnd(44),
    row.success.padEnd(8),
    String(row.totalP50 ?? "-").padEnd(9),
    String(row.totalP95 ?? "-").padEnd(9),
    String(row.firstVisibleP50 ?? "untested")
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  buildId: allSamples[0]?.buildId ?? null,
  macos: process.platform,
  node: process.version,
  runs: RUNS,
  summaries,
  // Raw per-round samples: never aggregated away, even on failure.
  samples: allSamples,
};
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(`\njson: ${JSON_OUT}`);
}
process.exit(exitCodeFor(allSamples));

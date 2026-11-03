// A repeatable task set for the execution loop, deliberately small and local:
// the point is to notice regressions and to compare models on fixed tools and
// fixed tasks, not to look impressive.
//
//   node bench/run.mjs                    # 20 runs per task, printed + JSON
//   node bench/run.mjs --runs 5 --json out.json
//   node bench/run.mjs --task finder     # one task
//
// Every number comes from the tool results' own `timings`, so the harness does
// not need to instrument the plugin from outside. `firstFeedbackMs` is measured
// from the first overlay command a task emits (the cursor hint), which is what
// the person watching actually perceives as "it started".
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CuSessionManager } from "../lib/core.mjs";
import { registerCuTools } from "../lib/index.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const RUNS = Math.max(1, Number(flag("runs", 20)));
const ONLY = flag("task", null);
const JSON_OUT = flag("json", null);

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(1));
};
const median = (values) => percentile(values, 50);

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
  // The service address lives in the real state dir; the benchmark keeps its
  // own temp dir so a run never writes pause/activity state into the user's.
  const homeState = join(process.env.HOME ?? tmpdir(), ".cu");
  let serviceUrl;
  let token;
  try {
    const config = JSON.parse(readFileSync(join(homeState, "config.json"), "utf8"));
    serviceUrl = `http://127.0.0.1:${config.port}`;
    token = config.token;
  } catch {
    // Fall back to the manager's own discovery.
  }
  const stateDir = mkdtempSync(join(tmpdir(), "cu-bench-"));
  const manager = new CuSessionManager({ stateDir, serviceUrl, token });
  const overlay = [];
  const cursorWrite = manager._cursorWrite.bind(manager);
  manager._cursorWrite = (command) => {
    overlay.push({ command, at: Date.now() });
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
  for (let i = 0; i < 40 && !window; i++) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const out = await manager.exec(["windows"]).catch(() => null);
    window = (out?.windows ?? []).find((entry) => entry.title === "cu demo window") ?? null;
  }
  if (!window) throw new Error("the demo window never appeared");
  return { demo, window };
}

// Each task returns { ok, timings, note } and may emit overlay commands.
const TASKS = {
  snapshot: {
    label: "AX snapshot of a native window",
    async run({ call, demoWindow }) {
      const started = Date.now();
      const result = await call("cu_snapshot", { pid: demoWindow.pid, windowId: demoWindow.windowId, full: true });
      return {
        ok: result?.ok === true,
        timings: { totalMs: Date.now() - started },
        note: `${result?.count ?? 0} nodes`,
      };
    },
  },
  click_ref: {
    label: "click by snapshot ref + observation",
    async run({ call, demoWindow, overlay }) {
      const snap = await call("cu_snapshot", { pid: demoWindow.pid, windowId: demoWindow.windowId, full: true });
      const line = (snap.lines ?? []).find((entry) => entry.includes("Demo Button"));
      if (!line) return { ok: false, note: "no button in the tree" };
      const ref = line.split(" ")[0];
      const started = Date.now();
      const result = await call("cu_click", { pid: demoWindow.pid, windowId: demoWindow.windowId, ref });
      const firstVisual = overlay.find((entry) => entry.at >= started);
      return {
        ok: result?.ok === true,
        timings: { ...result?.timings, firstFeedbackMs: firstVisual ? firstVisual.at - started : null },
        note: `changed=${result?.observation?.changed}`,
      };
    },
  },
  type_expect: {
    label: "type + explicit post-condition",
    async run({ call, demoWindow }) {
      const result = await call("cu_type", {
        pid: demoWindow.pid,
        windowId: demoWindow.windowId,
        text: "bench",
        mode: "type",
        expect: { query: "bench", timeoutMs: 1500 },
      });
      return { ok: result?.ok === true && result?.verified === true, timings: result?.timings };
    },
  },
  batch_flow: {
    label: "batch: click → wait → key (one roundtrip)",
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
        timings: { ...result?.timings, totalMs: result?.durationMs },
        note: `settle=${result?.timings?.settleMs}ms`,
      };
    },
  },
  preview: {
    label: "screenshot preview of the target window",
    async run({ call, demoWindow }) {
      const result = await call("cu_screenshot", { windowId: demoWindow.windowId, maxDimension: 960 });
      return {
        ok: result?.ok === true && Boolean(result?.image || result?.path),
        timings: { totalMs: result?.ms, captureMs: result?.captureMs },
        note: `via=${result?.via} ${result?.byteSize ?? 0}B`,
      };
    },
  },
  stop: {
    label: "stop a session and restore the desktop",
    async run({ call, demoWindow }) {
      await call("cu_session", {
        action: "start", windowId: demoWindow.windowId, pid: demoWindow.pid,
        appName: "CU Bench", dockDsh: false, splitScreen: false, preview: false,
      });
      const started = Date.now();
      const result = await call("cu_session", { action: "stop" });
      return { ok: result?.ok === true, timings: { totalMs: Date.now() - started } };
    },
  },
};

const selected = ONLY
  ? Object.entries(TASKS).filter(([name]) => name === ONLY)
  : Object.entries(TASKS);
if (selected.length === 0) {
  console.error(`unknown task ${ONLY}; known: ${Object.keys(TASKS).join(", ")}`);
  process.exit(2);
}

const harness = makeHarness();
let demo = null;
const results = [];
try {
  const started = await startDemo(harness.manager);
  demo = started.demo;
  const demoWindow = started.window;
  console.log(`demo window ${demoWindow.windowId} pid=${demoWindow.pid} bounds=${JSON.stringify(demoWindow.bounds)}`);
  console.log(`runs per task: ${RUNS}\n`);

  for (const [name, task] of selected) {
    const rows = [];
    for (let i = 0; i < RUNS; i++) {
      const overlayBefore = harness.overlay.length;
      try {
        const outcome = await task.run({
          call: harness.call,
          demoWindow,
          overlay: harness.overlay.slice(overlayBefore),
          manager: harness.manager,
        });
        rows.push({ ok: outcome.ok === true, timings: outcome.timings ?? {}, note: outcome.note ?? null });
      } catch (error) {
        rows.push({ ok: false, timings: {}, note: `threw: ${String(error?.message ?? error).slice(0, 120)}` });
      }
      // Reset per-task state between runs so a task cannot inherit a session.
      if (name !== "stop") await harness.call("cu_session", { action: "stop" }).catch(() => null);
    }

    const total = rows.map((row) => Number(row.timings.totalMs ?? row.timings.actionMs ?? NaN)).filter(Number.isFinite);
    const firstFeedback = rows.map((row) => Number(row.timings.firstFeedbackMs)).filter(Number.isFinite);
    const failures = rows.filter((row) => !row.ok);
    results.push({
      task: name,
      label: task.label,
      runs: RUNS,
      success: `${RUNS - failures.length}/${RUNS}`,
      totalP50: percentile(total, 50),
      totalP95: percentile(total, 95),
      firstFeedbackP50: percentile(firstFeedback, 50),
      firstFeedbackP95: percentile(firstFeedback, 95),
      notes: failures.map((row) => row.note).filter(Boolean).slice(0, 3),
    });
  }
} finally {
  await harness.call("cu_session", { action: "stop" }).catch(() => null);
  demo?.kill("SIGTERM");
  rmSync(harness.stateDir, { recursive: true, force: true });
}

console.log("task".padEnd(44), "ok".padEnd(8), "p50".padEnd(9), "p95".padEnd(9), "1st feedback p50");
for (const row of results) {
  console.log(
    row.label.padEnd(44),
    row.success.padEnd(8),
    String(row.totalP50 ?? "-").padEnd(9),
    String(row.totalP95 ?? "-").padEnd(9),
    String(row.firstFeedbackP50 ?? "-")
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  macos: process.platform,
  node: process.version,
  runs: RUNS,
  results,
};
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(`\njson: ${JSON_OUT}`);
}
process.exit(0);

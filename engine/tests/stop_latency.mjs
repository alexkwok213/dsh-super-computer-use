// Round-2 stop latency: real installed service, real CuSessionManager, real
// tool wrapper and the real UI registry stop path. Measures, separately:
//
//   gateMs       control() call -> inputGateClosed true (synchronous intent)
//   acceptMs     control() call -> stop promise resolved (cleanup returned)
//   lastInputMs  a real in-flight cu_expect settled after stop
//   zeroMs       manager.activeSession cleared and registry owner inactive
//
// It deliberately disables capsule/halo/cursor/native preview so repeated runs
// do not churn the desktop; the stop path and in-flight cancellation are the
// production ones.
//
//   node engine/tests/stop_latency.mjs --runs 30 --json docs/reviews/evidence/round2-stop-latency.json
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { CuSessionManager } from "../../lib/core.mjs";
import { registerCuTools } from "../../lib/index.mjs";
import { createCuUiRegistry } from "../../lib/cu-ui-session.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const RUNS = Math.max(5, Number(flag("runs", 30)));
const JSON_OUT = flag("json", null);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)] * 10) / 10;
}

async function findDemo(manager, demo) {
  for (let i = 0; i < 60; i += 1) {
    const out = await manager.exec(["windows"]).catch(() => null);
    const window = (out?.windows ?? []).find(
      (entry) => entry.title === "cu demo window" && entry.pid === demo.pid && entry.windowId > 0,
    );
    if (window) return window;
    await sleep(200);
  }
  throw new Error("demo window not found");
}

async function main() {
  const manager = new CuSessionManager();
  manager.writeActivity = () => {};
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => {};
      },
    },
    get(name) {
      if (name === "attachments") {
        return {
          imageLimits: { mediaTypes: ["image/jpeg"], maxImageBytes: 1e7, maxMessageImageBytes: 1e7 },
          async saveImage({ data, mediaType, name }) {
            return { attachmentId: `att-${data.length}`, mediaType, bytes: data.byteLength, width: 0, height: 0, name };
          },
        };
      }
      return undefined;
    },
  };
  const registry = createCuUiRegistry({ manager });
  registerCuTools({
    ctx,
    manager,
    registry,
    config: { autoSession: false, idleStopSeconds: 0, viewerMode: "native", uiProbe: false },
  });
  const exec = { agent: { id: "stop-latency" }, signal: new AbortController().signal };
  const call = (name, args) => tools.get(name).execute(args, exec);
  const demo = spawn(manager.resolveBinaryPath(), ["demo", "--seconds", "600"], { stdio: "ignore" });
  const samples = [];
  const failures = [];
  try {
    const window = await findDemo(manager, demo);
    for (let run = 0; run < RUNS; run += 1) {
      try {
        const started = await call("cu_session", {
          action: "start",
          windowId: window.windowId,
          pid: window.pid,
          appName: "stop-latency",
          dockDsh: false,
          splitScreen: false,
          capsule: false,
          halo: false,
          cursor: false,
          preview: false,
        });
        if (started?.ok !== true) throw new Error(`start failed: ${started?.error ?? "unknown"}`);
        const cuSessionId = registry.cuSessionId();
        const inflight = call("cu_expect", {
          pid: window.pid,
          windowId: window.windowId,
          query: `never-${run}-${Date.now()}`,
          timeoutMs: 2400,
        }).catch(() => null);
        await sleep(250);

        const t0 = performance.now();
        const control = registry.control({ hostSessionId: "stop-latency", cuSessionId, command: "stop" });
        const gateMs = manager.inputGateClosed === true ? performance.now() - t0 : null;
        const result = await control;
        const acceptMs = performance.now() - t0;
        const lastInput = await inflight;
        const lastInputMs = performance.now() - t0;
        while (performance.now() - t0 < 5000) {
          if (!manager.activeSession && registry.snapshot("stop-latency").state !== "stopping") break;
          await sleep(5);
        }
        const zeroMs = performance.now() - t0;
        if (result?.ok !== true) throw new Error(`stop failed: ${result?.error ?? "unknown"}`);
        samples.push({
          gateMs: gateMs === null ? null : Math.round(gateMs * 10) / 10,
          acceptMs: Math.round(acceptMs * 10) / 10,
          lastInputMs: Math.round(lastInputMs * 10) / 10,
          zeroMs: Math.round(zeroMs * 10) / 10,
          cleanupState: result.cleanupState ?? null,
          cancelledActions: result.detail?.cancelledActions ?? null,
          lastInputCancelled: lastInput?.ok === false || lastInput?.error ? lastInput.error ?? "failed" : "returned",
        });
        await sleep(150);
      } catch (error) {
        failures.push({ run, error: error?.message ?? String(error) });
      }
    }
    const summarize = (key) => ({
      p50: percentile(samples.map((row) => row[key]), 50),
      p95: percentile(samples.map((row) => row[key]), 95),
      max: samples.length ? Math.max(...samples.map((row) => row[key])) : null,
    });
    const report = {
      ok: failures.length === 0,
      runs: RUNS,
      completed: samples.length,
      failures,
      gateMs: summarize("gateMs"),
      acceptMs: summarize("acceptMs"),
      lastInputMs: summarize("lastInputMs"),
      zeroMs: summarize("zeroMs"),
      sample: samples.slice(0, 3),
      note:
        "gateMs is the server-side intent (synchronous gate close); acceptMs is cleanup return; " +
        "lastInputMs is a real in-flight cu_expect settling; zeroMs is manager session null + registry owner inactive. " +
        "Client-visible feedback (React paint after the HTTP response) is not measured here.",
    };
    console.log(JSON.stringify(report, null, 2));
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ report, samples }, null, 2));
    return report.ok ? 0 : 1;
  } finally {
    if (demo.exitCode === null) {
      demo.kill("SIGTERM");
      await sleep(300);
    }
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
  process.exit(1);
});

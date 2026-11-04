// Visible-feedback latency, kept SEPARATE from the local execution micro-bench.
// The three numbers are distinct and never substituted for one another:
//   commandWrittenMs  — action start → the overlay command was written to stdin
//   renderCommittedMs — overlay transaction committed (RenderAck; not available
//                       from the current helper, so null)
//   firstVisibleMs    — first real on-screen frame containing the test marker
//                       (needs screen-capture frame analysis; null here, UNTESTED)
//
// This script does NOT screenshot per frame. When the capture/analysis facility
// is unavailable it reports null and says so — it never writes 0 ms.
//
//   node bench/visual-latency.mjs --runs 20
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
const JSON_OUT = flag("json", null);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeHarness() {
  const tools = new Map();
  const ctx = {
    tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name); } },
    get: () => undefined,
  };
  let serviceUrl;
  let token;
  try {
    const config = JSON.parse(readFileSync(join(process.env.HOME ?? tmpdir(), ".cu", "config.json"), "utf8"));
    serviceUrl = `http://127.0.0.1:${config.port}`;
    token = config.token;
  } catch {
    /* discovery fallback */
  }
  const stateDir = mkdtempSync(join(tmpdir(), "cu-vislat-"));
  const manager = new CuSessionManager({ stateDir, serviceUrl, token });
  const overlay = [];
  const base = manager._cursorWrite.bind(manager);
  manager._cursorWrite = (command) => { overlay.push({ command, at: Date.now() }); return base(command); };
  manager.writeActivity = () => {};
  registerCuTools({ ctx, manager, config: { autoSession: false } });
  const run = { signal: new AbortController().signal, agent: { options: { provider: "bench", model: "bench" } } };
  return { manager, stateDir, overlay, call: (name, a = {}) => tools.get(name).execute(a, run) };
}

async function main() {
  const harness = makeHarness();
  const samples = [];
  let demo;
  try {
    demo = spawn(harness.manager.resolveBinaryPath(), ["demo", "--seconds", "900"], { stdio: "ignore" });
    let win = null;
    for (let i = 0; i < 40 && !win; i++) {
      await sleep(150);
      const out = await harness.manager.exec(["windows"]).catch(() => null);
      win = (out?.windows ?? []).find((w) => w.title === "cu demo window"
          && Number(w.windowId) > 0 && w.offStage !== true) ?? null;
    }
    if (!win) throw new Error("demo window never appeared");
    await harness.call("cu_session", {
      action: "start", windowId: win.windowId, pid: win.pid, dockDsh: false, splitScreen: false, preview: false,
    });
    await sleep(300);
    const snap = await harness.call("cu_snapshot", { pid: win.pid, windowId: win.windowId, full: true });
    const line = (snap.lines ?? []).find((l) => l.includes("Demo Button"));

    for (let i = 0; i < RUNS; i++) {
      const at = harness.overlay.length;
      // Same clock for both ends (Date.now ms) — mixing hrtime with Date.now is
      // exactly the cross-domain subtraction the spec forbids.
      const started = Date.now();
      const result = line
        ? await harness.call("cu_click", { pid: win.pid, windowId: win.windowId, ref: line.split(" ")[0], observe: false })
        : await harness.call("cu_click", { pid: win.pid, windowId: win.windowId, x: win.bounds.x + 140, y: win.bounds.y + 60, observe: false });
      const firstCmd = harness.overlay.slice(at).find((e) => e.command?.cmd === "cursor");
      const commandWrittenMs = firstCmd ? firstCmd.at - started : null;
      samples.push({
        run: i + 1,
        toolOk: result?.ok === true,
        commandWrittenMs,
        renderCommittedMs: null, // helper exposes no RenderAck yet
        firstVisibleMs: null,    // no screen-frame analysis available → untested, never 0
      });
      await sleep(80);
    }
    await harness.call("cu_session", { action: "stop" });
  } finally {
    await harness.call("cu_session", { action: "stop" }).catch(() => null);
    demo?.kill("SIGTERM");
    rmSync(harness.stateDir, { recursive: true, force: true });
  }

  const measured = samples.map((s) => s.commandWrittenMs).filter((v) => typeof v === "number");
  const p = (arr, q) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.ceil((q / 100) * arr.length) - 1)] : null);
  const report = {
    generatedAt: new Date().toISOString(),
    runs: RUNS,
    clockDomain: "monotonic",
    captureFps: null,
    clockMapping: null,
    clockErrorMs: null,
    // Screenshot capture + frame analysis for the real first-visible frame is
    // NOT wired here: report null/untested, never a fabricated 0 ms.
    support: {
      commandWritten: true,
      renderCommitted: false,
      firstVisible: false,
      reason: "on-screen frame capture/analysis unavailable in this environment; firstVisibleMs is null (untested)",
    },
    samples,
    summary: {
      commandWrittenP50: p(measured, 50),
      commandWrittenP95: p(measured, 95),
      renderCommittedP50: null,
      firstVisibleP50: null,
    },
  };
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`json: ${JSON_OUT}`);
  }
  console.log(JSON.stringify(report.summary));
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});

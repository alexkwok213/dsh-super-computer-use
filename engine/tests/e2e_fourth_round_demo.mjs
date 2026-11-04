// Fourth-round demo recording: same repo build, same run produces a 30–60s
// screen recording of the owned demo window, the unified event log, and a result
// JSON with the build identity. Uses the REAL cu_* tool definitions + a real
// isolated service. No model, no daily service, no global pkill.
//
//   node engine/tests/e2e_fourth_round_demo.mjs [seconds]
//
// Outputs:
//   docs/reviews/fourth-round-demo.mov
//   docs/reviews/fourth-round-demo-events.jsonl
//   docs/reviews/fourth-round-demo-result.json
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { CuSessionManager } from "../../lib/core.mjs";
import { registerCuTools } from "../../lib/index.mjs";

const seconds = Number(process.argv[2] || 34);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BIN = new URL("../bin/cu", import.meta.url).pathname;
const PORT = 49900 + Math.floor(Math.random() * 80);
const TOKEN = `demo-${Math.random().toString(36).slice(2)}`;
const VIDEO = "docs/reviews/fourth-round-demo.mov";
const tools = new Map();
const ctx = {
  tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name); } },
  get(name) {
    if (name === "attachments") {
      return {
        imageLimits: { mediaTypes: ["image/png", "image/jpeg"], maxImageBytes: 1e7, maxMessageImageBytes: 1e7 },
        async saveImage({ data, mediaType, name }) {
          return { attachmentId: `att-${data.length}`, mediaType, bytes: data.byteLength, width: 0, height: 0, name };
        },
      };
    }
    if (name === "llm") return { async resolveModelInfo() { return { inputModalities: ["text", "image"] }; } };
    return undefined;
  },
};
const manager = new CuSessionManager({ serviceUrl: `http://127.0.0.1:${PORT}`, token: TOKEN, binaryPath: BIN });
manager.writeActivity = () => {};
registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });
const run = { signal: new AbortController().signal, agent: { options: { provider: "e2e", model: "e2e" } } };
const call = (n, a = {}) => tools.get(n).execute(a, run);
const text = (s) => (Array.isArray(s?.lines) ? s.lines.join("\n") : "");
const counter = (s) => { const m = /Demo Button (\d+)/.exec(text(s)); return m ? Number(m[1]) : -1; };

async function main() {
  const service = spawn(BIN, ["service", "--port", String(PORT), "--token", TOKEN], { stdio: "ignore" });
  const demo = spawn(BIN, ["demo", "--seconds", String(seconds + 45)], { stdio: "ignore" });
  let recorder = null;
  const owned = [service, demo];
  try {
    for (let i = 0; i < 60; i++) {
      const st = await manager.exec(["status"], undefined, { control: true }).catch(() => null);
      if (st?.service === "cu") break;
      await sleep(150);
    }
    let win = null;
    for (let i = 0; i < 50 && !win; i++) {
      await sleep(150);
      const out = await manager.exec(["windows"], undefined, { control: true }).catch(() => null);
      win = (out?.windows ?? []).find((w) => w.title === "cu demo window" && w.pid === demo.pid && w.windowId > 0) ?? null;
    }
    if (!win) throw new Error("owned demo window did not appear");
    const status = await call("cu_status");
    const buildId = status?.buildId ?? null;

    await call("cu_session", { action: "start", windowId: win.windowId, pid: win.pid,
      appName: "Demo", dockDsh: false, splitScreen: false, preview: false, nativePreview: true });
    await sleep(900);

    // Record ONLY the owned demo window's region (not the rest of the desktop).
    const bounds = { x: Math.round(win.x ?? win.frame?.x ?? 420), y: Math.round(win.y ?? win.frame?.y ?? 380),
                     w: Math.round(win.w ?? win.width ?? win.frame?.width ?? 520),
                     h: Math.round(win.h ?? win.height ?? win.frame?.height ?? 470) };
    const region = `${bounds.x},${bounds.y},${bounds.w},${bounds.h}`;
    // Use -V <seconds> for video duration (macOS screencapture CLI)
    const recDuration = seconds + 4;
    recorder = spawn("screencapture", ["-v", "-V", String(recDuration), "-R", region, VIDEO], { stdio: "ignore" });
    const recExitPromise = new Promise((resolve) => recorder.on("close", resolve));

    const end = Date.now() + seconds * 1000;
    let cycles = 0;
    const failurePaths = { crossTargetRefused: 0, unsupportedSemantics: 0, queuedCancelled: 0 };
    while (Date.now() < end) {
      const s = await call("cu_snapshot", { pid: win.pid, windowId: win.windowId, full: true });
      const before = counter(s);
      const line = (s.lines ?? []).find((l) => l.includes("Demo Button"));
      if (line) {
        const ref = line.split(" ")[0];
        await call("cu_click", { pid: win.pid, windowId: win.windowId, ref, observe: false,
          expect: { query: `Demo Button ${before + 1}`, timeoutMs: 1500 } });
        if (cycles === 0 || cycles === 2) {
          const cross = await call("cu_click", { pid: 1, windowId: 999999, ref, observe: false });
          if (cross?.ok === false) failurePaths.crossTargetRefused += 1;
          const sem = await call("cu_click", { pid: win.pid, windowId: win.windowId, ref,
            button: "right", count: 2, observe: false });
          if (sem?.error === "unsupported_click_semantics") failurePaths.unsupportedSemantics += 1;
        }
      }
      const field = (s.lines ?? []).find((l) => l.includes("AXTextField") && !l.includes("AXSecureTextField"));
      if (field) {
        await call("cu_type", { pid: win.pid, windowId: win.windowId, ref: field.split(" ")[0],
          text: `demo${cycles}-${Date.now().toString(36)}`, mode: "setvalue", observe: false,
          expect: { query: `demo${cycles}`, timeoutMs: 1500 } });
      }
      await call("cu_key", { pid: win.pid, windowId: win.windowId, name: "tab", observe: false });
      await call("cu_scroll", { pid: win.pid, windowId: win.windowId, dy: 8, observe: false });
      if (cycles % 5 === 2) await call("cu_click", { pid: win.pid, windowId: win.windowId, x: 40, y: 60, observe: false });
      cycles += 1;
      await sleep(650);
    }

    // Failure path on camera: a queued action must not start after stop.
    const longAction = manager.exec(["expect", "--pid", String(win.pid), "--window", String(win.windowId),
      "--find", "never-present-fourth-demo", "--timeout", "3000"]);
    const queued = manager.exec(["key", "--pid", String(win.pid), "--window", String(win.windowId), "--name", "tab"]);
    await sleep(60);
    const stopResult = await call("cu_session", { action: "stop" });
    const queuedOutcome = await queued;
    await longAction.catch(() => null);
    if (queuedOutcome?.ok === false && queuedOutcome?.outcomeUnknown === true) failurePaths.queuedCancelled += 1;

    // Wait for the screencapture video recording process to finalize its file
    if (recorder) {
      await Promise.race([recExitPromise, sleep(8000)]);
    }
    await sleep(500);

    const events = manager.eventLog?.events ?? [];
    writeFileSync("docs/reviews/fourth-round-demo-events.jsonl", events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const sourceCounts = {}; const kindCounts = {};
    for (const e of events) {
      sourceCounts[e.source] = (sourceCounts[e.source] ?? 0) + 1;
      kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
    }
    let videoBytes = 0;
    try { videoBytes = execFileSync("stat", ["-f", "%z", VIDEO], { encoding: "utf8" }).trim(); } catch { /* ignore */ }
    const result = {
      buildId, binary: BIN, video: VIDEO, videoBytes: Number(videoBytes) || null,
      seconds, cycles, eventCount: events.length, sourceCounts, kindCounts, failurePaths,
      stop: { inputGateClosed: stopResult?.inputGateClosed ?? null, cleanupState: stopResult?.cleanupState ?? null },
      presentation: { commandWrittenMs: null, renderCommittedMs: null, firstVisibleMs: null },
    };
    writeFileSync("docs/reviews/fourth-round-demo-result.json", JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } finally {
    if (recorder) { try { recorder.kill("SIGINT"); } catch { /* ignore */ } }
    await call("cu_session", { action: "stop" }).catch(() => null);
    for (const proc of owned) { try { proc.kill("SIGTERM"); } catch { /* ignore */ } }
  }
}

main().then((code) => process.exit(code), (error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});

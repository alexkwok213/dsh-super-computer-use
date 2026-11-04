// Round-2 soak: real installed preview helper through the real Host bridge,
// 30 minutes by default, automatic stop.
//
// Phases: 0-10 min static demo window, 10-20 min continuously changing content
// (AX setvalue), 20-30 min static again. Every 60 s it samples the bridge
// process, the preview helper, and the real Harness host/renderer/GPU/network
// processes. It never waits for a human to stop it.
//
//   node engine/tests/preview_soak.mjs
//   node engine/tests/preview_soak.mjs --seconds 120 --interval 10 --json /tmp/soak.json
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CuSessionManager } from "../../lib/core.mjs";
import { createCuUiRegistry } from "../../lib/cu-ui-session.mjs";
import { createPreviewBridge } from "../../lib/preview-stream.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const SECONDS = Math.max(30, Number(flag("seconds", 1800)));
const INTERVAL = Math.max(5, Number(flag("interval", 60)));
const JSON_OUT = flag("json", null);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

function sh(command, args = []) {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

function rssCpu(pid) {
  const out = sh("ps", ["-o", "rss=,pcpu=", "-p", String(pid)]);
  if (!out) return { rssMb: null, cpu: null };
  const [rss, cpu] = out.split(/\s+/);
  return { rssMb: Math.round((Number(rss) / 1024) * 10) / 10, cpu: Number(cpu) };
}

function harnessPids() {
  const out = sh("ps", ["-axo", "pid=,command="]);
  const pids = { host: null, renderer: null, gpu: null, network: null };
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, command] = match;
    if (!command.includes("DeepSeek Harness")) continue;
    if (command.includes("--type=renderer")) pids.renderer = Number(pid);
    else if (command.includes("--type=gpu-process")) pids.gpu = Number(pid);
    else if (command.includes("--type=utility") && command.includes("network")) pids.network = Number(pid);
    else if (command.includes("/MacOS/DeepSeek Harness --expose-internals")) pids.host = Number(pid);
  }
  return pids;
}

function previewHelperPids() {
  return sh("pgrep", ["-f", "cu-preview preview-stream"])
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function activeTimeouts() {
  try {
    return process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  } catch {
    return null;
  }
}

async function main() {
  const manager = new CuSessionManager();
  const demo = spawn(manager.resolveBinaryPath(), ["demo", "--seconds", String(SECONDS + 120)], {
    stdio: "ignore",
  });
  let response;
  let reader;
  let registry;
  let preview;
  const log = [];
  const rows = [];
  const frames = [];
  const phases = [
    { name: "static-a", from: 0, to: Math.round(SECONDS / 3) },
    { name: "changing", from: Math.round(SECONDS / 3), to: Math.round((SECONDS * 2) / 3) },
    { name: "static-b", from: Math.round((SECONDS * 2) / 3), to: SECONDS },
  ];
  const phaseAt = (elapsed) => phases.find((phase) => elapsed >= phase.from && elapsed < phase.to)?.name ?? "done";
  let demoWindow = null;
  let changeRef = null;
  let changeSeq = 0;
  let parseBuffer = Buffer.alloc(0);
  let reading = true;
  let streamEnds = 0;
  let reconnects = 0;
  const bridgeLog = [];

  try {
    await sleep(2000);
    const wins = await manager.exec(["windows"]);
    demoWindow = (wins.windows ?? []).find((window) => window.title === "cu demo window");
    if (!demoWindow) throw new Error("demo window not found");
    manager.activeSession = {
      windowId: demoWindow.windowId,
      pid: demoWindow.pid,
      app: demoWindow.app ?? "cu",
      label: "soak",
      startedAt: now(),
    };
    manager.sessionId = `soak-${now()}`;
    manager.sessionGeneration = 1;
    manager._axWorkerAllowed = false;

    registry = createCuUiRegistry({ manager });
    registry.claim("soak-chat");
    registry.beginAction("soak-chat", { tool: "cu_click" });
    const cuSessionId = registry.cuSessionId();
    preview = createPreviewBridge({
      manager,
      log: (line) => {
        log.push(line);
        bridgeLog.push(line);
        if (/finalize|first frame|error/i.test(line)) console.log(JSON.stringify({ phase: "bridge", line }));
      },
    });
    const routes = new Map();
    preview.register({
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
      registry,
    });
    const route = routes.get("/api/scu/preview");
    const url =
      `http://127.0.0.1/api/scu/preview?hostSessionId=soak-chat&cuSessionId=${encodeURIComponent(cuSessionId)}&generation=1`;
    const startReader = (nextReader) => {
      reader = nextReader;
      (async () => {
        while (reading) {
          const { done, value } = await reader.read();
          if (done) {
            streamEnds += 1;
            return;
          }
          if (!value) continue;
          parseBuffer = Buffer.concat([parseBuffer, Buffer.from(value)]);
          for (;;) {
            if (parseBuffer.length < 8) break;
            const metaLength = parseBuffer.readUInt32BE(0);
            const jpegLength = parseBuffer.readUInt32BE(4);
            if (parseBuffer.length < 8 + metaLength + jpegLength) break;
            const meta = JSON.parse(parseBuffer.subarray(8, 8 + metaLength).toString("utf8"));
            parseBuffer = parseBuffer.subarray(8 + metaLength + jpegLength);
            frames.push({ at: now(), frameId: meta.frameId, gapFromPrev: frames.length ? now() - frames.at(-1).at : null });
          }
        }
      })().catch(() => {});
    };
    const openStream = async () => {
      response = await route.fetch(new Request(url));
      if (response.status !== 200) throw new Error(`preview HTTP ${response.status}`);
      startReader(response.body.getReader());
    };
    await openStream();

    console.log(
      JSON.stringify({
        phase: "start",
        pid: process.pid,
        seconds: SECONDS,
        interval: INTERVAL,
        demoPid: demo.pid,
        windowId: demoWindow.windowId,
      }),
    );

    const startedAt = now();
    let nextSample = 0;
    while (now() - startedAt < SECONDS * 1000) {
      const elapsed = Math.floor((now() - startedAt) / 1000);
      const phase = phaseAt(elapsed);
      if (phase === "changing") {
        if (!changeRef) {
          const snap = await manager.exec([
            "snapshot", "--pid", String(demoWindow.pid), "--window", String(demoWindow.windowId),
          ]);
          const node = (snap.nodes ?? []).find((entry) => entry.role === "AXTextArea")
            ?? (snap.nodes ?? []).find((entry) => entry.role === "AXTextField");
          changeRef = node?.ref ?? null;
        }
        if (changeRef) {
          changeSeq += 1;
          await manager.exec([
            "setvalue", "--pid", String(demoWindow.pid), "--window", String(demoWindow.windowId),
            "--ref", changeRef, "--text", `soak ${changeSeq} ${new Date().toISOString()}`,
          ]).catch(() => null);
          await manager.exec([
            "scroll", "--pid", String(demoWindow.pid), "--window", String(demoWindow.windowId),
            "--dy", String(changeSeq % 2 === 0 ? 20 : -20),
          ]).catch(() => null);
        }
        await sleep(2000);
      } else {
        await sleep(1000);
      }

      // The helper is bounded to 900 s; a 30-min soak must reconnect like the
      // real client does, and the reconnect itself must not leak or lose the
      // next stream.
      if (!reading) break;
      if (preview.stats().activeChildren === 0 && elapsed < SECONDS - 30) {
        reconnects += 1;
        console.log(JSON.stringify({ phase: "reconnect", elapsed, reconnects }));
        await sleep(1200);
        try {
          await openStream();
        } catch (error) {
          console.log(JSON.stringify({ phase: "reconnect_error", elapsed, error: error?.message }));
        }
      }

      if (elapsed >= nextSample) {
        nextSample += INTERVAL;
        const helperPids = previewHelperPids();
        const harness = harnessPids();
        const helper = helperPids[0] ? rssCpu(helperPids[0]) : { rssMb: null, cpu: null };
        const host = harness.host ? rssCpu(harness.host) : { rssMb: null, cpu: null };
        const renderer = harness.renderer ? rssCpu(harness.renderer) : { rssMb: null, cpu: null };
        const recent = frames.filter((frame) => now() - frame.at <= INTERVAL * 1000);
        const gaps = recent.map((frame) => frame.gapFromPrev).filter((gap) => typeof gap === "number");
        const row = {
          elapsed,
          phase,
          bridgeRssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
          hostRssMb: host.rssMb,
          rendererRssMb: renderer.rssMb,
          helperRssMb: helper.rssMb,
          hostCpu: host.cpu,
          rendererCpu: renderer.cpu,
          helperCpu: helper.cpu,
          helpers: helperPids.length,
          framesLastMinute: recent.length,
          maxGapMs: gaps.length ? Math.max(...gaps) : null,
          activeTimeouts: activeTimeouts(),
          bridge: preview.stats(),
          sessionEndListeners: manager.sessionEndListeners.size,
        };
        rows.push(row);
        console.log(JSON.stringify({ phase: "sample", ...row }));
      }
    }

    reading = false;
    await reader.cancel().catch(() => {});
    preview.dispose();
    registry.dispose();
    demo.kill("SIGTERM");
    await sleep(1500);
    const leftover = previewHelperPids();
    const summary = {
      ok: leftover.length === 0 && preview.stats().activeChildren === 0 && preview.stats().timers === 0,
      seconds: Math.round((now() - startedAt) / 1000),
      samples: rows.length,
      frames: frames.length,
      reconnects,
      streamEnds,
      phases: phases.map((phase) => ({
        phase: phase.name,
        frames: frames.filter((frame) => {
          const offset = Math.floor((frame.at - startedAt) / 1000);
          return offset >= phase.from && offset < phase.to;
        }).length,
      })),
      leftoverHelpers: leftover.length,
      finalStats: preview.stats(),
      bridgeErrors: log.filter((line) => /error|failed/i.test(line)).slice(-10),
      bridgeTail: bridgeLog.slice(-20),
    };
    console.log(JSON.stringify({ phase: "summary", ...summary }));
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ rows, summary }, null, 2));
    process.exit(summary.ok ? 0 : 1);
  } catch (error) {
    reading = false;
    await reader?.cancel().catch(() => {});
    preview?.dispose();
    registry?.dispose();
    demo.kill("SIGTERM");
    console.error(JSON.stringify({ phase: "error", error: error?.message ?? String(error) }));
    process.exit(1);
  }
}

main();

// Round-2 preview cost: same demo click, 30x with preview off vs 30x with a real
// installed preview-stream helper capturing the same window.
//
// Reports per-block P50/P95 and the P95 delta. It does not use the 6-sample
// median from the old report, and it keeps every failure.
//
//   node engine/tests/preview_cost.mjs --runs 30 --json docs/reviews/evidence/round2-preview-cost.json
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { CuSessionManager } from "../../lib/core.mjs";

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
  return sorted[Math.max(0, index)];
}

async function findDemo(manager, demo, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await manager.exec(["windows"]).catch(() => null);
    const candidate = (out?.windows ?? []).find(
      (entry) => entry.title === "cu demo window" && entry.pid === demo.pid && entry.windowId > 0,
    );
    if (candidate) {
      const snap = await manager.exec([
        "snapshot", "--pid", String(candidate.pid), "--window", String(candidate.windowId),
      ]).catch(() => null);
      const button = (snap?.nodes ?? []).find((node) => String(node.title ?? "").startsWith("Demo Button"));
      if (snap?.ok && button) return { window: candidate, button };
    }
    await sleep(200);
  }
  throw new Error("demo became addressable but no Demo Button was found");
}

async function startPreview(manager, windowId) {
  const bin = manager.resolvePreviewBinary();
  const child = spawn(
    bin,
    [
      "preview-stream", "--window", String(windowId), "--session", "preview-cost",
      "--generation", "1", "--fps", "10", "--max-dim", "480", "--seconds", "300", "--watch-parent",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = Buffer.alloc(0);
  const startedAt = performance.now();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview first frame timeout")), 8000);
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 8) {
        const metaLength = buffer.readUInt32BE(0);
        const jpegLength = buffer.readUInt32BE(4);
        if (buffer.length >= 8 + metaLength + jpegLength) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("preview helper exited before a frame"));
    });
  });
  return { child, firstFrameMs: performance.now() - startedAt };
}

async function runBlock(manager, demoWindow, button, runs) {
  const samples = [];
  const failures = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    try {
      const result = await manager.exec([
        "click", "--pid", String(demoWindow.pid), "--window", String(demoWindow.windowId),
        "--x", String(button.cx), "--y", String(button.cy), "--background",
      ]);
      const ms = performance.now() - started;
      if (result?.ok === false) failures.push({ i, error: result?.error ?? "not_ok", ms });
      else samples.push(ms);
    } catch (error) {
      failures.push({ i, error: error?.message ?? String(error) });
    }
    await sleep(30);
  }
  return { samples, failures };
}

async function main() {
  const manager = new CuSessionManager();
  const demo = spawn(manager.resolveBinaryPath(), ["demo", "--seconds", "600"], { stdio: "ignore" });
  let preview = null;
  try {
    const found = await findDemo(manager, demo);
    const button = { cx: found.button.cx, cy: found.button.cy };
    const demoWindow = found.window;

    const off = await runBlock(manager, demoWindow, button, RUNS);

    preview = await startPreview(manager, demoWindow.windowId);
    const on = await runBlock(manager, demoWindow, button, RUNS);

    const offP50 = percentile(off.samples, 50);
    const offP95 = percentile(off.samples, 95);
    const onP50 = percentile(on.samples, 50);
    const onP95 = percentile(on.samples, 95);
    const deltaP95 = offP95 && onP95 ? ((onP95 - offP95) / offP95) * 100 : null;
    const report = {
      ok: off.failures.length === 0 && on.failures.length === 0 && preview.child.exitCode === null,
      runs: RUNS,
      buildId: null,
      buildIdNote: "recorded from /v1/status in docs/reviews/harness-round2-acceptance.md",
      off: { count: off.samples.length, p50: offP50, p95: offP95, failures: off.failures },
      on: {
        count: on.samples.length, p50: onP50, p95: onP95, failures: on.failures,
        firstFrameMs: Math.round(preview.firstFrameMs),
      },
      p95DeltaPercent: deltaP95 === null ? null : Math.round(deltaP95 * 10) / 10,
      note: "relative P95 delta; negative means preview-on was faster in this run",
    };
    console.log(JSON.stringify(report, null, 2));
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    return report.ok && deltaP95 !== null && deltaP95 <= 20 ? 0 : 1;
  } finally {
    if (preview?.child && preview.child.exitCode === null) {
      try {
        preview.child.stdin.end();
        preview.child.kill("SIGTERM");
      } catch {}
      await sleep(300);
    }
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

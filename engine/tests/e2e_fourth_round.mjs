// Fourth-round same-build integration: real cu_* tool definitions + real repo
// engine/service on an ISOLATED port/token, driving a demo window this script
// owns. No model, no mocks, no daily service, no global pkill.
//
//   node engine/tests/e2e_fourth_round.mjs
//
// Writes docs/reviews/fourth-round-events.jsonl and prints a JSON verdict.
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { CuSessionManager } from "../../lib/core.mjs";
import { registerCuTools } from "../../lib/index.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BIN = new URL("../bin/cu", import.meta.url).pathname;
const PORT = 49500 + Math.floor(Math.random() * 400);
const TOKEN = `fourth-${Math.random().toString(36).slice(2)}`;
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
const manager = new CuSessionManager({
  serviceUrl: `http://127.0.0.1:${PORT}`,
  token: TOKEN,
  binaryPath: BIN,
});
manager.writeActivity = () => {};
registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });
const run = { signal: new AbortController().signal, agent: { options: { provider: "e2e", model: "e2e" } } };
const call = (n, a = {}) => tools.get(n).execute(a, run);
const lines = (s) => (Array.isArray(s?.lines) ? s.lines.join("\n") : "");
const counter = (s) => { const m = /Demo Button (\d+)/.exec(lines(s)); return m ? Number(m[1]) : -1; };

function previewChildren() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" });
    return out.split("\n").filter((l) => l.includes(" preview --window ") && l.includes(BIN));
  } catch { return []; }
}

async function main() {
  const service = spawn(BIN, ["service", "--port", String(PORT), "--token", TOKEN], { stdio: "ignore" });
  const demo = spawn(BIN, ["demo", "--seconds", "120"], { stdio: "ignore" });
  const owned = [service, demo];
  const checks = {};
  try {
    for (let i = 0; i < 60; i++) {
      try {
        const st = await manager.exec(["status"], undefined, { control: true }).catch(() => null);
        if (st?.service === "cu") break;
      } catch { /* retry */ }
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

    // ---- session start (R7: native watch preview via real session entry) ----
    await call("cu_session", { action: "start", windowId: win.windowId, pid: win.pid,
      appName: "Demo", dockDsh: false, splitScreen: false, preview: false, nativePreview: true });
    await sleep(1200);
    const previewAtStart = previewChildren();
    checks.previewStarted = previewAtStart.length > 0;

    // ---- R2: one observation gives nodes + tokens + observationId ----
    const snap = await call("cu_snapshot", { pid: win.pid, windowId: win.windowId, full: true });
    checks.observationId = snap?.observationId ?? null;
    checks.elementTokens = Boolean(snap?.elementTokens && Object.keys(snap.elementTokens).length > 0);
    const before = counter(snap);
    const buttonLine = (snap.lines ?? []).find((l) => l.includes("Demo Button"));
    if (!buttonLine) throw new Error("no Demo Button");
    const buttonRef = buttonLine.split(" ")[0];

    // ---- R1: explicit different target with the same ref must be refused ----
    const cross = await call("cu_click", { pid: 1, windowId: 999999, ref: buttonRef, observe: false });
    checks.crossTargetRefused = cross?.ok === false
      && ["target_mismatch", "identity_unproven", "stale_observation"].includes(cross?.error);

    // ---- R10: right + double on a retained token is refused explicitly ----
    const semantics = await call("cu_click", { pid: win.pid, windowId: win.windowId, ref: buttonRef,
      button: "right", count: 2, observe: false });
    checks.unsupportedSemantics = semantics?.ok === false && semantics?.error === "unsupported_click_semantics";

    // ---- real click with post-condition ----
    const click = await call("cu_click", { pid: win.pid, windowId: win.windowId, ref: buttonRef,
      observe: false, expect: { query: `Demo Button ${before + 1}`, timeoutMs: 2500 } });
    checks.clickVerified = click?.ok === true && click?.verified === true;

    // ---- R3: retained-object input in one native command ----
    const fieldLine = (snap.lines ?? []).find((l) => l.includes("AXTextField") && !l.includes("AXSecureTextField"));
    const token = `fourth-${Date.now().toString(36)}`;
    let typed = null;
    if (fieldLine) {
      typed = await call("cu_type", { pid: win.pid, windowId: win.windowId, ref: fieldLine.split(" ")[0],
        text: token, mode: "setvalue", observe: false, expect: { query: token, timeoutMs: 2500 } });
      checks.retainedInputVerified = typed?.ok === true && typed?.verified === true;
    } else {
      checks.retainedInputVerified = null;
    }

    // ---- native events for coordinate click / key / scroll (R9) ----
    await call("cu_click", { pid: win.pid, windowId: win.windowId, x: 40, y: 60, observe: false });
    await call("cu_key", { pid: win.pid, windowId: win.windowId, name: "tab", observe: false });
    await call("cu_scroll", { pid: win.pid, windowId: win.windowId, dy: 12, observe: false });

    // ---- R5: a queued action must not start after stop ----
    const longAction = manager.exec(["expect", "--pid", String(win.pid), "--window", String(win.windowId),
      "--find", "never-present-fourth-round", "--timeout", "3000"]);
    const queued = manager.exec(["key", "--pid", String(win.pid), "--window", String(win.windowId), "--name", "tab"]);
    await sleep(60);
    const stopResult = await call("cu_session", { action: "stop" });
    const queuedOutcome = await queued;
    await longAction.catch(() => null);
    checks.queuedCancelled = queuedOutcome?.ok === false && queuedOutcome?.outcomeUnknown === true;
    checks.inputGateClosed = stopResult?.inputGateClosed === true;
    checks.cleanupState = stopResult?.cleanupState ?? null;

    // ---- R8/R7: after stop, no preview child of this session survives ----
    await sleep(1200);
    checks.previewChildrenAfterStop = previewChildren().length;

    const events = manager.eventLog?.events ?? [];
    writeFileSync("docs/reviews/fourth-round-events.jsonl",
      events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const sourceCounts = {};
    const kindCounts = {};
    for (const e of events) {
      sourceCounts[e.source] = (sourceCounts[e.source] ?? 0) + 1;
      kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
    }
    checks.nativeKinds = [...new Set(events.filter((e) => e.source === "native").map((e) => e.kind))];

    const verdict = {
      buildId,
      checks,
      eventCount: events.length,
      sourceCounts,
      kindCounts,
      // Three different clocks; an unmeasured value is null, never 0.
      presentation: { commandWrittenMs: null, renderCommittedMs: null, firstVisibleMs: null,
                      note: "no screen-frame analyser in this run; not fabricated" },
    };
    console.log(JSON.stringify(verdict, null, 2));
    const ok = checks.previewStarted && checks.observationId && checks.elementTokens
      && checks.crossTargetRefused && checks.unsupportedSemantics && checks.clickVerified
      && checks.retainedInputVerified !== false
      && checks.queuedCancelled && checks.inputGateClosed && checks.previewChildrenAfterStop === 0
      && checks.nativeKinds.includes("key") && checks.nativeKinds.includes("scroll");
    return ok ? 0 : 1;
  } finally {
    await call("cu_session", { action: "stop" }).catch(() => null);
    for (const proc of owned) { try { proc.kill("SIGTERM"); } catch { /* ignore */ } }
  }
}

main().then((code) => process.exit(code), (error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});

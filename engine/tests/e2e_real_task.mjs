// Real end-to-end task through the actual cu_* tool layer against the INSTALLED
// engine/service (no model, no mocks): session start → snapshot → click(ref) with
// a post-condition → type a unique token with a post-condition → stop.
// Writes the unified action-event stream to docs/reviews/codex-experience-events.jsonl.
//
//   node engine/tests/e2e_real_task.mjs
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { CuSessionManager } from "../../lib/core.mjs";
import { registerCuTools } from "../../lib/index.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const manager = new CuSessionManager();
manager.writeActivity = () => {};
registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });
const run = { signal: new AbortController().signal, agent: { options: { provider: "e2e", model: "e2e" } } };
const call = (name, a = {}) => tools.get(name).execute(a, run);

const text = (snap) => (Array.isArray(snap?.lines) ? snap.lines.join("\n") : "");
const counter = (snap) => {
  const m = /Demo Button (\d+)/.exec(text(snap));
  return m ? Number(m[1]) : -1;
};

async function main() {
  const bin = manager.resolveBinaryPath();
  const demo = spawn(bin, ["demo", "--seconds", "90"], { stdio: "ignore" });
  let demoWin = null;
  try {
    for (let i = 0; i < 40 && !demoWin; i++) {
      await sleep(150);
      const out = await manager.exec(["windows"]).catch(() => null);
      demoWin = (out?.windows ?? []).find((w) => w.title === "cu demo window" && w.windowId > 0) ?? null;
    }
    if (!demoWin) throw new Error("demo window did not appear");

    const status = await call("cu_status");
    const buildId = status?.buildId ?? null;

    await call("cu_session", { action: "start", windowId: demoWin.windowId, pid: demoWin.pid,
      appName: "Demo", dockDsh: false, splitScreen: false, preview: false });

    const snap = await call("cu_snapshot", { pid: demoWin.pid, windowId: demoWin.windowId, full: true });
    const before = counter(snap);
    const buttonLine = (snap.lines ?? []).find((l) => l.includes("Demo Button"));
    const fieldLine = (snap.lines ?? []).find((l) => l.includes("AXTextField") && !l.includes("AXSecureTextField"));
    if (!buttonLine) throw new Error("no Demo Button");
    const buttonRef = buttonLine.split(" ")[0];

    const t0 = Date.now();
    const click = await call("cu_click", { pid: demoWin.pid, windowId: demoWin.windowId, ref: buttonRef,
      observe: false, expect: { query: `Demo Button ${before + 1}`, timeoutMs: 2500 } });
    const clickMs = Date.now() - t0;
    const afterSnap = await call("cu_snapshot", { pid: demoWin.pid, windowId: demoWin.windowId, full: true });
    const after = counter(afterSnap);

    let typeVerified = null;
    const token = `e2e-${Date.now().toString(36)}`;
    if (fieldLine) {
      const fieldRef = fieldLine.split(" ")[0];
      const t1 = Date.now();
      const typed = await call("cu_type", { pid: demoWin.pid, windowId: demoWin.windowId, ref: fieldRef,
        text: token, mode: "type", observe: false, expect: { query: token, timeoutMs: 2500 } });
      typeVerified = typed?.verified === true;
      var typeMs = Date.now() - t1;
    }

    await call("cu_session", { action: "stop" });

    const events = manager.eventLog?.events ?? [];
    writeFileSync("docs/reviews/codex-experience-events.jsonl", events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const ok = click?.ok === true && click?.verified === true && after === before + 1 && typeVerified === true;
    console.log(JSON.stringify({
      ok, buildId, window: demoWin.windowId,
      counterBefore: before, counterAfter: after,
      clickVerified: click?.verified === true, clickMs,
      typeToken: token, typeVerified, typeMs,
      eventCount: events.length,
      phases: events.map((e) => e.phase),
      stop: true,
    }, null, 2));
    return ok ? 0 : 1;
  } finally {
    demo.kill("SIGTERM");
    await call("cu_session", { action: "stop" }).catch(() => null);
  }
}

main().then((code) => process.exit(code), (error) => { console.error(String(error?.stack ?? error)); process.exit(1); });

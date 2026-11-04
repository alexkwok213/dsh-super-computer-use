// Round-2 two-session competition: the real tool wrapper, the real registry and
// the real installed service, driven as two host session ids (chat-a/chat-b).
// No model calls are needed; every tool call goes through the production wrapper.
//
//   node engine/tests/two_session_competition.mjs
import { spawn } from "node:child_process";

import { CuSessionManager } from "../../lib/core.mjs";
import { registerCuTools } from "../../lib/index.mjs";
import { createCuUiRegistry } from "../../lib/cu-ui-session.mjs";
import { createPreviewBridge } from "../../lib/preview-stream.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  throw new Error(message);
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
  fail("demo window not found");
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
    get() {
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
  const execFor = (id) => ({ agent: { id }, signal: new AbortController().signal });
  const call = (id, name, args) => tools.get(name).execute(args, execFor(id));
  const demo = spawn(manager.resolveBinaryPath(), ["demo", "--seconds", "180"], { stdio: "ignore" });
  const result = { ok: false, checks: {} };
  try {
    const window = await findDemo(manager, demo);
    const started = await call("chat-a", "cu_session", {
      action: "start",
      windowId: window.windowId,
      pid: window.pid,
      appName: "two-session",
      dockDsh: false,
      splitScreen: false,
      capsule: false,
      halo: false,
      cursor: false,
      preview: false,
    });
    if (started?.ok !== true) fail(`chat-a start failed: ${JSON.stringify(started)}`);
    const ownerSession = registry.cuSessionId();
    result.checks.aOwns = true;

    let bBusy = null;
    try {
      await call("chat-b", "cu_windows", {});
    } catch (error) {
      bBusy = error;
    }
    result.checks.bRefusedTools = bBusy?.code === "cu_busy";
    if (!result.checks.bRefusedTools) fail(`chat-b tool was not refused: ${bBusy?.message ?? "no error"}`);

    let bStart = null;
    try {
      await call("chat-b", "cu_session", {
        action: "start",
        windowId: window.windowId,
        pid: window.pid,
        dockDsh: false,
        splitScreen: false,
        capsule: false,
        halo: false,
        cursor: false,
        preview: false,
      });
    } catch (error) {
      bStart = error;
    }
    result.checks.bCannotStart = bStart?.code === "cu_busy";

    const bView = registry.snapshot("chat-b");
    result.checks.bSeesOnlyBusy =
      bView.state === "busy_elsewhere" && bView.target === null && bView.cuSessionId === null;
    if (!result.checks.bSeesOnlyBusy) fail(`chat-b saw owner data: ${JSON.stringify(bView)}`);

    const bStop = await registry.control({
      hostSessionId: "chat-b",
      cuSessionId: ownerSession,
      command: "stop",
    });
    result.checks.bCannotStop = bStop.ok === false && bStop.status === 403;
    result.checks.aStillOwns = registry.ownerSessionId() === "chat-a" && manager.activeSession !== null;

    const bridge = createPreviewBridge({ manager, log: () => {} });
    const routes = new Map();
    bridge.register({
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
      registry,
    });
    const route = routes.get("/api/scu/preview");
    const aPreview = await route.fetch(
      new Request(
        `http://127.0.0.1/api/scu/preview?hostSessionId=chat-a&cuSessionId=${encodeURIComponent(ownerSession)}&generation=${manager.sessionGeneration}`,
      ),
    );
    result.checks.aPreviewAccepted = aPreview.status === 200;
    if (aPreview.status === 200) await aPreview.body?.cancel?.().catch?.(() => {});
    const bPreview = await route.fetch(
      new Request(
        `http://127.0.0.1/api/scu/preview?hostSessionId=chat-b&cuSessionId=${encodeURIComponent(ownerSession)}&generation=${manager.sessionGeneration}`,
      ),
    );
    const bPreviewBody = await bPreview.json().catch(() => ({}));
    result.checks.bPreviewRefused = bPreview.status === 403 && bPreviewBody.error === "not_owner";
    bridge.dispose();

    // chat-a stops; then chat-b may claim. The old chat-a ticket cannot affect it.
    const stoppedByA = await call("chat-a", "cu_session", { action: "stop", pause: false });
    result.checks.aStopped = stoppedByA?.ok === true;
    const bStartAfter = await call("chat-b", "cu_session", {
      action: "start",
      windowId: window.windowId,
      pid: window.pid,
      dockDsh: false,
      splitScreen: false,
      capsule: false,
      halo: false,
      cursor: false,
      preview: false,
    });
    result.checks.bCanStartAfter = bStartAfter?.ok === true;
    result.checks.bOwns = registry.ownerSessionId() === "chat-b";
    result.checks.aSeesBusy = registry.snapshot("chat-a").state === "busy_elsewhere";
    await call("chat-b", "cu_session", { action: "stop", pause: false }).catch(() => null);

    result.ok = Object.values(result.checks).every(Boolean);
    console.log(JSON.stringify({ ok: result.ok, checks: result.checks, sessionId: ownerSession }, null, 2));
    return result.ok ? 0 : 1;
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

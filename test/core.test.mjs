import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  CuSessionManager,
  buildCommandArgv,
  renderNodeLine,
  sniffImageMediaType,
} from "../lib/core.mjs";
import { apply, registerCuTools } from "../lib/index.mjs";

process.env.CU_NO_USER_PAUSE = "1";

test("renderNodeLine formats snapshot nodes compactly", () => {
  const line = renderNodeLine({
    ref: "e12",
    role: "AXButton",
    title: "开始创作",
    enabled: true,
    x: 100,
    y: 200,
    w: 88,
    h: 32,
  });
  assert.match(line, /^e12 AXButton "开始创作"/);
  assert.match(line, /@100,200 88×32/);
});

test("CuSessionManager caches snapshot refs and computes compact deltas", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "cu-test-"));
  try {
    const manager = new CuSessionManager({ stateDir: tempDir });
    const firstRaw = {
      ok: true,
      pid: 4242,
      app: "DemoApp",
      count: 2,
      nodes: [
        { ref: "e1", role: "AXButton", title: "Demo Button 0", enabled: true, x: 10, y: 20, w: 100, h: 30 },
        { ref: "e2", role: "AXTextField", title: "demo-field", value: "", enabled: true, x: 10, y: 60, w: 200, h: 24 },
      ],
    };
    const first = manager.recordSnapshot(4242, 9001, firstRaw, { full: false });
    assert.equal(first.mode, "full");
    assert.equal(first.lines.length, 2);

    // Provenance lookup works for same pid + window. The frame is cached too:
    // without it a ref click had no point to aim the overlay at.
    const prov = manager.resolveRefProvenance(4242, "e1", 9001);
    assert.deepEqual(prov, {
      ref: "e1",
      role: "AXButton",
      title: "Demo Button 0",
      windowId: 9001,
      x: 10,
      y: 20,
      w: 100,
      h: 30,
      cx: 60,
      cy: 35,
    });

    // Cross-window lookup is rejected to prevent mis-clicking another window
    assert.equal(manager.resolveRefProvenance(4242, "e1", 9999), null);

    // Second snapshot after button click produces delta
    const secondRaw = {
      ok: true,
      pid: 4242,
      app: "DemoApp",
      count: 2,
      nodes: [
        { ref: "e1", role: "AXButton", title: "Demo Button 1", enabled: true, x: 10, y: 20, w: 100, h: 30 },
        { ref: "e2", role: "AXTextField", title: "demo-field", value: "", enabled: true, x: 10, y: 60, w: 200, h: 24 },
      ],
    };
    const second = manager.recordSnapshot(4242, 9001, secondRaw, { full: false });
    assert.equal(second.mode, "delta");
    assert.equal(second.unchanged, 1);
    assert.equal(second.changes.length, 1);
    assert.match(second.changes[0], /^~ e1 AXButton "Demo Button 1"/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildCommandArgv defaults to background and attaches ref provenance", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "cu-argv-"));
  try {
    const manager = new CuSessionManager({ stateDir: tempDir });
    manager.recordSnapshot(100, 555, {
      ok: true,
      pid: 100,
      app: "Jianying",
      count: 1,
      nodes: [{ ref: "e7", role: "AXButton", title: "导入", enabled: true, x: 1, y: 2, w: 30, h: 20 }],
    });

    const clickArgv = buildCommandArgv("click", { pid: 100, windowId: 555, ref: "e7" }, manager);
    assert.deepEqual(clickArgv, [
      "click",
      "--ref",
      "e7",
      "--pid",
      "100",
      "--window",
      "555",
      "--role",
      "AXButton",
      "--title",
      "导入",
      "--background",
    ]);

    const scrollArgv = buildCommandArgv("scroll", { pid: 100, dy: -240, dx: 0 }, manager);
    assert.deepEqual(scrollArgv, [
      "scroll",
      "--dy",
      "-240",
      "--pid",
      "100",
      "--background",
    ]);

    const fgKeyArgv = buildCommandArgv("key", { pid: 100, name: "return", mods: "cmd", foreground: true }, manager);
    assert.deepEqual(fgKeyArgv, [
      "key",
      "--name",
      "return",
      "--mods",
      "cmd",
      "--pid",
      "100",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pause latch blocks mutating actions until explicit resume", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "cu-pause-"));
  try {
    const pauseFile = join(tempDir, "pause");
    writeFileSync(pauseFile, "");
    const manager = new CuSessionManager({ stateDir: tempDir });

    assert.throws(
      () => manager.assertCanAct("click"),
      (err) => err.code === "PAUSED_BY_USER"
    );

    // Even if file is removed, latched stop remains until clearPauseLatch()
    rmSync(pauseFile, { force: true });
    assert.throws(
      () => manager.assertCanAct("type"),
      (err) => err.code === "PAUSED_BY_USER"
    );

    manager.clearPauseLatch();
    assert.doesNotThrow(() => manager.assertCanAct("click"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sniffImageMediaType detects PNG and JPEG headers", () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  const jpg = new Uint8Array([255, 216, 255, 224, 0, 16]);
  assert.equal(sniffImageMediaType(png), "image/png");
  assert.equal(sniffImageMediaType(jpg), "image/jpeg");
});

test("live CU service + isolated cu demo window roundtrip (background click + delta + preview)", async () => {
  const manager = new CuSessionManager();
  const status = await manager.getStatus();
  assert.equal(status.ok, true, "CU service on 127.0.0.1:47777 should be reachable");
  assert.equal(status.accessibility, true, "CU service should have Accessibility granted");
  assert.equal(status.screenRecording, true, "CU service should have Screen Recording granted");

  // Spawn isolated cu demo window (accessory policy, never steals user focus)
  const demoProc = spawn(manager.resolveBinaryPath(), ["demo", "--seconds", "10"], {
    stdio: "ignore",
  });

  try {
    let demoWin = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const winList = await manager.exec(["windows"]);
      demoWin = (winList.windows || []).find(
        (w) => w.title === "cu demo window" && w.pid === demoProc.pid,
      );
      if (demoWin) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(demoWin, "cu demo window should appear in window list");
    // A freshly shown window can lag its CGWindow/AX frames by a few ticks;
    // retry until the engine can address THIS window before asserting.
    let snap1Raw = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      snap1Raw = await manager.exec([
        "snapshot",
        "--pid",
        String(demoWin.pid),
        "--window",
        String(demoWin.windowId),
      ]);
      if (snap1Raw?.ok === true) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(snap1Raw.ok, true, JSON.stringify(snap1Raw));
    const snap1 = manager.recordSnapshot(demoWin.pid, demoWin.windowId, snap1Raw, { full: true });
    const btnNode = (snap1Raw.nodes || []).find((n) => n.title === "Demo Button 0");
    assert.ok(btnNode, "Demo Button 0 should exist in snapshot");

    // 2. Click Demo Button 0 in background via buildCommandArgv
    const clickArgv = buildCommandArgv(
      "click",
      { pid: demoWin.pid, windowId: demoWin.windowId, ref: btnNode.ref },
      manager
    );
    const clickRes = await manager.exec(clickArgv);
    assert.equal(clickRes.ok, true, JSON.stringify(clickRes));

    // 3. Re-snapshot and verify button title changed to Demo Button 1
    const snap2Raw = await manager.exec([
      "snapshot",
      "--pid",
      String(demoWin.pid),
      "--window",
      String(demoWin.windowId),
    ]);
    const snap2 = manager.recordSnapshot(demoWin.pid, demoWin.windowId, snap2Raw, { full: false });
    assert.equal(snap2.mode, "delta");
    assert.ok(
      snap2.changes.some((line) => line.includes("Demo Button 1")),
      `Expected delta to include Demo Button 1, got: ${JSON.stringify(snap2.changes)}`
    );

    // 4. Capture window preview screenshot (JPEG)
    const shotRes = await manager.exec([
      "shot",
      "--window",
      String(demoWin.windowId),
      "--max-dim",
      "640",
      "--format",
      "jpeg",
      "--quality",
      "0.72",
    ]);
    assert.equal(shotRes.ok, true);
    assert.ok(shotRes.base64 && shotRes.base64.length > 100, "Screenshot base64 should be non-empty");
    const bytes = Buffer.from(shotRes.base64, "base64");
    assert.equal(sniffImageMediaType(bytes), "image/jpeg");
  } finally {
    demoProc.kill("SIGTERM");
  }
});

test("DSH plugin apply() registers 13 cu_* tools, skill, inline image preview, and capsule session", async () => {
  const registeredTools = new Map();
  const registeredSkills = [];
  const effects = [];

  const mockCtx = {
    tools: {
      register(def) {
        registeredTools.set(def.name, def);
        return () => registeredTools.delete(def.name);
      },
    },
    get(serviceName) {
      if (serviceName === "skills") {
        return {
          register(skill) {
            registeredSkills.push(skill);
            return () => {};
          },
        };
      }
      if (serviceName === "llm") {
        return {
          async resolveModelInfo() {
            return { inputModalities: ["text", "image"] };
          },
        };
      }
      if (serviceName === "attachments") {
        return {
          imageLimits: {
            mediaTypes: ["image/png", "image/jpeg", "image/webp"],
            maxImageBytes: 10 * 1024 * 1024,
            maxMessageImageBytes: 10 * 1024 * 1024,
          },
          async saveImage({ data, mediaType, name }) {
            return {
              attachmentId: "att-demo-001",
              mediaType,
              bytes: data.byteLength,
              width: 520,
              height: 470,
              name,
            };
          },
        };
      }
      return undefined;
    },
    on() {
      return () => {};
    },
    effect(fn) {
      effects.push(fn());
    },
  };

  apply(mockCtx, { autoDockDsh: false, previewBudgetMs: 2000 });
  assert.equal(registeredTools.size, 13);
  const skillNames = registeredSkills.map((s) => s.name).sort();
  assert.deepEqual(skillNames, ["super-computer-use"]);

  const mockExec = {
    signal: new AbortController().signal,
    agent: {
      options: { provider: "mock", model: "vision-1" },
    },
  };

  const manager = new CuSessionManager();
  const demoProc = spawn(manager.resolveBinaryPath(), ["demo", "--seconds", "60"], {
    stdio: "ignore",
  });

  try {
    let demoWin = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const winOut = await registeredTools.get("cu_windows").execute({ app: "cu demo" }, mockExec);
      demoWin = (winOut.windows || []).find(
        (w) => w.title === "cu demo window" && w.pid === demoProc.pid,
      );
      if (demoWin) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(demoWin, "cu_windows should find cu demo window");
    // Wait until the engine can address the window before starting a session
    // whose inline preview would otherwise race the AX/CG frame match.
    let addressable = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const probe = await manager.exec([
        "snapshot", "--pid", String(demoWin.pid), "--window", String(demoWin.windowId),
      ]).catch(() => null);
      if (probe?.ok === true) {
        addressable = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(addressable, true, "demo window never became addressable");

    // Start visual session (spawns capsule + halo + captures Codex-style inline preview)
    const sessionTool = registeredTools.get("cu_session");
    const sessionVal = await sessionTool.execute(
      {
        action: "start",
        windowId: demoWin.windowId,
        pid: demoWin.pid,
        appName: "CU Demo",
        dockDsh: false,
        preview: true,
      },
      mockExec
    );
    assert.equal(sessionVal.ok, true);
    assert.equal(sessionVal.session, "started");
    assert.equal(sessionVal.image?.attachmentId, "att-demo-001");

    const renderedBlocks = sessionTool.output.render({}, sessionVal);
    assert.equal(renderedBlocks.length, 2);
    assert.equal(renderedBlocks[1].type, "image");
    assert.equal(renderedBlocks[1].attachment.attachmentId, "att-demo-001");

    // Snapshot & background click with automatic post-action observation
    const snapVal = await registeredTools
      .get("cu_snapshot")
      .execute({ pid: demoWin.pid, windowId: demoWin.windowId, full: true }, mockExec);
    assert.equal(snapVal.ok, true);
    const btnLine = snapVal.lines.find((l) => l.includes("Demo Button 0"));
    assert.ok(btnLine);
    const btnRef = btnLine.split(" ")[0];

    const clickVal = await registeredTools.get("cu_click").execute(
      {
        pid: demoWin.pid,
        windowId: demoWin.windowId,
        ref: btnRef,
        observe: true,
      },
      mockExec
    );
    assert.equal(clickVal.ok, true, JSON.stringify(clickVal));
    assert.equal(clickVal.observation?.mode, "delta");
    assert.ok(clickVal.observation.changes.some((c) => c.includes("Demo Button 1")));

    // The click's post-action observation replaced the current tree. Refs from
    // the pre-click snapshot are deliberately stale now; take a fresh
    // observation before addressing the same control again.
    const snapAfter = await registeredTools
      .get("cu_snapshot")
      .execute({ pid: demoWin.pid, windowId: demoWin.windowId, full: true }, mockExec);
    assert.equal(snapAfter.ok, true);
    const btnLineAfter = snapAfter.lines.find((l) => l.includes("Demo Button 1"));
    assert.ok(btnLineAfter);
    // This snapshot came from the retained AX worker, which keeps its own tree;
    // the native batch executor has not observed that tree and would rightly
    // reject the ref as stale. Use the button's frame for a coordinate batch.
    const frame = btnLineAfter.match(/@(\d+),(\d+) (\d+)×(\d+)/);
    assert.ok(frame, btnLineAfter);
    const cx = Number(frame[1]) + Number(frame[3]) / 2;
    const cy = Number(frame[2]) + Number(frame[4]) / 2;

    // Fast batch execution (click + wait + key) in a single local invocation
    const batchVal = await registeredTools.get("cu_batch").execute(
      {
        pid: demoWin.pid,
        windowId: demoWin.windowId,
        steps: [
          { action: "click", x: cx, y: cy, force: true },
          { action: "wait", ms: 50 },
          { action: "key", name: "tab" },
        ],
        preview: true,
      },
      mockExec
    );
    assert.equal(batchVal.ok, true);
    assert.equal(batchVal.completedSteps, 3);
    assert.equal(batchVal.totalSteps, 3);
    assert.ok(batchVal.durationMs < 3000, `Batch took too long: ${batchVal.durationMs}ms`);
    assert.ok(batchVal.timings?.steps >= 0, JSON.stringify(batchVal.timings));
    assert.ok(batchVal.preview?.ok, "Batch should include final preview");

    // Stop visual session and clean up capsule/halo
    const stopVal = await sessionTool.execute({ action: "stop" }, mockExec);
    assert.equal(stopVal.ok, true);
    assert.equal(stopVal.session, "stopped");
  } finally {
    for (const cleanup of effects) await cleanup?.();
    demoProc.kill("SIGTERM");
  }
});

test("visual session docks DSH by default and restores it on stop", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cu-layout-"));
  const calls = [];
  const manager = new CuSessionManager({ stateDir });
  manager.resolveBinaryPath = () => "/nonexistent/cu";
  manager.exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "windows") {
      return {
        ok: true,
        windows: [
          { windowId: 11, pid: 1, app: "DeepSeek Harness", title: "DSH",
            bounds: { x: 0, y: 33, width: 1728, height: 998 } },
          { windowId: 22, pid: 2, app: "Safari", title: "Safari",
            bounds: { x: 100, y: 100, width: 800, height: 600 } },
        ],
      };
    }
    return { ok: true };
  };

  manager.warmCaptureDaemon = () => {};
  const started = await manager.startVisualSession({
    windowId: 22, pid: 2, appName: "Safari", dockDsh: true, splitScreen: true,
    halo: false, cursor: false, seconds: 60,
  });
  assert.equal(started.dockedDsh, true);
  assert.equal(started.targetSplit, true);

  const flag = (argv, name) => argv[argv.indexOf(name) + 1];
  const dshMove = calls.find((a) => a[0] === "movewindow" && a[2] === "11");
  assert.ok(dshMove, "DSH window should be moved");
  assert.equal(flag(dshMove, "--x"), "1152");
  assert.equal(flag(dshMove, "--w"), "576");
  const targetMove = calls.find((a) => a[0] === "movewindow" && a[2] === "22");
  assert.ok(targetMove, "target window should take the left side");
  assert.equal(flag(targetMove, "--x"), "0");
  assert.equal(flag(targetMove, "--w"), "1152");
  assert.ok(calls.some((a) => a[0] === "screen-indicator" && a[2] === "on"),
    "session should raise the menu-bar screen-recording indicator");

  await manager.stopVisualSession();
  const dshRestore = calls.filter((a) => a[0] === "movewindow" && a[2] === "11").pop();
  assert.equal(flag(dshRestore, "--x"), "0");
  assert.equal(flag(dshRestore, "--w"), "1728");
  const targetRestore = calls.filter((a) => a[0] === "movewindow" && a[2] === "22").pop();
  assert.equal(flag(targetRestore, "--x"), "100");
  assert.equal(flag(targetRestore, "--w"), "800");
  assert.ok(calls.some((a) => a[0] === "screen-indicator" && a[2] === "off"),
    "stopping the session should clear the indicator");
  rmSync(stateDir, { recursive: true, force: true });
});

test("stopVisualSession returns lossless JSON for an auto-session without appName", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cu-stopjson-"));
  const manager = new CuSessionManager({ stateDir });
  manager.resolveBinaryPath = () => "/nonexistent/cu";
  manager.exec = async (argv) => (argv[0] === "windows"
    ? { ok: true, windows: [{ windowId: 22, pid: 2, app: "Safari", title: "Safari",
        bounds: { x: 0, y: 0, width: 800, height: 600 } }] }
    : { ok: true });

  manager.warmCaptureDaemon = () => {};
  await manager.startVisualSession({
    windowId: 22, pid: 2, dockDsh: false, splitScreen: false,
    halo: false, cursor: false, seconds: 60,
  });
  const stopped = await manager.stopVisualSession();

  assert.equal(stopped.previous.app, null);
  assert.deepEqual(JSON.parse(JSON.stringify(stopped)), stopped,
    "tool output must survive the host's lossless-JSON validation");
  rmSync(stateDir, { recursive: true, force: true });
});

test("auto-session shrinks DSH without moving the click target", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cu-autolayout-"));
  const calls = [];
  const manager = new CuSessionManager({ stateDir });
  manager.resolveBinaryPath = () => "/nonexistent/cu";
  manager.exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "windows") {
      return {
        ok: true,
        windows: [
          { windowId: 11, pid: 1, app: "DeepSeek Harness", title: "DSH",
            bounds: { x: 0, y: 33, width: 1728, height: 998 } },
          { windowId: 22, pid: 2, app: "Safari", title: "Safari",
            bounds: { x: 100, y: 100, width: 800, height: 600 } },
        ],
      };
    }
    return { ok: true };
  };
  manager.warmCaptureDaemon = () => {};
  await manager.startVisualSession({
    windowId: 22, pid: 2, appName: "Safari", dockDsh: true, splitScreen: false,
    halo: false, cursor: false, seconds: 60,
  });
  assert.ok(calls.some((a) => a[0] === "movewindow" && a[2] === "11"),
    "auto-session should shrink DSH");
  assert.ok(!calls.some((a) => a[0] === "movewindow" && a[2] === "22"),
    "auto-session must not move the target while a click is pending");
  await manager.stopVisualSession();
  rmSync(stateDir, { recursive: true, force: true });
});

test("dockDsh false leaves both windows untouched", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cu-nolayout-"));
  const calls = [];
  const manager = new CuSessionManager({ stateDir });
  manager.resolveBinaryPath = () => "/nonexistent/cu";
  manager.exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "windows") {
      return {
        ok: true,
        windows: [
          { windowId: 11, pid: 1, app: "DeepSeek Harness", title: "DSH",
            bounds: { x: 0, y: 33, width: 1728, height: 998 } },
          { windowId: 22, pid: 2, app: "Safari", title: "Safari",
            bounds: { x: 100, y: 100, width: 800, height: 600 } },
        ],
      };
    }
    return { ok: true };
  };
  manager.warmCaptureDaemon = () => {};
  await manager.startVisualSession({
    windowId: 22, pid: 2, appName: "Safari", dockDsh: false, splitScreen: true,
    halo: false, cursor: false, seconds: 60,
  });
  assert.ok(!calls.some((a) => a[0] === "movewindow"), "no window may move");
  await manager.stopVisualSession();
  rmSync(stateDir, { recursive: true, force: true });
});

test("the indicator-off request survives the input gate stopVisualSession closes", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cu-indicator-gate-"));
  const manager = new CuSessionManager({ stateDir });
  // stopVisualSession() closes the gate before cleanup runs. A non-control
  // command is answered locally, so the old fire-and-forget off never reached
  // the launchd service and macOS kept its "Currently Sharing" panel forever.
  manager.inputGateClosed = true;
  manager.sessionGeneration = 4;
  const dropped = await manager.exec(["screen-indicator", "--state", "off"], undefined, {});
  assert.equal(dropped.error, "cancelled");

  const seen = [];
  manager.exec = async (argv, signal, options = {}) => {
    seen.push({ argv, control: options.control === true });
    return { ok: true, screenIndicator: "off" };
  };
  assert.equal(await manager.stopScreenIndicator(), true);
  assert.deepEqual(seen[0].argv, ["screen-indicator", "--state", "off"]);
  assert.equal(seen[0].control, true, "indicator cleanup is control work");
  rmSync(stateDir, { recursive: true, force: true });
});

test("stopScreenIndicator retries and reports a service that answers on", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cu-indicator-retry-"));
  const manager = new CuSessionManager({ stateDir });
  let attempts = 0;
  manager.exec = async () => {
    attempts += 1;
    return { ok: true, screenIndicator: "on" };
  };
  assert.equal(await manager.stopScreenIndicator({ attempts: 2, timeoutMs: 200 }), false);
  assert.equal(attempts, 2, "a failed read-back must be retried, not trusted");
  assert.equal(manager.lastIndicatorError, "indicator_state_on");
  rmSync(stateDir, { recursive: true, force: true });
});

test("a missing menu-bar listener is reported without failing the release", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cu-indicator-listener-"));
  const manager = new CuSessionManager({ stateDir });
  manager.exec = async () => ({ ok: true, screenIndicator: "off", applied: false, listenerPid: 0 });
  // Nothing was ever opened, so cleanup succeeded — but the missing listener must
  // stay visible: it is why the system panel used to look permanently on.
  assert.equal(await manager.stopScreenIndicator(), true);
  assert.equal(manager.screenIndicatorListenerMissing, true);
  assert.equal(manager.screenIndicatorWasOn, false);

  // "previous":"on" is what turns a boot-time off into a reported leak.
  manager.exec = async () => ({
    ok: true, screenIndicator: "off", applied: true, previous: "on", listenerPid: 42,
  });
  assert.equal(await manager.stopScreenIndicator(), true);
  assert.equal(manager.screenIndicatorListenerMissing, false);
  assert.equal(manager.screenIndicatorWasOn, true);
  rmSync(stateDir, { recursive: true, force: true });
});

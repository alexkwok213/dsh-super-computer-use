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
      demoWin = (winList.windows || []).find((w) => w.title === "cu demo window");
      if (demoWin) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(demoWin, "cu demo window should appear in window list");
    await new Promise((r) => setTimeout(r, 300));

    // 1. Snapshot the demo window
    const snap1Raw = await manager.exec([
      "snapshot",
      "--pid",
      String(demoWin.pid),
      "--window",
      String(demoWin.windowId),
    ]);
    assert.equal(snap1Raw.ok, true);
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

  apply(mockCtx, { autoDockDsh: false });
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
      demoWin = (winOut.windows || []).find((w) => w.title === "cu demo window");
      if (demoWin) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(demoWin, "cu_windows should find cu demo window");

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

    // Fast batch execution (click + wait + key) in a single local invocation
    const batchVal = await registeredTools.get("cu_batch").execute(
      {
        pid: demoWin.pid,
        windowId: demoWin.windowId,
        steps: [
          { action: "click", ref: btnRef, force: true },
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
  await manager.startVisualSession({
    windowId: 22, pid: 2, appName: "Safari", dockDsh: false, splitScreen: true,
    halo: false, cursor: false, seconds: 60,
  });
  assert.ok(!calls.some((a) => a[0] === "movewindow"), "no window may move");
  await manager.stopVisualSession();
  rmSync(stateDir, { recursive: true, force: true });
});

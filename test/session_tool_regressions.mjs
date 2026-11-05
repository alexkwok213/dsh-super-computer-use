import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CuSessionManager } from "../lib/core.mjs";
import { registerCuTools } from "../lib/index.mjs";

function setup(t, options = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "cu-session-tools-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const manager = new CuSessionManager({ stateDir });
  manager.writeActivity = () => {};
  manager.setNativePreviewVisible = () => {};
  manager._axWorkerAllowed = false;
  const calls = [];
  const tools = new Map();
  registerCuTools({
    manager,
    config: { autoSession: false },
    registry: options.registry ?? null,
    defineTool: (x) => x,
    ctx: { tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } } },
  });
  return {
    manager,
    calls,
    run: (name, args, exec = { agent: { id: "chat-a" } }) => tools.get(name).execute(args, exec),
  };
}

test("cu_windows keeps the underlying error instead of reporting an empty success", async (t) => {
  const { manager, run } = setup(t);
  manager._execRequest = async () => ({
    ok: false,
    error: "cancelled",
    message: "the session was stopped before this action could start",
    outcomeUnknown: true,
    actionReplaySafe: false,
  });
  const result = await run("cu_windows", {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "cancelled");
  assert.equal(result.outcomeUnknown, true);
  assert.match(result.message, /stopped/);
  assert.deepEqual(result.windows, []);
  assert.equal(result.count, 0);
});

test("cu_windows still reports a genuinely empty window list as success", async (t) => {
  const { manager, run } = setup(t);
  manager._execRequest = async () => ({ ok: true, windows: [], frontmost: null });
  const result = await run("cu_windows", {});
  assert.equal(result.ok, true);
  assert.equal(result.count, 0);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.windows, []);
});

test("read-only window listing keeps working after a stop without reopening the input gate", async (t) => {
  // The real host always passes the UI registry; without it the ownership gate
  // is absent and this test would miss the paused-read regression.
  const registry = {
    beginAction() {
      throw new Error("a read-only call must never claim the desk");
    },
    endAction() {},
  };
  const { manager, run } = setup(t, { registry });
  let dispatched = 0;
  manager._execRequest = async () => {
    dispatched += 1;
    return { ok: true, windows: [{ windowId: 7, pid: 99, app: "Finder", title: "Desktop", bounds: { x: 0, y: 0, width: 800, height: 600 } }] };
  };
  // A user stop closed the gate and bumped the session generation.
  manager.inputGateClosed = true;
  manager.pauseLatched = true;
  manager.sessionGeneration += 1;
  const result = await run("cu_windows", {});
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(dispatched, 1, "a read must reach the engine even while input is gated");
  assert.equal(manager.inputGateClosed, true, "reading must not reopen the input gate");
  assert.equal(manager.pauseLatched, true);

  // Input is still refused by the same wrapper.
  let code = null;
  try {
    await run("cu_key", { pid: 99, name: "escape" });
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, "PAUSED_BY_USER");
});

test("a new chat's first snapshot is full, not another chat's delta", async (t) => {
  const { manager, run } = setup(t);
  const nodes = [
    { ref: "e1", role: "AXButton", title: "导入", x: 10, y: 10, w: 80, h: 24 },
    { ref: "e2", role: "AXButton", title: "导出", x: 100, y: 10, w: 80, h: 24 },
  ];
  manager._execRequest = async (argv) => {
    if (argv[0] === "windows") {
      return { ok: true, windows: [{ windowId: 5, pid: 42, app: "Notes", title: "n", bounds: { x: 0, y: 0, width: 900, height: 700 } }] };
    }
    if (argv[0] === "snapshot") return { ok: true, pid: 42, windowId: 5, app: "Notes", nodes };
    return { ok: true };
  };

  const first = await run("cu_snapshot", { pid: 42, windowId: 5 }, { agent: { id: "chat-a" } });
  assert.equal(first.mode, "full", "the first observation for chat-a is full");
  const same = await run("cu_snapshot", { pid: 42, windowId: 5 }, { agent: { id: "chat-a" } });
  assert.equal(same.mode, "delta", "the same chat gets a delta on its second read");
  const other = await run("cu_snapshot", { pid: 42, windowId: 5 }, { agent: { id: "chat-b" } });
  assert.equal(other.mode, "full", "chat-b has no baseline of its own and must see the whole tree");
  assert.ok(Array.isArray(other.lines) && other.lines.length === 2);
  assert.equal(manager.inputGateClosed, false);
});

test("a coordinate outside the target window is refused before dispatch", async (t) => {
  const { manager, calls, run } = setup(t);
  manager._execRequest = async (argv) => {
    calls.push(argv);
    if (argv[0] === "windows") {
      return { ok: true, windows: [{ windowId: 11, pid: 77, app: "Finder", title: "w", bounds: { x: 100, y: 100, width: 700, height: 500 } }] };
    }
    return { ok: true };
  };
  const result = await run("cu_click", { pid: 77, windowId: 11, x: 873, y: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "point_outside_target_window");
  assert.equal(result.point.x, 873);
  assert.equal(result.target.bounds.x + result.target.bounds.width, 800);
  assert.equal(calls.some((argv) => argv[0] === "click"), false, "no click event may be dispatched");
});

test("a coordinate is refused when the window moved after the observation it came from", async (t) => {
  const { manager, calls, run } = setup(t);
  let bounds = { x: 100, y: 100, width: 700, height: 500 };
  manager._execRequest = async (argv) => {
    calls.push(argv);
    if (argv[0] === "windows") {
      return { ok: true, windows: [{ windowId: 11, pid: 77, app: "Finder", title: "w", bounds: { ...bounds } }] };
    }
    if (argv[0] === "snapshot") {
      return { ok: true, pid: 77, windowId: 11, app: "Finder", nodes: [{ ref: "e1", role: "AXButton", title: "ok", x: 300, y: 300, w: 40, h: 20 }] };
    }
    return { ok: true };
  };
  await run("cu_snapshot", { pid: 77, windowId: 11 });

  bounds = { x: 110, y: 100, width: 700, height: 500 };
  const result = await run("cu_click", { pid: 77, windowId: 11, x: 300, y: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "window_geometry_changed");
  assert.deepEqual(result.previousBounds, { x: 100, y: 100, width: 700, height: 500 });
  assert.equal(calls.some((argv) => argv[0] === "click"), false);
});

test("a coordinate inside the current frame still dispatches", async (t) => {
  const { manager, calls, run } = setup(t);
  manager._execRequest = async (argv) => {
    calls.push(argv);
    if (argv[0] === "windows") {
      return { ok: true, windows: [{ windowId: 11, pid: 77, app: "Finder", title: "w", bounds: { x: 100, y: 100, width: 700, height: 500 } }] };
    }
    if (argv[0] === "click") return { ok: true, x: 300, y: 300 };
    if (argv[0] === "snapshot") return { ok: true, pid: 77, windowId: 11, app: "Finder", nodes: [] };
    return { ok: true };
  };
  const result = await run("cu_click", { pid: 77, windowId: 11, x: 300, y: 300 });
  assert.equal(result.ok, true);
  assert.ok(calls.some((argv) => argv[0] === "click"));
});

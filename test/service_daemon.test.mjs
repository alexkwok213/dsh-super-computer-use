import test from "node:test";
import assert from "node:assert/strict";
import { CuSessionManager } from "../lib/core.mjs";

test("CuSessionManager can resolve bundled binary in bin/cu", () => {
  const manager = new CuSessionManager();
  const bin = manager.resolveBinaryPath();
  assert.ok(typeof bin === "string" && bin.length > 0, "bin path should be non-empty");
  assert.ok(bin.endsWith("/cu"), `expected path ending with /cu, got ${bin}`);
});

test("CuSessionManager resolvePreviewBinary prefers sibling preview binary", () => {
  const manager = new CuSessionManager();
  const previewBin = manager.resolvePreviewBinary();
  assert.ok(typeof previewBin === "string" && previewBin.length > 0);
  assert.ok(previewBin.includes("cu"), `expected cu preview binary, got ${previewBin}`);
});

test("CuSessionManager openSystemSettings invokes without error", () => {
  const manager = new CuSessionManager();
  // Call with dry check / target names
  const res1 = manager.openSystemSettings("accessibility");
  assert.equal(res1, true);
  const res2 = manager.openSystemSettings("screenRecording");
  assert.equal(res2, true);
});

test("CuSessionManager ensureServiceRunning reports ok when service responds", async () => {
  const manager = new CuSessionManager();
  try {
    const status = await manager.ensureServiceRunning(AbortSignal.timeout(4000));
    assert.equal(status.ok, true);
  } finally {
    manager.stopManagedService();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CuSessionManager } from "../lib/core.mjs";

const TEST_DIR = resolve(new URL(".", import.meta.url).pathname);

test("the suite runs against a temporary CU_STATE_DIR, never the real ~/.cu", () => {
  assert.equal(process.env.NODE_TEST_CONTEXT !== undefined, true, "must be a node --test child");
  assert.ok(process.env.CU_STATE_DIR, "CU_STATE_DIR must be set by scripts/test-isolated.mjs");
  assert.notEqual(resolve(process.env.CU_STATE_DIR), resolve(join(homedir(), ".cu")));
  const manager = new CuSessionManager();
  assert.equal(resolve(manager.stateDir), resolve(process.env.CU_STATE_DIR));
});

test("a test-context manager refuses to touch the default real state dir", () => {
  const manager = new CuSessionManager({ stateDir: join(homedir(), ".cu") });
  // Explicit ~/.cu is allowed by the constructor but a test process must not be
  // able to spawn a helper there: that is the exact path that used to rewrite
  // the live config. Simulate the unsafe default by clearing the explicit flag.
  manager._stateDirExplicit = false;
  const violation = manager._testIsolationViolation();
  assert.equal(violation?.error, "test_isolation_required");
});

test("no test spawns the helper without CU_STATE_DIR or opens System Settings", () => {
  const violations = [];
  for (const name of readdirSync(TEST_DIR)) {
    if (!name.endsWith(".mjs") || name === "isolation_guard.mjs") continue;
    const lines = readFileSync(join(TEST_DIR, name), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/\bopenSystemSettings\s*\(/.test(line) && !/systemSettingsUrl/.test(line)) {
        violations.push(`${name}:${index + 1} calls openSystemSettings (launches System Settings)`);
      }
      if (/\bspawn\s*\(/.test(line)) {
        const window = lines.slice(index, index + 9).join("\n");
        if (window.includes('"service"') && !window.includes("CU_STATE_DIR")) {
          violations.push(`${name}:${index + 1} spawns the helper without an explicit CU_STATE_DIR`);
        }
      }
    });
  }
  assert.deepEqual(violations, []);
});

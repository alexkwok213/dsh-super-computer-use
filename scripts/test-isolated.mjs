#!/usr/bin/env node
/**
 * Run the plugin test suite without touching the person's real ~/.cu.
 *
 * The suite used to spawn the helper with no CU_STATE_DIR. The helper rewrote
 * ~/.cu/config.json with its own port, then exited with the test, so the live
 * plugin kept dialing a dead port. This wrapper gives every test process a
 * throwaway CU_STATE_DIR and proves afterwards that the real config and pause
 * latch were not modified.
 *
 * Usage:
 *   node scripts/test-isolated.mjs               # test/*.mjs
 *   node scripts/test-isolated.mjs test/a.mjs    # one file
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const REAL_STATE = join(homedir(), ".cu");
const configPath = join(REAL_STATE, "config.json");
const pausePath = join(REAL_STATE, "pause");

const fingerprint = (path) => {
  try {
    if (!existsSync(path)) return "missing";
    const stats = statSync(path);
    return `${createHash("sha256").update(readFileSync(path)).digest("hex")}:${stats.size}`;
  } catch {
    return "unreadable";
  }
};

const before = { config: fingerprint(configPath), pause: fingerprint(pausePath) };
const stateDir = mkdtempSync(join(tmpdir(), "cu-test-state-"));

const requested = process.argv.slice(2);
const files = requested.length
  ? requested
  : readdirSync(join(ROOT, "test"))
      .filter((name) => name.endsWith(".mjs"))
      .sort()
      .map((name) => join("test", name));

// A separate pathname also isolates native application/process registration.
// Executing concurrent tests from the live helper path caused SIGTERM during
// AppKit cleanup on this host, even with separate state and ports.
const testBinDir = join(stateDir, "bin");
mkdirSync(testBinDir);
const serviceSource = process.env.CU_BIN && existsSync(process.env.CU_BIN)
  ? resolve(process.env.CU_BIN) : join(ROOT, "bin", "cu");
const previewSource = process.env.CU_PREVIEW_BIN && existsSync(process.env.CU_PREVIEW_BIN)
  ? resolve(process.env.CU_PREVIEW_BIN) : join(ROOT, "bin", "cu-preview");
for (const [source, name] of [[serviceSource, "cu"], [previewSource, "cu-preview"]]) {
  copyFileSync(source, join(testBinDir, name));
  chmodSync(join(testBinDir, name), 0o755);
}

let exitCode = 1;
let suiteOutput = "";
try {
  const child = spawn(
    process.execPath,
    // Serial execution and a per-test ceiling keep helper-spawning suites from
    // racing each other (and from hanging forever) on a loaded machine.
    ["--test", "--test-concurrency=1", "--test-timeout=120000", ...files],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CU_STATE_DIR: stateDir,
        CU_BIN: join(testBinDir, "cu"),
        CU_PREVIEW_BIN: join(testBinDir, "cu-preview"),
        CU_TEST_SOURCE_BIN: serviceSource,
        // The real pause latch lives in the real state dir; tests may still
        // exercise pause explicitly through their own temporary directory.
        CU_NO_USER_PAUSE: "1",
        CU_DISABLE_DISPLAY_AWAKE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    suiteOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    suiteOutput += chunk.toString();
  });
  exitCode = await new Promise((resolveExit) => {
    child.on("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
    child.on("error", () => resolveExit(1));
  });
} finally {
  // stopManagedService schedules a late SIGKILL; give it time to land before
  // the directory disappears, then remove only the directory this run made.
  await new Promise((r) => setTimeout(r, 900));
  rmSync(stateDir, { recursive: true, force: true });
}

const after = { config: fingerprint(configPath), pause: fingerprint(pausePath) };
const changed = [];
if (before.config !== after.config) changed.push("~/.cu/config.json");
if (before.pause !== after.pause) changed.push("~/.cu/pause");

if (changed.length) {
  console.error(
    `\n[test-isolated] FAILED: the suite modified real user state: ${changed.join(", ")}`,
  );
  exitCode = 1;
} else {
  // Keep the evidence short and machine-readable: the suites' own summary is
  // above, this line is what proves the isolation claim.
  const summary = suiteOutput.match(/^# (pass|fail|skipped) \d+$/gm) ?? [];
  console.log(
    `[test-isolated] real ~/.cu untouched (config ${after.config.slice(0, 12)}…, pause ${after.pause}); ` +
      `state dir ${stateDir} removed; ${summary.join(" ")}`,
  );
}

process.exit(exitCode);

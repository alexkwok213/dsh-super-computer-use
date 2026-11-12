#!/usr/bin/env node
/**
 * One development update: test, build if needed, reload the running DSH plugin,
 * and prove what is actually live.
 *
 * The checkout is linked into the desktop profile, so the file bytes are already
 * the bytes DSH resolves. This command updates the *running* generations through
 * the Host's own HMR service and refuses to report success until the Host
 * identity, browser bundle revision, and native helper build id all match disk.
 *
 * It never writes ~/.cu/config.json, never opens a port, never starts a
 * long-lived helper outside the plugin, and never commits or pushes.
 *
 * Exit codes:
 *   0  verified live
 *   1  tests, build, reload, or verification failed
 *   2  usage error
 *   3  blocked: active CU session, HMR unavailable, page not open, or restart needed
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEV_SYNC_PROTOCOL,
  DEV_SYNC_SCHEMA,
  clientRevMatches,
  devSyncPaths,
  hashEngineSources,
  hashHostSources,
  listEngineSourceFiles,
  nativeReplacementRequired,
  parseClientVersion,
  pidAlive,
  probeHelper,
  readJson,
  resolveStateDir,
  sha256File,
  writeJsonAtomic,
} from "../lib/dev-sync.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_ID = "dsh-super-computer-use";
const PROFILE = process.env.DSH_PROFILE || "desktop";
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const EXIT = Object.freeze({ ok: 0, failure: 1, usage: 2, blocked: 3 });

class SyncResult extends Error {
  constructor(exitCode, headline, detail = {}, lines = []) {
    super(headline);
    this.exitCode = exitCode;
    this.detail = detail;
    this.lines = lines;
  }
}

let jsonMode = false;
function say(label, text = "") {
  if (jsonMode) return;
  const line = text ? `[dev:sync] ${label.padEnd(8)} ${text}` : `[dev:sync] ${label}`;
  console.log(line);
}
function info(text) {
  if (jsonMode) return;
  console.log(`[dev:sync] ${text}`);
}
function failure(headline, detail = {}, lines = []) {
  return new SyncResult(EXIT.failure, headline, detail, lines);
}
function blocked(headline, detail = {}, lines = []) {
  return new SyncResult(EXIT.blocked, headline, detail, lines);
}

function parseArgs(argv) {
  const options = {
    waitIdleMs: 20000,
    timeoutMs: 60000,
    skipTests: false,
    forceBuild: false,
    checkOnly: false,
    json: false,
    help: false,
  };
  const takeValue = (arg, index, name) => {
    const equals = arg.indexOf("=");
    if (equals !== -1) return arg.slice(equals + 1);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new SyncResult(EXIT.usage, `${name} needs a value`, {});
    }
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--skip-tests") options.skipTests = true;
    else if (arg === "--force-build") options.forceBuild = true;
    else if (arg === "--check-only") options.checkOnly = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--wait-idle" || arg.startsWith("--wait-idle=")) {
      const value = Number(takeValue(arg, index, "--wait-idle"));
      if (!Number.isFinite(value) || value < 0) throw new SyncResult(EXIT.usage, "--wait-idle must be >= 0", {});
      options.waitIdleMs = Math.round(value * 1000);
      if (arg === "--wait-idle") index += 1;
    } else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const value = Number(takeValue(arg, index, "--timeout"));
      if (!Number.isFinite(value) || value <= 0) throw new SyncResult(EXIT.usage, "--timeout must be > 0", {});
      options.timeoutMs = Math.round(value * 1000);
      if (arg === "--timeout") index += 1;
    } else {
      throw new SyncResult(EXIT.usage, `unknown argument: ${arg}`, {}, ["run `npm run dev:sync -- --help`"]);
    }
  }
  return options;
}

function usage() {
  console.log(`Usage: npm run dev:sync -- [options]

  --wait-idle <seconds>  wait this long for an idle CU session before giving up
                         (default 20; 0 means report the blocker immediately)
  --timeout <seconds>    total reload/verification budget (default 60)
  --skip-tests           skip the automated suite (prints a warning)
  --force-build          rebuild the universal helper even when sources match
  --check-only           print the link/runtime/hashes plan without changing anything
  --json                 print one JSON result instead of human lines
  -h, --help             this text

Exit codes: 0 verified, 1 failed, 2 usage, 3 blocked/needs user or restart.`);
}

function acquireLock(path) {
  const attempt = () => {
    let fd;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readJson(path);
      const started = Date.parse(existing?.startedAt ?? "");
      const fresh = Number.isFinite(started) && Date.now() - started < 10 * 60 * 1000;
      if (existing && pidAlive(Number(existing.pid)) && fresh) {
        throw failure("another dev:sync is already running", {
          pid: existing.pid,
          startedAt: existing.startedAt,
          lock: path,
        });
      }
      try {
        unlinkSync(path);
      } catch {
        // Retry once; a live owner would still be caught.
      }
      return attempt();
    }
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    } finally {
      closeSync(fd);
    }
    return { path, pid: process.pid };
  };
  return attempt();
}

function releaseLock(lock) {
  if (!lock) return;
  const current = readJson(lock.path);
  if (Number(current?.pid) !== process.pid) return;
  try {
    unlinkSync(lock.path);
  } catch {
    // best effort
  }
}

function verifyCheckout() {
  const linkPath = join(DSH_HOME, "profiles", PROFILE, "node_modules", PACKAGE_ID);
  if (!existsSync(linkPath)) {
    throw failure("profile link is missing", {
      link: linkPath,
      profile: PROFILE,
      hint: `cd ${join(DSH_HOME, "profiles", PROFILE)} && pnpm add link:${REPO_ROOT}`,
    });
  }
  let target;
  try {
    target = realpathSync(linkPath);
  } catch (error) {
    throw failure("profile link cannot be resolved", { link: linkPath, error: String(error?.message ?? error) });
  }
  const root = realpathSync(REPO_ROOT);
  if (target !== root) {
    throw failure("profile link points at another checkout", {
      link: linkPath,
      target,
      expected: root,
      hint: "Do not let dev:sync repair or repoint the link; fix the link deliberately.",
    });
  }
  const pkg = readJson(join(target, "package.json"));
  if (pkg?.name !== PACKAGE_ID) {
    throw failure("linked package has the wrong name", { link: linkPath, name: pkg?.name ?? null });
  }
  return { linkPath, target, packageMeta: pkg };
}

function hostProcessCommand(pid) {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function requestPathFor(runtime, paths) {
  const candidate = runtime?.devSync?.requestPath;
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  const resolved = resolve(candidate);
  const root = resolve(paths.root);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return null;
  return resolved;
}

function verifyRuntime(runtime) {
  if (!runtime || runtime.schema !== DEV_SYNC_SCHEMA) {
    throw blocked("the running DSH has not loaded a dev-sync-capable plugin yet", {
      runtimeFile: "missing or old schema",
      hint: "Restart DSH once so it loads this checkout; then run dev:sync again. Do not fake a reload.",
    });
  }
  if (runtime.devSync?.protocol !== DEV_SYNC_PROTOCOL) {
    throw blocked("the running plugin has an incompatible dev-sync protocol", {
      expected: DEV_SYNC_PROTOCOL,
      observed: runtime.devSync?.protocol ?? null,
    });
  }
  if (runtime.packageName !== PACKAGE_ID) {
    throw failure("runtime identity belongs to another package", { name: runtime.packageName });
  }
  if (resolve(runtime.entryPath ?? "") !== resolve(REPO_ROOT, "lib", "index.mjs")) {
    throw blocked("the running plugin was loaded from another path", {
      entryPath: runtime.entryPath ?? null,
      expected: join(REPO_ROOT, "lib", "index.mjs"),
    });
  }
  const hostPid = Number(runtime.hostPid);
  if (!pidAlive(hostPid)) {
    throw blocked("the reported DSH Host process is not running", { hostPid });
  }
  const command = hostProcessCommand(hostPid);
  if (!command.includes("dsh-desktop-host") && !command.includes("app.asar/dsh")) {
    throw blocked("the reported pid is not a DSH Host", { hostPid, command: command.slice(0, 200) });
  }
  // The HMR requirement is enforced in run(), only when a generation actually
  // needs replacing. A host without the HMR APIs can still be verified after a
  // normal DSH restart has already loaded the current checkout.
  if (runtime.phase !== "ready") {
    throw blocked("the running plugin has not finished applying", { phase: runtime.phase ?? null });
  }
  return hostPid;
}

/**
 * Whether a live reload is required but the host cannot perform one.
 *
 * HMR exists to replace a running generation, not to verify one a normal DSH
 * restart already loaded. When plan.anyChange is false, run() only checks the
 * four identity hashes and never writes a reload request, so a missing HMR API
 * is not a blocker. Every real change still hits the original exit-3 gate.
 * This must never be used to skip a reload that the plan says is needed.
 */
export function reloadRequiresHmr(runtime, plan) {
  return Boolean(plan?.anyChange) && runtime?.hmr?.available !== true;
}

function sourceSnapshot() {
  const host = hashHostSources(REPO_ROOT);
  const clientPath = join(REPO_ROOT, "client.js");
  const clientSource = (() => {
    try {
      return readFileSync(clientPath, "utf8");
    } catch {
      return "";
    }
  })();
  const client = {
    path: clientPath,
    sourceHash: sha256File(clientPath),
    version: parseClientVersion(clientSource),
  };
  const servicePath = join(REPO_ROOT, "bin", "cu");
  const previewPath = join(REPO_ROOT, "bin", "cu-preview");
  const native = {
    servicePath,
    serviceBuildId: sha256File(servicePath),
    previewPath,
    previewBuildId: sha256File(previewPath),
  };
  const engine = hashEngineSources(REPO_ROOT);
  if (!client.sourceHash) throw failure("client.js is missing or unreadable", { path: clientPath });
  if (!native.serviceBuildId) throw failure("bin/cu is missing or unreadable", { path: servicePath });
  if (!native.previewBuildId) throw failure("bin/cu-preview is missing or unreadable", { path: previewPath });
  return { host, client, native, engine };
}

export function sourcesNewerThanBinary(engineFiles, binaryPath) {
  let binaryTime = 0;
  try {
    binaryTime = statSync(binaryPath).mtimeMs;
  } catch {
    return true;
  }
  for (const file of engineFiles) {
    try {
      if (statSync(file.path).mtimeMs > binaryTime) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function planSync(runtime, source, buildRecord, options, context = {}) {
  const hostChanged = runtime.hostSourceHash !== source.host.hash;
  const clientChanged = runtime.client?.sourceHash !== source.client.sourceHash;
  // `runtime.native` is the hash this Host generation loaded from disk. A
  // native-only update can leave that field alone while the helper is already
  // running a different binary. The live probe is therefore part of the plan.
  const running = context.runningHelper;
  const helperMismatch =
    running !== undefined &&
    (!running?.ok || (running.buildId && running.buildId !== source.native.serviceBuildId));
  const nativeChanged =
    runtime.native?.serviceBuildId !== source.native.serviceBuildId ||
    runtime.native?.previewBuildId !== source.native.previewBuildId ||
    helperMismatch;
  const binaryMissing =
    !existsSync(source.native.servicePath) || !existsSync(source.native.previewPath);
  const recordMatches = buildRecord?.engineHash === source.engine.hash;
  const binariesMatchRecord = Boolean(
    buildRecord &&
      buildRecord.serviceBuildId === source.native.serviceBuildId &&
      buildRecord.previewBuildId === source.native.previewBuildId,
  );
  const needsBuild =
    options.forceBuild ||
    binaryMissing ||
    (buildRecord
      ? !recordMatches || !binariesMatchRecord
      : sourcesNewerThanBinary(listEngineSourceFiles(REPO_ROOT), source.native.servicePath));
  return {
    hostChanged,
    clientChanged,
    nativeChanged,
    needsBuild,
    buildReason: options.forceBuild
      ? "forced"
      : binaryMissing
        ? "binary_missing"
        : buildRecord
          ? !recordMatches
            ? "engine_changed"
            : !binariesMatchRecord
              ? "binary_record_mismatch"
              : "engine_unchanged"
          : needsBuild
            ? "sources_newer_than_binary"
            : "initial_record",
    anyChange: hostChanged || clientChanged || nativeChanged || needsBuild,
  };
}

async function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300000;
  return await new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: { ...process.env, ...options.env },
        detached: true,
      });
    } catch (error) {
      rejectRun(failure(`could not run ${command}`, { error: String(error?.message ?? error) }));
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // detached:true makes the child a process-group leader, so this also
        // stops descendants such as `node --test` and swiftc.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(failure(`could not run ${command}`, { error: String(error?.message ?? error) }));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectRun(
          failure(`${command} timed out`, {
            command,
            timeoutMs,
            signal: signal ?? null,
            hint: "The process group was killed; no reload was attempted.",
          }),
        );
        return;
      }
      if (signal) {
        rejectRun(failure(`${command} was terminated by a signal`, { command, signal }));
        return;
      }
      resolveRun(code ?? 1);
    });
  });
}

function verifyUniversalBinary(path) {
  try {
    const output = execFileSync("/usr/bin/lipo", ["-info", path], { encoding: "utf8" });
    if (!output.includes("arm64") || !output.includes("x86_64")) {
      throw failure("helper is not a universal binary", { path, lipo: output.trim().slice(0, 300) });
    }
    return output.trim().replace(/\s+/g, " ").slice(0, 200);
  } catch (error) {
    if (error instanceof SyncResult) throw error;
    // lipo is part of the Xcode command line tools; the build already needed it.
    return "lipo unavailable";
  }
}

async function buildNative(paths, source, options, plan) {
  if (!plan.needsBuild) {
    say("build", `skipped (${plan.buildReason}; engine ${source.engine.hash.slice(0, 12)})`);
    return false;
  }
  say("build", `building universal helper (${plan.buildReason})`);
  const backups = new Map();
  for (const path of [source.native.servicePath, source.native.previewPath]) {
    if (existsSync(path)) backups.set(path, readFileSync(path));
  }
  const status = await runCommand("bash", ["scripts/build-universal.sh"], {
    timeoutMs: Number(process.env.DEV_SYNC_BUILD_TIMEOUT_MS) || 600000,
  });
  if (status !== 0) {
    for (const [path, buffer] of backups) {
      try {
        writeFileSync(path, buffer);
      } catch {
        // The failure is already reported; restore is best effort.
      }
    }
    throw failure("native build failed; previous binaries restored", { status });
  }
  for (const path of [source.native.servicePath, source.native.previewPath]) {
    if (!existsSync(path)) throw failure("native build did not produce a helper", { path });
    verifyUniversalBinary(path);
  }
  const record = {
    schema: 1,
    engineHash: source.engine.hash,
    engineFiles: source.engine.files,
    serviceBuildId: sha256File(source.native.servicePath),
    previewBuildId: sha256File(source.native.previewPath),
    builtAt: new Date().toISOString(),
  };
  writeJsonAtomic(paths.build, record);
  say("build", `ok (cu ${record.serviceBuildId.slice(0, 12)}…, preview ${record.previewBuildId.slice(0, 12)}…)`);
  return true;
}

async function runTests(options) {
  if (options.skipTests) {
    info("TESTS SKIPPED by --skip-tests; this run cannot claim test coverage.");
    return false;
  }
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    say("tests", `running npm test (isolated CU state directory, attempt ${attempt}/${attempts})`);
    const status = await runCommand(process.execPath, ["scripts/test-isolated.mjs"], {
      timeoutMs: Number(process.env.DEV_SYNC_TEST_TIMEOUT_MS) || 300000,
    });
    if (status === 0) {
      say("tests", attempt === 1 ? "passed" : "passed on retry");
      return true;
    }
    if (attempt < attempts) {
      say("tests", `attempt ${attempt} failed; retrying once with a fresh isolated state directory`);
    }
  }
  throw failure("automated tests failed twice; nothing was reloaded", { attempts });
}

function restoreBinaries(backups) {
  for (const [path, buffer] of backups) {
    try {
      // Replace the inode, not just the bytes. macOS associates provenance and
      // code-signing approval with the file; writing over a signed executable in
      // place can leave a stale provenance that Gatekeeper kills on next exec.
      const temporary = `${path}.restore-${process.pid}-${Date.now()}`;
      writeFileSync(temporary, buffer, { mode: 0o755 });
      renameSync(temporary, path);
    } catch {
      // best effort
    }
  }
}

function requestIdFor(attempt) {
  return `${Date.now()}-${attempt}-${randomBytes(4).toString("hex")}`;
}

async function waitForStatus(paths, requestId, deadline, options) {
  let announcedReload = false;
  while (Date.now() < deadline) {
    const status = readJson(paths.status);
    if (status?.requestId === requestId) {
      if (status.state === "reloading" && !announcedReload) {
        say("reload", `host generation is being replaced (${requestId})`);
        announcedReload = true;
      }
      if (status.state === "ready") return status;
      if (status.state === "deferred") return status;
      if (status.state === "needs_client") return status;
      if (status.state === "restart_required" || status.state === "unsupported") return status;
      if (status.state === "failed") return status;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  return null;
}

function helperCommand(pid) {
  return hostProcessCommand(pid);
}

function verifyHelperProcess(pid, expectedPath) {
  if (!pid) return { ok: false, reason: "no_pid" };
  const command = helperCommand(pid);
  const ok = command.includes(expectedPath);
  return { ok, command: command.slice(0, 300) };
}

function countRepoHelpers(expectedPath) {
  try {
    const output = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    const lines = output.split("\n").filter((line) => line.includes(expectedPath) && line.includes(" service"));
    return lines.map((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return { pid: Number(match?.[1]) || null, command: (match?.[2] ?? "").slice(0, 300) };
    });
  } catch {
    return [];
  }
}

function noBuildProcesses() {
  try {
    const output = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    return output
      .split("\n")
      .filter((line) => line.includes(REPO_ROOT) && /(?:^|\s)(?:swiftc|swift-frontend|lipo)(?:\s|$)/.test(line))
      .map((line) => line.trim().slice(0, 300));
  } catch {
    return [];
  }
}

async function verifyLive(runtime, source, status, context) {
  const checks = [];
  const hostPid = Number(runtime?.hostPid);
  if (!pidAlive(hostPid)) throw failure("the new Host generation is not running", { hostPid });
  if (runtime.hostSourceHash !== source.host.hash) {
    throw failure("the live Host code does not match disk", {
      expected: source.host.hash,
      observed: runtime.hostSourceHash,
    });
  }
  checks.push({ name: "host", ok: true, pid: hostPid, loadedAt: runtime.loadedAt, sourceHash: runtime.hostSourceHash });

  const clientReport = readJson(context.paths.client);
  const requireClient = context.requireClient;
  const clientMatches = Boolean(
    clientReport &&
      clientReport.hostPid === hostPid &&
      clientReport.matchesCurrent === true &&
      clientReport.observedAt >= context.requestStartedAt &&
      clientRevMatches(clientReport.rev, runtime.client),
  );
  if (requireClient && !clientMatches) {
    throw blocked("the browser bundle was not observed running the new revision", {
      expectedRev: runtime.client?.entryRev ?? null,
      observedRev: clientReport?.rev ?? null,
      observedAt: clientReport?.observedAt ?? null,
      hint: "Keep the DSH page open so Client HMR can swap the bundle, then rerun dev:sync. Do not claim the client change is live.",
    });
  }
  checks.push({
    name: "client",
    ok: requireClient ? clientMatches : true,
    required: requireClient,
    expectedRev: runtime.client?.entryRev ?? null,
    observedRev: clientReport?.rev ?? null,
    version: clientReport?.version ?? null,
    capabilities: clientReport?.capabilities ?? null,
  });

  const helper = await probeHelper(context.stateDir);
  const nativeOk = Boolean(helper?.ok && helper.buildId === source.native.serviceBuildId);
  if (!nativeOk) {
    throw failure("the native helper build id does not match bin/cu", {
      expectedBuildId: source.native.serviceBuildId,
      observedBuildId: helper?.buildId ?? null,
      helperPid: helper?.pid ?? null,
      required: context.requireNative,
    });
  }
  const processCheck = verifyHelperProcess(helper.pid, source.native.servicePath);
  if (!processCheck.ok) {
    throw failure("the helper is not running the binary from this checkout", {
      pid: helper.pid,
      expectedPath: source.native.servicePath,
      command: processCheck.command,
    });
  }
  const oldPid = context.oldHelperPid;
  const oldPidExited = !oldPid || oldPid === helper.pid ? null : !pidAlive(oldPid);
  if (oldPid && oldPid !== helper.pid && !oldPidExited) {
    throw failure("the previous helper is still alive after the reload", { oldPid, newPid: helper.pid });
  }
  if (context.requireNative && oldPid === helper.pid) {
    throw failure("the helper pid did not change although the native binary changed", {
      pid: helper.pid,
      oldBuildId: context.oldHelperBuildId,
      newBuildId: helper.buildId,
    });
  }
  const helpers = countRepoHelpers(source.native.servicePath);
  if (helpers.length > 1 || (helpers.length === 1 && helpers[0].pid !== helper.pid)) {
    throw failure("more than one helper from this checkout is running", {
      helpers,
      expectedPid: helper.pid,
    });
  }
  const buildProcesses = noBuildProcesses();
  if (buildProcesses.length > 0) {
    throw failure("a build process from this run is still running", { processes: buildProcesses });
  }
  checks.push({
    name: "native",
    ok: true,
    pid: helper.pid,
    buildId: helper.buildId,
    version: helper.version,
    oldPid: oldPid ?? null,
    oldPidExited,
    helpers: helpers.length,
  });
  checks.push({ name: "leftovers", ok: true, helpers: helpers.length, buildProcesses: 0 });

  return {
    checks,
    client: clientReport,
    helper,
    hostPid,
    statusState: status?.state ?? null,
  };
}

async function run(options) {
  jsonMode = options.json;
  const paths = devSyncPaths(resolveStateDir(), REPO_ROOT);
  try {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw failure("cannot create the dev-sync state directory", { path: paths.root, error: String(error?.message ?? error) });
  }

  say("repo", REPO_ROOT);
  const checkout = verifyCheckout();
  say("link", `ok -> ${checkout.target}`);

  const runtime = readJson(paths.runtime);
  const hostPid = verifyRuntime(runtime);
  const initialRequestPath = requestPathFor(runtime, paths);
  if (!initialRequestPath) {
    throw blocked("the running plugin does not publish a generation request path", {
      hint: "Restart DSH once to load the current dev-sync protocol; do not write into a stale request file.",
    });
  }
  say("host", `pid ${hostPid} loaded ${runtime.loadedAt} hash ${runtime.hostSourceHash.slice(0, 12)}…`);

  const source = sourceSnapshot();
  const buildRecord = readJson(paths.build);
  const currentHelper = await probeHelper(resolveStateDir());
  const plan = planSync(runtime, source, buildRecord, options, { runningHelper: currentHelper });
  say(
    "plan",
    [
      `host ${plan.hostChanged ? "changed" : "same"}`,
      `client ${plan.clientChanged ? "changed" : "same"}`,
      `native ${plan.nativeChanged ? "changed" : "same"}`,
      `build ${plan.needsBuild ? plan.buildReason : "skipped"}`,
    ].join(", "),
  );

  if (reloadRequiresHmr(runtime, plan)) {
    throw blocked("this DSH build does not expose the Host HMR APIs needed for a live reload", {
      hmr: runtime.hmr ?? null,
      hint: "No supported automatic reload is available. Restart DSH to load changes and say so; do not invent a success path.",
    });
  }

  if (options.checkOnly) {
    return {
      exitCode: EXIT.ok,
      result: {
        ok: true,
        checkOnly: true,
        repoRoot: REPO_ROOT,
        link: checkout.linkPath,
        runtime,
        requestPath: initialRequestPath,
        source,
        plan,
        testsWouldRun: plan.anyChange && !options.skipTests,
      },
    };
  }

  if (!plan.anyChange) {
    say("update", "no source change; verifying the live generations instead of reloading");
    const status = { state: "ready", checks: {} };
    const verified = await verifyLive(runtime, source, status, {
      paths,
      stateDir: resolveStateDir(),
      requireClient: false,
      requireNative: false,
      oldHelperPid: null,
      oldHelperBuildId: null,
      requestStartedAt: 0,
    });
    say("client", `rev ${verified.client?.rev ?? "?"} observed, entry ${runtime.client?.entryRev ?? "?"}`);
    say("native", `pid ${verified.helper.pid} build ${verified.helper.buildId.slice(0, 12)}…`);
    say("leftover", "no helper/build process from this run remains");
    say("OK", `DSH is running this checkout (host ${runtime.hostSourceHash.slice(0, 12)}…, client ${runtime.client?.entryRev ?? "n/a"}, native ${verified.helper.buildId.slice(0, 12)}…)`);
    return {
      exitCode: EXIT.ok,
      result: {
        ok: true,
        updated: false,
        repoRoot: REPO_ROOT,
        host: runtime,
        source,
        ...verified,
      },
    };
  }

  let built = false;
  let tested = false;
  let backups = null;
  if (plan.needsBuild) {
    backups = new Map();
    for (const path of [source.native.servicePath, source.native.previewPath]) {
      if (existsSync(path)) backups.set(path, readFileSync(path));
    }
    try {
      built = await buildNative(paths, source, options, plan);
    } catch (error) {
      restoreBinaries(backups);
      throw error;
    }
    // Re-read hashes after the build; the binary identity changed.
    source.native.serviceBuildId = sha256File(source.native.servicePath);
    source.native.previewBuildId = sha256File(source.native.previewPath);
    try {
      tested = await runTests(options);
    } catch (error) {
      // Do not leave a freshly built binary in place when the suite rejects the
      // change. The reload never runs in this branch.
      restoreBinaries(backups);
      throw error;
    }
  } else {
    say("build", `skipped (${plan.buildReason}; engine ${source.engine.hash.slice(0, 12)})`);
    if (!buildRecord) {
      // Seed the record only when the binaries are newer than every source; the
      // next ordinary JS-only change then skips this decision entirely.
      writeJsonAtomic(paths.build, {
        schema: 1,
        engineHash: source.engine.hash,
        engineFiles: source.engine.files,
        serviceBuildId: source.native.serviceBuildId,
        previewBuildId: source.native.previewBuildId,
        builtAt: new Date().toISOString(),
      });
    }
    try {
      tested = await runTests(options);
    } catch (error) {
      throw error;
    }
  }

  try {
    // A source edit during the tests/build is not what we are about to reload.
    const after = sourceSnapshot();
    if (
      after.host.hash !== source.host.hash ||
      after.client.sourceHash !== source.client.sourceHash ||
      after.native.serviceBuildId !== source.native.serviceBuildId ||
      after.native.previewBuildId !== source.native.previewBuildId
    ) {
      throw failure("sources changed while dev:sync was running; rerun after the edit settles", {
        before: { host: source.host.hash, client: source.client.sourceHash },
        after: { host: after.host.hash, client: after.client.sourceHash },
      });
    }

    const oldHelper = await probeHelper(resolveStateDir());
    const requireNative = nativeReplacementRequired(oldHelper, source.native.serviceBuildId);
    const requireClient = plan.clientChanged;
    const requestStartedAt = Date.now();
    const expected = {
      hostSourceHash: source.host.hash,
      clientSourceHash: source.client.sourceHash,
      clientVersion: source.client.version,
      native: {
        serviceBuildId: source.native.serviceBuildId,
        previewBuildId: source.native.previewBuildId,
      },
      requireClient,
      requireNative,
    };
    const previous = {
      hostSourceHash: runtime.hostSourceHash,
      clientSourceHash: runtime.client?.sourceHash ?? null,
      helperPid: oldHelper?.pid ?? null,
      helperBuildId: oldHelper?.buildId ?? null,
    };

    const overallDeadline = Date.now() + options.timeoutMs;
    const idleDeadline = Date.now() + options.waitIdleMs;
    let status = null;
    let attempt = 0;
    let lastDeferred = null;
    while (Date.now() < overallDeadline) {
      attempt += 1;
      const requestId = requestIdFor(attempt);
      const request = {
        schema: DEV_SYNC_SCHEMA,
        protocol: DEV_SYNC_PROTOCOL,
        requestId,
        repoRoot: REPO_ROOT,
        targetHostPid: hostPid,
        requestedAt: new Date().toISOString(),
        requestedByPid: process.pid,
        timeoutMs: Math.min(25000, options.timeoutMs),
        expected,
        previous,
      };
      // A reload can advance the generation between attempts. Write to the
      // path that generation published; never keep poking a stale watch.
      const latestRuntime = readJson(paths.runtime);
      const attemptRequestPath = requestPathFor(latestRuntime, paths) ?? initialRequestPath;
      try {
        writeJsonAtomic(attemptRequestPath, request);
      } catch (error) {
        throw failure("could not write the reload request", { path: attemptRequestPath, error: String(error?.message ?? error) });
      }
      say("reload", `requested ${requestId}`);
      status = await waitForStatus(paths, requestId, overallDeadline, options);
      if (!status) {
        throw blocked("timed out waiting for the new generation", {
          waitedMs: options.timeoutMs,
          lastStatus: readJson(paths.status),
          hint: "The plugin may have failed to reload. A DSH restart may be required; do not claim success.",
        });
      }
      if (status.state === "ready") break;
      if (status.state === "deferred") {
        lastDeferred = status;
        const canWait = Date.now() < idleDeadline;
        if (!canWait) {
          throw blocked("CU is busy; the update was deliberately not forced", {
            reason: status.reason ?? "busy",
            detail: status.detail ?? null,
            waitedMs: options.waitIdleMs,
            activeSession: runtime.activeSession ?? null,
            hint: "Finish or stop the CU session, then rerun dev:sync. This command does not kill a running operation.",
          });
        }
        say("reload", `deferred (${status.reason ?? "busy"}); waiting for idle`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
        continue;
      }
      if (status.state === "needs_client") {
        throw blocked("the host reloaded but the browser bundle was not observed", {
          expectedRev: status.client?.entryRev ?? null,
          observed: status.client?.observed ?? null,
          hint: "Keep the DSH page open; Client HMR will swap the bundle. Rerun once it is connected.",
        });
      }
      if (status.state === "restart_required" || status.state === "unsupported") {
        throw blocked("DSH requires a restart or lacks the supported reload path", {
          reason: status.reason ?? null,
          detail: status.detail ?? null,
          restartReason: status.reason ?? null,
          hint: "Do not force a restart while work is active. Report that a restart is required.",
        });
      }
      if (status.state === "failed") {
        throw failure("the reload reported a failure", {
          reason: status.reason ?? null,
          detail: status.detail ?? null,
          expected: status.expected ?? null,
          observed: status.observed ?? null,
        });
      }
      break;
    }

    if (!status || status.state !== "ready") {
      throw blocked("the reload did not reach a verified state", {
        lastDeferred,
        status: status ?? null,
        hint: "No success is claimed without a ready status.",
      });
    }

    // Re-read the report written by the new generation; status is a claim, the
    // runtime file is the identity the live plugin itself wrote.
    const live = readJson(paths.runtime);
    if (!live || live.hostPid !== hostPid) {
      throw failure("the live runtime report is missing or belongs to another Host", {
        expectedHostPid: hostPid,
        observedHostPid: live?.hostPid ?? null,
      });
    }
    const verified = await verifyLive(live, source, status, {
      paths,
      stateDir: resolveStateDir(),
      requireClient,
      requireNative,
      oldHelperPid: oldHelper?.pid ?? null,
      oldHelperBuildId: oldHelper?.buildId ?? null,
      requestStartedAt,
    });
    say("client", requireClient
      ? `rev ${verified.client?.rev ?? "?"} observed, entry ${live.client?.entryRev ?? "?"}`
      : `unchanged; observed ${verified.client?.rev ?? "not required"}`);
    say("native", `pid ${verified.helper.pid} build ${verified.helper.buildId.slice(0, 12)}…; old pid ${oldHelper?.pid ?? "none"} ${verified.checks.find((c) => c.name === "native")?.oldPidExited === true ? "exited" : "n/a"}`);
    say("leftover", "no helper/build process from this run remains");
    say("OK", `DSH is running this checkout (host ${live.hostSourceHash.slice(0, 12)}…, client ${live.client?.entryRev ?? "n/a"}, native ${verified.helper.buildId.slice(0, 12)}…)`);

    return {
      exitCode: EXIT.ok,
      result: {
        ok: true,
        updated: true,
        repoRoot: REPO_ROOT,
        tested,
        built,
        host: live,
        source,
        status,
        ...verified,
      },
    };
  } catch (error) {
    // A post-reload verification failure is reported as failed, but the new
    // binary stays on disk: the running helper may already be using it, and
    // silently reverting would make the next check lie. Only build/test
    // failures above restore the previous binaries.
    throw error;
  }
}

function printResult(outcome) {
  if (jsonMode) {
    console.log(JSON.stringify(outcome.result ?? { ok: false }, null, 2));
    return;
  }
  if (outcome.result?.checkOnly) {
    say("check", "link and runtime are usable; no tests, build, or reload performed");
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    jsonMode = options.json;
    if (options.help) {
      usage();
      return EXIT.ok;
    }
  } catch (error) {
    if (error instanceof SyncResult) {
      console.error(`[dev:sync] ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }

  const paths = devSyncPaths(resolveStateDir(), REPO_ROOT);
  let lock = null;
  try {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    lock = acquireLock(paths.lock);
    const outcome = await run(options);
    printResult(outcome);
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof SyncResult) {
      if (jsonMode) {
        console.log(JSON.stringify({ ok: false, exitCode: error.exitCode, error: error.message, detail: error.detail }, null, 2));
      } else {
        const prefix = error.exitCode === EXIT.blocked ? "BLOCKED" : "FAILED";
        console.error(`[dev:sync] ${prefix}: ${error.message}`);
        for (const line of error.lines ?? []) console.error(`[dev:sync]   ${line}`);
        if (error.detail && Object.keys(error.detail).length > 0) {
          console.error(`[dev:sync]   ${JSON.stringify(error.detail)}`);
        }
      }
      return error.exitCode;
    }
    console.error(`[dev:sync] FAILED: ${error?.stack ?? error}`);
    return EXIT.failure;
  } finally {
    releaseLock(lock);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  });
}

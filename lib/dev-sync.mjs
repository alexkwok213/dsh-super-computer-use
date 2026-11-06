// Development update protocol for a linked DSH plugin.
//
// A checkout is linked into the desktop profile, so the bytes on disk are
// already the bytes DSH resolves. What is missing after an edit is the running
// generation: Host modules, the browser bundle, and the native helper. This
// module lets a local command ask the *running* plugin to replace those
// generations through the Host's own HMR service, then proves what is live.
//
// It deliberately opens no port and starts no second service. The trigger is a
// request file watched through `ctx.hmr.watchConfig`; the replacement itself is
// `ctx.hmr.reconcileProfile`, the same API the profile watcher and Plugin
// Manager use. If this DSH build does not expose those APIs, the command is told
// so instead of pretending a reload happened.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEV_SYNC_SCHEMA = 1;
export const DEV_SYNC_PROTOCOL = 1;
export const DEV_SYNC_CAPABILITIES = Object.freeze([
  "host-reconcile",
  "client-hello",
  "native-probe",
  "file-poll",
  "status-fence",
  "runtime-republish",
  "native-recycle",
]);
export const CLIENT_HELLO_PATH = "/api/scu/client-hello";

const DEV_SYNC_DIR = "dev-sync";

/** SHA-256 of a Buffer or string. */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** SHA-256 of a file, or null when it cannot be read. */
export function sha256File(path) {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/** Read a JSON file, returning null for any read/parse failure. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Atomically replace a JSON file. The temporary file never survives a throw. */
export function writeJsonAtomic(path, value, { mode = 0o600 } = {}) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    renameSync(temporary, path);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // best effort
    }
    throw error;
  }
}

/** Whether a process id is still alive (EPERM still means alive). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** State directory shared with the native helper and the plugin manager. */
export function resolveStateDir(env = process.env) {
  return env.CU_STATE_DIR || join(homedir(), ".cu");
}

/** Stable short key for one checkout, so two checkouts never share a request. */
export function repoKey(repoRoot) {
  return sha256(resolve(repoRoot)).slice(0, 12);
}

/** Files that define the Host half: the manifest plus every lib/*.mjs file. */
export function listHostSourceFiles(repoRoot) {
  const files = [{ name: "package.json", path: join(repoRoot, "package.json") }];
  const libDir = join(repoRoot, "lib");
  let names = [];
  try {
    names = readdirSync(libDir)
      .filter((name) => name.endsWith(".mjs"))
      .sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    files.push({ name: `lib/${name}`, path: join(libDir, name) });
  }
  return files;
}

/**
 * Host identity. Covers package.json and every lib/*.mjs file, not just the two
 * files an older build hashed. A changed manifest (exports, dsh.client, version)
 * is therefore part of the same fingerprint.
 */
export function hashHostSources(repoRoot) {
  const hash = createHash("sha256");
  const files = listHostSourceFiles(repoRoot);
  for (const file of files) {
    const buffer = readFileSync(file.path);
    hash.update(`${file.name}\0${buffer.length}\0`);
    hash.update(buffer);
  }
  return { hash: hash.digest("hex"), files: files.map((file) => file.name) };
}

/** Every Swift source plus the exact build recipe used for bin/cu. */
export function listEngineSourceFiles(repoRoot) {
  const files = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "build" || entry.name === "bin") continue;
        walk(full, name);
      } else if (entry.name.endsWith(".swift")) {
        files.push({ name, path: full });
      }
    }
  };
  walk(join(repoRoot, "engine", "Sources"), "engine/Sources");
  const buildScript = join(repoRoot, "scripts", "build-universal.sh");
  if (existsSync(buildScript)) files.push({ name: "scripts/build-universal.sh", path: buildScript });
  return files;
}

/** Build identity of the native sources. Used only to decide whether to rebuild. */
export function hashEngineSources(repoRoot) {
  const hash = createHash("sha256");
  const files = listEngineSourceFiles(repoRoot);
  for (const file of files) {
    const buffer = readFileSync(file.path);
    hash.update(`${file.name}\0${buffer.length}\0`);
    hash.update(buffer);
  }
  return { hash: hash.digest("hex"), files: files.map((file) => file.name) };
}

/** The `rev` in a DSH bundle URL (`...client.js&rev=abc` or `...?rev=abc`). */
export function parseClientRev(url) {
  const match = /[?&]rev=([^&#]+)/.exec(String(url ?? ""));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** The CLIENT_VERSION constant embedded in client.js. */
export function parseClientVersion(source) {
  const match = /const\s+CLIENT_VERSION\s*=\s*["']([^"']+)["']/.exec(String(source ?? ""));
  return match ? match[1] : null;
}

/** Absolute paths for one checkout's control files. */
export function devSyncPaths(stateDir, repoRoot) {
  const root = join(stateDir, DEV_SYNC_DIR, repoKey(repoRoot));
  return {
    root,
    request: join(root, "request.json"),
    status: join(root, "status.json"),
    runtime: join(root, "runtime.json"),
    client: join(root, "client.json"),
    build: join(root, "build.json"),
    lock: join(root, "cli.lock"),
  };
}

/** Read the current helper status without exposing its token. */
export async function probeHelper(stateDir, { timeoutMs = 900 } = {}) {
  const config = readJson(join(stateDir, "config.json"));
  const port = Number(config?.port);
  if (!Number.isInteger(port) || port <= 0) return null;
  const headers = {};
  if (typeof config?.token === "string" && config.token) {
    headers.authorization = `Bearer ${config.token}`;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const status = await response.json();
    if (!status || status.ok !== true) return null;
    return {
      ok: true,
      pid: Number(status.pid) || null,
      buildId: typeof status.buildId === "string" ? status.buildId : null,
      version: typeof status.version === "string" ? status.version : null,
      port,
    };
  } catch {
    return null;
  }
}

/**
 * Identity of the generation that is *running*, computed at module evaluation.
 * Every field is local metadata; no credential is read.
 */
export function createRuntimeIdentity({ repoRoot, entryPath, packageMeta }) {
  const root = resolve(repoRoot);
  const meta = packageMeta ?? readJson(join(root, "package.json")) ?? {};
  const host = hashHostSources(root);
  const clientPath = join(root, "client.js");
  const clientSource = (() => {
    try {
      return readFileSync(clientPath, "utf8");
    } catch {
      return "";
    }
  })();
  const servicePath = join(root, "bin", "cu");
  const previewPath = join(root, "bin", "cu-preview");
  const serviceBuildId = sha256File(servicePath);
  const previewBuildId = sha256File(previewPath);
  return {
    schema: DEV_SYNC_SCHEMA,
    protocol: DEV_SYNC_PROTOCOL,
    packageName: meta.name ?? "dsh-super-computer-use",
    version: meta.version ?? null,
    entryPath,
    repoRoot: root,
    hostPid: process.pid,
    loadedAt: new Date().toISOString(),
    sourceHash: host.hash,
    hostSourceHash: host.hash,
    hostSourceFiles: host.files,
    client: {
      version: parseClientVersion(clientSource),
      sourceHash: sha256(clientSource),
      entryRev: null,
      entryUrl: null,
      batchRevs: [],
      refreshedAt: null,
    },
    native: {
      servicePath,
      serviceBuildId,
      previewPath,
      previewBuildId,
    },
    devSync: {
      protocol: DEV_SYNC_PROTOCOL,
      capabilities: [...DEV_SYNC_CAPABILITIES],
    },
  };
}

/**
 * Refresh the browser bundle identity from the live client module graph.
 * `rebuilt()` is the Host's own operation: it stats the artifact, advances the
 * revision when the file changed, and notifies the Client HMR transport.
 */
export function refreshClientIdentity(runtime, ctx) {
  const modules = ctx?.get?.("clientModules");
  if (modules?.rebuilt) {
    try {
      modules.rebuilt(runtime.packageName);
    } catch {
      // A missing bundle is reported below as an absent rev, not a crash.
    }
  }
  let entry = null;
  let batchRevs = [];
  try {
    const graph = modules?.graph?.();
    entry = graph?.entries?.find((row) => row.id === runtime.packageName) ?? null;
    batchRevs = (graph?.batches ?? [])
      .filter((batch) => Array.isArray(batch.entries) && batch.entries.includes(runtime.packageName))
      .map((batch) => batch.rev)
      .filter(Boolean);
  } catch {
    // Keep the previous identity when the graph cannot be read.
  }
  const clientPath = join(runtime.repoRoot, "client.js");
  let source = "";
  try {
    source = readFileSync(clientPath, "utf8");
  } catch {
    source = "";
  }
  runtime.client = {
    ...runtime.client,
    version: parseClientVersion(source),
    sourceHash: sha256(source),
    entryRev: entry?.rev ?? null,
    entryUrl: entry?.url ?? null,
    batchRevs,
    refreshedAt: new Date().toISOString(),
  };
  return runtime.client;
}

/** Whether a browser-reported revision is the current artifact for this plugin. */
export function clientRevMatches(rev, client) {
  if (typeof rev !== "string" || rev.length === 0) return false;
  if (client?.entryRev === rev) return true;
  return Array.isArray(client?.batchRevs) && client.batchRevs.includes(rev);
}

function sanitizedRuntime(runtime, phase, extra = {}) {
  return {
    schema: runtime.schema,
    protocol: runtime.protocol,
    phase,
    packageName: runtime.packageName,
    version: runtime.version,
    entryPath: runtime.entryPath,
    repoRoot: runtime.repoRoot,
    hostPid: runtime.hostPid,
    loadedAt: runtime.loadedAt,
    sourceHash: runtime.hostSourceHash,
    hostSourceHash: runtime.hostSourceHash,
    hostSourceFiles: runtime.hostSourceFiles,
    client: runtime.client,
    native: runtime.native,
    devSync: runtime.devSync,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

/** A matching live executable may be reused even if the Host loaded older disk metadata. */
export function nativeReplacementRequired(helper, expectedBuildId) {
  return !helper?.ok || !expectedBuildId || helper.buildId !== expectedBuildId;
}

/**
 * Install the request watcher and write the generation report.
 *
 * @param {object} ctx Host Cordis context.
 * @param {object} deps
 * @param {object} deps.runtime Identity from `createRuntimeIdentity`.
 * @param {any} deps.manager CuSessionManager instance.
 * @param {string} deps.stateDir Shared CU state directory.
 * @param {() => {busy: boolean, reason?: string, detail?: object}} deps.activity
 * @param {(line: string) => void} [deps.log]
 */
export async function installDevSync(ctx, deps) {
  const { runtime, manager, stateDir, activity = () => ({ busy: false }), log = () => {} } = deps;
  const paths = devSyncPaths(stateDir, runtime.repoRoot);
  try {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  } catch {
    // The caller still gets a handle; status writes below report the failure.
  }
  // One request path per generation. A disposed generation's watchConfig
  // disposer can briefly outlive the reload that replaced it; a fresh path
  // prevents that transient registration from blocking the new generation.
  // The path is published in the runtime report, and the CLI reads it there.
  const requestPath = join(
    paths.root,
    `request-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.json`,
  );
  runtime.devSync = { ...runtime.devSync, requestPath };

  const hmr = ctx?.get?.("hmr");
  const hmrAvailable = Boolean(
    hmr &&
      typeof hmr.runExclusive === "function" &&
      typeof hmr.reconcileProfile === "function",
  );
  const hmrInfo = {
    available: hmrAvailable,
    runExclusive: typeof hmr?.runExclusive === "function",
    watchConfig: typeof hmr?.watchConfig === "function",
    reconcileProfile: typeof hmr?.reconcileProfile === "function",
  };

  let latestHello = null;
  let disposeWatch = null;
  let handling = false;
  let disposed = false;

  const writeRuntime = (phase, extra = {}) => {
    try {
      writeJsonAtomic(paths.runtime, sanitizedRuntime(runtime, phase, extra));
    } catch (error) {
      log(`dev-sync runtime report failed: ${error?.message ?? error}`);
    }
  };

  const writeStatus = (status) => {
    try {
      // A generation that has already been replaced can still resume after its
      // reconcile promise resolves. Never let it overwrite the status written
      // by the newer generation that actually owns the request.
      const existing = readJson(paths.status);
      if (
        existing?.requestId === status.requestId &&
        existing.loadedAt &&
        existing.loadedAt !== runtime.loadedAt &&
        Date.parse(existing.loadedAt) > Date.parse(runtime.loadedAt)
      ) {
        return;
      }
      writeJsonAtomic(paths.status, {
        schema: DEV_SYNC_SCHEMA,
        protocol: DEV_SYNC_PROTOCOL,
        hostPid: runtime.hostPid,
        loadedAt: runtime.loadedAt,
        hostSourceHash: runtime.hostSourceHash,
        ...status,
        at: new Date().toISOString(),
      });
    } catch (error) {
      log(`dev-sync status report failed: ${error?.message ?? error}`);
    }
  };

  const busy = () => {
    try {
      const result = activity();
      if (result && typeof result === "object") return result;
      return result ? { busy: true, reason: "busy" } : { busy: false };
    } catch (error) {
      return { busy: true, reason: "activity_probe_failed", detail: { message: String(error?.message ?? error) } };
    }
  };

  const verifyNative = async (request, deadline) => {
    const required = request?.expected?.requireNative === true;
    const oldPid = Number(request?.previous?.helperPid) || null;
    const expectedBuildId = request?.expected?.native?.serviceBuildId ?? runtime.native.serviceBuildId;
    const replacementWasNeeded = required && nativeReplacementRequired({
      ok: Boolean(oldPid), buildId: request?.previous?.helperBuildId,
    }, expectedBuildId);
    let helper = await probeHelper(stateDir);
    // A native-only change does not replace the Host module, so the plugin is
    // not restarted and its existing helper would keep serving the old binary.
    // Recycle a helper this manager owns, then start the current bin/cu. Never
    // kill a helper the plugin does not manage.
    if (
      required &&
      helper?.ok &&
      expectedBuildId &&
      helper.buildId !== expectedBuildId
    ) {
      const managed = manager?.managedServiceProcess;
      if (managed && Number(managed.pid) === helper.pid) {
        log(`dev-sync recycling native helper ${helper.pid}`);
        try {
          manager.stopManagedService();
        } catch {
          // The probe below reports whether it actually went away.
        }
        const stopBy = Date.now() + 5000;
        while (pidAlive(helper.pid) && Date.now() < stopBy && !disposed) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        try {
          await manager?.ensureServiceRunning?.();
        } catch {
          // The next probe reports the outcome.
        }
        helper = null;
      } else {
        return {
          ok: false,
          required,
          helper: {
            ok: true,
            pid: helper.pid,
            buildId: helper.buildId,
            version: helper.version,
            port: helper.port,
          },
          expectedBuildId,
          buildIdMatches: false,
          oldPid,
          oldPidExited: false,
          reason: "helper_not_managed_by_plugin",
        };
      }
    }
    const waitUntil = Math.min(deadline, Date.now() + 15000);
    while (
      (!helper?.ok || (required && expectedBuildId && helper.buildId !== expectedBuildId)) &&
      Date.now() < waitUntil &&
      !disposed
    ) {
      try {
        await manager?.ensureServiceRunning?.();
      } catch {
        // The next probe reports whether it became reachable.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      helper = await probeHelper(stateDir);
    }
    const buildIdMatches = Boolean(helper?.buildId && expectedBuildId && helper.buildId === expectedBuildId);
    let oldPidExited = true;
    if (oldPid && oldPid !== helper?.pid) {
      const stopBy = Date.now() + 5000;
      while (pidAlive(oldPid) && Date.now() < stopBy && !disposed) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      oldPidExited = !pidAlive(oldPid);
    } else if (oldPid && oldPid === helper?.pid) {
      oldPidExited = replacementWasNeeded ? false : null;
    }
    const ok = Boolean(helper?.ok && buildIdMatches && oldPidExited !== false);
    if (helper?.ok) {
      // `native.serviceBuildId` is the hash this generation loaded from disk;
      // these fields describe what the live helper is actually running, which
      // can advance without a Host reload when only the native binary changed.
      runtime.native = {
        ...runtime.native,
        runningServiceBuildId: helper.buildId,
        runningPid: helper.pid,
        runningAt: new Date().toISOString(),
      };
      writeRuntime("ready", { hmr: hmrInfo });
    }
    return {
      ok,
      required,
      helper: helper
        ? { ok: true, pid: helper.pid, buildId: helper.buildId, version: helper.version, port: helper.port }
        : null,
      expectedBuildId,
      buildIdMatches,
      oldPid,
      oldPidExited,
    };
  };

  const settle = async (request, { afterReload = false } = {}) => {
    const currentStatus = readJson(paths.status);
    const startedAt =
      currentStatus?.requestId === request?.requestId && Number(currentStatus.startedAt)
        ? Number(currentStatus.startedAt)
        : Date.now();
    const deadline = Date.now() + Math.min(Number(request?.timeoutMs) || 25000, 30000);
    refreshClientIdentity(runtime, ctx);
    // Publish the refreshed Client identity. The apply-time report can predate a
    // client-only update; the verifier must not compare the browser against a
    // stale entry revision.
    writeRuntime("ready", { hmr: hmrInfo });

    if (request?.expected?.hostSourceHash && runtime.hostSourceHash !== request.expected.hostSourceHash) {
      writeStatus({
        requestId: request?.requestId,
        state: "failed",
        phase: afterReload ? "after_reload" : "same_generation",
        reason: "host_source_hash_mismatch",
        expected: request.expected.hostSourceHash,
        observed: runtime.hostSourceHash,
      });
      return;
    }
    if (request?.expected?.clientSourceHash && runtime.client.sourceHash !== request.expected.clientSourceHash) {
      writeStatus({
        requestId: request?.requestId,
        state: "failed",
        phase: afterReload ? "after_reload" : "same_generation",
        reason: "client_source_hash_mismatch",
        expected: request.expected.clientSourceHash,
        observed: runtime.client.sourceHash,
      });
      return;
    }

    const requireClient = request?.expected?.requireClient === true;
    let clientOk = !requireClient;
    if (requireClient) {
      while (Date.now() < deadline && !disposed) {
        if (
          latestHello &&
          latestHello.observedAt >= startedAt &&
          clientRevMatches(latestHello.rev, runtime.client)
        ) {
          clientOk = true;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }

    const native = await verifyNative(request, deadline);
    const checks = {
      host: true,
      client: clientOk,
      clientRequired: requireClient,
      native: native.ok,
      nativeRequired: native.required,
    };
    const ready =
      checks.host &&
      (!checks.clientRequired || checks.client) &&
      (!checks.nativeRequired || checks.native);

    if (ready) {
      writeStatus({
        requestId: request?.requestId,
        state: "ready",
        phase: afterReload ? "after_reload" : "same_generation",
        startedAt,
        checks,
        client: {
          required: requireClient,
          ...runtime.client,
          observed: latestHello
            ? {
                rev: latestHello.rev,
                version: latestHello.version,
                capabilities: latestHello.capabilities,
                observedAt: latestHello.observedAt,
                matchesCurrent: latestHello.observedAt >= startedAt && clientRevMatches(latestHello.rev, runtime.client),
              }
            : null,
        },
        native,
      });
      log(`dev-sync ready host=${runtime.hostSourceHash.slice(0, 12)} client=${runtime.client.entryRev ?? "none"} native=${native.helper?.buildId?.slice(0, 12) ?? "none"}`);
      return;
    }

    writeStatus({
      requestId: request?.requestId,
      state: checks.clientRequired && !checks.client ? "needs_client" : "failed",
      phase: afterReload ? "after_reload" : "same_generation",
      startedAt,
      checks,
      reason:
        checks.clientRequired && !checks.client
          ? "client_not_observed"
          : "native_verification_failed",
      client: {
        required: requireClient,
        ...runtime.client,
        observed: latestHello
          ? {
              rev: latestHello.rev,
              version: latestHello.version,
              capabilities: latestHello.capabilities,
              observedAt: latestHello.observedAt,
              matchesCurrent: clientRevMatches(latestHello.rev, runtime.client),
            }
          : null,
      },
      native,
    });
  };

  // The file poller can run with HMR's AsyncLocalStorage transaction marker
  // still inherited from the reload that started this generation. `exit` clears
  // that marker so runExclusive can queue a fresh, top-level reconcile instead
  // of rejecting it as nested.
  const reconcileFromNormalTurn = async () => {
    const run = () => hmr.runExclusive(() => hmr.reconcileProfile([runtime.packageName]));
    if (hmr.executing && typeof hmr.executing.exit === "function") {
      return hmr.executing.exit(run);
    }
    if (typeof hmr.executing?.getStore === "function" && hmr.executing.getStore() === true) {
      return hmr.reconcileProfile([runtime.packageName]);
    }
    return run();
  };

  const handleRequest = async () => {
    if (disposed || handling) return;
    const request = readJson(requestPath);
    if (!request || request.schema !== DEV_SYNC_SCHEMA || typeof request.requestId !== "string") return;
    if (request.repoRoot && resolve(request.repoRoot) !== runtime.repoRoot) return;
    if (request.targetHostPid && Number(request.targetHostPid) !== runtime.hostPid) return;

    const previous = readJson(paths.status);
    if (
      previous?.requestId === request.requestId &&
      previous.state !== "deferred" &&
      previous.state !== undefined
    ) {
      // Already received, reloading, or settled. A duplicate file event must
      // not run a second reconcile; a new CLI attempt uses a new request id.
      return;
    }

    handling = true;
    try {
      log(`dev-sync request received ${request.requestId}`);
    const busyState = busy();
      if (busyState.busy) {
        writeStatus({
          requestId: request.requestId,
          state: "deferred",
          reason: busyState.reason ?? "busy",
          detail: busyState.detail ?? null,
        });
        log(`dev-sync deferred: ${busyState.reason ?? "busy"}`);
        return;
      }

      let diskHost = null;
      try {
        diskHost = hashHostSources(runtime.repoRoot).hash;
      } catch (error) {
        writeStatus({
          requestId: request.requestId,
          state: "failed",
          reason: "host_hash_unreadable",
          detail: String(error?.message ?? error),
        });
        return;
      }
      if (request.expected?.hostSourceHash && diskHost !== request.expected.hostSourceHash) {
        writeStatus({
          requestId: request.requestId,
          state: "failed",
          reason: "source_changed_during_sync",
          expected: request.expected.hostSourceHash,
          observed: diskHost,
        });
        return;
      }

      writeStatus({
        requestId: request.requestId,
        state: "reloading",
        startedAt: Date.now(),
        expected: request.expected,
        request,
      });
      log(`dev-sync reload requested ${request.requestId}`);

      let result;
      try {
        result = await reconcileFromNormalTurn();
      } catch (error) {
        writeStatus({
          requestId: request.requestId,
          state: "failed",
          reason: "reconcile_failed",
          detail: String(error?.message ?? error).slice(0, 500),
        });
        return;
      }

      if (result?.restartReason) {
        writeStatus({
          requestId: request.requestId,
          state: "restart_required",
          reason: result.restartReason,
          pending: Array.isArray(result.pending) ? result.pending : [],
          warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 10) : [],
        });
        return;
      }

      // A Host change stops this generation. Its reconcile promise can still
      // resolve after the replacement started; in that case the new runtime
      // report proves the expected generation is live, and the new generation
      // owns verification. Only report "not replaced" when no such report exists.
      if (request.expected?.hostSourceHash && runtime.hostSourceHash !== request.expected.hostSourceHash) {
        const replacement = readJson(paths.runtime);
        if (
          replacement &&
          replacement.loadedAt !== runtime.loadedAt &&
          replacement.hostSourceHash === request.expected.hostSourceHash
        ) {
          return;
        }
        writeStatus({
          requestId: request.requestId,
          state: "restart_required",
          reason: "host_module_not_replaced",
          expected: request.expected.hostSourceHash,
          observed: runtime.hostSourceHash,
          pending: Array.isArray(result?.pending) ? result.pending : [],
        });
        return;
      }

      await settle(request, { afterReload: false });
    } catch (error) {
      writeStatus({
        requestId: request.requestId,
        state: "failed",
        reason: "dev_sync_internal_error",
        detail: String(error?.message ?? error).slice(0, 500),
      });
      log(`dev-sync request failed: ${error?.message ?? error}`);
    } finally {
      handling = false;
    }
  };

  const noteClientHello = (hello) => {
    if (!hello || typeof hello !== "object") return;
    const rev = typeof hello.clientRev === "string" ? hello.clientRev.slice(0, 200) : "";
    if (!rev) return;
    // The announcement can arrive between a client-only artifact change and the
    // request that refreshes the graph. Refresh before comparing so the recorded
    // expected rev is the one the browser just executed.
    refreshClientIdentity(runtime, ctx);
    const capabilities = Array.isArray(hello.capabilities)
      ? hello.capabilities.filter((item) => typeof item === "string").slice(0, 20)
      : [];
    latestHello = {
      rev,
      version: typeof hello.clientVersion === "string" ? hello.clientVersion.slice(0, 80) : null,
      capabilities,
      scriptUrl: typeof hello.scriptUrl === "string" ? hello.scriptUrl.slice(0, 500) : null,
      observedAt: Date.now(),
    };
    const report = {
      schema: DEV_SYNC_SCHEMA,
      protocol: DEV_SYNC_PROTOCOL,
      hostPid: runtime.hostPid,
      loadedAt: runtime.loadedAt,
      hostSourceHash: runtime.hostSourceHash,
      observedAt: latestHello.observedAt,
      rev: latestHello.rev,
      version: latestHello.version,
      capabilities: latestHello.capabilities,
      scriptUrl: latestHello.scriptUrl,
      expected: {
        entryRev: runtime.client.entryRev,
        batchRevs: runtime.client.batchRevs,
        sourceHash: runtime.client.sourceHash,
        version: runtime.client.version,
      },
      matchesCurrent: clientRevMatches(latestHello.rev, runtime.client),
      versionMatches: latestHello.version === runtime.client.version,
    };
    try {
      writeJsonAtomic(paths.client, report);
    } catch (error) {
      log(`dev-sync client report failed: ${error?.message ?? error}`);
    }
    if (report.matchesCurrent) {
      log(`dev-sync client hello matches ${latestHello.rev}`);
    }
  };

  refreshClientIdentity(runtime, ctx);
  writeRuntime("ready", { hmr: hmrInfo });

  if (hmrAvailable) {
    // A plain file watch, deliberately not `hmr.watchConfig`: that callback runs
    // inside HMR's transaction, and a self-reload started there either nests the
    // transaction or deadlocks the disposer that must remove the watch. The
    // reload itself still uses the supported `runExclusive` + `reconcileProfile`
    // pair, just from a normal asynchronous turn. `watchFile` follows the path
    // across the CLI's atomic rename.
    let scheduled = null;
    const schedule = () => {
      if (disposed) return;
      if (scheduled) clearTimeout(scheduled);
      scheduled = setTimeout(() => {
        scheduled = null;
        handleRequest().catch((error) => {
          log(`dev-sync scheduled request failed: ${error?.message ?? error}`);
        });
      }, 100);
      scheduled.unref?.();
    };
    const onRequestFile = (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
      schedule();
    };
    watchFile(requestPath, { interval: 300, persistent: false }, onRequestFile);
    disposeWatch = async () => {
      unwatchFile(requestPath, onRequestFile);
      if (scheduled) clearTimeout(scheduled);
      scheduled = null;
    };
    log("dev-sync watcher installed (HMR reconcile available)");
  } else {
    log("dev-sync watcher unavailable: HMR service missing");
  }

  // A new generation starts after a reconcile. Finish the pending verification
  // instead of treating the request as lost with the old generation.
  const pendingStatus = readJson(paths.status);
  const pendingRequest =
    pendingStatus?.state === "reloading" && pendingStatus.requestId
      ? pendingStatus.request ?? null
      : null;
  if (pendingRequest && pendingRequest.requestId === pendingStatus.requestId) {
    setTimeout(() => {
      settle(pendingRequest, { afterReload: true }).catch((error) => {
        log(`dev-sync pending settle failed: ${error?.message ?? error}`);
      });
    }, 0).unref?.();
  }

  return {
    paths,
    runtime,
    noteClientHello,
    hmr: hmrInfo,
    async dispose() {
      disposed = true;
      try {
        if (disposeWatch) await disposeWatch();
      } catch {
        // Disposal continues; the next generation re-registers.
      }
      disposeWatch = null;
    },
  };
}

// Session ownership for the Harness-embedded Computer Use UI.
//
// One desktop, one control owner. A Harness chat (hostSessionId) claims the
// desktop when it starts using a cu_* tool; another chat may read that the
// desktop is busy but can neither see the owner's target nor stop it. The
// registry is deliberately not a second executor: every stop goes through the
// existing CuSessionManager stop gate, and state is derived from the same
// manager the tools use.

export const SNAPSHOT_VERSION = 1;

/** Stable English states. The client maps them to locale strings. */
export const STATE = Object.freeze({
  idle: "idle",
  claimed: "claimed",
  running: "running",
  waiting: "waiting",
  verified: "verified",
  failed: "failed",
  stopping: "stopping",
  stopped: "stopped",
  cleanupUnknown: "cleanup_unknown",
  busyElsewhere: "busy_elsewhere",
});

const ACTIVE_STATES = new Set([
  STATE.claimed,
  STATE.running,
  STATE.waiting,
  STATE.verified,
  STATE.failed,
]);

const TOOL_LABELS = Object.freeze({
  cu_session: "session",
  cu_windows: "windows",
  cu_launch: "launch",
  cu_snapshot: "observe",
  cu_screenshot: "screenshot",
  cu_find: "find",
  cu_expect: "verify",
  cu_click: "click",
  cu_type: "type",
  cu_key: "key",
  cu_scroll: "scroll",
  cu_batch: "batch",
});

function cleanLabel(value, max = 64) {
  if (typeof value !== "string") return "";
  // User input bodies must never reach the UI. Callers pass tool names and
  // fixed labels only; this is the last line of defence against stray text.
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function readTarget(manager) {
  const session = manager?.activeSession;
  if (!session) return null;
  return {
    pid: Number.isInteger(session.pid) ? session.pid : null,
    windowId: Number.isInteger(session.windowId) ? session.windowId : null,
    appName: cleanLabel(session.app, 80) || null,
  };
}

function readTargetGeneration(manager) {
  const generation = Number(manager?.sessionGeneration);
  return Number.isFinite(generation) ? generation : 0;
}

function publicTarget(target) {
  if (!target) return null;
  return { pid: target.pid, windowId: target.windowId, appName: target.appName };
}

/**
 * @param {{ manager?: any, clock?: () => number }} [options]
 */
export function createCuUiRegistry(options = {}) {
  const manager = options.manager;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const log = typeof options.log === "function" ? options.log : () => {};

  const listeners = new Set();
  let revision = 0;
  let seq = 0;
  /** @type {null | {hostSessionId: string, cuSessionId: string, active: boolean, state: string, label: string, action: any, target: any, targetGeneration: number, previewStatus: string, cleanupState: string, startedAt: number, updatedAt: number, error: string|null}} */
  let owner = null;
  let stopPromise = null;
  let disposed = false;

  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A UI listener must never break control state.
      }
    }
  };

  const bump = () => {
    // Revisions must stay monotonic across plugin reloads: a client rejects a
    // snapshot whose revision is lower than the one it already showed, and a
    // restarted registry would otherwise start again from 1.
    revision = Math.max(revision + 1, Date.now());
    if (owner) owner.updatedAt = clock();
    emit();
    return revision;
  };

  const idleSnapshot = (hostSessionId) => ({
    version: SNAPSHOT_VERSION,
    revision,
    hostSessionId: hostSessionId ?? null,
    cuSessionId: null,
    ownerSessionId: null,
    targetGeneration: 0,
    target: null,
    state: STATE.idle,
    label: "",
    action: null,
    previewStatus: "unavailable",
    cleanupState: "clean",
    startedAt: null,
    updatedAt: clock(),
    error: null,
  });

  const ownerSnapshot = () => ({
    version: SNAPSHOT_VERSION,
    revision,
    hostSessionId: owner.hostSessionId,
    cuSessionId: owner.cuSessionId,
    ownerSessionId: owner.hostSessionId,
    targetGeneration: owner.targetGeneration,
    target: publicTarget(owner.target),
    state: owner.state,
    label: owner.label,
    action: owner.action
      ? {
          tool: owner.action.tool,
          kind: owner.action.kind,
          ok: owner.action.ok ?? null,
          verified: owner.action.verified ?? null,
        }
      : null,
    previewStatus: owner.previewStatus,
    cleanupState: owner.cleanupState,
    startedAt: owner.startedAt,
    updatedAt: owner.updatedAt,
    error: owner.error,
  });

  /**
   * The snapshot one chat is allowed to see. A foreign active owner exposes
   * only "busy", never its session id, target, label or action.
   */
  function snapshot(hostSessionId) {
    if (!hostSessionId || typeof hostSessionId !== "string") return idleSnapshot(hostSessionId);
    if (!owner) return idleSnapshot(hostSessionId);
    if (owner.hostSessionId !== hostSessionId) {
      if (owner.active) {
        return {
          ...idleSnapshot(hostSessionId),
          state: STATE.busyElsewhere,
          ownerSessionId: null,
        };
      }
      return idleSnapshot(hostSessionId);
    }
    return ownerSnapshot();
  }

  function claim(hostSessionId) {
    if (disposed) return { ok: false, error: "disposed" };
    if (!hostSessionId || typeof hostSessionId !== "string") {
      return { ok: false, error: "no_host_session" };
    }
    if (owner && owner.hostSessionId !== hostSessionId && owner.active) {
      return { ok: false, error: "cu_busy" };
    }
    if (!owner || owner.hostSessionId !== hostSessionId || !owner.active) {
      seq += 1;
      owner = {
        hostSessionId,
        cuSessionId: `cu-${seq}-${String(clock()).slice(-6)}`,
        active: true,
        state: STATE.claimed,
        label: "",
        action: null,
        target: readTarget(manager),
        targetGeneration: readTargetGeneration(manager),
        previewStatus: "unavailable",
        cleanupState: "clean",
        startedAt: clock(),
        updatedAt: clock(),
        error: null,
      };
      stopPromise = null;
      bump();
    }
    return { ok: true, cuSessionId: owner.cuSessionId, revision };
  }

  function beginAction(hostSessionId, action = {}) {
    const claimed = claim(hostSessionId);
    if (!claimed.ok) return claimed;
    if (stopPromise && owner?.state === STATE.stopping) {
      return { ok: false, error: "stopping" };
    }
    const tool = cleanLabel(action.tool, 40);
    owner.state = STATE.running;
    owner.label = cleanLabel(action.label || TOOL_LABELS[tool] || tool, 64);
    owner.action = { tool, kind: TOOL_LABELS[tool] ?? "action", ok: null, verified: null };
    owner.target = readTarget(manager) ?? owner.target;
    owner.targetGeneration = readTargetGeneration(manager);
    owner.error = null;
    bump();
    return { ok: true, cuSessionId: owner.cuSessionId, revision };
  }

  function endAction(hostSessionId, result = {}) {
    if (!owner || owner.hostSessionId !== hostSessionId) return { ok: false, error: "not_owner" };
    // A stop can land while this action is in flight (the UI Stop button is
    // itself a click). The late result must never turn a stopped session back
    // into "failed" or "waiting".
    if (!owner.active) return { ok: true, ignored: "inactive" };
    if (owner.state === STATE.stopping) return { ok: true, ignored: "stopping" };
    if (owner.state === STATE.stopped || owner.state === STATE.cleanupUnknown) {
      return { ok: true, ignored: "stopped" };
    }
    const ok = result.ok !== false;
    const verified = result.verified === true;
    owner.target = readTarget(manager) ?? owner.target;
    owner.targetGeneration = readTargetGeneration(manager);
    owner.action = {
      ...(owner.action ?? { tool: "action", kind: "action" }),
      ok,
      verified: ok ? verified : false,
    };
    if (!ok) {
      owner.state = STATE.failed;
      owner.label = cleanLabel(result.failedLabel || owner.label, 64);
      owner.error = cleanLabel(result.error, 200) || "action_failed";
    } else if (verified) {
      owner.state = STATE.verified;
      owner.label = cleanLabel("verified", 64);
      owner.error = null;
    } else {
      owner.state = STATE.waiting;
      owner.label = cleanLabel("waiting", 64);
      owner.error = null;
    }
    bump();
    return { ok: true, revision };
  }

  function setTarget(target) {
    if (!owner) return;
    const next = target === null ? null : publicTarget(target);
    const generation = readTargetGeneration(manager);
    if (
      generation === owner.targetGeneration &&
      JSON.stringify(next) === JSON.stringify(publicTarget(owner.target))
    ) {
      return;
    }
    owner.target = next;
    owner.targetGeneration = generation;
    bump();
  }

  function setPreviewStatus(hostSessionId, cuSessionId, status) {
    if (!owner || owner.hostSessionId !== hostSessionId) return { ok: false, error: "not_owner" };
    if (cuSessionId && owner.cuSessionId !== cuSessionId) return { ok: false, error: "stale_session" };
    const allowed = new Set(["unavailable", "connecting", "live", "stale"]);
    if (!allowed.has(status)) return { ok: false, error: "invalid_status" };
    if (owner.previewStatus === status) return { ok: true, revision };
    owner.previewStatus = status;
    bump();
    return { ok: true, revision };
  }

  async function control(request = {}) {
    const { hostSessionId, cuSessionId, expectedRevision, command } = request;    if (command !== "stop" && command !== "takeover") {
      return { ok: false, status: 400, error: "unknown_command" };
    }
    if (!hostSessionId || typeof hostSessionId !== "string") {
      return { ok: false, status: 400, error: "no_host_session" };
    }
    if (!owner || !owner.active) {
      return {
        ok: true,
        alreadyStopped: true,
        state: STATE.stopped,
        cleanupState: owner?.cleanupState ?? "clean",
        revision,
      };
    }
    if (owner.hostSessionId !== hostSessionId) {
      return { ok: false, status: 403, error: "not_owner" };
    }
    if (cuSessionId && owner.cuSessionId !== cuSessionId) {
      return { ok: false, status: 409, error: "stale_session", revision };
    }
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== revision) {
      return { ok: false, status: 409, error: "stale_revision", revision };
    }
    if (stopPromise) return stopPromise;

    const stopStartedAt = clock();
    owner.state = STATE.stopping;
    owner.label = command === "takeover" ? "takeover" : "stopping";
    bump();

    // Close the input gate before any await. stopVisualSession re-closes it and
    // invalidates the generation, but this makes the intent explicit and keeps
    // a queued action from starting in the microtask before it runs.
    try {
      manager.inputGateClosed = true;
      manager.cancelInFlight?.();
      // Gate-closed latency is the honest server-side stop latency: the UI
      // request has already arrived, and no queued input can start after this.
      log(`ui stop gate closed in ${clock() - stopStartedAt}ms (${command})`);
    } catch {
      // The real stop below reports the honest cleanup state.
    }

    stopPromise = (async () => {
      let cleanupState = "unknown";
      let stopped = false;
      let detail = null;
      try {
        const result = await manager.stopVisualSession({ pause: request.pause === true });
        stopped = result?.ok !== false;
        cleanupState = result?.cleanupState === "clean" ? "clean" : "unknown";
        detail = {
          cancelledActions: result?.cancelledActions ?? 0,
          nativePreviewStopped: result?.nativePreviewStopped ?? false,
          restoredDsh: result?.restoredDsh ?? false,
          restoredTarget: result?.restoredTarget ?? false,
        };
      } catch (error) {
        stopped = false;
        cleanupState = "unknown";
        detail = { message: cleanLabel(error?.message ?? error, 160) };
      }
      if (owner) {
        owner.active = false;
        owner.state = stopped
          ? cleanupState === "clean"
            ? STATE.stopped
            : STATE.cleanupUnknown
          : STATE.failed;
        owner.label = command === "takeover" ? "taken_over" : "stopped";
        owner.action = null;
        owner.target = null;
        owner.previewStatus = "unavailable";
        owner.cleanupState = cleanupState;
        owner.error = stopped ? null : (detail?.message ?? "stop_failed");
      }
      log(
        `ui stop cleanup ${stopped ? owner?.state : "failed"} in ${clock() - stopStartedAt}ms cleanup=${cleanupState}`,
      );
      bump();
      return {
        ok: stopped,
        state: owner?.state ?? STATE.stopped,
        cleanupState,
        revision,
        detail,
        command,
      };
    })();

    try {
      return await stopPromise;
    } finally {
      stopPromise = null;
    }
  }

  /** A stop that already happened elsewhere (turn end, agent dispose). */
  function markStopped(hostSessionId, detail = {}) {
    if (!owner || !owner.active) return { ok: true, ignored: true };
    if (hostSessionId && owner.hostSessionId !== hostSessionId) return { ok: false, error: "not_owner" };
    const cleanupState = detail.cleanupState === "clean" ? "clean" : "unknown";
    owner.active = false;
    owner.state = cleanupState === "clean" ? STATE.stopped : STATE.cleanupUnknown;
    owner.label = "stopped";
    owner.action = null;
    owner.target = null;
    owner.previewStatus = "unavailable";
    owner.cleanupState = cleanupState;
    owner.error = null;
    bump();
    return { ok: true, revision };
  }

  /** The agent that owned the session went away: stop, never transfer. */
  async function sessionEnded(hostSessionId) {
    if (!owner || owner.hostSessionId !== hostSessionId || !owner.active) return { ok: true };
    return control({ hostSessionId, cuSessionId: owner.cuSessionId, command: "stop" });
  }

  function release(hostSessionId, cuSessionId) {
    if (!owner || owner.hostSessionId !== hostSessionId) return { ok: true, released: false };
    if (cuSessionId && owner.cuSessionId !== cuSessionId) return { ok: false, error: "stale_session" };
    if (owner.active) return { ok: false, error: "still_active" };
    owner = null;
    bump();
    return { ok: true, released: true };
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    disposed = true;
    listeners.clear();
    owner = null;
  }

  return {
    snapshot,
    claim,
    beginAction,
    endAction,
    setTarget,
    setPreviewStatus,
    control,
    sessionEnded,
    markStopped,
    release,
    subscribe,
    dispose,
    state: () => owner?.state ?? STATE.idle,
    ownerSessionId: () => owner?.hostSessionId ?? null,
    cuSessionId: () => owner?.cuSessionId ?? null,
    revision: () => revision,
  };
}

export { TOOL_LABELS };

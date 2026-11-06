// Session ownership for the Harness-embedded Computer Use UI.
//
// One desktop, one controlling chat. Inside that chat, however, a session can
// hold several targets (application + window). The chat-level claim protects
// other conversations; the target map carries per-window state, stop gates,
// preview status and action identity. The registry is deliberately not a
// second executor: every stop goes through CuSessionManager, and state is
// derived from the manager plus the target each tool actually addressed.

export const SNAPSHOT_VERSION = 1;

/** Stable English states. The client maps them to locale strings. */
export const STATE = Object.freeze({
  idle: "idle",
  claimed: "claimed",
  running: "running",
  waiting: "waiting",
  verified: "verified",
  // Completed successfully, but the action carried no proof of the expected
  // effect. This is a real, terminal outcome — not "still waiting".
  unverified: "unverified",
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
  STATE.unverified,
  STATE.failed,
]);

const FINAL_STATES = new Set([STATE.stopped, STATE.cleanupUnknown]);
const PREVIEW_STATES = new Set([
  "unavailable",
  "connecting",
  "live",
  "stale",
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

function targetKey(pid, windowId) {
  if (pid === undefined || pid === null || !Number.isFinite(Number(pid))) return null;
  return `${Number(pid)}:${windowId === undefined || windowId === null ? "app" : Number(windowId)}`;
}

function publicTarget(target) {
  if (!target) return null;
  return {
    targetId: target.id,
    pid: target.pid ?? null,
    windowId: target.windowId ?? null,
    appName: target.appName ?? null,
  };
}

function publicTargetState(target) {
  return {
    targetId: target.id,
    pid: target.pid ?? null,
    windowId: target.windowId ?? null,
    appName: target.appName ?? null,
    state: target.state,
    label: target.label ?? "",
    action: target.action
      ? {
          tool: target.action.tool,
          kind: target.action.kind,
          ok: target.action.ok ?? null,
          verified: target.action.verified ?? null,
        }
      : null,
    previewStatus: target.previewStatus,
    nativePreview: target.nativePreview ?? null,
    cleanupState: target.cleanupState,
    active: target.active === true,
    startedAt: target.startedAt ?? null,
    updatedAt: target.updatedAt ?? null,
    error: target.error ?? null,
    targetGeneration: target.generation ?? 0,
  };
}

function readEngineSessionId(manager) {
  return typeof manager?.sessionId === "string" ? manager.sessionId : null;
}

function newTargetRecord(input = {}) {
  return {
    id: input.id ?? targetKey(input.pid, input.windowId),
    pid: input.pid ?? null,
    windowId: input.windowId ?? null,
    appName: typeof input.appName === "string" ? input.appName : (input.app ?? null),
    generation: Number.isFinite(Number(input.generation)) ? Number(input.generation) : 0,
    active: input.active !== false,
    state: input.state ?? STATE.claimed,
    label: "",
    actionId: null,
    action: null,
    previewStatus: "unavailable",
    cleanupState: "clean",
    startedAt: input.startedAt ?? Date.now(),
    updatedAt: input.updatedAt ?? Date.now(),
    error: null,
  };
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
  let actionSeq = 0;
  let sessionEndUnsubscribe = null;
  let owner = null;
  let stopPromise = null;
  const targetStopPromises = new Map();
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
    targets: [],
    targetCount: 0,
    state: STATE.idle,
    label: "",
    action: null,
    previewStatus: "unavailable",
    cleanupState: "clean",
    startedAt: null,
    updatedAt: clock(),
    error: null,
  });

  const activeTargets = (session = owner) =>
    session ? [...session.targets.values()].filter((target) => target.active && !FINAL_STATES.has(target.state)) : [];

  const primaryTarget = (session = owner) => {
    if (!session) return null;
    return (
      session.targets.get(session.primaryTargetId) ??
      activeTargets(session)[0] ??
      [...session.targets.values()][0] ??
      null
    );
  };

  const deriveState = (session = owner) => {
    if (!session) return STATE.idle;
    const active = activeTargets(session);
    if (active.length === 0) {
      if ([...session.targets.values()].some((target) => target.state === STATE.stopping)) return STATE.stopping;
      if ([...session.targets.values()].some((target) => target.state === STATE.cleanupUnknown)) {
        return STATE.cleanupUnknown;
      }
      if (session.targets.size > 0) return STATE.stopped;
      // A claimed owner has no target for a moment. A stop-all owns a terminal
      // state that must survive that empty interval instead of becoming idle.
      if (session.actionId) return session.state;
      if (session.action) return session.state;
      if (session.state === STATE.stopping || FINAL_STATES.has(session.state) || session.state === STATE.failed) {
        return session.state;
      }
      return session.active ? STATE.claimed : STATE.stopped;
    }
    const primary = primaryTarget(session);
    if (primary && active.includes(primary)) return primary.state;
    // A target that is currently doing work is the most useful summary.
    for (const state of [STATE.running, STATE.waiting, STATE.failed, STATE.verified, STATE.unverified, STATE.claimed]) {
      if (active.some((target) => target.state === state)) return state;
    }
    return active[0].state;
  };

  const syncTargetsFromManager = (session = owner, { makePrimary = false } = {}) => {
    if (!session) return [];
    let rows = [];
    try {
      if (typeof manager?.listTargets === "function") rows = manager.listTargets() ?? [];
    } catch {
      rows = [];
    }
    if (
      rows.length === 0 &&
      manager?.activeSession &&
      manager.activeSession.pid !== undefined &&
      manager.activeSession.pid !== null
    ) {
      const sessionView = manager.activeSession;
      rows = [{
        targetId: sessionView.targetId ?? targetKey(sessionView.pid, sessionView.windowId),
        pid: sessionView.pid,
        windowId: sessionView.windowId ?? null,
        app: sessionView.app ?? null,
        label: sessionView.label ?? null,
        generation:
          sessionView.generation !== undefined
            ? sessionView.generation
            : manager.sessionGeneration ?? 0,
        gateClosed: false,
        stopped: false,
        closed: false,
      }];
    }
    const seen = new Set();
    for (const row of rows) {
      if (!row || typeof row.targetId !== "string") continue;
      seen.add(row.targetId);
      let target = session.targets.get(row.targetId);
      if (!target) {
        target = newTargetRecord({
          id: row.targetId,
          pid: row.pid,
          windowId: row.windowId,
          appName: row.app,
          generation: row.generation,
          active: row.stopped !== true && row.gateClosed !== true && row.closed !== true,
          state:
            row.stopped || row.gateClosed || row.closed ? STATE.stopped : STATE.claimed,
          startedAt: row.startedAt,
        });
        session.targets.set(target.id, target);
      } else {
        const generationChanged =
          Number.isFinite(Number(row.generation)) &&
          Number(row.generation) !== Number(target.generation);
        target.pid = row.pid ?? target.pid;
        target.windowId = row.windowId ?? null;
        target.appName = row.app ?? target.appName;
        if (generationChanged) {
          target.generation = Number(row.generation);
          target.actionId = null;
          target.action = null;
          target.previewStatus = "unavailable";
          target.error = null;
          target.updatedAt = clock();
          if (target.active) target.state = STATE.claimed;
        }
        if (row.stopped || row.gateClosed || row.closed) {
          if (target.state !== STATE.stopping) {
            target.state = STATE.stopped;
            target.active = false;
            target.actionId = null;
            target.action = null;
            target.previewStatus = "unavailable";
          }
        } else if (!target.active && FINAL_STATES.has(target.state)) {
          // Reopened explicitly: a new generation is a new target incarnation.
          target.active = true;
          target.state = STATE.claimed;
          target.cleanupState = "clean";
          target.error = null;
        }
      }
      target.nativePreview = row.nativePreview ?? null;
      if (typeof row.label === "string" && row.label) target.label = cleanLabel(row.label, 64);
      target.generation = Number.isFinite(Number(row.generation)) ? Number(row.generation) : target.generation;
    }
    // The manager's current target is a useful primary hint, but never replace
    // an explicitly selected one during a running action.
    const managerPrimary = manager?.currentTargetKey ?? manager?.activeSession?.targetId ?? null;
    if (
      (makePrimary || !session.primaryTargetId) &&
      managerPrimary &&
      session.targets.has(managerPrimary)
    ) {
      session.primaryTargetId = managerPrimary;
    }
    if (!session.primaryTargetId || !session.targets.has(session.primaryTargetId)) {
      session.primaryTargetId = activeTargets(session)[0]?.id ?? [...session.targets.values()][0]?.id ?? null;
    }
    return rows;
  };

  const refreshOwnerState = (session = owner) => {
    if (!session) return;
    session.state = deriveState(session);
    const primary = primaryTarget(session);
    session.target = publicTarget(primary);
    session.targetGeneration = primary?.generation ?? 0;
    if (primary) session.previewStatus = primary.previewStatus;
    session.cleanupState = primary?.cleanupState ?? session.cleanupState ?? "clean";
    if (primary) {
      session.error = primary.error ?? null;
      session.label = primary.label ?? session.label ?? "";
      session.action = primary.action ?? null;
    }
    const active = activeTargets(session);
    if (
      active.length === 0 &&
      session.targets.size > 0 &&
      ![...session.targets.values()].some((target) => target.state === STATE.stopping)
    ) {
      // A claimed chat with no target yet is still an active claim. Only a chat
      // whose known targets have all ended (or explicitly stopped) is retired.
      session.active = false;
      session.primaryTargetId = null;
    }
  };

  const ownerSnapshot = () => {
    refreshOwnerState(owner);
    const targets = [...owner.targets.values()].map(publicTargetState);
    const primary = primaryTarget(owner);
    return {
      version: SNAPSHOT_VERSION,
      revision,
      hostSessionId: owner.hostSessionId,
      cuSessionId: owner.cuSessionId,
      ownerSessionId: owner.hostSessionId,
      targetGeneration: primary?.generation ?? 0,
      target: publicTarget(primary),
      targets,
      targetCount: targets.length,
      state: owner.state,
      active: owner.active === true,
      label: owner.label ?? "",
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
    };
  };

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
    // A retired owner is terminal. Do not let a residual manager.activeSession
    // (for example a stop implementation that is still unwinding) resurrect it
    // as a fresh claimed target on the next read.
    if (owner.active) syncTargetsFromManager(owner);
    return ownerSnapshot();
  }

  function claim(hostSessionId) {
    if (disposed) return { ok: false, error: "disposed" };
    if (!hostSessionId || typeof hostSessionId !== "string") {
      return { ok: false, error: "no_host_session" };
    }
    if (owner && owner.hostSessionId !== hostSessionId && owner.active) {
      const managerActive = Boolean(manager?.activeSession) || Boolean(manager?.targets?.size);
      const actionRunning = Boolean(owner.actionId) || [...owner.targets.values()].some((target) => target.actionId);
      // A fresh claim reserves the desktop before its first native action.
      if (!managerActive && !actionRunning && owner.state !== STATE.claimed) {
        owner.active = false;
      } else {
        return { ok: false, error: "cu_busy" };
      }
    }
    if (!owner || owner.hostSessionId !== hostSessionId || !owner.active) {
      seq += 1;
      owner = {
        hostSessionId,
        cuSessionId: `cu-${seq}-${String(clock()).slice(-6)}`,
        engineSessionId: readEngineSessionId(manager),
        actionId: null,
        active: true,
        state: STATE.claimed,
        label: "",
        action: null,
        target: null,
        targetGeneration: 0,
        previewStatus: "unavailable",
        cleanupState: "clean",
        startedAt: clock(),
        updatedAt: clock(),
        error: null,
        targets: new Map(),
        primaryTargetId: null,
      };
      stopPromise = null;
      targetStopPromises.clear();
      syncTargetsFromManager(owner, { makePrimary: true });
      refreshOwnerState(owner);
      bump();
    } else {
      // The manager can have created targets since the last tool call (for
      // example a cu_snapshot that established a second window).
      syncTargetsFromManager(owner);
      refreshOwnerState(owner);
    }
    // Engine-side identity for its session-end notices. A notice from a
    // previous owner can then never retire the new one.
    if (manager && owner) manager._uiOwnerId = owner.cuSessionId;
    return { ok: true, cuSessionId: owner.cuSessionId, revision };
  }

  function targetFromHint(session, hint = {}) {
    if (!session) return null;
    if (typeof hint.targetId === "string" && hint.targetId) {
      const exact = session.targets.get(hint.targetId);
      if (exact) return exact;
    }
    let resolved = hint;
    try {
      if (typeof manager?.resolveTargetArgs === "function") resolved = manager.resolveTargetArgs(hint);
    } catch {
      resolved = hint;
    }
    const key = targetKey(resolved.pid, resolved.windowId);
    if (key && session.targets.has(key)) return session.targets.get(key);
    if (key) {
      // A path through a foreign window must not be silently adopted. Only a
      // hint that the manager already knows (or a new explicit target) creates
      // a record; otherwise the action will resolve and sync on completion.
      const known = manager?.targets?.get?.(key);
      if (known) {
        const created = newTargetRecord({
          id: key,
          pid: known.pid,
          windowId: known.windowId,
          appName: known.app,
          generation: known.generation,
          active: !known.stopped && !known.gateClosed && !known.closed,
          state: known.stopped || known.gateClosed ? STATE.stopped : STATE.claimed,
          startedAt: known.startedAt,
        });
        session.targets.set(key, created);
        return created;
      }
    }
    const primary = primaryTarget(session);
    if (!hint.pid && !hint.windowId && !hint.targetId) return primary;
    return null;
  }

  function beginAction(hostSessionId, action = {}) {
    const claimed = claim(hostSessionId);
    if (!claimed.ok) return claimed;
    if (stopPromise && owner?.state === STATE.stopping) {
      return { ok: false, error: "stopping" };
    }
    const tool = cleanLabel(action.tool, 40);
    const operation = cleanLabel(action.operation, 24);
    const explicitStart =
      tool === "cu_session" && (operation === "start" || operation === "resume" || operation === "preview");
    const explicitStop = tool === "cu_session" && operation === "stop";
    syncTargetsFromManager(owner);
    let target = targetFromHint(owner, action);
    if (target && FINAL_STATES.has(target.state) && !explicitStart && !explicitStop) {
      return { ok: false, error: "target_stopped", targetId: target.id };
    }
    if (target && target.state === STATE.stopping && !explicitStop) {
      return { ok: false, error: "stopping", targetId: target.id };
    }
    actionSeq += 1;
    const actionId = `act-${actionSeq}`;
    owner.actionId = actionId;
    owner.engineSessionId = readEngineSessionId(manager);
    owner.state = STATE.running;
    owner.label = cleanLabel(action.label || TOOL_LABELS[tool] || tool, 64);
    owner.action = { tool, kind: TOOL_LABELS[tool] ?? "action", ok: null, verified: null, actionId };
    owner.error = null;
    if (target) {
      target.actionId = actionId;
      target.state = STATE.running;
      target.label = owner.label;
      target.action = { tool, kind: TOOL_LABELS[tool] ?? "action", ok: null, verified: null, actionId };
      target.error = null;
      target.updatedAt = clock();
      // The action names this target as primary; that is what the compact card
      // and the single native preview follow.
      owner.primaryTargetId = target.id;
      owner.action = target.action;
      owner.label = target.label;
    }
    refreshOwnerState(owner);
    bump();
    return {
      ok: true,
      // Immutable identity of THIS action. The caller must hand the same ticket
      // back to endAction; a newer action gets a different id, so a late result
      // can never be mistaken for current state.
      ticket: Object.freeze({
        hostSessionId,
        cuSessionId: owner.cuSessionId,
        actionId,
        ...(target ? { targetId: target.id } : {}),
      }),
      cuSessionId: owner.cuSessionId,
      ...(target ? { targetId: target.id } : {}),
      revision,
    };
  }

  function endAction(ticket, result = {}) {
    if (
      !ticket ||
      typeof ticket !== "object" ||
      typeof ticket.hostSessionId !== "string" ||
      typeof ticket.cuSessionId !== "string" ||
      typeof ticket.actionId !== "string"
    ) {
      return { ok: false, error: "invalid_ticket" };
    }
    if (!owner || owner.hostSessionId !== ticket.hostSessionId) {
      return { ok: false, error: "not_owner" };
    }
    if (owner.cuSessionId !== ticket.cuSessionId) {
      return { ok: true, ignored: "stale_session" };
    }
    syncTargetsFromManager(owner);
    let target = ticket.targetId ? owner.targets.get(ticket.targetId) : primaryTarget(owner);
    if (!target && owner.primaryTargetId) target = owner.targets.get(owner.primaryTargetId);
    // A stop can land while this action is in flight (the UI Stop button is
    // itself a click). The late result must never turn a stopped session back
    // into "failed" or "unverified".
    if (!owner.active) return { ok: true, ignored: "inactive" };
    if (owner.state === STATE.stopping) return { ok: true, ignored: "stopping" };
    if (target && (target.state === STATE.stopping || FINAL_STATES.has(target.state))) {
      return { ok: true, ignored: "target_stopped" };
    }
    if (target && target.actionId && target.actionId !== ticket.actionId) {
      // A newer action in the same target owns the state now; this result is
      // history, not news.
      return { ok: true, ignored: "stale_action" };
    }
    if (!target && owner.actionId !== ticket.actionId) {
      return { ok: true, ignored: "stale_action" };
    }
    // `cu_session start` creates the target during execute. Its ticket had no
    // targetId when the action began; the freshly synced primary target is the
    // one this action created/attached, so attach the result now.
    if (target && !target.actionId && ticket.targetId === undefined && owner.actionId === ticket.actionId) {
      target.actionId = ticket.actionId;
    }

    const ok = result.ok !== false;
    const verified = result.verified === true;
    const waiting = result.pending === true || result.waiting === true;
    const sessionStarted = result.session === "started" || result.session === "continued";
    const nextState = sessionStarted && ok
      ? STATE.claimed
      : !ok
        ? STATE.failed
        : verified
          ? STATE.verified
          : waiting
            ? STATE.waiting
            : STATE.unverified;
    const nextAction = {
      ...(target?.action ?? owner.action ?? { tool: "action", kind: "action" }),
      ok,
      verified: ok ? verified : false,
    };
    if (target) {
      target.actionId = null;
      target.engineSessionId = readEngineSessionId(manager);
      target.generation = Number(manager?.targets?.get?.(target.id)?.generation ?? target.generation);
      target.state = nextState;
      target.label = cleanLabel(
        !ok
          ? result.failedLabel || target.label
          : sessionStarted
            ? "session"
            : verified
              ? "verified"
              : waiting
                ? "waiting"
                : "unverified",
        64,
      );
      target.action = nextAction;
      target.error = !ok ? (cleanLabel(result.error, 200) || "action_failed") : null;
      target.updatedAt = clock();
    }
    owner.actionId = null;
    owner.engineSessionId = readEngineSessionId(manager) ?? owner.engineSessionId;
    owner.state = nextState;
    owner.label = target?.label ?? cleanLabel(
      !ok ? result.failedLabel || owner.label : verified ? "verified" : waiting ? "waiting" : "unverified",
      64,
    );
    owner.action = nextAction;
    owner.error = !ok ? (cleanLabel(result.error, 200) || "action_failed") : null;
    refreshOwnerState(owner);
    bump();
    return { ok: true, revision };
  }

  function setTarget(target) {
    if (!owner) return { ok: false, error: "no_owner" };
    if (target === null) {
      owner.primaryTargetId = null;
      refreshOwnerState(owner);
      bump();
      return { ok: true };
    }
    const key = target.targetId ?? targetKey(target.pid, target.windowId);
    if (!key) return { ok: false, error: "invalid_target" };
    let record = owner.targets.get(key);
    if (!record) {
      record = newTargetRecord({ ...target, id: key });
      owner.targets.set(key, record);
    } else {
      record.pid = target.pid ?? record.pid;
      record.windowId = target.windowId ?? null;
      record.appName = target.appName ?? target.app ?? record.appName;
      record.generation = Number(target.generation ?? record.generation);
    }
    owner.primaryTargetId = key;
    refreshOwnerState(owner);
    bump();
    return { ok: true, revision };
  }

  function setPreviewStatus(hostSessionId, cuSessionId, status, targetId = null) {
    if (!owner || owner.hostSessionId !== hostSessionId) return { ok: false, error: "not_owner" };
    if (cuSessionId && owner.cuSessionId !== cuSessionId) return { ok: false, error: "stale_session" };
    if (!PREVIEW_STATES.has(status)) return { ok: false, error: "invalid_status" };
    const target = targetId ? owner.targets.get(targetId) : primaryTarget(owner);
    if (!target && !targetId) {
      // A claimed session can exist for a moment before its first observation
      // names a window. Preview status is still valid owner-level state then.
      if (owner.previewStatus === status) return { ok: true, revision };
      owner.previewStatus = status;
      refreshOwnerState(owner);
      bump();
      return { ok: true, revision };
    }
    if (!target) return { ok: false, error: "no_target" };
    if (target.previewStatus === status) return { ok: true, revision };
    target.previewStatus = status;
    if (owner.primaryTargetId === target.id) owner.previewStatus = status;
    refreshOwnerState(owner);
    bump();
    return { ok: true, revision };
  }

  const stopResultSnapshot = (hostSessionId) => snapshot(hostSessionId);

  async function stopAll(request) {
    const pause = request.pause !== false;
    const startedAt = clock();
    const endedTargets = [...owner.targets.values()];
    for (const target of endedTargets) {
      if (!FINAL_STATES.has(target.state)) target.state = STATE.stopping;
      target.active = false;
      target.actionId = null;
      target.action = null;
    }
    owner.state = STATE.stopping;
    owner.label = request.command === "takeover" ? "takeover" : "stopping";
    bump();

    // Close the input gate and latch the user pause before any await. This is
    // the exact window in which a queued action would otherwise start.
    try {
      manager.inputGateClosed = true;
      if (pause) manager.pauseLatched = true;
      manager.cancelInFlight?.();
      log(`ui stop-all gate closed in ${clock() - startedAt}ms (${request.command})`);
    } catch {
      // The real stop below reports the honest cleanup state.
    }

    let cleanupState = "unknown";
    let stopped = false;
    let detail = null;
    try {
      const result = await manager.stopVisualSession({ pause, reason: request.reason ?? "ui_stop" });
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
    for (const target of endedTargets) {
      target.active = false;
      target.state = stopped
        ? cleanupState === "clean"
          ? STATE.stopped
          : STATE.cleanupUnknown
        : STATE.failed;
      target.label = request.command === "takeover" ? "taken_over" : "stopped";
      target.action = null;
      target.actionId = null;
      target.previewStatus = "unavailable";
      target.cleanupState = cleanupState;
      target.error = stopped ? null : detail?.message ?? "stop_failed";
      target.updatedAt = clock();
    }
    owner.active = false;
    owner.primaryTargetId = null;
    owner.target = null;
    owner.targetGeneration = 0;
    owner.action = null;
    owner.actionId = null;
    owner.state = stopped
      ? cleanupState === "clean"
        ? STATE.stopped
        : STATE.cleanupUnknown
      : STATE.failed;
    owner.label = request.command === "takeover" ? "taken_over" : "stopped";
    owner.previewStatus = "unavailable";
    owner.cleanupState = cleanupState;
    owner.error = stopped ? null : detail?.message ?? "stop_failed";
    log(
      `ui stop-all cleanup ${stopped ? owner.state : "failed"} in ${clock() - startedAt}ms cleanup=${cleanupState}`,
    );
    bump();
    return {
      ok: stopped,
      state: owner.state,
      cleanupState,
      revision,
      detail,
      command: request.command,
      inputGateClosed: true,
      remainingTargets: 0,
      snapshot: stopResultSnapshot(request.hostSessionId),
    };
  }

  async function stopOne(request, target) {
    const prior = targetStopPromises.get(target.id);
    if (prior) return prior;
    const pause = request.pause === true;
    const startedAt = clock();
    target.state = STATE.stopping;
    target.label = "stopping";
    target.updatedAt = clock();
    owner.state = STATE.stopping;
    bump();
    // manager.stopTarget closes this target's gate and invalidates its
    // generation before its first await. Calling it here keeps that immediacy.
    let promise;
    try {
      if (typeof manager.stopTarget === "function") {
        promise = manager.stopTarget(target.id, {
          pause,
          reason: request.reason ?? "ui_stop_target",
        });
      } else {
        promise = manager.stopVisualSession({ pause, reason: "ui_stop_target" });
      }
    } catch (error) {
      promise = Promise.reject(error);
    }
    const tracked = (async () => {
      let cleanupState = "unknown";
      let stopped = false;
      let detail = null;
      try {
        const result = await promise;
        stopped = result?.ok !== false;
        cleanupState = result?.cleanupState === "clean" ? "clean" : "unknown";
        detail = {
          cancelledActions: result?.cancelledActions ?? 0,
          nativePreviewStopped: result?.nativePreviewStopped ?? false,
          indicatorsStopped: result?.indicatorsStopped ?? 0,
          remainingTargets: result?.remainingTargets ?? 0,
        };
      } catch (error) {
        stopped = false;
        detail = { message: cleanLabel(error?.message ?? error, 160) };
      }
      target.active = false;
      target.state = stopped
        ? cleanupState === "clean"
          ? STATE.stopped
          : STATE.cleanupUnknown
        : STATE.failed;
      target.label = "stopped";
      target.action = null;
      target.actionId = null;
      target.previewStatus = "unavailable";
      target.cleanupState = cleanupState;
      target.error = stopped ? null : detail?.message ?? "stop_failed";
      target.updatedAt = clock();
      const remaining = activeTargets(owner);
      if (remaining.length > 0) {
        owner.primaryTargetId = remaining[0].id;
        owner.active = true;
      } else {
        owner.active = false;
        owner.primaryTargetId = null;
        owner.target = null;
        owner.state = target.state;
        owner.label = "stopped";
        owner.previewStatus = "unavailable";
        owner.cleanupState = cleanupState;
        owner.error = target.error;
      }
      refreshOwnerState(owner);
      log(
        `ui stop target ${target.id} ${stopped ? "ok" : "failed"} in ${clock() - startedAt}ms cleanup=${cleanupState}`,
      );
      bump();
      return {
        ok: stopped,
        targetId: target.id,
        state: target.state,
        cleanupState,
        revision,
        detail,
        inputGateClosed: remaining.length === 0,
        targetGateClosed: true,
        remainingTargets: remaining.length,
        command: request.command,
        snapshot: stopResultSnapshot(request.hostSessionId),
      };
    })();
    targetStopPromises.set(target.id, tracked);
    try {
      return await tracked;
    } finally {
      targetStopPromises.delete(target.id);
    }
  }

  async function control(request = {}) {
    const { hostSessionId, cuSessionId, command } = request;
    if (command !== "stop" && command !== "takeover") {
      return { ok: false, status: 400, error: "unknown_command" };
    }
    if (!hostSessionId || typeof hostSessionId !== "string") {
      return { ok: false, status: 400, error: "no_host_session" };
    }
    // A stop without a session identity is an unverifiable instruction. It is
    // rejected instead of guessed from "whatever owns the desk now".
    if (typeof cuSessionId !== "string" || cuSessionId.length === 0) {
      return { ok: false, status: 400, error: "no_cu_session" };
    }
    if (!owner) {
      return {
        ok: true,
        alreadyStopped: true,
        state: STATE.stopped,
        cleanupState: "clean",
        revision,
        inputGateClosed: true,
        remainingTargets: 0,
        snapshot: idleSnapshot(hostSessionId),
      };
    }
    if (owner.hostSessionId !== hostSessionId) {
      return { ok: false, status: 403, error: "not_owner" };
    }
    if (owner.cuSessionId !== cuSessionId) {
      return { ok: false, status: 409, error: "stale_session", revision };
    }
    const targetId = typeof request.targetId === "string" && request.targetId ? request.targetId : null;
    if (targetId) {
      const target = owner.targets.get(targetId);
      if (!target) {
        return {
          ok: true,
          alreadyStopped: true,
          targetId,
          cleanupState: "clean",
          revision,
          inputGateClosed: false,
          targetGateClosed: true,
          remainingTargets: activeTargets(owner).length,
          snapshot: snapshot(hostSessionId),
        };
      }
      if (FINAL_STATES.has(target.state) && !targetStopPromises.has(target.id)) {
        return {
          ok: true,
          alreadyStopped: true,
          targetId,
          state: target.state,
          cleanupState: target.cleanupState,
          revision,
          inputGateClosed: activeTargets(owner).length === 0,
          targetGateClosed: true,
          remainingTargets: activeTargets(owner).length,
          snapshot: snapshot(hostSessionId),
        };
      }
      return await stopOne(request, target);
    }

    if (!owner.active) {
      // The card is still shown for a naturally-ended session. A click on its
      // Stop button is still the user's stop intent: latch the pause here, or
      // the next ordinary action would be allowed to auto-start a session.
      const pauseRequested = request.pause !== false;
      if (pauseRequested) {
        manager.inputGateClosed = true;
        manager.pauseLatched = true;
        if (typeof manager.latchUserPause === "function") {
          Promise.resolve(manager.latchUserPause()).catch(() => {});
        }
      }
      return {
        ok: true,
        alreadyStopped: true,
        state: owner.state,
        cleanupState: owner.cleanupState,
        revision,
        inputGateClosed: true,
        remainingTargets: 0,
        snapshot: snapshot(hostSessionId),
      };
    }
    if (stopPromise) return stopPromise;
    stopPromise = stopAll(request);
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
    // A turn-end completion can arrive after this chat already started a new
    // session; only the captured CU session may be marked stopped.
    if (detail.cuSessionId && owner.cuSessionId !== detail.cuSessionId) {
      return { ok: true, ignored: "stale_session" };
    }
    const cleanupState = detail.cleanupState === "clean" ? "clean" : "unknown";
    for (const target of owner.targets.values()) {
      target.active = false;
      target.state = cleanupState === "clean" ? STATE.stopped : STATE.cleanupUnknown;
      target.label = "stopped";
      target.action = null;
      target.actionId = null;
      target.previewStatus = "unavailable";
      target.cleanupState = cleanupState;
      target.error = null;
    }
    owner.active = false;
    owner.primaryTargetId = null;
    owner.state = cleanupState === "clean" ? STATE.stopped : STATE.cleanupUnknown;
    owner.label = "stopped";
    owner.action = null;
    owner.actionId = null;
    owner.target = null;
    owner.targetGeneration = 0;
    owner.previewStatus = "unavailable";
    owner.cleanupState = cleanupState;
    owner.error = null;
    bump();
    return { ok: true, revision };
  }

  /**
   * The manager ended the desktop session on its own (idle timer, safety timer,
   * agent dispose, plugin unload). The UI must follow that single event instead
   * of running a second timer that guesses engine state.
   */
  function handleManagerSessionEnd(notice = {}) {
    if (!owner || !owner.active) return;
    const ownerId = typeof notice.ownerId === "string" ? notice.ownerId : null;
    if (ownerId) {
      if (ownerId !== owner.cuSessionId) return;
    } else {
      const engineSessionId = typeof notice.sessionId === "string" ? notice.sessionId : null;
      if (!engineSessionId || !owner.engineSessionId || engineSessionId !== owner.engineSessionId) {
        return;
      }
    }
    markStopped(owner.hostSessionId, {
      cleanupState: notice.cleanupState,
      reason: notice.reason,
      cuSessionId: notice.ownerId ?? undefined,
    });
  }

  if (typeof manager?.onSessionEnd === "function") {
    sessionEndUnsubscribe = manager.onSessionEnd(handleManagerSessionEnd);
  }

  /** The agent that owned the session went away: stop, never transfer. */
  async function sessionEnded(hostSessionId) {
    if (!owner || owner.hostSessionId !== hostSessionId || !owner.active) return { ok: true };
    // A disappearing agent is a natural end, not a user stop: it must not latch
    // the pause that blocks the next chat's explicit start.
    return control({
      hostSessionId,
      cuSessionId: owner.cuSessionId,
      command: "stop",
      pause: false,
      reason: "agent_dispose",
    });
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
    try {
      sessionEndUnsubscribe?.();
    } catch {
      // Teardown continues.
    }
    sessionEndUnsubscribe = null;
    listeners.clear();
    owner = null;
    targetStopPromises.clear();
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
    sync: () => {
      if (!owner) return idleSnapshot(null);
      syncTargetsFromManager(owner);
      refreshOwnerState(owner);
      return ownerSnapshot();
    },
    targets: () => (owner ? [...owner.targets.values()].map(publicTargetState) : []),
    primaryTargetId: () => owner?.primaryTargetId ?? null,
    state: () => owner?.state ?? STATE.idle,
    ownerSessionId: () => owner?.hostSessionId ?? null,
    cuSessionId: () => owner?.cuSessionId ?? null,
    revision: () => revision,
  };
}

export { TOOL_LABELS, ACTIVE_STATES, FINAL_STATES };

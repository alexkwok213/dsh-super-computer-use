// Bounded preview proxy: one supervised `cu preview-stream` child per viewer.
//
// The Host never accepts a pid/window/path from the browser. It starts the
// engine for the manager's current bound target and only forwards frames whose
// session id and target generation match the authenticated owner. A slow reader
// keeps at most one PENDING LATEST frame (a newer frame replaces the pending
// one), and every way this stream can end (abort, close, child exit, spawn
// error, plugin unload) goes through one idempotent finalize.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { ROUTES } from "./harness-ui-bridge.mjs";

const MAX_META = 16 * 1024;
const MAX_JPEG = 2 * 1024 * 1024;

function jsonError(error, status) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function killChild(child) {
  if (!child || child.__scuKilled) return;
  child.__scuKilled = true;
  try {
    child.stdin?.end();
  } catch {
    // ignore
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 1000);
  timer.unref?.();
}

/**
 * @param {{ manager: any, log?: (line: string) => void }} deps
 */
export function createPreviewBridge({ manager, log = () => {} } = {}) {
  const active = new Set();
  // One live helper per owner+camera. A second viewer (card + overlay both
  // mounting, a retry racing a rebind) replaces the previous stream instead of
  // stacking ScreenCaptureKit clients.
  const byOwner = new Map();
  // Every live stream owns its child, guard interval, listeners, byOwner entry
  // and response controller. stats() is the test/diagnostic view of what is
  // still retained.
  const states = new Set();

  function stats() {
    return {
      activeChildren: active.size,
      owners: byOwner.size,
      streams: states.size,
      timers: [...states].filter((state) => state.guard).length,
      framesReceived: [...states].reduce((sum, state) => sum + state.received, 0),
      pendingFrames: [...states].filter((state) => state.pendingFrame).length,
      pendingBytes: [...states].reduce(
        (sum, state) => sum + (state.pendingFrame ? state.pendingFrame.length : 0),
        0,
      ),
    };
  }

  /**
   * The single teardown path. Idempotent: a natural exit, a client cancel and a
   * plugin dispose that race each other all end here exactly once, and only the
   * stream that is still current may report "unavailable" (an old helper's late
   * exit must not overwrite the replacement's "connecting"/"live").
   */
  function finalize(state, reason) {
    if (!state || state.closed) return;
    state.closed = true;
    state.reason = reason;
    if (state.guard) {
      clearInterval(state.guard);
      state.guard = null;
    }
    if (state.signal && state.abortListener) {
      try {
        state.signal.removeEventListener("abort", state.abortListener);
      } catch {
        // ignore
      }
    }
    state.abortListener = null;
    states.delete(state);
    state.pendingFrame = null;
    state.buffer = Buffer.alloc(0);
    active.delete(state.child);
    const isCurrent = byOwner.get(state.ownerKey) === state;
    if (isCurrent) byOwner.delete(state.ownerKey);
    if (isCurrent) {
      try {
        state.registry?.setPreviewStatus(state.hostSessionId, state.cuSessionId, "unavailable");
      } catch {
        // Registry may already be disposed during plugin unload.
      }
    }
    killChild(state.child);
    try {
      state.controller?.close();
    } catch {
      // already closed / cancelled
    }
    log(
      `preview finalize reason=${reason} frames=${state.frames} dropped=${state.dropped} ` +
        `replaced=${state.replaced} age=${Date.now() - state.startedAt}ms ` +
        `stderr=${state.lastError.slice(0, 300)}`,
    );
  }

  function enqueueFrame(state, controller, frame) {
    try {
      controller.enqueue(new Uint8Array(frame));
    } catch {
      finalize(state, "enqueue_failed");
      return;
    }
    state.frames += 1;
    if (!state.firstFrameAt) {
      state.firstFrameAt = Date.now();
      log(`preview first frame in ${state.firstFrameAt - state.startedAt}ms`);
      try {
        state.registry.setPreviewStatus(state.hostSessionId, state.cuSessionId, "live");
      } catch {
        // Registry may already be disposed.
      }
    }
  }

  function handle(request, registry) {
    const url = new URL(request.url);
    const hostSessionId = url.searchParams.get("hostSessionId");
    const cuSessionId = url.searchParams.get("cuSessionId");
    const generation = Number(url.searchParams.get("generation"));

    log(`preview request state=${registry.snapshot(hostSessionId).state} gen=${generation}`);
    if (!hostSessionId) return jsonError("no_host_session", 400);
    if (!cuSessionId) return jsonError("no_cu_session", 400);
    if (!Number.isInteger(generation)) return jsonError("no_generation", 400);

    const snapshot = registry.snapshot(hostSessionId);
    if (snapshot.state === "busy_elsewhere" || snapshot.state === "idle") {
      log(`preview rejected: not_owner (${snapshot.state})`);
      return jsonError("not_owner", 403);
    }
    if (snapshot.cuSessionId !== cuSessionId) {
      log(`preview rejected: stale_session ${snapshot.cuSessionId} != ${cuSessionId}`);
      return jsonError("stale_session", 409);
    }
    if (snapshot.targetGeneration !== generation) {
      log(`preview rejected: stale_generation ${snapshot.targetGeneration} != ${generation}`);
      return jsonError("stale_generation", 409);
    }
    if (
      !["claimed", "running", "waiting", "verified", "unverified", "failed"].includes(snapshot.state)
    ) {
      return jsonError("session_not_active", 409);
    }

    const target = manager.activeSession;
    if (!target || !Number.isInteger(target.windowId)) {
      log("preview rejected: no_target");
      return jsonError("no_target", 409);
    }

    const bin = manager.resolvePreviewBinary?.() ?? manager.resolveBinaryPath?.();
    if (!bin || !existsSync(bin)) {
      log(`preview rejected: engine_missing ${bin}`);
      return jsonError("engine_missing", 503);
    }
    log(`preview spawn window=${target.windowId} session=${cuSessionId} gen=${generation}`);

    const ownerKey = `${hostSessionId}:${cuSessionId}`;
    const previous = byOwner.get(ownerKey);
    if (previous) finalize(previous, "replaced");

    const child = spawn(
      bin,
      [
        "preview-stream",
        "--window",
        String(target.windowId),
        "--session",
        cuSessionId,
        "--generation",
        String(generation),
        "--fps",
        "10",
        "--max-dim",
        "960",
        "--seconds",
        "900",
        "--watch-parent",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const state = {
      child,
      ownerKey,
      hostSessionId,
      cuSessionId,
      generation,
      registry,
      controller: null,
      guard: null,
      closed: false,
      reason: null,
      pendingFrame: null,
      buffer: Buffer.alloc(0),
      frames: 0,
      dropped: 0,
      replaced: 0,
      received: 0,
      firstFrameAt: 0,
      lastError: "",
      startedAt: Date.now(),
      signal: request.signal ?? null,
      abortListener: null,
    };
    active.add(child);
    byOwner.set(ownerKey, state);
    states.add(state);
    log(`preview child pid=${child.pid} window=${target.windowId} gen=${generation}`);

    const stream = new ReadableStream({
      start(controller) {
        state.controller = controller;
        try {
          registry.setPreviewStatus(hostSessionId, cuSessionId, "connecting");
        } catch {
          // ignore
        }
        // A target switch or a stop must end this stream even if the viewer
        // never closes its half; the child is bounded by the owner generation.
        state.guard = setInterval(() => {
          if (state.closed) return;
          const current = registry.snapshot(hostSessionId);
          if (
            current.cuSessionId !== cuSessionId ||
            current.targetGeneration !== generation ||
            !["claimed", "running", "waiting", "verified", "unverified", "failed"].includes(
              current.state,
            )
          ) {
            finalize(state, "owner_changed");
          }
        }, 1000);
        state.guard.unref?.();

        child.stderr.on("data", (chunk) => {
          state.lastError = (state.lastError + chunk.toString("utf8")).slice(-800);
        });
        child.on("error", (error) => {
          state.lastError = `spawn_failed: ${error?.message ?? error}`;
          finalize(state, "spawn_error");
        });
        child.on("exit", (code, signal) => {
          finalize(state, `child_exit:${code ?? signal}`);
        });
        child.stdout.on("data", (chunk) => {
          if (state.closed) return;
          state.buffer = state.buffer.length === 0 ? chunk : Buffer.concat([state.buffer, chunk]);
          for (;;) {
            if (state.buffer.length < 8) return;
            const metaLength = state.buffer.readUInt32BE(0);
            const jpegLength = state.buffer.readUInt32BE(4);
            if (
              metaLength <= 0 ||
              metaLength > MAX_META ||
              jpegLength <= 0 ||
              jpegLength > MAX_JPEG
            ) {
              state.lastError = `invalid_frame_header meta=${metaLength} jpeg=${jpegLength}`;
              finalize(state, "invalid_frame_header");
              return;
            }
            const total = 8 + metaLength + jpegLength;
            if (state.buffer.length < total) return;
            const frame = state.buffer.subarray(0, total);
            state.buffer = state.buffer.subarray(total);

            let meta;
            try {
              meta = JSON.parse(frame.subarray(8, 8 + metaLength).toString("utf8"));
            } catch {
              state.dropped += 1;
              continue;
            }
            if (meta?.targetGeneration !== generation || meta?.cuSessionId !== cuSessionId) {
              state.dropped += 1;
              continue;
            }
            state.received += 1;
            // Backpressure: exactly one pending frame. A newer frame replaces
            // the pending one (latest wins), so the reader resumes on current
            // content instead of a stale queue head. Memory stays bounded to
            // one frame.
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              if (state.pendingFrame) state.dropped += 1;
              state.replaced += 1;
              state.pendingFrame = new Uint8Array(frame);
              continue;
            }
            enqueueFrame(state, controller, frame);
          }
        });
      },
      pull(controller) {
        if (state.closed) return;
        if (!state.pendingFrame) return;
        const frame = state.pendingFrame;
        state.pendingFrame = null;
        enqueueFrame(state, controller, frame);
      },
      cancel() {
        log("preview stream cancelled by consumer");
        finalize(state, "consumer_cancel");
      },
    });

    // Empty stdin is held open so the child's --watch-parent EOF detector fires
    // exactly when this response goes away.
    try {
      child.stdin.on("error", () => {});
    } catch {
      // ignore
    }

    if (state.signal) {
      if (state.signal.aborted) {
        finalize(state, "request_aborted");
      } else {
        state.abortListener = () => finalize(state, "request_aborted");
        state.signal.addEventListener("abort", state.abortListener, { once: true });
      }
    }

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-scu-frames",
        "cache-control": "no-store",
        "x-scu-preview": "1",
      },
    });
  }

  function dispose() {
    for (const state of [...states]) finalize(state, "dispose");
    // Defensive: a child registered after its state was finalized by a race is
    // still ours to kill.
    for (const child of active) killChild(child);
    active.clear();
    byOwner.clear();
  }

  return {
    register({ register, registry }) {
      const disposeRoute = register({
        path: ROUTES.preview,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: (request) => handle(request, registry),
      });
      return () => {
        dispose();
        if (typeof disposeRoute === "function") disposeRoute();
      };
    },
    dispose,
    stats,
  };
}

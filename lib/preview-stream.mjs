// Bounded preview proxy: one supervised `cu preview-stream` child per viewer.
//
// The Host never accepts a pid/window/path from the browser. It starts the
// engine for the manager's current bound target and only forwards frames whose
// session id and target generation match the authenticated owner. A slow reader
// drops frames instead of growing a queue, and every way this stream can end
// (abort, close, child exit, plugin unload) kills the child.

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
    if (!["claimed", "running", "waiting", "verified", "failed"].includes(snapshot.state)) {
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
    if (previous) {
      active.delete(previous);
      killChild(previous);
      byOwner.delete(ownerKey);
    }

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
    active.add(child);
    byOwner.set(ownerKey, child);
    log(`preview child pid=${child.pid} window=${target.windowId} gen=${generation}`);

    let closed = false;
    let killedByClient = false;
    let frames = 0;
    let dropped = 0;
    let lastError = "";
    let buffer = Buffer.alloc(0);
    let firstFrameAt = 0;
    const startedAt = Date.now();

    let guard = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (guard) clearInterval(guard);
      log(
        `preview cleanup frames=${frames} dropped=${dropped} age=${Date.now() - startedAt}ms stderr=${lastError.slice(0, 300)}`,
      );
      active.delete(child);
      if (byOwner.get(ownerKey) === child) byOwner.delete(ownerKey);
      killChild(child);
      try {
        registry.setPreviewStatus(hostSessionId, cuSessionId, "unavailable");
      } catch {
        // Registry may already be disposed during plugin unload.
      }
    };

    const stream = new ReadableStream({
      start(controller) {
        registry.setPreviewStatus(hostSessionId, cuSessionId, "connecting");
        // A target switch or a stop must end this stream even if the viewer
        // never closes its half; the child is bounded by the owner generation.
        guard = setInterval(() => {
          if (closed) return;
          const current = registry.snapshot(hostSessionId);
          if (
            current.cuSessionId !== cuSessionId ||
            current.targetGeneration !== generation ||
            !["claimed", "running", "waiting", "verified", "failed"].includes(current.state)
          ) {
            try {
              controller.close();
            } catch {
              // already closed
            }
            cleanup();
          }
        }, 1000);
        guard.unref?.();
        child.stderr.on("data", (chunk) => {
          lastError = (lastError + chunk.toString("utf8")).slice(-800);
        });
        child.on("error", (error) => {
          lastError = `spawn_failed: ${error?.message ?? error}`;
          try {
            controller.close();
          } catch {
            // already closed
          }
          cleanup();
        });
        child.on("exit", (code, signal) => {
          active.delete(child);
          if (closed) {
            log(`preview child exited after cleanup code=${code} signal=${signal}`);
            return;
          }
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // already closed
            }
            try {
              registry.setPreviewStatus(hostSessionId, cuSessionId, "unavailable");
            } catch {
              // ignore
            }
            log(
              `preview child exited frames=${frames} dropped=${dropped} after=${Date.now() - startedAt}ms ${lastError.slice(0, 200)}`,
            );
          }
        });
        child.stdout.on("data", (chunk) => {
          if (closed) return;
          buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
          for (;;) {
            if (buffer.length < 8) return;
            const metaLength = buffer.readUInt32BE(0);
            const jpegLength = buffer.readUInt32BE(4);
            if (metaLength <= 0 || metaLength > MAX_META || jpegLength <= 0 || jpegLength > MAX_JPEG) {
              lastError = `invalid_frame_header meta=${metaLength} jpeg=${jpegLength}`;
              try {
                controller.close();
              } catch {
                // ignore
              }
              cleanup();
              return;
            }
            const total = 8 + metaLength + jpegLength;
            if (buffer.length < total) return;
            const frame = buffer.subarray(0, total);
            buffer = buffer.subarray(total);

            let meta;
            try {
              meta = JSON.parse(frame.subarray(8, 8 + metaLength).toString("utf8"));
            } catch {
              continue;
            }
            if (meta?.targetGeneration !== generation || meta?.cuSessionId !== cuSessionId) {
              dropped += 1;
              continue;
            }
            // Backpressure: the consumer has at most one frame waiting. When the
            // queue is full, drop this frame and keep the newest content flowing.
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              dropped += 1;
              continue;
            }
            try {
              controller.enqueue(new Uint8Array(frame));
            } catch {
              cleanup();
              return;
            }
            frames += 1;
            if (!firstFrameAt) {
              firstFrameAt = Date.now();
              log(`preview first frame in ${firstFrameAt - startedAt}ms`);
              registry.setPreviewStatus(hostSessionId, cuSessionId, "live");
            }
          }
        });
      },
      cancel() {
        killedByClient = true;
        log("preview stream cancelled by consumer");
        cleanup();
      },
    });

    // Empty stdin is held open so the child's --watch-parent EOF detector fires
    // exactly when this response goes away.
    try {
      child.stdin.on("error", () => {});
    } catch {
      // ignore
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

  return {
    register({ register, registry }) {
      const disposeRoute = register({
        path: ROUTES.preview,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: (request) => handle(request, registry),
      });
      return () => {
        for (const child of active) killChild(child);
        active.clear();
        if (typeof disposeRoute === "function") disposeRoute();
      };
    },
    dispose() {
      for (const child of active) killChild(child);
      active.clear();
    },
  };
}

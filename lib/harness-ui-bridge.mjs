// Authenticated Host bridge for the embedded Computer Use UI.
//
// The bridge registers exact Fetch routes through the Host's own connection
// service (the same carrier that authenticates the desktop page). It never
// opens a port, never mints its own token and never trusts the query string as
// authorization: the connection service checks the page's peer first, and the
// registry checks that the caller owns the CU session.

export const ROUTES = Object.freeze({
  probe: "/api/scu/probe",
  state: "/api/scu/state",
  hello: "/api/scu/client-hello",
  control: "/api/scu/control",
  preview: "/api/scu/preview",
});

const MAX_STATE_BODY = 4096;
const MAX_CONTROL_BODY = 16 * 1024;
const PRESENCE_MS = 6000;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function byteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: "body_too_large" };
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, error: "body_unreadable" };
  }
  if (byteLength(text) > maxBytes) return { ok: false, status: 413, error: "body_too_large" };
  if (!text) return { ok: false, status: 400, error: "empty_body" };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, status: 400, error: "invalid_body" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}

/**
 * Install the UI bridge. Returns a handle with `dispose`, `available` and
 * `clientPresent` (used to decide embedded vs native viewing).
 *
 * @param {any} ctx Host Cordis context
 * @param {{registry: any, manager?: any, preview?: any}} deps
 */
export function installHarnessUiBridge(ctx, deps = {}) {
  const { registry } = deps;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  let connection = ctx?.get?.("connection") ?? null;
  let routesInstalled = false;
  let disposed = false;
  let deferred = false;
  const presence = new Map();
  const disposers = [];

  const noteClient = (hostSessionId) => {
    if (typeof hostSessionId !== "string" || !hostSessionId) return;
    presence.set(hostSessionId, Date.now());
    // Keep the map from growing across long Harness uptimes.
    if (presence.size > 64) {
      const cutoff = Date.now() - PRESENCE_MS * 4;
      for (const [key, at] of presence) if (at < cutoff) presence.delete(key);
    }
  };

  const onClientHello = typeof deps.onClientHello === "function" ? deps.onClientHello : null;

  const clientPresent = (hostSessionId, maxAgeMs = PRESENCE_MS) => {
    if (typeof hostSessionId !== "string" || !hostSessionId) return false;
    const at = presence.get(hostSessionId);
    return typeof at === "number" && Date.now() - at <= maxAgeMs;
  };

  const disposeRoutes = () => {
    while (disposers.length > 0) {
      try {
        disposers.pop()?.();
      } catch {
        // Teardown continues; a single route must not strand the rest.
      }
    }
    routesInstalled = false;
  };

  const dispose = () => {
    disposed = true;
    disposeRoutes();
    presence.clear();
  };

  const installRoutes = (activeConnection) => {
    if (
      disposed ||
      routesInstalled ||
      !activeConnection ||
      typeof activeConnection.fetch?.register !== "function"
    ) {
      return false;
    }
    connection = activeConnection;
    const register = (route) => {
      disposers.push(activeConnection.fetch.register(route));
    };

  // --- Gate probe (Task 1): proves the desktop carrier delivers a streamed
  // body before EOF, and that abort/401/403 behave. Removed after the gate via
  // one config flag; the route itself is authenticated by connection.
  if (deps.config?.uiProbe !== false) {
    register({
      path: ROUTES.probe,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async () => {
        const encoder = new TextEncoder();
        const startedAt = Date.now();
        let timer;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(JSON.stringify({ i: 0, at: Date.now(), startedAt }) + "\n"),
            );
            timer = setTimeout(() => {
              try {
                controller.enqueue(
                  encoder.encode(JSON.stringify({ i: 1, at: Date.now(), startedAt }) + "\n"),
                );
                controller.close();
              } catch {
                // The client aborted; the bridge cancels the stream.
              }
            }, 300);
          },
          cancel() {
            clearTimeout(timer);
          },
        });
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-store",
            "x-scu-probe": "1",
          },
        });
      },
    });
  }

  register({
    path: ROUTES.state,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const parsed = await readJson(request, MAX_STATE_BODY);
      if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);
      const hostSessionId = parsed.value.hostSessionId;
      if (typeof hostSessionId !== "string" || !hostSessionId) {
        return json({ ok: false, error: "no_host_session" }, 400);
      }
      noteClient(hostSessionId);
      // Watching is not input. Polling must not re-arm the input idle timer and
      // keep a viewing-only session owning the desk forever; the manager's own
      // idle/safety timers decide when the session ends, and the UI follows its
      // end notification.
      return json({
        ok: true,
        serverNow: Date.now(),
        snapshot: registry.snapshot(hostSessionId),
      });
    },
  });

  // The browser half announces the artifact revision it actually executed. The
  // connection service authenticates the page; the body carries no credential.
  // This is how a development update proves the Client bundle was swapped, not
  // merely written to disk.
  register({
    path: ROUTES.hello,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const parsed = await readJson(request, MAX_STATE_BODY);
      if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);
      const value = parsed.value;
      if (typeof value.clientRev !== "string" || value.clientRev.length === 0 || value.clientRev.length > 200) {
        return json({ ok: false, error: "invalid_client_rev" }, 400);
      }
      const hello = {
        clientRev: value.clientRev,
        clientVersion:
          typeof value.clientVersion === "string" ? value.clientVersion.slice(0, 80) : null,
        scriptUrl: typeof value.scriptUrl === "string" ? value.scriptUrl.slice(0, 500) : null,
        capabilities: Array.isArray(value.capabilities)
          ? value.capabilities
              .filter((item) => typeof item === "string")
              .slice(0, 20)
              .map((item) => item.slice(0, 80))
          : [],
      };
      try {
        onClientHello?.(hello);
      } catch {
        // A diagnostic sink must never fail the browser's announcement.
      }
      return json({ ok: true, serverNow: Date.now() }, 200);
    },
  });

  register({
    path: ROUTES.control,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const parsed = await readJson(request, MAX_CONTROL_BODY);
      if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);
      const { hostSessionId, cuSessionId, expectedRevision, command, targetId } = parsed.value;
      if (command === "open_settings") {
        const opened = deps.manager?.openSystemSettings?.(parsed.value.target);
        return json({ ok: true, opened: Boolean(opened), serverNow: Date.now() }, 200);
      }
      if (typeof hostSessionId !== "string" || !hostSessionId) {
        return json({ ok: false, error: "no_host_session" }, 400);
      }
      noteClient(hostSessionId);
      const result = await registry.control({
        hostSessionId,
        cuSessionId: typeof cuSessionId === "string" ? cuSessionId : undefined,
        expectedRevision:
          Number.isInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : undefined,
        targetId: typeof targetId === "string" && targetId ? targetId.slice(0, 120) : undefined,
        // Target stops default to no session-wide pause; stop-all defaults to
        // latching the user pause in the registry.
        ...(typeof parsed.value.pause === "boolean" ? { pause: parsed.value.pause } : {}),
        command,
      });
      const status = result.ok ? 200 : (result.status ?? 400);
      return json({ ...result, serverNow: Date.now() }, status);
    },
  });

    // Preview is installed by the preview module (Task 4). Until then a clear
    // 503 keeps the client from pretending a video exists.
    if (typeof deps.preview?.register === "function") {
      const disposePreview = deps.preview.register({ register, registry, noteClient });
      if (typeof disposePreview === "function") disposers.push(disposePreview);
    } else {
      register({
        path: ROUTES.preview,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: async () =>
          json({ ok: false, error: "preview_unavailable", reason: "not_implemented" }, 503),
      });
    }
    routesInstalled = true;
    return true;
  };

  if (!installRoutes(connection)) {
    // The desktop host constructs `connection` behind an async init; plugins
    // that mount earlier must wait for the service instead of reading it once
    // and permanently reporting "unavailable" (DSH's own market does the same
    // with ctx.inject(["connection"], ...)).
    if (typeof ctx?.inject === "function") {
      deferred = true;
      try {
        ctx.inject(["connection"], (scopedCtx) => {
          if (disposed) return () => {};
          const live = scopedCtx?.get?.("connection") ?? ctx?.get?.("connection");
          if (!installRoutes(live)) {
            log("Harness UI bridge: connection service became available but exposes no fetch.register");
            return () => {};
          }
          log("Harness UI bridge installed after connection service became ready");
          return () => {
            if (connection === live) connection = null;
            disposeRoutes();
          };
        });
        log("Harness UI bridge deferred until connection service is ready");
      } catch (error) {
        log(`Harness UI bridge inject failed: ${String(error?.message ?? error).slice(0, 200)}`);
      }
    }
  }

  return {
    get available() {
      return routesInstalled && Boolean(connection);
    },
    get deferred() {
      return deferred && !routesInstalled;
    },
    get reason() {
      if (routesInstalled) return null;
      return deferred ? "connection_service_deferred" : "connection_service_unavailable";
    },
    clientPresent,
    noteClient,
    dispose,
    routes: ROUTES,
  };
}

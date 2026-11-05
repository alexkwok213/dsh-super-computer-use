import test from "node:test";
import assert from "node:assert/strict";
import { installHarnessUiBridge } from "../lib/harness-ui-bridge.mjs";
import { createCuUiRegistry } from "../lib/cu-ui-session.mjs";

function harness() {
  const routes = new Map();
  const ctx = {
    get(name) {
      if (name !== "connection") return undefined;
      return {
        fetch: {
          register(route) {
            routes.set(`${route.methods.join(",")} ${route.path}`, route);
            return () => routes.delete(`${route.methods.join(",")} ${route.path}`);
          },
        },
      };
    },
  };
  const manager = {
    activeSession: null,
    sessionId: null,
    sessionGeneration: 0,
    inputGateClosed: false,
    async stopVisualSession() {
      this.activeSession = null;
      return { ok: true, cleanupState: "unknown", cancelledActions: 0 };
    },
    cancelInFlight() {
      return 0;
    },
  };
  const registry = createCuUiRegistry({ manager });
  const hellos = [];
  const bridge = installHarnessUiBridge(ctx, {
    registry,
    manager,
    config: { uiProbe: true },
    onClientHello: (hello) => hellos.push(hello),
  });
  return { routes, ctx, manager, registry, bridge, hellos };
}

function post(path, body) {
  return new Request(`http://127.0.0.1/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("bridge registers exact state, control, hello, probe and preview routes", () => {
  const { routes } = harness();
  assert.ok(routes.has("POST /api/scu/state"));
  assert.ok(routes.has("POST /api/scu/control"));
  assert.ok(routes.has("POST /api/scu/client-hello"));
  assert.ok(routes.has("GET /api/scu/probe"));
  assert.ok(routes.has("GET /api/scu/preview"));
});

test("client hello records the executed bundle revision and rejects a missing one", async () => {
  const { routes, hellos } = harness();
  const route = routes.get("POST /api/scu/client-hello");
  const response = await route.fetch(
    post("/scu/client-hello", {
      clientRev: "abc123",
      clientVersion: "0.3.0",
      scriptUrl: "http://127.0.0.1:1/plugins/??dsh-super-computer-use/client.js&rev=abc123",
      capabilities: ["dev-sync-hello", "ignored", 7],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(hellos.length, 1);
  assert.equal(hellos[0].clientRev, "abc123");
  assert.deepEqual(hellos[0].capabilities, ["dev-sync-hello", "ignored"]);
  assert.match(hellos[0].scriptUrl, /rev=abc123/);

  const missing = await route.fetch(post("/scu/client-hello", { clientVersion: "0.3.0" }));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "invalid_client_rev");
  assert.equal(hellos.length, 1);
});

test("state returns this chat's snapshot and marks the client present", async () => {
  const { routes, registry, manager, bridge } = harness();
  registry.claim("chat-a");
  manager.start = () => {};
  const response = await routes.get("POST /api/scu/state").fetch(
    post("/scu/state", { hostSessionId: "chat-a" }),
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.snapshot.hostSessionId, "chat-a");
  assert.equal(bridge.clientPresent("chat-a"), true);
  assert.equal(bridge.clientPresent("chat-b"), false);
});

test("state requires a host session and rejects malformed or oversized bodies", async () => {
  const { routes } = harness();
  const route = routes.get("POST /api/scu/state");
  const missing = await route.fetch(post("/scu/state", {}));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "no_host_session");

  const malformed = await route.fetch(post("/scu/state", "{"));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "invalid_json");

  const oversized = await route.fetch(post("/scu/state", { hostSessionId: "x".repeat(5000) }));
  assert.equal(oversized.status, 413);
});

test("control stop is owner-checked, revision-checked and idempotent", async () => {
  const { routes, registry, manager } = harness();
  const claim = registry.claim("chat-a");
  manager.activeSession = { windowId: 12, pid: 13, app: "Notes" };
  const route = routes.get("POST /api/scu/control");

  const foreign = await route.fetch(
    post("/scu/control", {
      hostSessionId: "chat-b",
      cuSessionId: claim.cuSessionId,
      command: "stop",
    }),
  );
  assert.equal(foreign.status, 403);

  const stale = await route.fetch(
    post("/scu/control", {
      hostSessionId: "chat-a",
      cuSessionId: "cu-old",
      command: "stop",
    }),
  );
  assert.equal(stale.status, 409);

  const unknown = await route.fetch(
    post("/scu/control", { hostSessionId: "chat-a", command: "explode" }),
  );
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, "unknown_command");

  const first = await route.fetch(
    post("/scu/control", {
      hostSessionId: "chat-a",
      cuSessionId: claim.cuSessionId,
      command: "stop",
    }),
  );
  assert.equal(first.status, 200);
  assert.equal((await first.json()).cleanupState, "unknown");

  const again = await route.fetch(
    post("/scu/control", {
      hostSessionId: "chat-a",
      cuSessionId: claim.cuSessionId,
      command: "stop",
    }),
  );
  assert.equal(again.status, 200);
  assert.equal((await again.json()).alreadyStopped, true);
});

test("probe delivers the first chunk before the second and is removed by config", async () => {
  const { routes } = harness();
  const response = await routes.get("GET /api/scu/probe").fetch(
    new Request("http://127.0.0.1/api/scu/probe", { method: "GET" }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const reader = response.body.getReader();
  const started = Date.now();
  const first = await reader.read();
  const firstAt = Date.now() - started;
  assert.equal(first.done, false);
  assert.ok(firstAt < 250, `first chunk arrived after ${firstAt}ms`);
  const second = await reader.read();
  assert.equal(second.done, false);
  assert.ok(Date.now() - started >= 250);
  await reader.cancel();

  const routes2 = new Map();
  const ctx2 = {
    get: () => ({
      fetch: {
        register(route) {
          routes2.set(`${route.methods.join(",")} ${route.path}`, route);
          return () => routes2.delete(`${route.methods.join(",")} ${route.path}`);
        },
      },
    }),
  };
  const manager2 = { activeSession: null, sessionGeneration: 0 };
  const registry2 = createCuUiRegistry({ manager: manager2 });
  const bridge2 = installHarnessUiBridge(ctx2, {
    registry: registry2,
    manager: manager2,
    config: { uiProbe: false },
  });
  assert.equal(routes2.has("GET /api/scu/probe"), false);
  assert.equal(routes2.has("POST /api/scu/state"), true);
  bridge2.dispose();
});

// Round-2 client lifecycle regressions (review R1/R2 + state-visibility S5).
//
// These tests load the real client.js factory and drive the real SessionStore /
// PreviewController with a controllable fetch, createImageBitmap, canvas and
// timer queue. No source-text matching: the behaviour is observed on the
// classes the Harness actually mounts.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../client.js", import.meta.url), "utf8");

function loadClient(fetchImpl) {
  let factory;
  const timers = new Map();
  const images = [];
  let nextTimer = 1;
  let now = 1000;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          factory = definition.factory;
        },
      },
    },
    console,
    performance: { now: () => now },
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn, ms, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fetch: (...args) => fetchImpl(...args),
    createImageBitmap(blob) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      images.push({ blob, resolve, reject });
      return promise;
    },
    AbortController,
    Blob,
    TextDecoder,
    TextEncoder,
    Response,
    ReadableStream,
    location: { protocol: "http:", host: "127.0.0.1:55984" },
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: "client.js" });
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
    useState: (initial) => [initial, () => {}],
    useSyncExternalStore: (_subscribe, get) => get(),
  };
  const module = factory(() => react);
  assert.ok(module.__test?.SessionStore, "client must expose its classes to the test build");
  const renderNode = (node) => {
    if (node === null || node === undefined || node === false) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(renderNode).join(" ");
    if (typeof node.type === "function") {
      return renderNode(node.type({ ...node.props, children: node.children }));
    }
    const children = [...(node.children ?? [])];
    if (node.props?.children !== undefined) children.push(node.props.children);
    return children.map(renderNode).join(" ");
  };
  if (module.__test.CuCard) {
    module.__test.CuCard.ctx = { get: () => undefined };
  }
  if (module.__test.Overlay) {
    module.__test.Overlay.ctx = { get: () => undefined };
  }
  if (module.__test.ControlDeck) {
    module.__test.ControlDeck.ctx = { get: () => undefined };
  }
  const expandVNodes = (node, out = []) => {
    if (node === null || node === undefined || node === false) return out;
    if (Array.isArray(node)) {
      for (const child of node) expandVNodes(child, out);
      return out;
    }
    if (typeof node.type === "function") {
      return expandVNodes(node.type({ ...node.props, children: node.children }), out);
    }
    out.push(node);
    expandVNodes(node.children ?? [], out);
    if (node.props?.children !== undefined) expandVNodes(node.props.children, out);
    return out;
  };
  return {
    SessionStore: module.__test.SessionStore,
    PreviewController: module.__test.PreviewController,
    CuCard: module.__test.CuCard,
    Overlay: module.__test.Overlay,
    ControlDeck: module.__test.ControlDeck,
    activeDeckSession: module.__test.activeDeckSession,
    storeFor: module.__test.storeFor,
    expansion: module.__test.expansion,
    render: (node) => renderNode(node),
    findVNodes: (node, predicate) => expandVNodes(node).filter(predicate),
    timers,
    images,
    advance(ms) {
      now += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [id, timer] of [...timers]) {
          if (timer.at <= now) {
            timers.delete(id);
            timer.fn();
            fired = true;
          }
        }
      }
    },
    async flush() {
      for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const flushHost = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function abortablePending() {
  const pending = [];
  const fetch = (url, options = {}) => {
    if (url.includes("/api/scu/probe")) {
      // The probe is unrelated to lifecycle; answer it immediately so the
      // request log contains only state/control traffic.
      return Promise.resolve({ ok: false, status: 503, text: async () => "" });
    }
    return new Promise((resolve, reject) => {
      const entry = {
        url,
        options,
        settled: false,
        aborted: false,
        resolve(value) {
          if (entry.settled) return;
          entry.settled = true;
          resolve(value);
        },
        reject(error) {
          if (entry.settled) return;
          entry.settled = true;
          reject(error);
        },
      };
      options.signal?.addEventListener("abort", () => {
        entry.aborted = true;
        entry.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
      pending.push(entry);
    });
  };
  return { fetch, pending };
}

function snapshot(overrides = {}) {
  return {
    version: 1,
    revision: 1,
    hostSessionId: "chat-a",
    cuSessionId: "cu-a",
    ownerSessionId: "chat-a",
    targetGeneration: 1,
    target: { pid: 42, windowId: 7, appName: "Notes" },
    state: "running",
    label: "click",
    action: { tool: "cu_click", kind: "click", ok: null, verified: null },
    previewStatus: "unavailable",
    cleanupState: "clean",
    startedAt: 1,
    updatedAt: 2,
    error: null,
    ...overrides,
  };
}

function stateResponse(value) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, snapshot: value }),
  };
}

function previewStream() {
  let controller;
  const body = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  return {
    response: { ok: true, status: 200, body },
    enqueue(bytes) {
      controller.enqueue(bytes);
    },
  };
}

function frame(meta, jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])) {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const bytes = new Uint8Array(8 + metaBytes.length + jpeg.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, metaBytes.length, false);
  view.setUint32(4, jpeg.length, false);
  bytes.set(metaBytes, 8);
  bytes.set(jpeg, 8 + metaBytes.length);
  return bytes;
}

function meta(overrides = {}) {
  return {
    version: 1,
    frameId: "1",
    cuSessionId: "cu-a",
    targetGeneration: 1,
    geometryVersion: 1,
    ...overrides,
  };
}

function watch(store) {
  store.watching = true;
  store.previewWanted = true;
  store.notify();
  store.preview.open();
}

function canvas() {
  const state = { draws: 0, width: 2, height: 2 };
  state.getContext = () => ({
    drawImage() {
      state.draws += 1;
    },
    clearRect() {},
  });
  return state;
}

// ---------------------------------------------------------------- R1 --------

test("R1: unmounting while a poll is pending leaves no timer and no alive poller", async () => {
  const network = abortablePending();
  const h = loadClient(network.fetch);
  const store = new h.SessionStore("chat-a");
  const unmount = store.mount();
  assert.equal(network.pending.length, 1);
  unmount();
  assert.equal(h.timers.size, 0, "stop clears the timer synchronously");
  await h.flush();
  assert.equal(h.timers.size, 0, "the aborted request's finally must not schedule a new poll");
  assert.equal(store.mounts, 0);
  assert.equal(store.inflight, false);
});

test("R1: a late settlement of the old epoch cannot host a new epoch", async () => {
  const network = abortablePending();
  const h = loadClient(network.fetch);
  const store = new h.SessionStore("chat-a");
  const unmount = store.mount();
  const first = network.pending[0];
  unmount();
  store.mount();
  const second = network.pending[1];
  assert.ok(second, "remount starts a new poll");

  // The old request settles after the new one started.
  first.reject(new Error("old_network_error"));
  await h.flush();
  assert.equal(store.inflight, true, "the old finally must not clear the new epoch's inflight flag");
  assert.equal(store.connection, "connecting", "the old error must not mark the new epoch reconnecting");
  assert.equal(h.timers.size, 0, "the old finally must not schedule a duplicate poll");

  second.resolve(stateResponse(snapshot()));
  await h.flush();
  assert.equal(store.connection, "live");
  assert.equal(h.timers.size, 1, "the new epoch schedules exactly one next poll");
});

test("R1: 50 mount/unmount cycles leave no timer and one poller at most", async () => {
  const network = abortablePending();
  const h = loadClient(network.fetch);
  const store = new h.SessionStore("chat-a");
  for (let i = 0; i < 50; i += 1) {
    const unmount = store.mount();
    await h.flush();
    assert.ok(network.pending.filter((entry) => !entry.settled && !entry.aborted).length <= 1);
    unmount();
    await h.flush();
    assert.equal(h.timers.size, 0, `cycle ${i} left a timer`);
  }
  assert.equal(store.mounts, 0);
  assert.equal(store.inflight, false);
  assert.equal(network.pending.filter((entry) => !entry.settled && !entry.aborted).length, 0);
});

// ---------------------------------------------------------------- R2 --------

test("R2: a decode for target A cannot paint after target B opened", async () => {
  const streams = [];
  const previews = [];
  const fetch = (url, options = {}) => {
    if (url.includes("/api/scu/preview")) {
      const stream = previewStream();
      streams.push(stream);
      return Promise.resolve(stream.response);
    }
    if (url.includes("/api/scu/state")) {
      return new Promise(() => {});
    }
    return Promise.reject(Object.assign(new Error("not found"), { status: 404 }));
  };
  const h = loadClient(fetch);
  const store = new h.SessionStore("chat-a");
  const surface = canvas();
  store.preview.attach(surface);
  store.previewWanted = true;
  store.active = true;
  store.applySnapshot(snapshot({ cuSessionId: "cu-a", targetGeneration: 1, revision: 1 }));
  watch(store);
  await h.flush();

  streams[0].enqueue(frame(meta({ frameId: "A" })));
  await h.flush();
  assert.equal(store.preview.decoding, true, "A's bitmap decode is pending");
  assert.equal(h.images.length, 1);

  // Target switch: B opens while A's decode is still pending.
  store.applySnapshot(snapshot({ cuSessionId: "cu-a", targetGeneration: 2, revision: 2 }));
  await h.flush();
  assert.ok(streams.length >= 2, "B opened its own stream");
  assert.equal(store.preview.frames, 0, "a new stream starts with zero frames");

  const bitmapA = { width: 2, height: 2, closed: 0, close() { this.closed += 1; } };
  h.images[0].resolve(bitmapA);
  await h.flush();
  assert.equal(surface.draws, 0, "A's late bitmap must not be painted");
  assert.equal(bitmapA.closed, 1, "the dropped bitmap is closed exactly once");
  assert.equal(store.preview.decoding, false);
  assert.notEqual(store.previewInfo.status, "live");

  // B's own first frame does paint.
  streams[streams.length - 1].enqueue(frame(meta({ frameId: "B", targetGeneration: 2 })));
  await h.flush();
  const bitmapB = { width: 2, height: 2, closed: 0, close() { this.closed += 1; } };
  h.images[h.images.length - 1].resolve(bitmapB);
  await h.flush();
  assert.equal(surface.draws, 1);
  assert.equal(store.previewInfo.status, "live");
  assert.equal(store.preview.frames, 1);
});

test("R2: a cuSessionId change with the same generation also retires the old decode", async () => {
  const streams = [];
  const fetch = (url) => {
    if (url.includes("/api/scu/preview")) {
      const stream = previewStream();
      streams.push(stream);
      return Promise.resolve(stream.response);
    }
    return new Promise(() => {});
  };
  const h = loadClient(fetch);
  const store = new h.SessionStore("chat-a");
  const surface = canvas();
  store.preview.attach(surface);
  store.previewWanted = true;
  store.active = true;
  store.applySnapshot(snapshot({ cuSessionId: "cu-a", targetGeneration: 1, revision: 1 }));
  watch(store);
  await h.flush();
  streams[0].enqueue(frame(meta({ cuSessionId: "cu-a", targetGeneration: 1 })));
  await h.flush();

  // Same generation, new cuSessionId: a new session, not a new target.
  store.applySnapshot(snapshot({ cuSessionId: "cu-b", targetGeneration: 1, revision: 2 }));
  await h.flush();
  h.images[0].resolve({ width: 2, height: 2, closed: 0, close() {} });
  await h.flush();
  assert.equal(surface.draws, 0, "the old session's decode must not paint into the new session");
  assert.notEqual(store.previewInfo.status, "live");
});

test("R2: a stream with no first frame is aborted and explicitly degraded", async () => {
  const streams = [];
  let previewRequests = 0;
  const fetch = (url) => {
    if (url.includes("/api/scu/preview")) {
      previewRequests += 1;
      const stream = previewStream();
      streams.push(stream);
      return Promise.resolve(stream.response);
    }
    return new Promise(() => {});
  };
  const h = loadClient(fetch);
  const store = new h.SessionStore("chat-a");
  store.preview.attach(canvas());
  store.previewWanted = true;
  store.active = true;
  store.applySnapshot(snapshot({ cuSessionId: "cu-a", targetGeneration: 1 }));
  watch(store);
  await h.flush();
  assert.equal(store.preview.running, true);

  h.advance(1500);
  await h.flush();
  assert.equal(store.preview.running, false, "a first-frame timeout must end this stream, not wait forever");
  assert.equal(store.preview.abort, null);
  assert.equal(store.previewInfo.status, "stale");
  assert.equal(store.previewInfo.reason, "first_frame_timeout");

  // The same identity is not respawned in a tight loop.
  const before = previewRequests;
  store.preview.open();
  await h.flush();
  assert.equal(previewRequests, before);
});

// ------------------------------------------------------- state visibility -----

test("previewInfo, connection and stopping are visible through one React snapshot", async () => {
  const network = abortablePending();
  const h = loadClient(network.fetch);
  const store = new h.SessionStore("chat-a");
  store.mount();
  const base = store.getSnapshot();

  store.setPreview({ status: "live", fps: 9 });
  const afterPreview = store.getSnapshot();
  assert.notEqual(afterPreview, base, "a preview change must produce a new snapshot object");
  assert.equal(afterPreview.previewInfo.status, "live");
  assert.equal(afterPreview.previewInfo.fps, 9);

  store.setConnection("reconnecting");
  const afterConnection = store.getSnapshot();
  assert.notEqual(afterConnection, afterPreview);
  assert.equal(afterConnection.connection, "reconnecting");
  assert.equal(afterConnection.lastError, null);

  const stopping = store.stopControl("stop");
  const duringStop = store.getSnapshot();
  assert.notEqual(duringStop, afterConnection);
  assert.equal(duringStop.stopping, true);

  const control = network.pending.find(
    (entry) => entry.url.includes("/api/scu/control") && entry.settled !== true,
  );
  assert.ok(control, "stopControl posted to the control route");
  control.resolve({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ ok: true, state: "stopped", cleanupState: "unknown", snapshot: snapshot({ state: "stopped", cleanupState: "unknown", revision: 5 }) }),
  });
  await stopping;
  await h.flush();
  const afterStop = store.getSnapshot();
  assert.equal(afterStop.stopping, false);
  assert.equal(afterStop.state, "stopped");
  assert.equal(afterStop.revision, 5, "the authoritative snapshot wins over revision+1");
});

test("the real card renders preview, stopping and error state from the latest snapshot", () => {
  const network = abortablePending();
  const h = loadClient(network.fetch);
  const store = h.storeFor("chat-a");
  store.active = true;
  store.applySnapshot(snapshot({ state: "running" }));
  store.watching = true;
  store.previewWanted = true;
  store.setPreview({ status: "live", fps: 9 });
  store.stopping = true;
  store.notify();

  const first = h.render({ type: h.CuCard, props: { sessionId: "chat-a" }, children: [] });
  assert.match(first, /Live/);
  assert.match(first, /Stopping/);

  store.stopping = false;
  store.setPreview({ status: "stale", reason: "no_frames" });
  store.lastError = "stop_failed";
  store.notify();
  const second = h.render({ type: h.CuCard, props: { sessionId: "chat-a" }, children: [] });
  assert.match(second, /Last frame/);
  assert.match(second, /stop_failed/);
});

test("the default card is a compact strip; Watch is the user action that starts video", async () => {
  const network = abortablePending();
  const h = loadClient(network.fetch);
  const store = h.storeFor("chat-a");
  store.active = true;
  store.applySnapshot(snapshot({ state: "running" }));
  const strip = h.render({ type: h.CuCard, props: { sessionId: "chat-a" }, children: [] });
  assert.match(strip, /Watch/);
  assert.doesNotMatch(strip, /No preview/);
  assert.doesNotMatch(strip, /Hide preview/);
  assert.equal(store.preview.running, false, "no preview may be started before the user asks");

  store.toggleWatch();
  assert.equal(store.watching, true);
  const card = h.render({ type: h.CuCard, props: { sessionId: "chat-a" }, children: [] });
  assert.match(card, /Hide preview/);
  assert.equal(store.preview.running, true, "Watch opens the real stream");
  store.stop();
});

test("mounting never sends the diagnostic probe request", async () => {
  const network = abortablePending();
  const h = loadClient(network.fetch);
  const store = new h.SessionStore("chat-a");
  store.mount();
  assert.equal(network.pending.some((entry) => entry.url.includes("/api/scu/probe")), false);
  store.stop();
});

test("stop and expand have exactly one activation handler", () => {
  const h = loadClient(abortablePending().fetch);
  const store = h.storeFor("chat-a");
  store.active = true;
  store.applySnapshot(snapshot({ state: "running" }));
  const tree = { type: h.CuCard, props: { sessionId: "chat-a" }, children: [] };
  const stop = h.findVNodes(tree, (node) => node.props?.className === "scu-stop");
  assert.equal(stop.length, 1);
  assert.equal(typeof stop[0].props.onClick, "function");
  assert.equal(stop[0].props.onPointerDown, undefined, "one semantic trigger, not pointerdown+click");

  store.toggleWatch();
  const expand = h.findVNodes(tree, (node) => node.props?.className === "scu-icon");
  assert.ok(expand.length >= 1);
  assert.equal(expand[0].props.onPointerDown, undefined);
  assert.equal(typeof expand[0].props.onClick, "function");
  store.stop();
});

test("overlay diagnostics are collapsed by default", () => {
  const h = loadClient(abortablePending().fetch);
  const store = h.storeFor("chat-a");
  store.active = true;
  store.applySnapshot(snapshot({ state: "running" }));
  h.expansion.set("chat-a");
  const tree = { type: h.Overlay, props: {}, children: [] };
  const details = h.findVNodes(tree, (node) => node.props?.className === "scu-diag");
  assert.equal(details.length, 1);
  assert.equal(details[0].type, "details");
  assert.notEqual(details[0].props.open, true, "diagnostics must not be permanently open");
  const text = h.render(tree);
  assert.match(text, /Details/);
  h.expansion.set(null);
  store.stop();
});

test("card and overlay canvases both paint; detaching one leaves the other", async () => {
  const streams = [];
  const fetch = (url) => {
    if (url.includes("/api/scu/preview")) {
      const stream = previewStream();
      streams.push(stream);
      return Promise.resolve(stream.response);
    }
    return new Promise(() => {});
  };
  const h = loadClient(fetch);
  const store = new h.SessionStore("chat-a");
  const card = canvas();
  const overlay = canvas();
  store.preview.attach(card);
  store.preview.attach(overlay);
  store.active = true;
  store.applySnapshot(snapshot({ cuSessionId: "cu-a", targetGeneration: 1 }));
  store.watching = true;
  store.previewWanted = true;
  store.notify();
  store.preview.open();
  await h.flush();
  streams[0].enqueue(frame(meta({ frameId: "one" })));
  await h.flush();
  h.images[0].resolve({ width: 2, height: 2, close() {} });
  await h.flush();
  assert.equal(card.draws, 1);
  assert.equal(overlay.draws, 1, "the expanded overlay must also receive the frame");

  store.preview.detach(overlay);
  streams[0].enqueue(frame(meta({ frameId: "two" })));
  await h.flush();
  h.images[h.images.length - 1].resolve({ width: 2, height: 2, close() {} });
  await h.flush();
  assert.equal(card.draws, 2, "closing the overlay must not stop the card canvas");
  assert.equal(overlay.draws, 1);
  store.stop();
});

test("two targets own separate preview streams; stopping A leaves B live", async () => {
  const network = abortablePending();
  const streams = [];
  const fetch = (url, options = {}) => {
    if (url.includes("/api/scu/preview")) {
      const stream = previewStream();
      streams.push({ stream, url });
      return Promise.resolve(stream.response);
    }
    return network.fetch(url, options);
  };
  const h = loadClient(fetch);
  const store = h.storeFor("chat-a");
  store.active = true;
  store.previewWanted = true;
  const targets = [
    {
      targetId: "101:11", pid: 101, windowId: 11, appName: "Alpha", state: "running",
      label: "click", action: { tool: "cu_click", kind: "click" }, previewStatus: "unavailable",
      cleanupState: "clean", active: true, targetGeneration: 4,
    },
    {
      targetId: "202:22", pid: 202, windowId: 22, appName: "Beta", state: "running",
      label: "click", action: { tool: "cu_click", kind: "click" }, previewStatus: "unavailable",
      cleanupState: "clean", active: true, targetGeneration: 7,
    },
  ];
  store.applySnapshot(snapshot({
    revision: 1,
    targetGeneration: 4,
    target: { targetId: "101:11", pid: 101, windowId: 11, appName: "Alpha" },
    targets,
  }));
  store.watching = true;
  store.previewWanted = true;
  store.notify();
  store.openPreviews();
  await h.flush();
  assert.equal(streams.length, 2, "each target gets its own preview stream");
  assert.ok(streams[0].url.includes("targetId=101%3A11"), streams[0].url);
  assert.ok(streams[1].url.includes("targetId=202%3A22"), streams[1].url);

  const view = store.getSnapshot();
  assert.equal(view.targets.length, 2);
  assert.equal(view.targets.find((target) => target.targetId === "101:11").active, true);
  const card = h.render({ type: h.CuCard, props: { sessionId: "chat-a" }, children: [] });
  assert.match(card, /Alpha/);
  assert.match(card, /Beta/);
  assert.match(card, /Stop all|全部停止/);

  // User stops A through the per-target button.
  const stopping = store.stopControl("stop", "101:11");
  const control = network.pending.find(
    (entry) => entry.url.includes("/api/scu/control") && entry.settled !== true,
  );
  assert.ok(control, "per-target stop posted to the control route");
  const body = JSON.parse(control.options.body);
  assert.equal(body.targetId, "101:11");
  assert.equal(body.pause, false);
  control.resolve({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        ok: true,
        state: "running",
        cleanupState: "unknown",
        snapshot: snapshot({
          revision: 2,
          targetGeneration: 7,
          target: { targetId: "202:22", pid: 202, windowId: 22, appName: "Beta" },
          targets: [
            { ...targets[0], state: "stopped", active: false, cleanupState: "unknown" },
            targets[1],
          ],
        }),
      }),
  });
  await stopping;
  await h.flush();
  assert.equal(store.previewFor("101:11").running, false, "A's stream is closed");
  assert.equal(store.previewFor("202:22").running, true, "B's stream is untouched");
  assert.equal(store.getSnapshot().targets.find((target) => target.targetId === "101:11").active, false);

  // Stop-all closes the remaining stream and freezes both targets.
  const all = store.stopControl("stop", null);
  const allControl = network.pending.find(
    (entry) => entry.url.includes("/api/scu/control") && entry.settled !== true,
  );
  const allBody = JSON.parse(allControl.options.body);
  assert.equal(allBody.targetId, undefined);
  assert.equal(allBody.pause, true);
  allControl.resolve({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        ok: true,
        state: "cleanup_unknown",
        cleanupState: "unknown",
        snapshot: snapshot({
          revision: 3,
          state: "cleanup_unknown",
          target: null,
          targetGeneration: 0,
          targets: [
            { ...targets[0], state: "cleanup_unknown", active: false },
            { ...targets[1], state: "cleanup_unknown", active: false },
          ],
        }),
      }),
  });
  await all;
  await h.flush();
  assert.equal(store.previewFor("202:22").running, false);
  assert.equal(store.getSnapshot().state, "cleanup_unknown");
  store.stop();
});

test("the DSH Control Deck appears automatically and binds to the active conversation", () => {
  const h = loadClient(abortablePending().fetch);
  const store = h.storeFor("chat-deck");
  store.active = true;
  const targets = [
    {
      targetId: "a:7", pid: 1, windowId: 7, appName: "Alpha", state: "running",
      active: true, targetGeneration: 1, action: { kind: "click" }, previewStatus: "unavailable",
    },
    {
      targetId: "b:8", pid: 2, windowId: 8, appName: "Beta", state: "waiting",
      active: true, targetGeneration: 1, action: { kind: "type" }, previewStatus: "unavailable",
    },
  ];
  store.applySnapshot(snapshot({
    revision: 1,
    targetGeneration: 1,
    target: { targetId: "a:7", pid: 1, windowId: 7, appName: "Alpha" },
    targets,
  }));
  assert.equal(store.getSnapshot().deckVisible, true, "an active session opens the deck without Watch");
  h.activeDeckSession.set("chat-deck");
  const deckNode = { type: h.ControlDeck, props: {}, children: [] };
  const deck = h.render(deckNode);
  assert.match(deck, /Alpha/);
  assert.match(deck, /Beta/);
  // Control-only deck: one float per target, and no aggregate pill repeating the
  // composer card's "Stop all" (three boxes for two targets read as clutter).
  assert.doesNotMatch(deck, /2 targets/);
  assert.doesNotMatch(deck, /Stop all/);
  const floats = h.findVNodes(
    deckNode,
    (node) => typeof node.type === "string" && /scu-float/.test(node.props?.className ?? "") &&
      node.type === "article",
  );
  assert.equal(floats.length, 2, "one floating panel per target, not one shared deck");

  // Closing one target's float must leave the sibling float alive.
  store.dismissTargetPanel("a:7");
  const afterOneClose = h.render(deckNode);
  assert.doesNotMatch(afterOneClose, /Alpha/);
  assert.match(afterOneClose, /Beta/);
  assert.equal(store.getSnapshot().hiddenTargetIds.includes("a:7"), true);

  // Reopen all, then hide the whole stack.
  store.showDeck();
  store.dismissDeck();
  assert.equal(store.getSnapshot().deckVisible, false);
  h.activeDeckSession.set(null);
  store.stop();
});

test("a visible native preview is the only surface: no composer card, no duplicate float", () => {
  const h = loadClient(abortablePending().fetch);
  const store = h.storeFor("chat-native");
  store.active = true;
  const targets = [
    {
      targetId: "a:7", pid: 1, windowId: 7, appName: "Alpha", state: "running",
      active: true, targetGeneration: 1, action: { kind: "click" },
      previewStatus: "live",
      nativePreview: { status: "live", visible: true, windowId: 9001 },
    },
  ];
  store.applySnapshot(snapshot({
    revision: 1,
    targetGeneration: 1,
    target: { targetId: "a:7", pid: 1, windowId: 7, appName: "Alpha" },
    targets,
  }));
  const card = h.render({ type: h.CuCard, props: { sessionId: "chat-native" }, children: [] });
  assert.equal(card.trim(), "", "the native preview window replaces the in-chat card");

  h.activeDeckSession.set("chat-native");
  const deck = h.render({ type: h.ControlDeck, props: {}, children: [] });
  assert.equal(deck.trim(), "", "no per-target page float when the native preview exists");
  h.activeDeckSession.set(null);
  store.stop();
});

test("closing the native preview restores the in-chat fallback control", () => {
  const h = loadClient(abortablePending().fetch);
  const store = h.storeFor("chat-native-closed");
  store.active = true;
  const targets = [
    {
      targetId: "a:7", pid: 1, windowId: 7, appName: "Alpha", state: "running",
      active: true, targetGeneration: 1, action: { kind: "click" },
      previewStatus: "closed",
      nativePreview: { status: "closed", visible: false, windowId: 9001 },
    },
  ];
  store.applySnapshot(snapshot({
    revision: 1,
    targetGeneration: 1,
    target: { targetId: "a:7", pid: 1, windowId: 7, appName: "Alpha" },
    targets,
  }));
  const card = h.render({ type: h.CuCard, props: { sessionId: "chat-native-closed" }, children: [] });
  assert.match(card, /Alpha/);
  assert.match(card, /Watch/);
  assert.match(card, /Stop all|全部停止/);
  store.stop();
});

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPreviewBridge } from "../lib/preview-stream.mjs";
import { createCuUiRegistry } from "../lib/cu-ui-session.mjs";

function makeFakeEngine({
  frames = 2,
  hang = false,
  badHeader = false,
  exitDelay = 50,
  frameGapMs = 0,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scu-preview-"));
  const path = join(dir, "cu-preview");
  const script = `#!/usr/bin/env node
const frames = ${frames};
const hang = ${hang ? "true" : "false"};
const badHeader = ${badHeader ? "true" : "false"};
const exitDelay = ${exitDelay};
const frameGapMs = ${frameGapMs};
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const session = value("--session");
const generation = Number(value("--generation"));
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
function frame(i) {
  const meta = Buffer.from(JSON.stringify({
    version: 1, frameId: String(i), cuSessionId: session,
    targetGeneration: generation, geometryVersion: 1,
    capturedAtNs: Date.now() * 1e6, pixelWidth: 2, pixelHeight: 2,
    contentRect: { x: 0, y: 0, width: 2, height: 2 },
  }));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(meta.length, 0);
  header.writeUInt32BE(jpeg.length, 4);
  return Buffer.concat([header, meta, jpeg]);
}
function emit(i) {
  if (i > frames) return;
  process.stdout.write(frame(i));
  if (i < frames) {
    if (frameGapMs > 0) setTimeout(() => emit(i + 1), frameGapMs);
    else emit(i + 1);
  }
}
if (badHeader) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(999999999, 0);
  header.writeUInt32BE(1, 4);
  process.stdout.write(header);
} else {
  emit(1);
}
if (hang) setInterval(() => {}, 1000); else setTimeout(() => process.exit(0), exitDelay);
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function setup(engine, { binary = true } = {}) {
  const manager = {
    activeSession: { windowId: 41, pid: 42, app: "Notes" },
    sessionGeneration: 3,
    inputGateClosed: false,
    resolvePreviewBinary: () => (binary ? engine : join(engine, "missing")),
    resolveBinaryPath: () => (binary ? engine : join(engine, "missing")),
    async stopVisualSession() {
      return { ok: true, cleanupState: "unknown" };
    },
    cancelInFlight() {
      return 0;
    },
  };
  const registry = createCuUiRegistry({ manager });
  const claim = registry.claim("chat-a");
  const routes = new Map();
  const logs = [];
  const preview = createPreviewBridge({ manager, log: (line) => logs.push(line) });
  preview.register({
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
    registry,
  });
  return { manager, registry, claim, route: routes.get("/api/scu/preview"), logs, preview };
}

function request(claim, session, generation, options = {}) {
  const query = new URLSearchParams({
    hostSessionId: "chat-a",
    cuSessionId: session ?? claim.cuSessionId,
    generation: String(generation ?? 3),
  });
  return new Request(`http://127.0.0.1/api/scu/preview?${query}`, { method: "GET", ...options });
}

async function drain(response) {
  const reader = response.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

async function readFrames(response, count) {
  const reader = response.body.getReader();
  let buffer = Buffer.alloc(0);
  const frames = [];
  while (frames.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = Buffer.concat([buffer, Buffer.from(value)]);
    for (;;) {
      if (buffer.length < 8) break;
      const metaLength = buffer.readUInt32BE(0);
      const jpegLength = buffer.readUInt32BE(4);
      if (buffer.length < 8 + metaLength + jpegLength) break;
      const meta = JSON.parse(buffer.subarray(8, 8 + metaLength).toString());
      frames.push({ meta, jpeg: buffer.subarray(8 + metaLength, 8 + metaLength + jpegLength) });
      buffer = buffer.subarray(8 + metaLength + jpegLength);
    }
  }
  await reader.cancel();
  return frames;
}

function readWithTimeout(reader, ms) {
  return Promise.race([
    reader.read(),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms)),
  ]);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assertDrained(preview) {
  const stats = preview.stats();
  assert.equal(stats.activeChildren, 0, `active children: ${JSON.stringify(stats)}`);
  assert.equal(stats.owners, 0, `owner entries: ${JSON.stringify(stats)}`);
  assert.equal(stats.streams, 0, `live stream states: ${JSON.stringify(stats)}`);
  assert.equal(stats.timers, 0, `guard intervals: ${JSON.stringify(stats)}`);
  assert.equal(stats.pendingFrames, 0, `pending frames: ${JSON.stringify(stats)}`);
}

const pidOf = (logs) => {
  const line = logs.find((entry) => entry.includes("preview child pid="));
  return line ? Number(line.match(/pid=(\d+)/)[1]) : null;
};

test("preview streams matching frames from the bound target only", async () => {
  const { route, claim } = setup(makeFakeEngine({ frames: 3 }));
  const response = await route.fetch(request(claim));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/x-scu-frames");
  const frames = await readFrames(response, 3);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].meta.cuSessionId, claim.cuSessionId);
  assert.equal(frames[0].meta.targetGeneration, 3);
  assert.deepEqual([...frames[0].jpeg], [0xff, 0xd8, 0xff, 0xd9]);
});

test("preview rejects a foreign owner, a stale session and a stale generation", async () => {
  const { route, claim } = setup(makeFakeEngine({ frames: 1 }));
  const foreign = new Request("http://127.0.0.1/api/scu/preview?hostSessionId=chat-b&cuSessionId=x&generation=3");
  const foreignResponse = await route.fetch(foreign);
  assert.equal(foreignResponse.status, 403);

  const stale = await route.fetch(request({ cuSessionId: "cu-old" }, "cu-old", 3));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "stale_session");

  const staleGeneration = await route.fetch(request(claim, claim.cuSessionId, 2));
  assert.equal(staleGeneration.status, 409);
  assert.equal((await staleGeneration.json()).error, "stale_generation");
});

test("a bad frame header fails closed without forwarding garbage", async () => {
  const { route, claim, logs, preview } = setup(makeFakeEngine({ badHeader: true }));
  const response = await route.fetch(request(claim));
  const text = await new Response(response.body).text();
  assert.equal(text, "");
  assert.ok(logs.some((line) => line.includes("invalid_frame_header")));
  await wait(100);
  assertDrained(preview);
});

test("natural helper exit releases the child, interval, owner entry and status", async () => {
  const { route, claim, registry, preview } = setup(makeFakeEngine({ frames: 1, exitDelay: 10 }));
  const response = await route.fetch(request(claim));
  await drain(response);
  await wait(30);
  assertDrained(preview);
  assert.equal(registry.snapshot("chat-a").previewStatus, "unavailable");
});

test("a spawn error releases every resource and does not leave a timer", async () => {
  const engine = makeFakeEngine({ frames: 1 });
  chmodSync(engine, 0o644);
  const { route, claim, registry, preview } = setup(engine);
  const response = await route.fetch(request(claim));
  await drain(response);
  await wait(100);
  assertDrained(preview);
  assert.equal(registry.snapshot("chat-a").previewStatus, "unavailable");
});

test("a helper killed with SIGTERM is finalized exactly once", async () => {
  const { route, claim, logs, preview } = setup(makeFakeEngine({ frames: 1, hang: true }));
  const response = await route.fetch(request(claim));
  const reader = response.body.getReader();
  try {
    await reader.read();
    const pid = pidOf(logs);
    assert.ok(pid);
    process.kill(pid, "SIGTERM");
    await wait(250);
    assertDrained(preview);
    assert.equal(logs.filter((line) => line.includes("preview finalize")).length, 1);
  } finally {
    preview.dispose();
    await reader.cancel().catch(() => {});
  }
});

test("aborting the request signal finalizes the stream and kills the helper", async () => {
  const { route, claim, preview } = setup(makeFakeEngine({ frames: 1, hang: true }));
  const controller = new AbortController();
  const response = await route.fetch(request(claim, undefined, undefined, { signal: controller.signal }));
  const reader = response.body.getReader();
  try {
    await reader.read();
    controller.abort();
    await wait(250);
    assertDrained(preview);
  } finally {
    preview.dispose();
    await reader.cancel().catch(() => {});
  }
});

test("cancelling the response kills the helper process", async () => {
  const { route, claim, logs, preview } = setup(makeFakeEngine({ frames: 1, hang: true }));
  const response = await route.fetch(request(claim));
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await wait(300);
  assert.ok(logs.some((line) => line.includes("preview stream cancelled by consumer")));
  const pid = pidOf(logs);
  assert.ok(pid, "child pid was logged");
  await wait(1200);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `helper ${pid} should be dead`);
  assertDrained(preview);
});

test("dispose finalizes every active stream", async () => {
  const { route, claim, preview } = setup(makeFakeEngine({ frames: 1, hang: true }));
  const response = await route.fetch(request(claim));
  const reader = response.body.getReader();
  await reader.read();
  assert.equal(preview.stats().activeChildren, 1);
  preview.dispose();
  await wait(50);
  assertDrained(preview);
  await reader.cancel().catch(() => {});
});

test("a replaced stream's old finalize cannot overwrite the new stream's previewStatus", async () => {
  const { route, claim, registry, logs, preview } = setup(makeFakeEngine({ frames: 1, hang: true }));
  const first = await route.fetch(request(claim));
  const firstReader = first.body.getReader();
  const firstFrame = await readWithTimeout(firstReader, 1000);
  assert.equal(firstFrame.timedOut, undefined);
  assert.equal(registry.snapshot("chat-a").previewStatus, "live");
  const oldPid = pidOf(logs);

  // Same owner + session: the bridge replaces stream 1 with stream 2.
  const second = await route.fetch(request(claim));
  const secondReader = second.body.getReader();
  const secondFrame = await readWithTimeout(secondReader, 1000);
  assert.equal(secondFrame.timedOut, undefined);

  // The old child's exit arrives after stream 2 is live. It must not report
  // "unavailable" for the new stream.
  await wait(150);
  assert.equal(registry.snapshot("chat-a").previewStatus, "live");
  assert.equal(preview.stats().activeChildren, 1);
  assert.equal(preview.stats().owners, 1);
  let oldAlive = true;
  try {
    process.kill(oldPid, 0);
  } catch {
    oldAlive = false;
  }
  assert.equal(oldAlive, false, "the replaced helper must be dead");
  preview.dispose();
  await secondReader.cancel().catch(() => {});
});

test("backpressure keeps one pending latest frame instead of the oldest queued frame", async () => {
  const { route, claim, preview, logs } = setup(makeFakeEngine({ frames: 5, hang: true }));
  const response = await route.fetch(request(claim));
  const reader = response.body.getReader();
  try {
    // A slow reader: wait until the bridge has received all five frames while
    // the consumer asked for nothing. Only one frame may be waiting, and it
    // must be the latest one.
    const deadline = Date.now() + 2000;
    while (preview.stats().framesReceived < 5 && Date.now() < deadline) await wait(20);
    assert.equal(preview.stats().framesReceived, 5);
    assert.equal(preview.stats().pendingFrames, 1, "exactly one frame may be pending");
    assert.ok(
      preview.stats().pendingBytes <= 2 * 1024 * 1024 + 16 * 1024,
      "pending memory must stay bounded to one frame",
    );
    const first = await reader.read();
    assert.equal(first.done, false);
    const second = await readWithTimeout(reader, 1000);
    assert.equal(second.timedOut, undefined, "the stream must not stall after the consumer resumes");
    const buffer = Buffer.from(second.value);
    const metaLength = buffer.readUInt32BE(0);
    const meta = JSON.parse(buffer.subarray(8, 8 + metaLength).toString());
    assert.equal(meta.frameId, "5", "the resumed reader must receive the latest frame, not frame 2");
  } finally {
    preview.dispose();
    await reader.cancel().catch(() => {});
  }
});

test("100 natural exit/reconnect cycles leave no timer, child or owner entry", async () => {
  const { route, claim, preview } = setup(makeFakeEngine({ frames: 1, exitDelay: 5 }));
  for (let i = 0; i < 100; i += 1) {
    const response = await route.fetch(request(claim));
    await drain(response);
    await wait(10);
    assertDrained(preview);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPreviewBridge } from "../lib/preview-stream.mjs";
import { createCuUiRegistry } from "../lib/cu-ui-session.mjs";

function makeFakeEngine({ frames = 2, hang = false, badHeader = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scu-preview-"));
  const path = join(dir, "cu-preview");
  const script = `#!/usr/bin/env node
const frames = ${frames};
const hang = ${hang ? "true" : "false"};
const badHeader = ${badHeader ? "true" : "false"};
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
if (badHeader) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(999999999, 0);
  header.writeUInt32BE(1, 4);
  process.stdout.write(header);
} else {
  for (let i = 1; i <= frames; i++) process.stdout.write(frame(i));
}
if (hang) setInterval(() => {}, 1000); else setTimeout(() => process.exit(0), 50);
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function setup(engine) {
  const manager = {
    activeSession: { windowId: 41, pid: 42, app: "Notes" },
    sessionGeneration: 3,
    inputGateClosed: false,
    resolvePreviewBinary: () => engine,
    resolveBinaryPath: () => engine,
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
  return {
    manager,
    registry,
    claim,
    route: routes.get("/api/scu/preview"),
    logs,
    preview,
  };
}

function request(claim, session, generation) {
  const query = new URLSearchParams({
    hostSessionId: "chat-a",
    cuSessionId: session ?? claim.cuSessionId,
    generation: String(generation ?? 3),
  });
  return new Request(`http://127.0.0.1/api/scu/preview?${query}`, { method: "GET" });
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
  const { route, claim, logs } = setup(makeFakeEngine({ badHeader: true }));
  const response = await route.fetch(request(claim));
  const text = await new Response(response.body).text();
  assert.equal(text, "");
  assert.ok(logs.some((line) => line.includes("invalid_frame_header")));
});

test("cancelling the response kills the helper process", async () => {
  const { route, claim, logs } = setup(makeFakeEngine({ frames: 1, hang: true }));
  const response = await route.fetch(request(claim));
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(logs.some((line) => line.includes("preview stream cancelled by consumer")));
  const pidLine = logs.find((line) => line.includes("preview child pid="));
  assert.ok(pidLine, "child pid was logged");
  const pid = Number(pidLine.match(/pid=(\d+)/)[1]);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `helper ${pid} should be dead`);
});

// What the model gets told about itself. Two questions used to be unanswerable
// from inside a tool call: "can this route actually see an image?" and "which
// app am I already driving?" — so the model guessed at both, and a screenshot
// that only landed on disk looked exactly like one it had seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('stub')]);
const jpegBase64 = JPEG.toString('base64');

const SNAPSHOT = {
  ok: true,
  pid: 42,
  app: 'Probe',
  count: 1,
  nodes: [{ ref: 'k0.0', role: 'AXButton', title: '导入', x: 10, y: 10, w: 80, h: 24 }],
};

function harness({ exec, llm, attachments, agent } = {}) {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(name) {
      if (name === 'llm') return llm ?? undefined;
      if (name === 'attachments') {
        if (attachments) return attachments;
        return {
          imageLimits: { mediaTypes: ['image/jpeg'], maxImageBytes: 1e7, maxMessageImageBytes: 1e7 },
          async saveImage({ mediaType, name }) {
            return { attachmentId: 'att-cap', mediaType, bytes: 4, width: 10, height: 10, name };
          },
        };
      }
      return undefined;
    },
  };
  const manager = new CuSessionManager();
  manager._cursorWrite = () => true;
  manager.writeActivity = () => {};
  manager.exec = exec ?? (async (argv) => (argv[0] === 'snapshot' ? SNAPSHOT : { ok: true }));
  // Never spawn a real capture daemon from a unit test: it outlives the runner.
  manager.captureShotViaDaemon = async () => ({ ok: false, error: 'no_daemon' });
  manager.stopCaptureDaemon = () => {};
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });
  const run = {
    signal: new AbortController().signal,
    agent: agent ?? { options: { provider: 'p', model: 'm' } },
  };
  return { manager, call: (name, args) => tools.get(name).execute(args, run) };
}

test('cu_status says whether the route can see images, and why not', async () => {
  const withVision = harness({
    llm: { async resolveModelInfo() { return { inputModalities: ['text', 'image'] }; } },
  });
  const yes = await withVision.call('cu_status', {});
  assert.equal(yes.vision.supported, true);
  assert.equal(yes.vision.model, 'm');

  const textOnly = harness({
    llm: { async resolveModelInfo() { return { inputModalities: ['text'] }; } },
  });
  const no = await textOnly.call('cu_status', {});
  assert.equal(no.vision.supported, false);

  const unknown = harness({
    llm: { async resolveModelInfo() { throw new Error('catalogue offline'); } },
  });
  const maybe = await unknown.call('cu_status', {});
  assert.equal(maybe.vision.supported, null, 'unknown must not read as yes');
  assert.match(maybe.vision.reason, /catalogue offline/);
});

test('a preview the model cannot receive reports why, not just a path', async () => {
  const { call } = harness({
    llm: { async resolveModelInfo() { return { inputModalities: ['text'] }; } },
    attachments: {
      imageLimits: { mediaTypes: ['image/jpeg'], maxImageBytes: 1e7, maxMessageImageBytes: 1e7 },
      async saveImage() { throw new Error('should not be called'); },
    },
    async exec(argv) {
      if (argv[0] === 'shot') {
        return {
          ok: true,
          base64: jpegBase64,
          mimeType: 'image/jpeg',
          size: { width: 10, height: 10 },
          scale: 1,
        };
      }
      return { ok: true };
    },
  });
  const result = await call('cu_screenshot', { windowId: 7 });
  // The route is text-only, so the bytes go to disk and the reason is stated.
  assert.equal(result.ok, true);
  assert.equal(result.imageDelivered, false);
  assert.match(result.imageDeliveryReason, /does not accept image input/);
  assert.ok(result.path);
});

test('cu_status reports the last image delivery, including a refusal', async () => {
  const { manager, call } = harness({
    llm: { async resolveModelInfo() { return { inputModalities: ['text'] }; } },
    async exec(argv) {
      if (argv[0] === 'shot') {
        return {
          ok: true,
          base64: jpegBase64,
          mimeType: 'image/jpeg',
          size: { width: 10, height: 10 },
          scale: 1,
        };
      }
      return { ok: true };
    },
  });
  await call('cu_screenshot', { windowId: 7 });
  const status = await call('cu_status', {});
  assert.equal(status.lastImage.delivered, false);
  assert.ok(status.lastImage.at);
  assert.match(status.lastImage.reason, /image input/);
  assert.equal(manager.lastImage.delivered, false);
});

test('an active session supplies the target so calls stop repeating it', async () => {
  const seen = [];
  const { call, manager } = harness({
    async exec(argv) {
      seen.push(argv.join(' '));
      if (argv[0] === 'snapshot') return SNAPSHOT;
      return { ok: true, action: 'click', x: 5, y: 6 };
    },
  });
  manager.activeSession = { windowId: 7, pid: 42 };

  const snap = await call('cu_snapshot', { full: true });
  assert.equal(snap.ok, true);
  assert.equal(snap.pid, 42);
  assert.equal(snap.windowId, 7);
  assert.ok(seen[0].includes('--pid 42') && seen[0].includes('--window 7'), seen[0]);

  const click = await call('cu_click', { ref: 'k0.0', observe: false });
  assert.equal(click.ok, true);
  assert.ok(seen.at(-1).includes('--pid 42'), seen.at(-1));
});

test('without a session the target is still required', async () => {
  const { call } = harness({});
  // The adapter must not invent a pid; the engine argv builder refuses instead.
  await assert.rejects(async () => {
    await call('cu_snapshot', {});
  }, /snapshot requires pid/);
});

test('an explicit target still wins over the session', async () => {
  const seen = [];
  const { call, manager } = harness({
    async exec(argv) {
      seen.push(argv.join(' '));
      return { ok: true };
    },
  });
  manager.activeSession = { windowId: 7, pid: 42 };
  await call('cu_screenshot', { windowId: 99, screen: true });
  assert.ok(seen[0].includes('--screen'), seen[0]);
});

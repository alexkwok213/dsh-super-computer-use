import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';

test('captureShotViaDaemon returns the engine shot shape', async () => {
  const m = new CuSessionManager();
  // Stub the transport so the test exercises shape adaptation, not SCK.
  m._captureRequest = async (req) => ({
    ok: true,
    base64: 'AAAA',
    mimeType: 'image/jpeg',
    width: 1280,
    height: 900,
    origin: { x: 10, y: 20 },
    size: { width: 640, height: 450 },
    scale: 2,
  });
  const shot = await m.captureShotViaDaemon({ windowId: 7, maxDimension: 1280, format: 'jpeg', quality: 0.76 });
  assert.equal(shot.ok, true);
  assert.equal(shot.mimeType, 'image/jpeg');
  assert.equal(shot.size.width, 640);
  assert.equal(shot.scale, 2);
  assert.equal(shot.origin.x, 10);
});

test('captureShotViaDaemon reports failure without throwing', async () => {
  const m = new CuSessionManager();
  m._captureRequest = async () => ({ ok: false, error: 'capture_failed' });
  const shot = await m.captureShotViaDaemon({ windowId: 7 });
  assert.equal(shot.ok, false);
  assert.equal(shot.error, 'capture_failed');
});

test('captureShotViaDaemon degrades when the daemon cannot start', async () => {
  const m = new CuSessionManager();
  m._captureRequest = async () => { throw new Error('spawn failed'); };
  const shot = await m.captureShotViaDaemon({ windowId: 7 });
  assert.equal(shot.ok, false);
  assert.equal(shot.error, 'capture_daemon_unavailable');
});

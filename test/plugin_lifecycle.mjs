import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';

test('batch clamps a trailing wait to the remaining deadline', async () => {
  const m = new CuSessionManager();
  const t0 = Date.now();
  const res = await m.executeBatch({
    steps: [{ action: 'wait', ms: 5000 }],
    timeoutMs: 200,
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, false);
  assert.equal(res.error, 'batch_timeout');
  // Must not sleep the full 5 s past a 200 ms budget.
  assert.ok(elapsed < 700, `elapsed ${elapsed}ms should be near the budget`);
});

test('batch reports a step that exceeded the deadline as outcome unknown', async () => {
  const m = new CuSessionManager();
  m.exec = async () => {
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true };
  };
  const res = await m.executeBatch({
    pid: 1,
    steps: [{ action: 'click', x: 1, y: 1 }, { action: 'click', x: 2, y: 2 }],
    timeoutMs: 150,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'batch_timeout');
  assert.equal(res.outcomeUnknown, true);
});

test('dockDsh defaults to true: DSH shrinks right and the target takes the left', async () => {
  const m = new CuSessionManager();
  const calls = [];
  m.exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'windows') {
      return { ok: true, windows: [
        { windowId: 7, pid: 5, app: 'Target', bounds: { x: 10, y: 40, width: 800, height: 600 } },
        { windowId: 9, pid: 1, app: 'DeepSeek Harness', bounds: { x: 0, y: 30, width: 1728, height: 1000 } },
      ] };
    }
    return { ok: true };
  };
  m.spawnIndicator = () => null;
  m.writeActivity = () => {};
  m.clearPauseLatch = () => {};
  m.stopVisualIndicatorsOnly = async () => {};
  // dockDsh omitted -> the documented default is to dock: a target window
  // narrower than the display would otherwise sit under the DSH panel.
  await m.startVisualSession({ windowId: 7 });

  const moves = calls.filter((argv) => argv[0] === 'movewindow');
  const arg = (argv, flag) => Number(argv[argv.indexOf(flag) + 1]);
  assert.equal(moves.length, 2, `expected a DSH dock and a target move: ${JSON.stringify(calls)}`);

  const dshMove = moves.find((argv) => arg(argv, '--window') === 9);
  assert.ok(dshMove, 'DSH window must be docked');
  // 1728-wide display -> DSH keeps the right 576 pt, the target gets 1152.
  assert.equal(arg(dshMove, '--x'), 1152);
  assert.equal(arg(dshMove, '--w'), 576);
  assert.equal(arg(dshMove, '--y'), 30);
  assert.equal(arg(dshMove, '--h'), 970);

  const targetMove = moves.find((argv) => arg(argv, '--window') === 7);
  assert.ok(targetMove, 'target window must take the left side');
  assert.equal(arg(targetMove, '--x'), 0);
  assert.equal(arg(targetMove, '--w'), 1152);

  // The dock is reversible: the pre-dock geometry has to be remembered.
  assert.deepEqual(m.dockedDshWindow, { windowId: 9, x: 0, y: 30, w: 1728, h: 1000 });
  assert.deepEqual(m.savedTargetBounds, { windowId: 7, x: 10, y: 40, w: 800, h: 600 });
});

test('repeated same-target start is idempotent (no redundant resume/move)', async () => {
  const m = new CuSessionManager();
  const calls = [];
  m.exec = async (argv) => {
    calls.push(argv[0]);
    if (argv[0] === 'windows') {
      return { ok: true, windows: [
        { windowId: 7, pid: 5, app: 'Target', bounds: { x: 10, y: 40, width: 800, height: 600 } },
        { windowId: 9, pid: 1, app: 'DeepSeek Harness', bounds: { x: 0, y: 30, width: 1728, height: 1000 } },
      ] };
    }
    return { ok: true };
  };
  m.spawnIndicator = () => null;
  m.writeActivity = () => {};
  m.clearPauseLatch = () => {};
  m.stopVisualIndicatorsOnly = async () => {};
  await m.startVisualSession({ windowId: 7, dockDsh: true });
  const firstResume = calls.filter((c) => c === 'resume').length;
  calls.length = 0;
  await m.startVisualSession({ windowId: 7, dockDsh: true });
  // Second identical start must not re-resume nor re-move windows.
  assert.equal(calls.filter((c) => c === 'resume').length, 0, `re-resumed: ${calls}`);
  assert.equal(calls.filter((c) => c === 'movewindow').length, 0, `re-moved: ${calls}`);
  assert.ok(firstResume >= 0);
});

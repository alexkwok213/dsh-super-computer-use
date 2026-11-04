// Read-only service concurrency probe. Creates and closes only CU's demo window.
import { spawn } from 'node:child_process';
import { CuSessionManager } from '../../lib/core.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const manager = new CuSessionManager();
const status = await manager.getStatus(AbortSignal.timeout(5000));
if (!status.ok) throw new Error(`service unavailable: ${status.error}`);
const binary = manager.resolveBinaryPath();
const demo = spawn(binary, ['demo', '--seconds', '30'], { stdio: 'ignore' });
let window;
const samples = [];
try {
  for (let i = 0; i < 25; i++) {
    const list = await manager.exec(['windows']);
    window = list.windows?.find(w => w.pid === demo.pid && w.title === 'cu demo window');
    if (window) break;
    await sleep(100);
  }
  if (!window) throw new Error('isolated demo window did not appear');
  for (let round = 0; round < 3; round++) {
    const idleAt = performance.now();
    await manager.getStatus(AbortSignal.timeout(5000));
    const idleStatusMs = Math.round(performance.now() - idleAt);
    const slowAt = performance.now();
    const slow = manager.exec([
      'expect', '--pid', String(window.pid), '--window', String(window.windowId),
      '--find', '__review_absent_control_1289__', '--timeout', '2400',
    ]).then(result => ({ error: result.error, elapsedMs: Math.round(performance.now() - slowAt) }));
    await sleep(300);
    const statusAt = performance.now();
    const during = await manager.getStatus(AbortSignal.timeout(6000));
    const statusDuringExpectMs = Math.round(performance.now() - statusAt);
    const expectResult = await slow;
    samples.push({ round: round + 1, idleStatusMs, statusDuringExpectMs, statusOk: during.ok, expectResult });
  }
  console.log(JSON.stringify({ serviceBuildId: status.buildId, binary, samples }, null, 2));
} finally {
  demo.kill('SIGTERM');
}

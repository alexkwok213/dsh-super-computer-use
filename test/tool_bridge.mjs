import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startToolBridge, callToolBridge } from '../lib/tool-bridge.mjs';

test('authenticated bridge invokes registered tools and delivers actual image bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scu-bridge-'));
  let bridge;
  try {
    const tools = new Map([['cu_test', { name: 'cu_test', description: 'test', parameters: { value: { type: 'number', required: true } },
      async execute(args, exec) {
        assert.match(exec.agent.id, /^external:/);
        await exec.externalImages.save(new Uint8Array([1, 2, 3]), 'image/png');
        return { ok: true, echoed: args.value };
      } }]]);
    bridge = await startToolBridge({ stateDir: dir, tools, version: 'test' });
    assert.equal(statSync(bridge.descriptorPath).mode & 0o777, 0o600);
    const list = await callToolBridge(dir, { method: 'tools/list', clientId: 'test' });
    assert.equal(list.tools[0].name, 'cu_test');
    assert.deepEqual(list.tools[0].inputSchema.required, ['value']);
    assert.equal(list.tools[0].inputSchema.properties.value.required, undefined);
    const result = await callToolBridge(dir, { method: 'tools/call', clientId: 'test', name: 'cu_test', arguments: { value: 4 } });
    assert.equal(result.result.echoed, 4);
    assert.deepEqual(result.images, [{ type: 'image', mimeType: 'image/png', data: 'AQID' }]);
    const descriptor = JSON.parse(readFileSync(bridge.descriptorPath));
    await assert.rejects(callToolBridge(dir, { method: 'tools/call', clientId: 'test', name: 'cu_test' }, { token: descriptor.token + 'bad' }), /unauthorized/);
    await assert.rejects(callToolBridge(dir, { method: 'tools/call', clientId: 'test', name: 'strokes' }), /unknown_tool/);
  } finally { await bridge?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('disconnect aborts in-flight input and disposal removes its own discovery files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scu-bridge-'));
  let bridge, sawAbort = false, started;
  const began = new Promise(resolve => { started = resolve; });
  try {
    bridge = await startToolBridge({ stateDir: dir, version: 'test', tools: new Map([
      ['cu_wait', { name: 'cu_wait', parameters: {}, execute: async (_, exec) => {
        started();
        await new Promise(resolve => exec.signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true }));
        return { ok: false, error: 'cancelled' };
      } }],
    ]) });
    const abort = new AbortController();
    const pending = callToolBridge(dir, { method: 'tools/call', clientId: 'test', name: 'cu_wait' }, { signal: abort.signal });
    await began;
    abort.abort();
    await assert.rejects(pending);
    for (let n = 0; n < 50 && !sawAbort; n++) await new Promise(r => setTimeout(r, 10));
    assert.equal(sawAbort, true);
    await bridge.dispose();
    await assert.rejects(callToolBridge(dir, { method: 'tools/list', clientId: 'test' }), /bridge_unavailable/);
  } finally { await bridge?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('MCP stdio forwards tool calls through the Host and preserves image blocks', async () => {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const dir = mkdtempSync(join(tmpdir(), 'scu-bridge-'));
  let bridge, child;
  try {
    bridge = await startToolBridge({ stateDir: dir, version: 'test', tools: new Map([
      ['cu_test', { name: 'cu_test', parameters: { value: { type: 'number' } }, async execute(args, exec) {
        await exec.externalImages.save(new Uint8Array([9, 8, 7]), 'image/png');
        return { ok: true, value: args.value };
      } }],
    ]) });
    child = spawn(process.execPath, ['bin/dsh-mcp.mjs'], { env: { ...process.env, CU_DSH_STATE_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = new Map();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { const message = JSON.parse(line); responses.get(message.id)?.(message); });
    const rpc = (id, method, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP timeout')), 3000);
      responses.set(id, value => { clearTimeout(timer); responses.delete(id); resolve(value); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const init = await rpc(1, 'initialize', {});
    assert.equal(init.result.serverInfo.name, 'dsh-super-computer-use');
    const list = await rpc(2, 'tools/list', {});
    assert.equal(list.result.tools[0].inputSchema.properties.value.type, 'number');
    const painted = await rpc(3, 'tools/call', { name: 'cu_test', arguments: { value: 5 } });
    assert.equal(JSON.parse(painted.result.content[0].text).value, 5);
    assert.deepEqual(painted.result.content[1], { type: 'image', mimeType: 'image/png', data: 'CQgH' });
    await bridge.dispose();
    const gone = await rpc(4, 'tools/call', { name: 'cu_test', arguments: {} });
    assert.equal(gone.result.isError, true);
    assert.match(gone.result.content[0].text, /bridge_unavailable/);
    child.stdin.end();
    lines.close();
  } finally { child?.kill(); await bridge?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('explicit stop is serviced while a drawing request is still running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scu-bridge-'));
  let bridge, release, started;
  const began = new Promise(resolve => { started = resolve; });
  try {
    const waiting = new Promise(resolve => { release = resolve; });
    bridge = await startToolBridge({ stateDir: dir, version: 'test', tools: new Map([
      ['cu_paint', { name: 'cu_paint', parameters: {}, async execute() { started(); await waiting; return { ok: false, error: 'stopped' }; } }],
      ['cu_session', { name: 'cu_session', parameters: {}, async execute() { release(); return { ok: true }; } }],
    ]) });
    const paint = callToolBridge(dir, { method: 'tools/call', clientId: 'test', name: 'cu_paint' });
    await began;
    const stop = callToolBridge(dir, { method: 'tools/call', clientId: 'test', name: 'cu_session', arguments: { action: 'stop' } });
    const outcome = await Promise.race([stop, new Promise(resolve => setTimeout(() => resolve(null), 300))]);
    release(); await paint; await stop;
    assert.ok(outcome, 'stop must not be queued behind paint');
  } finally { release?.(); await bridge?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

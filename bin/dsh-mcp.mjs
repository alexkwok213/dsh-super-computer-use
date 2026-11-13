#!/usr/bin/env node
// Stdio/one-shot client only. Requires the live DSH plugin-owned bridge.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callToolBridge } from '../lib/tool-bridge.mjs';

const stateDir = process.env.CU_DSH_STATE_DIR ?? join(homedir(), '.cu');
const clientId = process.env.CU_DSH_CLIENT_ID ?? randomUUID();
const active = new Map();
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
async function invoke(name, args, signal = controller.signal) {
  return callToolBridge(stateDir, { method: 'tools/call', clientId, name, arguments: args }, { signal });
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
if (process.argv[2] === '--call') {
  let body = '';
  for await (const line of input) body += line;
  try {
    const response = await invoke(process.argv[3], body.trim() ? JSON.parse(body) : {});
    process.stdout.write(JSON.stringify(response) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message, actionReplaySafe: false }) + '\n');
    process.exitCode = 1;
  }
} else {
  const send = response => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n');
  async function handle(request) {
    if (request.method === 'notifications/cancelled') { active.get(request.params?.requestId)?.abort(); return; }
    if (request.id === undefined) return;
    const abort = new AbortController();
    active.set(request.id, abort);
    try {
      let result;
      if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dsh-super-computer-use', version: '1' }, instructions: 'Operate through cu_route, cu_discover and cu_session. Native painting must use cu_paint and inspect returned images between strokes. Never fall back to raw cu strokes. Pixel checks never prove the artwork complete.' };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: (await callToolBridge(stateDir, { method: 'tools/list', clientId }, { signal: abort.signal })).tools };
      else if (request.method === 'tools/call') {
        const response = await invoke(request.params?.name, request.params?.arguments ?? {}, abort.signal);
        result = { content: [{ type: 'text', text: JSON.stringify({ ...response.result, bridge: { hostPid: response.hostPid, version: response.version } }) }, ...response.images], isError: response.result?.ok === false };
      } else { send({ id: request.id, error: { code: -32601, message: 'method not found' } }); return; }
      send({ id: request.id, result });
    } catch (error) { send({ id: request.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error.message, actionReplaySafe: false }) }] } }); }
    finally { active.delete(request.id); }
  }
  input.on('line', line => {
    try { void handle(JSON.parse(line)); }
    catch { send({ id: null, error: { code: -32700, message: 'parse error' } }); }
  });
  input.on('close', () => { for (const abort of active.values()) abort.abort(); });
  controller.signal.addEventListener('abort', () => { for (const abort of active.values()) abort.abort(); input.close(); });
}

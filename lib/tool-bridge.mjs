// Plugin-owned authenticated Unix socket. The stdio adapter is only a client;
// it cannot boot a helper, dispatch native commands or survive plugin unload.
import { createServer, createConnection } from 'node:net';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, chmodSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const MAX_REQUEST = 1024 * 1024;
const MAX_RESPONSE = 20 * 1024 * 1024;
const TIMEOUT = 120000;
const descriptorName = 'dsh-tools.json';

function objectSchema(parameters) {
  const required = Object.entries(parameters).filter(([, value]) => value.required === true).map(([key]) => key);
  const properties = Object.fromEntries(Object.entries(parameters).map(([key, value]) => {
    const { required: flag, ...schema } = value;
    if (Array.isArray(flag)) schema.required = flag;
    if (schema.properties) Object.assign(schema, objectSchema(schema.properties));
    return [key, schema];
  }));
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

export async function startToolBridge({ stateDir, tools, version }) {
  mkdirSync(stateDir, { recursive: true });
  const directory = mkdtempSync(join(stateDir, 'dsh-tools-'));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, 'rpc.sock');
  const descriptorPath = join(stateDir, descriptorName);
  const token = randomBytes(32).toString('hex');
  const connections = new Set();
  let closed = false, queue = Promise.resolve();
  const server = createServer(socket => {
    connections.add(socket);
    const controller = new AbortController();
    socket.setTimeout(TIMEOUT, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => { controller.abort(); connections.delete(socket); });
    let bytes = Buffer.alloc(0), accepted = false;
    socket.on('data', data => {
      if (accepted) return;
      bytes = Buffer.concat([bytes, data]);
      if (bytes.length > MAX_REQUEST) { socket.destroy(); return; }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      accepted = true;
      const execute = async () => {
        if (controller.signal.aborted || closed) return;
        const images = [];
        try {
          const request = JSON.parse(bytes.subarray(0, newline));
          const supplied = Buffer.from(typeof request.token === 'string' ? request.token : '');
          const expected = Buffer.from(token);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('unauthorized');
          if (!/^[a-zA-Z0-9-]{1,80}$/.test(request.clientId ?? '')) throw new Error('invalid_client_id');
          let response;
          if (request.method === 'tools/list') {
            response = { version, hostPid: process.pid, tools: [...tools.values()].map(tool => ({
              name: tool.name, description: tool.description,
              inputSchema: objectSchema(tool.parameters ?? {}),
            })) };
          } else if (request.method === 'tools/call') {
            const tool = tools.get(request.name);
            if (!tool || !request.name.startsWith('cu_')) throw new Error('unknown_tool');
            const result = await tool.execute(request.arguments ?? {}, {
              signal: controller.signal,
              agent: { id: `external:${request.clientId}` },
              externalImages: {
                supported: true,
                // Explicit MCP delivery; never masquerades as a DSH model route.
                async save(data, mimeType) {
                  if (images.length >= 4 || data.length > 12 * 1024 * 1024) throw new Error('image_delivery_limit');
                  images.push({ type: 'image', mimeType, data: Buffer.from(data).toString('base64') });
                  return { delivery: 'mcp_image', captureId: randomUUID() };
                },
              },
            });
            response = { result, images, hostPid: process.pid, version };
          } else throw new Error('unknown_method');
          const encoded = JSON.stringify(response);
          if (Buffer.byteLength(encoded) > MAX_RESPONSE) throw new Error('response_too_large');
          if (!socket.destroyed) socket.end(encoded + '\n');
        } catch (error) {
          if (!socket.destroyed) socket.end(JSON.stringify({ error: String(error?.message ?? error), images }) + '\n');
        }
      };
      // Stop must reach the manager while the operation it cancels is active.
      // This only selects scheduling; execute still authenticates every request.
      let control = false;
      try {
        const request = JSON.parse(bytes.subarray(0, newline));
        control = request.method === 'tools/call' && request.name === 'cu_session' && request.arguments?.action === 'stop';
      } catch { /* execute reports malformed input */ }
      if (control) void execute();
      else queue = queue.catch(() => {}).then(execute);
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
    const temporary = join(directory, 'discovery.json');
    writeFileSync(temporary, JSON.stringify({ socketPath, token, hostPid: process.pid, version }), { mode: 0o600 });
    renameSync(temporary, descriptorPath);
  } catch (error) {
    server.close(); rmSync(directory, { recursive: true, force: true }); throw error;
  }
  return { descriptorPath, async dispose() {
    if (closed) return;
    closed = true;
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    try { if (JSON.parse(readFileSync(descriptorPath)).token === token) rmSync(descriptorPath); } catch { /* a newer generation owns discovery */ }
    rmSync(directory, { recursive: true, force: true });
  } };
}

export async function callToolBridge(stateDir, request, { signal, token } = {}) {
  let descriptor;
  try { descriptor = JSON.parse(readFileSync(join(stateDir, descriptorName))); }
  catch { throw new Error('bridge_unavailable: start DSH with the plugin loaded; do not fall back to raw cu strokes'); }
  return new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.socketPath);
    let bytes = Buffer.alloc(0), settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('bridge_call_aborted: outcome may be unknown; inspect before retrying'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(TIMEOUT, () => finish(new Error('bridge_timeout: outcome may be unknown; inspect before retrying')));
    socket.on('connect', () => {
      const encoded = JSON.stringify({ ...request, token: token ?? descriptor.token });
      if (Buffer.byteLength(encoded) > MAX_REQUEST) { finish(new Error('request_too_large')); return; }
      socket.write(encoded + '\n');
    });
    socket.on('data', data => {
      bytes = Buffer.concat([bytes, data]);
      if (bytes.length > MAX_RESPONSE) { finish(new Error('response_too_large')); return; }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(bytes.subarray(0, newline));
        if (response.error) finish(new Error(response.error)); else finish(null, response);
      } catch (error) { finish(error); }
    });
    socket.on('error', error => finish(new Error(`bridge_unavailable: ${error.code ?? 'transport_error'}; no automatic replay`)));
    socket.on('close', () => finish(new Error('bridge_disconnected: outcome may be unknown; inspect before retrying')));
  });
}

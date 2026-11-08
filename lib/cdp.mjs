// Chrome DevTools Protocol (CDP) stroke injection.
//
// Why this exists: a browser canvas (Canva, Figma, tldraw, …) is a GPU/WebGL
// surface. CGEvent-based pointer injection (`cghidEventTap` or postToPid) is
// filtered by the page's render loop and does not paint; the only reliable way
// to draw is `Input.dispatchMouseEvent` over a CDP session, exactly like
// Codex's `started debugging this browser` path.
//
// This module is dependency-free: it talks the raw CDP websocket protocol with
// the Node global WebSocket (Node >= 22). It discovers the browser endpoint
// from Chrome's DevToolsActivePort file, or accepts an explicit ws URL.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, readlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PROFILE_DIRS = [
  join(homedir(), "Library/Application Support/Google/Chrome"),
  join(homedir(), "Library/Application Support/Microsoft Edge"),
  join(homedir(), "Library/Application Support/Chromium"),
  join(homedir(), "Library/Application Support/BraveSoftware/Brave-Browser"),
];

/** Read <profile>/DevToolsActivePort → { port, path } or null. */
export function readDevToolsActivePort(profileDir) {
  const dir = profileDir || DEFAULT_PROFILE_DIRS.find((d) => existsSync(join(d, "DevToolsActivePort")));
  if (!dir) return null;
  const file = join(dir, "DevToolsActivePort");
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").split("\n");
  const port = Number(lines[0]);
  const path = (lines[1] || "").trim(); // e.g. /devtools/browser/<uuid>
  if (!Number.isFinite(port) || port <= 0 || !path.startsWith("/devtools/")) return null;
  return { port, path, browserUrl: `ws://127.0.0.1:${port}${path}`, profileDir: dir };
}

/** Minimal CDP websocket client with request/response correlation. */
class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message || "cdp_error"} (${msg.error.code ?? "?"})`));
        else resolve(msg.result ?? {});
      }
    });
  }

  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (err) { this.pending.delete(id); reject(err); }
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function openWebSocket(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(new Error("node_websocket_missing: Node >= 22 exposes global WebSocket"));
      return;
    }
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close(); } catch { /* ignore */ } reject(new Error("cdp_connect_timeout")); }
    }, timeoutMs);
    ws.onopen = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(ws); } };
    ws.onerror = (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`cdp_connect_error: ${e?.message || "failed"}`)); }
    };
  });
}

/** Connect to Chrome and attach to the page whose URL contains `urlMatch`. */
export async function connectPage({ wsUrl, urlMatch, targetId, profileDir } = {}) {
  let endpoint = wsUrl;
  let portInfo = null;
  if (!endpoint) {
    portInfo = readDevToolsActivePort(profileDir);
    if (!portInfo) {
      throw new Error(
        "cdp_unavailable: no DevToolsActivePort. Launch Chrome with " +
        "--remote-debugging-port=9222 (same profile keeps logins) and retry, or pass wsUrl.",
      );
    }
    endpoint = portInfo.browserUrl;
  }
  const ws = await openWebSocket(endpoint);
  const client = new CdpClient(ws);
  try {
    const { targetInfos = [] } = await client.send("Target.getTargets", {}, null);
    const pages = targetInfos.filter((t) => t.type === "page");
    let page;
    if (targetId && pages.some((p) => p.targetId === targetId)) {
      page = pages.find((p) => p.targetId === targetId);
    } else if (urlMatch) {
      page = pages.find((p) => (p.url || "").includes(urlMatch));
    }
    if (!page) {
      client.close();
      const list = pages.map((p) => `${p.title} | ${p.url}`).join("\n");
      throw new Error(`cdp_page_not_found: no page matched (${targetId || urlMatch || "any"}). Pages:\n${list}`);
    }
    const { sessionId } = await client.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }, null);
    client.sessionId = sessionId;
    return { client, page, endpoint, portInfo, pages };
  } catch (err) {
    client.close();
    throw err;
  }
}

/**
 * Convert one DrawPlan layer into CSS-pixel polylines.
 * Mirrors engine strokePaths(fromPlan:) so plan geometry is identical; the
 * only difference is the coordinate space (CSS px inside the page viewport).
 */
export function planLayerToStrokes(plan, layerIndex, inset = 0.13) {
  const { x0, y0, sx, sy, layers } = plan;
  const layer = layers.find((l) => l.index === layerIndex) ?? layers[layerIndex];
  if (!layer) throw new Error(`plan_layer_missing: no layer ${layerIndex}`);
  const runs = layer.runs || [];
  const strokes = [];
  for (const run of runs) {
    if (!Array.isArray(run) || run.length < 3) continue;
    const [i0, j, i1] = run;
    const y = y0 + (j + 0.5) * sy;
    let xa = x0 + i0 * sx + inset * sx;
    let xb = x0 + (i1 + 1) * sx - inset * sx;
    if (xb <= xa) { const m = (xa + xb) / 2; xa = m - 0.5; xb = m + 0.5; }
    strokes.push([[xa, y], [xb, y]]);
  }
  return { hex: layer.hex || "", strokes };
}

/** Inject one polyline as mouse pressed/moved/released with a pace between moves. */
async function dispatchPolyline(client, points, paceMs, buttons = 1) {
  const [x0, y0] = points[0];
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, button: "none", buttons: 0 });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons, clickCount: 1 });
  for (let i = 1; i < points.length; i++) {
    if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: points[i][0], y: points[i][1], button: "left", buttons });
  }
  const last = points[points.length - 1];
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last[0], y: last[1], button: "left", buttons: 0, clickCount: 1 });
}

/**
 * Inject a list of polylines over an attached page. Returns counts.
 * Coordinates are CSS px in the page viewport (no screen transform).
 */
export async function paintStrokes(client, strokes, { paceMs = 14, onProgress } = {}) {
  let pts = 0;
  for (let s = 0; s < strokes.length; s++) {
    const strokes_ = strokes[s];
    if (!Array.isArray(strokes_) || strokes_.length < 2) continue;
    await dispatchPolyline(client, strokes_, paceMs);
    pts += strokes_.length;
    if (typeof onProgress === "function" && (s % Math.max(1, Math.floor(strokes.length / 20)) === 0)) {
      onProgress(s, strokes.length);
    }
  }
  return { strokes: strokes.length, points: pts };
}

/** Send a Cmd/Ctrl+Z style undo (best effort) — used to clear a botched layer. */
export async function sendUndo(client, { meta = true } = {}) {
  const modifiers = meta ? 4 : 2; // 4=Meta, 2=Ctrl per CDP Input modifiers bitmask
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
}

// ---------------------------------------------------------------------------
// Persistent connection pool.
//
// Chrome 133+ re-prompts "Allow remote debugging?" for every *new* browser
// debugging connection. Reconnecting once per paint layer therefore nags the
// user on every stroke batch. Caching one attached session per (endpoint,
// page) and reusing it keeps the dialog to at most once per page per Chrome
// run — the practical fix for the repeated-prompt problem.
// ---------------------------------------------------------------------------
const pool = new Map(); // key -> { client, page, endpoint, lastUsed }

function poolKey({ endpoint, targetId, urlMatch }) {
  return `${endpoint}::${targetId || (urlMatch ? `url:${urlMatch}` : "any")}`;
}

/** Connect (or reuse a live cached session). `reuse=false` forces a fresh one. */
export async function acquirePage(opts = {}) {
  const reuse = opts.reuse !== false;
  // Resolve endpoint first so the pool key is stable.
  let endpoint = opts.wsUrl;
  if (!endpoint) {
    const info = readDevToolsActivePort(opts.profileDir);
    if (!info) {
      throw new Error(
        "cdp_unavailable: no DevToolsActivePort. Launch Chrome with " +
        "--remote-debugging-port=9222 (same profile keeps logins) and retry, or pass wsUrl.",
      );
    }
    endpoint = info.browserUrl;
  }
  const key = poolKey({ endpoint, targetId: opts.targetId, urlMatch: opts.urlMatch });
  if (reuse) {
    const cached = pool.get(key);
    if (cached && cached.client.ws.readyState === 1 && !cached.dead) {
      cached.lastUsed = Date.now();
      return cached;
    }
    if (cached) pool.delete(key);
  }
  const conn = await connectPage({ ...opts, wsUrl: endpoint });
  // Detect a dead socket so the next call reconnects cleanly.
  conn.client.ws.addEventListener("close", () => { conn.dead = true; pool.delete(key); });
  conn.dead = false;
  conn.lastUsed = Date.now();
  if (reuse) pool.set(key, conn);
  return conn;
}

/** Drop cached sessions (optionally the one matching a key, else all). */
export function releasePages(opts = {}) {
  let closed = 0;
  for (const [key, conn] of [...pool.entries()]) {
    const match = !opts.endpoint && !opts.urlMatch && !opts.targetId
      ? true
      : (opts.urlMatch ? (conn.page?.url || "").includes(opts.urlMatch) : true);
    if (match) {
      try { conn.client.close(); } catch { /* ignore */ }
      pool.delete(key);
      closed++;
    }
  }
  return closed;
}

/** Number of live cached sessions (for status/diagnostics). */
export function poolSize() {
  let n = 0;
  for (const conn of pool.values()) if (!conn.dead && conn.client.ws.readyState === 1) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Owned debug Chrome.
//
// Chrome 144+ re-prompts "Allow remote debugging?" for every new attached
// session on a user's everyday browser (chrome://inspect#remote-debugging).
// The browser-use / Playwright way avoids that entirely: launch a Chrome with
// a *dedicated* --user-data-dir and --remote-debugging-port. That instance is
// owned by the plugin, its debugging port is trusted for its lifetime, and the
// user's daily Chrome is never touched. Log in to Canva once in this profile
// and it persists across runs.
// ---------------------------------------------------------------------------
const CHROME_APP = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LAUNCHED = new Map(); // profileDir -> { proc, port, startedAt }

/** Read the pid embedded in <profile>/SingletonLock (symlink "host-<pid>") or null. */
function readSingletonLockPid(profileDir) {
  const link = join(profileDir, "SingletonLock");
  try {
    if (!existsSync(link)) return null;
    const target = readlinkSync(link); // e.g. "MacBook-Pro.local-36622"
    const m = /-(\d+)$/.exec(target);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export function defaultDebugProfileDir() {
  return join(process.env.CU_STATE_DIR || join(homedir(), ".cu"), "cdp-profile");
}

/**
 * Copy the user's existing Chrome login state into a dedicated profile so the
 * owned debug Chrome starts already signed in to their sites (Canva etc.).
 *
 * This is the "keep the original browser's records" half of owning a profile:
 * cookies + saved logins + local storage are what carry a web login. Big caches
 * (Service Worker, IndexedDB, GPUCache) are deliberately skipped — they are not
 * login state and would bloat the copy. The daily Chrome must be closed for a
 * fully consistent copy; while it is running we copy the committed SQLite state
 * (safe for cookies/localStorage on the same OS user, which shares the Chrome
 * Safe Storage key).
 *
 * Returns { copied: string[], skipped: string[], source } — never throws on a
 * missing optional file.
 */
export function syncProfileLogin({ sourceProfileDir, destProfileDir, dailyUserDataDir } = {}) {
  const userData = dailyUserDataDir || DEFAULT_PROFILE_DIRS.find((d) => existsSync(join(d, "Default")));
  if (!userData) return { copied: [], skipped: ["no daily Chrome user-data-dir"], source: null };
  const srcDefault = join(userData, "Default");
  if (!existsSync(srcDefault)) return { copied: [], skipped: ["daily Default profile missing"], source: userData };
  const dest = destProfileDir || defaultDebugProfileDir();
  const destDefault = join(dest, "Default");
  mkdirSync(destDefault, { recursive: true });

  // Whole-folder small state plus individual key files.
  const files = ["Cookies", "Cookies-journal", "Login Data", "Login Data-journal", "Web Data", "Web Data-journal", "Preferences", "Secure Preferences", "History"];
  const copied = [];
  const skipped = [];
  for (const name of files) {
    const from = join(srcDefault, name);
    if (!existsSync(from)) { skipped.push(name); continue; }
    try { copyFileSync(from, join(destDefault, name)); copied.push(name); } catch { skipped.push(name); }
  }
  // Local State at the user-data root carries the OS-crypt reference.
  const srcLocalState = join(userData, "Local State");
  if (existsSync(srcLocalState)) {
    try { copyFileSync(srcLocalState, join(dest, "Local State")); copied.push("Local State"); } catch { skipped.push("Local State"); }
  }
  // Local Storage folder (small; may hold site tokens).
  const srcLS = join(srcDefault, "Local Storage");
  if (existsSync(srcLS)) {
    try {
      cpSync(srcLS, join(destDefault, "Local Storage"), { recursive: true });
      copied.push("Local Storage");
    } catch { skipped.push("Local Storage"); }
  }
  return { copied, skipped, source: userData };
}

/** Launch (or return an already-launched) owned debug Chrome; resolve endpoint. */
export async function launchDebugChrome({ profileDir, port = 9333, startUrl, extraArgs = [], timeoutMs = 15000, syncLogin = true, syncLoginFrom } = {}) {
  const dir = profileDir || defaultDebugProfileDir();
  // 1. Same-process memo.
  const existing = LAUNCHED.get(dir);
  if (existing) {
    const info = await waitForDebugPort(existing.port, 3000);
    if (info) return { ...info, launched: existing };
    LAUNCHED.delete(dir);
  }
  // 2. A previous plugin process may have launched it: reconnect to the
  //    persisted/known port if it is already serving. Spawning a second Chrome
  //    on the same --user-data-dir makes the new process hand off to the
  //    existing one and exit (looks like a "flash crash"), so never do that.
  const already = await resolveOwnedEndpoint(dir);
  if (already) {
    LAUNCHED.set(dir, { proc: null, port: already.port, startedAt: Date.now() });
    return { ...already, launched: LAUNCHED.get(dir), loginSync: null, reused: true };
  }
  // 3. Detect a live Chrome owning this profile even if our endpoint file is
  //    stale: the SingletonLock points at <host>-<pid>. If that pid is alive,
  //    reconnect rather than spawn a competing instance.
  const livePid = readSingletonLockPid(dir);
  if (livePid && processAlive(livePid)) {
    // Try a short resolve loop in case it is still bringing the port up.
    for (let i = 0; i < 20; i++) {
      const info = await waitForDebugPort(port, 500);
      if (info) {
        LAUNCHED.set(dir, { proc: null, port: info.port, startedAt: Date.now() });
        return { ...info, launched: LAUNCHED.get(dir), loginSync: null, reused: true };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const chrome = existsSync(CHROME_APP) ? CHROME_APP : "google-chrome";
  // Carry the user's existing logins into the owned profile before first launch so
  // the debug Chrome is pre-signed-in. Only meaningful the first time (a running
  // instance keeps its own cookies); safe to run repeatedly.
  let loginSync = null;
  if (syncLogin) {
    try { loginSync = syncProfileLogin({ destProfileDir: dir, dailyUserDataDir: syncLoginFrom }); }
    catch (err) { loginSync = { copied: [], skipped: [String(err?.message ?? err)], source: null }; }
  }
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    ...extraArgs,
  ];
  if (startUrl) args.push(startUrl);
  const proc = spawn(chrome, args, { detached: true, stdio: "ignore" });
  proc.unref();
  LAUNCHED.set(dir, { proc, port, startedAt: Date.now() });
  const info = await waitForDebugPort(port, timeoutMs);
  if (!info) throw new Error("cdp_launch_timeout: debug Chrome port never opened");
  // Persist the port so later plugin calls (and other processes) can reconnect
  // to the same owned Chrome without relaunching and without a DevToolsActivePort.
  try { writeFileSync(join(dir, ".cdp-endpoint.json"), JSON.stringify({ port, savedAt: Date.now() })); } catch { /* ignore */ }
  return { ...info, launched: LAUNCHED.get(dir), loginSync };
}

/**
 * Resolve the endpoint of an already-running owned debug Chrome for `profileDir`
 * (reads the persisted port and asks /json/version). Returns null if not running.
 */
export async function resolveOwnedEndpoint(profileDir) {
  const dir = profileDir || defaultDebugProfileDir();
  let port = LAUNCHED.get(dir)?.port;
  if (!port) {
    const meta = join(dir, ".cdp-endpoint.json");
    if (existsSync(meta)) {
      try { port = JSON.parse(readFileSync(meta, "utf8")).port; } catch { port = undefined; }
    }
  }
  if (!port) return null;
  return waitForDebugPort(port, 2500);
}

async function waitForDebugPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const j = await res.json();
        if (j.webSocketDebuggerUrl) {
          return { port, path: new URL(j.webSocketDebuggerUrl).pathname, browserUrl: j.webSocketDebuggerUrl };
        }
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function waitForActivePort(dir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readDevToolsActivePort(dir);
    if (info) {
      // Confirm the WS actually accepts connections.
      try {
        const ws = await openWebSocket(info.browserUrl, 1500);
        ws.close();
        return info;
      } catch { /* retry */ }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** True if Chrome is running as an owned debug instance for this profile. */
export function ownedChromeRunning(profileDir) {
  return LAUNCHED.has(profileDir || defaultDebugProfileDir());
}

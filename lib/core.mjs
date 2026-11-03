import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Detect PNG, JPEG, WebP, or GIF from magic bytes.
 * @param {Uint8Array} data
 * @returns {"image/png" | "image/jpeg" | "image/webp" | "image/gif" | undefined}
 */
export function sniffImageMediaType(data) {
  if (!(data instanceof Uint8Array) || data.byteLength < 4) return undefined;
  if (
    data.byteLength >= 8 &&
    data[0] === 137 &&
    data[1] === 80 &&
    data[2] === 78 &&
    data[3] === 71 &&
    data[4] === 13 &&
    data[5] === 10 &&
    data[6] === 26 &&
    data[7] === 10
  ) {
    return "image/png";
  }
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) {
    return "image/jpeg";
  }
  if (
    data.byteLength >= 12 &&
    data[0] === 82 &&
    data[1] === 73 &&
    data[2] === 70 &&
    data[3] === 70 &&
    data[8] === 87 &&
    data[9] === 69 &&
    data[10] === 66 &&
    data[11] === 80
  ) {
    return "image/webp";
  }
  if (
    data.byteLength >= 6 &&
    data[0] === 71 &&
    data[1] === 73 &&
    data[2] === 70 &&
    data[3] === 56 &&
    (data[4] === 55 || data[4] === 57) &&
    data[5] === 97
  ) {
    return "image/gif";
  }
  return undefined;
}

/**
 * Format a snapshot node into a compact single-line string for the LLM.
 * @param {Record<string, any>} node
 * @returns {string}
 */
export function renderNodeLine(node) {
  const parts = [String(node.ref ?? "?"), String(node.role ?? "?")];
  const title = node.title ?? "";
  const value = node.value ?? "";
  if (title !== "") {
    parts.push(JSON.stringify(String(title)));
  }
  if (value !== "" && value !== title) {
    parts.push(`value=${JSON.stringify(String(value))}`);
  }
  if (node.enabled === false) {
    parts.push("disabled");
  }
  if (node.focused === true) {
    parts.push("focused");
  }
  if (
    typeof node.x === "number" &&
    typeof node.y === "number" &&
    typeof node.w === "number" &&
    typeof node.h === "number"
  ) {
    parts.push(
      `@${Math.round(node.x)},${Math.round(node.y)} ${Math.round(node.w)}×${Math.round(node.h)}`
    );
  }
  return parts.join(" ");
}

/**
 * Hide non-target desktop applications to prevent Stage Manager thumbnail churn.
 * @param {string[]} [keepAppNames]
 * @returns {Promise<string[]>}
 */
export async function hideUnrelatedApps(keepAppNames = []) {
  return new Promise((resolve) => {
    const keepList = [...new Set([...keepAppNames, "DeepSeek Harness", "Electron", "Claude CU Bridge"])];
    const script = `
      set keepList to ${JSON.stringify(keepList)}
      set hiddenList to {}
      tell application "System Events"
        set appList to every process whose visible is true
        repeat with p in appList
          set pName to name of p
          if pName is not in keepList then
            try
              set visible of p to false
              copy pName to end of hiddenList
            end try
          end if
        end repeat
      end tell
      return hiddenList
    `;
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.on("close", () => {
      const names = stdout
        .trim()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      resolve(names);
    });
    child.on("error", () => resolve([]));
  });
}

/**
 * Restore applications previously hidden by hideUnrelatedApps.
 * @param {string[]} appNames
 */
export async function restoreHiddenApps(appNames = []) {
  if (!appNames || appNames.length === 0) return;
  return new Promise((resolve) => {
    const script = `
      set restoreList to ${JSON.stringify(appNames)}
      tell application "System Events"
        repeat with pName in restoreList
          try
            tell process pName to set visible to true
          end try
        end repeat
      end tell
    `;
    const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
    child.on("close", resolve);
    child.on("error", resolve);
  });
}

/**
 * Construct a narrow, validated CLI argv array for `/v1/exec`.
 * Defaults mutating actions (`click`, `type`, `key`, `scroll`, `paste`) to `--background`
 * unless `foreground: true` is explicitly passed.
 *
 * @param {string} command
 * @param {Record<string, any>} params
 * @param {CuSessionManager} [manager]
 * @returns {string[]}
 */
export function buildCommandArgv(command, params = {}, manager) {
  const foreground = params.foreground === true;
  const pid = params.pid !== undefined ? Number(params.pid) : undefined;
  const windowId = params.windowId !== undefined ? Number(params.windowId) : undefined;

  switch (command) {
    case "click":
    case "double_click": {
      const argv = ["click"];
      if (params.ref !== undefined) {
        if (!pid) {
          throw new Error("click with ref requires pid");
        }
        argv.push("--ref", String(params.ref), "--pid", String(pid));
        if (windowId !== undefined) {
          argv.push("--window", String(windowId));
        }
        const prov = manager?.resolveRefProvenance(pid, String(params.ref), windowId);
        if (prov?.role) argv.push("--role", String(prov.role));
        if (prov?.title) argv.push("--title", String(prov.title));
      } else {
        if (typeof params.x !== "number" || typeof params.y !== "number") {
          throw new Error("click without ref requires numeric x and y coordinates");
        }
        argv.push("--x", String(params.x), "--y", String(params.y));
        if (pid !== undefined) argv.push("--pid", String(pid));
        if (windowId !== undefined) argv.push("--window", String(windowId));
      }
      if (params.button && params.button !== "left") {
        argv.push("--button", String(params.button));
      }
      const count = command === "double_click" ? 2 : params.count;
      if (count !== undefined && Number(count) > 1) {
        argv.push("--count", String(Number(count)));
      }
      if (!foreground) {
        argv.push("--background");
      }
      if (params.force === true) {
        argv.push("--force");
      }
      return argv;
    }

    case "type": {
      if (typeof params.text !== "string") {
        throw new Error("type requires text string");
      }
      const argv = ["type", "--text", params.text];
      if (pid !== undefined) argv.push("--pid", String(pid));
      if (params.ref !== undefined && pid !== undefined) {
        argv.push("--ref", String(params.ref));
        const prov = manager?.resolveRefProvenance(pid, String(params.ref), windowId);
        if (prov?.role) argv.push("--role", String(prov.role));
        if (prov?.title) argv.push("--title", String(prov.title));
      }
      if (!foreground) {
        argv.push("--background");
      }
      if (params.tryOffstage === true) {
        argv.push("--try-offstage");
      }
      return argv;
    }

    case "setvalue": {
      if (!pid || !params.ref || typeof params.text !== "string") {
        throw new Error("setvalue requires pid, ref, and text");
      }
      const argv = [
        "setvalue",
        "--pid",
        String(pid),
        "--ref",
        String(params.ref),
        "--text",
        params.text,
      ];
      if (windowId !== undefined) argv.push("--window", String(windowId));
      const prov = manager?.resolveRefProvenance(pid, String(params.ref), windowId);
      if (prov?.role) argv.push("--role", String(prov.role));
      if (prov?.title) argv.push("--title", String(prov.title));
      return argv;
    }

    case "action": {
      if (!pid || !params.ref || !params.name) {
        throw new Error("action requires pid, ref, and name");
      }
      const argv = [
        "action",
        "--pid",
        String(pid),
        "--ref",
        String(params.ref),
        "--name",
        String(params.name),
      ];
      if (windowId !== undefined) argv.push("--window", String(windowId));
      const prov = manager?.resolveRefProvenance(pid, String(params.ref), windowId);
      if (prov?.role) argv.push("--role", String(prov.role));
      if (prov?.title) argv.push("--title", String(prov.title));
      if (params.force === true) argv.push("--force");
      return argv;
    }

    case "key": {
      if (!params.name) {
        throw new Error("key requires name (e.g. return, escape, tab)");
      }
      const argv = ["key", "--name", String(params.name)];
      if (params.mods) {
        argv.push("--mods", String(params.mods));
      }
      if (pid !== undefined) argv.push("--pid", String(pid));
      if (windowId !== undefined) argv.push("--window", String(windowId));
      if (!foreground) {
        argv.push("--background");
      }
      if (params.tryOffstage === true) {
        argv.push("--try-offstage");
      }
      return argv;
    }

    case "scroll": {
      const dy = Number(params.dy ?? 0);
      const dx = Number(params.dx ?? 0);
      if (dy === 0 && dx === 0) {
        throw new Error("scroll requires non-zero dy or dx");
      }
      const argv = ["scroll", "--dy", String(dy)];
      if (dx !== 0) argv.push("--dx", String(dx));
      if (typeof params.x === "number" && typeof params.y === "number") {
        argv.push("--x", String(params.x), "--y", String(params.y));
      }
      if (pid !== undefined) argv.push("--pid", String(pid));
      if (windowId !== undefined) argv.push("--window", String(windowId));
      if (!foreground) {
        argv.push("--background");
      }
      return argv;
    }

    case "snapshot": {
      if (!pid) throw new Error("snapshot requires pid");
      const argv = ["snapshot", "--pid", String(pid)];
      if (windowId !== undefined) argv.push("--window", String(windowId));
      if (params.all === true) argv.push("--all");
      if (params.maxNodes !== undefined) {
        argv.push("--max-nodes", String(Math.max(50, Math.min(Number(params.maxNodes), 3000))));
      }
      // Bound the engine's settle loop: a tree that never stops changing (live
      // clock/spinner) would otherwise burn the full 600 ms deadline. Measured
      // identical node counts at 0 vs 2 extra walks on Finder, so the hot path
      // takes a single walk; the plugin's change-driven observe re-reads when the
      // tree actually changes. Callers may raise settle/maxSettleWalks explicitly.
      if (params.settle !== undefined) argv.push("--settle", String(Number(params.settle)));
      // The delta cache compares rendered lines, which never include action
      // lists, so the automatic post-action observe can skip the per-node
      // actionNames IPC (measured ~27% faster on an 800-node tree).
      if (params.noActions === true) argv.push("--no-actions");
      argv.push("--max-settle-walks", String(Number(params.maxSettleWalks ?? 0)));
      return argv;
    }

    case "shot": {
      const argv = ["shot"];
      if (params.screen === true) {
        argv.push("--screen");
        if (params.display !== undefined) argv.push("--display", String(Number(params.display)));
      } else if (windowId !== undefined) {
        argv.push("--window", String(windowId));
      } else {
        throw new Error("shot requires windowId or screen: true");
      }
      const maxDim = Number(params.maxDimension ?? 1280);
      if (maxDim > 0) argv.push("--max-dim", String(maxDim));
      if (params.region) argv.push("--region", String(params.region));
      const format = params.format === "png" ? "png" : "jpeg";
      argv.push("--format", format);
      if (format === "jpeg") {
        argv.push("--quality", String(Number(params.quality ?? 0.76)));
      }
      return argv;
    }

    case "movewindow": {
      if (windowId === undefined) throw new Error("movewindow requires windowId");
      const argv = ["movewindow", "--window", String(windowId)];
      if (typeof params.x === "number" && typeof params.y === "number") {
        argv.push("--x", String(params.x), "--y", String(params.y));
      }
      if (typeof params.width === "number") argv.push("--w", String(params.width));
      if (typeof params.height === "number") argv.push("--h", String(params.height));
      return argv;
    }

    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

/**
 * Manages connection to the local CU service, snapshot deltas, ref provenance,
 * floating capsule/halo indicator processes, and user pause/stop latches.
 */
export class CuSessionManager {
  /**
   * @param {{ stateDir?: string, serviceUrl?: string, token?: string, binaryPath?: string }} [options]
   */
  constructor(options = {}) {
    this.stateDir = options.stateDir ?? join(homedir(), ".cu");
    this.explicitUrl = options.serviceUrl;
    this.explicitToken = options.token;
    this.explicitBinary = options.binaryPath;

    /** @type {boolean} */
    this.pauseLatched = false;

    /** @type {Map<string, { windowId: number | null, refs: Map<string, {ref: string, role: string, title: string, windowId: number | null}>, lines: Map<string, string> }>} */
    this.snapshots = new Map();

    /** @type {Set<import("node:child_process").ChildProcess>} */
    this.indicators = new Set();

    /** @type {import("node:child_process").ChildProcess | null} */
    this.cursorProcess = null;

    /** @type {import("node:child_process").ChildProcess | null} */
    this.captureProcess = null;

    /** @type {{ windowId: number, x: number, y: number, w: number, h: number } | null} */
    this.dockedDshWindow = null;

    /** @type {{ windowId: number, x: number, y: number, w: number, h: number } | null} */
    this.savedTargetBounds = null;

    /** @type {string[]} */
    this.hiddenApps = [];

    /** @type {{ windowId?: number, pid?: number, app?: string, label?: string, startedAt: number } | null} */
    this.activeSession = null;

    /** @type {Promise<any>} */
    this.queue = Promise.resolve();
  }

  /**
   * Read ~/.cu/config.json for port & bearer token.
   */
  readServiceConfig() {
    const configPath = join(this.stateDir, "config.json");
    let port = 47777;
    let token = "";
    try {
      if (existsSync(configPath)) {
        const raw = JSON.parse(readFileSync(configPath, "utf8"));
        if (typeof raw.port === "number" && raw.port > 0) port = raw.port;
        if (typeof raw.token === "string") token = raw.token;
      }
    } catch {
      // ignore read errors
    }
    return {
      baseUrl: this.explicitUrl ?? `http://127.0.0.1:${port}`,
      token: this.explicitToken ?? token,
    };
  }

  /**
   * Locate the prebuilt `cu` binary for non-TCC GUI indicators (`capsule`, `halo`, `demo`).
   */
  resolveBinaryPath() {
    if (this.explicitBinary && existsSync(this.explicitBinary)) {
      return this.explicitBinary;
    }
    if (process.env.CU_BIN && existsSync(process.env.CU_BIN)) {
      return process.env.CU_BIN;
    }
    const candidates = [
      join(homedir(), "Library", "Application Support", "cu", "bin", "cu"),
      "/Applications/Computer Use.app/Contents/MacOS/Computer Use",
      // Bundled engine inside this repository (engine/bin/cu built by engine/build.sh).
      resolve(__dirname, "../engine/bin/cu"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return candidates[0];
  }

  /**
   * Write one JSON line to the persistent agent-cursor overlay's stdin.
   * Silent no-op when no overlay process is running, so cursor feedback can
   * never block or fail a real action.
   * @param {Record<string, any>} command
   */
  _cursorWrite(command) {
    const stream = this.cursorProcess?.stdin;
    if (!stream || stream.destroyed || !stream.writable) return false;
    try {
      stream.write(`${JSON.stringify(command)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Move the visible agent cursor to a global point (top-left origin). */
  showAgentCursor(x, y, { glide = true } = {}) {
    return this._cursorWrite({ cmd: "cursor", x: Number(x), y: Number(y), glide: Boolean(glide) });
  }

  /** Pulse a click ripple at a global point. */
  showClickRipple(x, y) {
    return this._cursorWrite({ cmd: "click", x: Number(x), y: Number(y) });
  }

  /** Toggle the ambient screen-edge aura. */
  setAgentAura(visible) {
    return this._cursorWrite({ cmd: "aura", visible: Boolean(visible) });
  }

  /** Show a short action label next to the agent cursor. */
  showActionLabel(text, x, y) {
    const label = String(text ?? "").slice(0, 28);
    return this._cursorWrite({ cmd: "label", text: label, x: Number(x), y: Number(y) });
  }

  /** Start the persistent cursor overlay once per session. */
  startCursorOverlay() {    if (this.cursorProcess && !this.cursorProcess.killed && this.cursorProcess.exitCode === null) {
      return this.cursorProcess;
    }
    const bin = this.resolveBinaryPath();
    if (!existsSync(bin)) return null;
    try {
      const child = spawn(bin, ["cursor-overlay"], { stdio: ["pipe", "ignore", "ignore"] });
      child.unref();
      child.on("exit", () => {
        if (this.cursorProcess === child) this.cursorProcess = null;
      });
      this.cursorProcess = child;
      return child;
    } catch {
      return null;
    }
  }

  /** Stop the cursor overlay and release its stdin (it exits on EOF). */
  stopCursorOverlay() {
    const child = this.cursorProcess;
    this.cursorProcess = null;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  /**
   * Send one request to the persistent capture daemon and await its JSON reply.
   * The daemon holds a warm SCShareableContent, so steady-state window captures
   * are ~120 ms instead of ~240 ms for a per-shot `screencapture` spawn.
   */
  async _captureRequest(request, timeoutMs = 12000) {
    // One request/reply at a time: the daemon answers on a single stdout stream,
    // so concurrent callers would otherwise race for each other's replies.
    const run = () => this.__captureRequestOnce(request, timeoutMs);
    const chained = (this.captureQueue ?? Promise.resolve()).then(run, run);
    this.captureQueue = chained.catch(() => {});
    return await chained;
  }

  async __captureRequestOnce(request, timeoutMs) {
    const child = this.startCaptureDaemon();
    if (!child) throw new Error("capture daemon unavailable");
    return await new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        child.stdout.off("data", onData);
        child.off("exit", onExit);
        clearTimeout(timer);
        fn(value);
      };
      const onExit = () => finish(reject, new Error("capture daemon exited"));
      const onData = (chunk) => {
        buffer += chunk.toString("utf8");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const parsed = JSON.parse(line);
            if (parsed.captureDaemon) continue; // ready banner
            finish(resolve, parsed);
            return;
          } catch {
            // ignore malformed line, keep reading
          }
        }
      };
      const timer = setTimeout(() => finish(reject, new Error("capture daemon timeout")), timeoutMs);
      child.stdout.on("data", onData);
      child.once("exit", onExit);
      try {
        child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  /** Start the persistent capture daemon once per plugin lifetime. */
  startCaptureDaemon() {
    if (this.captureProcess && !this.captureProcess.killed && this.captureProcess.exitCode === null) {
      return this.captureProcess;
    }
    const bin = this.resolveBinaryPath();
    if (!existsSync(bin)) return null;
    try {
      const child = spawn(bin, ["capture-daemon"], { stdio: ["pipe", "pipe", "ignore"] });
      child.unref();
      child.stdout.setEncoding("utf8");
      child.on("exit", () => {
        if (this.captureProcess === child) this.captureProcess = null;
      });
      this.captureProcess = child;
      return child;
    } catch {
      return null;
    }
  }

  /** Stop the capture daemon and release its stdin. */
  stopCaptureDaemon() {
    const child = this.captureProcess;
    this.captureProcess = null;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  /**
   * Capture via the warm daemon, returning the same shape as the engine's `shot`
   * command. Degrades to `{ok:false}` instead of throwing so callers can fall
   * back to the normal exec path.
   * @param {{ windowId?: number, screen?: boolean, display?: number, maxDimension?: number, format?: string, quality?: number }} opts
   */
  async captureShotViaDaemon(opts = {}) {
    try {
      const request = { cmd: "shot" };
      if (opts.windowId !== undefined) request.windowId = Number(opts.windowId);
      if (opts.screen === true) request.screen = true;
      if (opts.display !== undefined) request.display = Number(opts.display);
      if (opts.format) request.format = String(opts.format);
      if (opts.quality !== undefined) request.quality = Number(opts.quality);
      if (opts.maxDimension !== undefined) request.maxDim = Number(opts.maxDimension);
      const response = await this._captureRequest(request);
      if (!response?.ok) {
        return { ok: false, error: response?.error ?? "capture_failed" };
      }
      return {
        ok: true,
        base64: response.base64,
        mimeType: response.mimeType,
        width: response.width,
        height: response.height,
        origin: response.origin ?? { x: 0, y: 0 },
        size: response.size ?? { width: 0, height: 0 },
        scale: response.scale ?? 1,
        windowId: opts.windowId ?? null,
        screen: Boolean(opts.screen),
      };
    } catch (error) {
      return { ok: false, error: "capture_daemon_unavailable",
               message: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /**
   * Check whether ~/.cu/pause was touched within the last 60 seconds.
   */
  isPauseFileActive() {    const pausePath = join(this.stateDir, "pause");
    try {
      if (!existsSync(pausePath)) return false;
      const st = statSync(pausePath);
      return Date.now() - st.mtimeMs < 60_000;
    } catch {
      return false;
    }
  }

  /**
   * Gate every mutating desktop action on abort signal and user stop/pause latch.
   * @param {string} actionName
   * @param {AbortSignal} [signal]
   */
  assertCanAct(actionName, signal) {
    if (signal?.aborted) {
      const err = new Error(`Action ${actionName} aborted by caller signal`);
      err.code = "ABORTED";
      throw err;
    }
    if (this.isPauseFileActive()) {
      this.pauseLatched = true;
    }
    if (this.pauseLatched) {
      const err = new Error(
        `Computer Use has been paused/stopped by the user (action=${actionName}). Call cu_session with action="start" or action="resume" to continue.`
      );
      err.code = "PAUSED_BY_USER";
      throw err;
    }
  }

  /**
   * Clear the plugin-level pause latch and remove ~/.cu/pause if present.
   */
  clearPauseLatch() {
    this.pauseLatched = false;
    const pausePath = join(this.stateDir, "pause");
    try {
      rmSync(pausePath, { force: true });
    } catch {
      // ignore
    }
  }

  /**
   * Write current action text into ~/.cu/activity.json so floating capsule/halo displays it live.
   * @param {string} text
   */
  writeActivity(text) {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const activityPath = join(this.stateDir, "activity.json");
      writeFileSync(
        activityPath,
        JSON.stringify({ text: String(text), ts: Date.now() / 1000 }),
        "utf8"
      );
    } catch {
      // best effort
    }
  }

  /**
   * Query GET /v1/status from the local CU service.
   * @param {AbortSignal} [signal]
   */
  async getStatus(signal) {
    const { baseUrl } = this.readServiceConfig();
    try {
      const res = await fetch(`${baseUrl}/v1/status`, {
        method: "GET",
        signal,
      });
      const data = await res.json();
      if (data.paused === true) {
        this.pauseLatched = true;
      }
      return data;
    } catch (err) {
      return {
        ok: false,
        error: "service_unreachable",
        message: `CU local service at ${baseUrl} is not reachable: ${err.message}`,
        nextSteps: ["Run ./install-app.sh or start cu service on port 47777"],
      };
    }
  }

  /**
   * Execute an argv command via the local CU service (`POST /v1/exec`), serialized.
   * @param {string[]} argv
   * @param {AbortSignal} [signal]
   * @returns {Promise<Record<string, any>>}
   */
  exec(argv, signal) {
    const run = async () => {
      if (signal?.aborted) {
        return { ok: false, error: "aborted", message: "Operation aborted before execution" };
      }
      const { baseUrl, token } = this.readServiceConfig();
      const res = await fetch(`${baseUrl}/v1/exec`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-CU-Caller-Pid": String(process.pid),
          "X-CU-Caller-Name": "dsh-computer-use",
        },
        body: JSON.stringify({ argv }),
        signal,
      });
      const result = await res.json();
      if (result?.error === "paused_by_user") {
        this.pauseLatched = true;
      }
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Cache snapshot nodes for provenance resolution and compute compact delta output.
   * @param {number} pid
   * @param {number | undefined} windowId
   * @param {Record<string, any>} raw
   * @param {{ full?: boolean }} [options]
   */
  recordSnapshot(pid, windowId, raw, options = {}) {
    const key = `${pid}:${windowId ?? "app"}`;
    const previous = this.snapshots.get(key);
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];

    const refs = new Map();
    const lines = new Map();
    const renderedList = [];

    for (const node of nodes) {
      const ref = String(node.ref ?? "");
      if (!ref) continue;
      const line = renderNodeLine(node);
      refs.set(ref, {
        ref,
        role: String(node.role ?? ""),
        title: String(node.title ?? ""),
        windowId: windowId ?? null,
      });
      lines.set(ref, line);
      renderedList.push(line);
    }

    this.snapshots.set(key, {
      windowId: windowId ?? null,
      refs,
      lines,
    });

    const truncated = raw.truncated === true;
    if (options.full === true || !previous) {
      return {
        mode: "full",
        pid,
        windowId: windowId ?? null,
        app: raw.app ?? "",
        count: nodes.length,
        ...(truncated ? { truncated: true, limit: raw.limit } : {}),
        lines: renderedList,
      };
    }

    const changes = [];
    let unchanged = 0;
    for (const [ref, line] of lines.entries()) {
      const prevLine = previous.lines.get(ref);
      if (prevLine === undefined) {
        changes.push(`+ ${line}`);
      } else if (prevLine !== line) {
        changes.push(`~ ${line}`);
      } else {
        unchanged += 1;
      }
    }
    for (const [ref, prevLine] of previous.lines.entries()) {
      if (!lines.has(ref)) {
        changes.push(`- ${prevLine}`);
      }
    }

    return {
      mode: "delta",
      pid,
      windowId: windowId ?? null,
      app: raw.app ?? "",
      count: nodes.length,
      ...(truncated ? { truncated: true, limit: raw.limit } : {}),
      unchanged,
      changes,
    };
  }

  /**
   * Resolve cached role/title provenance for a ref in the same pid and window scope.
   * Returns null if windowId mismatches, preventing cross-window ref mis-targeting.
   * @param {number} pid
   * @param {string} ref
   * @param {number} [windowId]
   */
  resolveRefProvenance(pid, ref, windowId) {
    const key = `${pid}:${windowId ?? "app"}`;
    const entry = this.snapshots.get(key);
    if (!entry) return null;
    if (windowId !== undefined && entry.windowId !== null && entry.windowId !== windowId) {
      return null;
    }
    return entry.refs.get(ref) ?? null;
  }

  /**
   * Spawn a detached floating indicator (`capsule` and/or `halo`) and monitor for user stop.
   * @param {string[]} args
   */
  spawnIndicator(args) {
    const bin = this.resolveBinaryPath();
    if (!existsSync(bin)) return null;
    const child = spawn(bin, args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    this.indicators.add(child);
    child.on("exit", () => {
      this.indicators.delete(child);
      if (this.isPauseFileActive()) {
        this.pauseLatched = true;
      }
    });
    return child;
  }

  /**
   * Execute a sequence of steps locally without model roundtrip lag.
   * Chaining click, type, key, scroll, setvalue, wait, or action steps in a single fast pass.
   *
   * @param {{ pid?: number, windowId?: number, steps: Array<Record<string, any>>, timeoutMs?: number, stopOnError?: boolean, settleMs?: number }} params
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ ok: boolean, completedSteps: number, totalSteps: number, durationMs: number, results: Array<any>, failedStep?: number, error?: string }>}
   */
  async executeBatch(params, signal) {
    this.assertCanAct("batch", signal);
    const steps = Array.isArray(params.steps) ? params.steps : [];
    if (steps.length === 0) {
      throw new Error("batch requires a non-empty steps array");
    }
    if (steps.length > 50) {
      throw new Error("batch accepts at most 50 steps per invocation");
    }

    const defaultPid = params.pid !== undefined ? Number(params.pid) : undefined;
    const defaultWindowId = params.windowId !== undefined ? Number(params.windowId) : undefined;
    const stopOnError = params.stopOnError !== false;
    const settleMs = Number(params.settleMs ?? 60);
    const timeoutMs = Number(params.timeoutMs ?? 20000);

    const startTime = Date.now();
    const results = [];
    let failed = false;
    let failedStepIndex = null;
    let failureReason = null;
    // Track whether the deadline was crossed *after* a mutating step was
    // dispatched: its effect may or may not have landed, so the caller must be
    // told the outcome is unknown rather than assume success or retry blindly.
    let outcomeUnknown = false;
    const remaining = () => timeoutMs - (Date.now() - startTime);

    for (let i = 0; i < steps.length; i++) {
      if (signal?.aborted) {
        failed = true;
        failedStepIndex = i;
        failureReason = "aborted";
        break;
      }
      if (remaining() <= 0) {
        failed = true;
        failedStepIndex = i;
        failureReason = "batch_timeout";
        break;
      }

      const step = steps[i];
      const action = step.action;
      if (!action) {
        throw new Error(`Step ${i + 1} is missing action`);
      }

      const stepPid = step.pid !== undefined ? Number(step.pid) : defaultPid;
      const stepWindowId = step.windowId !== undefined ? Number(step.windowId) : defaultWindowId;

      const stepLabel = action === "type"
        ? `打字 "${step.text?.slice(0, 20) ?? ""}"`
        : action === "key"
        ? `按键 ${step.name ?? ""}`
        : action === "click"
        ? `点击 ${step.ref ? step.ref : `@${step.x},${step.y}`}`
        : action;
      this.writeActivity(`批处理 ${i + 1}/${steps.length}: ${stepLabel}`);

      if (action === "wait") {
        // Never sleep past the batch budget: clamp to what is left.
        const want = Math.max(10, Math.min(Number(step.ms ?? 500), 10000));
        const slice = Math.min(want, Math.max(0, remaining()));
        if (slice > 0) await new Promise((resolve) => setTimeout(resolve, slice));
        results.push({ ok: true, action: "wait", ms: slice });
        if (remaining() <= 0) {
          failed = true;
          failedStepIndex = i + 1 < steps.length ? i + 1 : undefined;
          failureReason = "batch_timeout";
          if (failedStepIndex === undefined) failedStepIndex = null;
          break;
        }
        continue;
      }

      try {
        const mergedParams = {
          ...step,
          pid: stepPid,
          windowId: stepWindowId,
        };
        const argv = buildCommandArgv(action, mergedParams, this);
        const res = await this.exec(argv, signal);
        const ok = Boolean(res?.ok);
        results.push({ ok, action, ...res });
        if (!ok && stopOnError) {
          failed = true;
          failedStepIndex = i;
          failureReason = res?.error ?? "step_failed";
          break;
        }
        // The step was dispatched; if it straddled the deadline, its effect may
        // or may not have landed. Stop and flag the outcome as unknown.
        if (remaining() <= 0 && i < steps.length - 1) {
          failed = true;
          failedStepIndex = i + 1;
          failureReason = "batch_timeout";
          outcomeUnknown = true;
          break;
        }
      } catch (err) {
        const dispatched = err?.code !== "ABORTED";
        results.push({ ok: false, action, error: err.message });
        if (remaining() <= 0) {
          outcomeUnknown = outcomeUnknown || dispatched;
        }
        if (stopOnError) {
          failed = true;
          failedStepIndex = i;
          failureReason = err.message;
          break;
        }
      }

      if (settleMs > 0 && i < steps.length - 1) {
        const slice = Math.min(settleMs, Math.max(0, remaining()));
        if (slice > 0) await new Promise((resolve) => setTimeout(resolve, slice));
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      ok: !failed,
      completedSteps: results.filter((r) => r.ok).length,
      totalSteps: steps.length,
      durationMs,
      ...(failed ? { failedStep: failedStepIndex, error: failureReason } : {}),
      ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
      results,
    };
  }

  /**
   * Start or update a visible Computer Use session:
   * - Clears any previous pause latch
   * - Spawns top-right floating capsule (`cu capsule`) + optional target window border (`cu halo`)
   * - Arranges DSH and target window side-by-side in split screen (prepareDisplay style)
   * - Optionally hides unrelated apps to prevent Stage Manager thumbnail churn
   *
   * @param {{ windowId?: number, pid?: number, appName?: string, label?: string, halo?: boolean, dockDsh?: boolean, splitScreen?: boolean, hideOtherApps?: boolean, seconds?: number }} [opts]
   */
  async startVisualSession(opts = {}) {
    // Same-target restart is idempotent: if a session is already live for this
    // exact window/pid, only refresh the indicators and labels instead of
    // re-resuming, re-listing windows and re-moving them. Explicit `resume:true`
    // still forces a fresh resume for the "continue" path.
    const sameTarget =
      this.activeSession &&
      opts.force !== true &&
      opts.resume !== true &&
      this.activeSession.windowId === opts.windowId &&
      this.activeSession.pid === opts.pid;

    await this.stopVisualIndicatorsOnly();
    this.clearPauseLatch();
    if (!sameTarget) {
      await this.exec(["resume"]).catch(() => {});
    }

    const seconds = Number(opts.seconds ?? 900);
    const titleLabel =
      opts.label ||
      (opts.appName ? `${opts.appName} — DSH 操控中` : "DeepSeek 正在操控电脑");

    if (sameTarget) {
      // Re-arm indicators and aura without touching geometry or pausing state.
      this.writeActivity("会话继续");
      this.spawnIndicator(["capsule", "--label", titleLabel, "--seconds", String(seconds)]);
      if (opts.halo !== false && opts.windowId !== undefined) {
        this.spawnIndicator(["halo", "--window", String(opts.windowId), "--label", titleLabel,
                             "--seconds", String(seconds)]);
      }
      if (opts.cursor !== false) {
        try { this.startCursorOverlay(); this.setAgentAura(true); } catch { /* ignore */ }
      }
      this.activeSession = { ...this.activeSession, label: titleLabel };
      return {
        ok: true, session: "continued", label: titleLabel,
        windowId: opts.windowId ?? null,
        dockedDsh: Boolean(this.dockedDshWindow),
        targetSplit: Boolean(this.savedTargetBounds),
        hiddenApps: this.hiddenApps?.length ?? 0,
      };
    }

    const winList = await this.exec(["windows"]).catch(() => ({ windows: [] }));
    const windows = winList?.windows || [];

    // 1. Arrange Side-by-Side Split Screen (prepareDisplay). Derive geometry
    // from the actual display so we do not assume a specific Mac's resolution.
    // Docking is opt-in (default false, matching the tool docs): only touch the
    // user's windows when they explicitly asked for it.
    if (opts.dockDsh === true && !this.dockedDshWindow) {
      const dshWin = windows.find(
        (w) =>
          typeof w.app === "string" &&
          (w.app.includes("DeepSeek Harness") || w.app.includes("Electron"))
      );
      if (dshWin && dshWin.bounds) {
        this.dockedDshWindow = {
          windowId: dshWin.windowId,
          x: dshWin.bounds.x,
          y: dshWin.bounds.y,
          w: dshWin.bounds.width,
          h: dshWin.bounds.height,
        };

        // Full display bounds: widest window at x=0 spanning the screen (the
        // DSH window itself or a full-screen desktop window reports it).
        const display =
          windows
            .filter((w) => w.bounds && w.bounds.x <= 1)
            .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0] ||
          dshWin;
        const screenW = Math.round(display.bounds?.width || dshWin.bounds.width * 2);
        const dshW = Math.min(640, Math.round(screenW / 3));
        const targetW = screenW - dshW;
        // Menu bar height: the DSH window's top edge is a good proxy (33 on
        // notched displays), clamped to a sane range.
        const topY = Math.max(24, Math.min(40, Math.round(dshWin.bounds.y)));
        const screenH =
          display.bounds?.height && display.bounds.x <= 1
            ? Math.round(display.bounds.height)
            : Math.round(dshWin.bounds.height + topY);
        const usableH = Math.max(400, screenH - topY);

        // Move DSH to the right side
        await this.exec([
          "movewindow", "--window", String(dshWin.windowId),
          "--x", String(targetW), "--y", String(topY),
          "--w", String(dshW), "--h", String(usableH),
        ]).catch(() => {});

        // If a target window is specified, position it on the left side
        if (opts.windowId !== undefined && opts.splitScreen !== false && !this.savedTargetBounds) {
          const targetWin = windows.find((w) => w.windowId === opts.windowId);
          if (targetWin && targetWin.bounds) {
            this.savedTargetBounds = {
              windowId: opts.windowId,
              x: targetWin.bounds.x,
              y: targetWin.bounds.y,
              w: targetWin.bounds.width,
              h: targetWin.bounds.height,
            };
            await this.exec([
              "movewindow", "--window", String(opts.windowId),
              "--x", "0", "--y", String(topY),
              "--w", String(targetW), "--h", String(usableH),
            ]).catch(() => {});
          }
        }
      }
    }

    // 2. Hide other apps to prevent Stage Manager thumbnail bounce
    if (opts.hideOtherApps === true) {
      const keepList = [opts.appName, "DeepSeek Harness", "Electron"].filter(Boolean);
      this.hiddenApps = await hideUnrelatedApps(keepList);
    }

    if (opts.windowId !== undefined && opts.bringOnStage !== false) {
      await this.exec([
        "stage",
        "--window",
        String(opts.windowId),
        "--no-stage-switch",
      ]).catch(() => {});
    }

    this.writeActivity("会话已启动");
    this.spawnIndicator(["capsule", "--label", titleLabel, "--seconds", String(seconds)]);

    if (opts.halo !== false && opts.windowId !== undefined) {
      this.spawnIndicator([
        "halo",
        "--window",
        String(opts.windowId),
        "--label",
        titleLabel,
        "--seconds",
        String(seconds),
      ]);
    }

    // Persistent agent-cursor overlay: one process for the whole session, driven
    // by JSON lines. Best-effort; its absence never blocks the session.
    if (opts.cursor !== false) {
      try {
        this.startCursorOverlay();
        this.setAgentAura(true);
      } catch {
        // ignore
      }
    }

    this.activeSession = {
      windowId: opts.windowId,
      pid: opts.pid,
      app: opts.appName,
      label: titleLabel,
      startedAt: Date.now(),
    };

    return {
      ok: true,
      session: "started",
      label: titleLabel,
      windowId: opts.windowId ?? null,
      dockedDsh: Boolean(this.dockedDshWindow),
      targetSplit: Boolean(this.savedTargetBounds),
      hiddenApps: this.hiddenApps?.length ?? 0,
    };
  }

  async stopVisualIndicatorsOnly() {
    for (const child of Array.from(this.indicators)) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.indicators.delete(child);
    }
  }

  /**
   * Stop the active Computer Use session, dismiss floating indicators, and restore DSH & target window bounds.
   * @param {{ pause?: boolean }} [opts]
   */
  async stopVisualSession(opts = {}) {
    await this.stopVisualIndicatorsOnly();
    this.setAgentAura(false);
    this.stopCursorOverlay();
    this.stopCaptureDaemon();
    this.writeActivity("已结束");

    let restoredDsh = false;
    if (this.dockedDshWindow) {
      const prev = this.dockedDshWindow;
      this.dockedDshWindow = null;
      await this.exec([
        "movewindow",
        "--window",
        String(prev.windowId),
        "--x",
        String(prev.x),
        "--y",
        String(prev.y),
        "--w",
        String(prev.w),
        "--h",
        String(prev.h),
      ]).catch(() => {});
      restoredDsh = true;
    }

    let restoredTarget = false;
    if (this.savedTargetBounds) {
      const prevTarget = this.savedTargetBounds;
      this.savedTargetBounds = null;
      await this.exec([
        "movewindow",
        "--window",
        String(prevTarget.windowId),
        "--x",
        String(prevTarget.x),
        "--y",
        String(prevTarget.y),
        "--w",
        String(prevTarget.w),
        "--h",
        String(prevTarget.h),
      ]).catch(() => {});
      restoredTarget = true;
    }

    if (this.hiddenApps && this.hiddenApps.length > 0) {
      const toRestore = this.hiddenApps;
      this.hiddenApps = [];
      await restoreHiddenApps(toRestore).catch(() => {});
    }

    if (opts.pause === true) {
      this.pauseLatched = true;
      const { baseUrl, token } = this.readServiceConfig();
      await fetch(`${baseUrl}/v1/pause`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }

    const prevSession = this.activeSession;
    this.activeSession = null;
    return {
      ok: true,
      session: "stopped",
      paused: this.pauseLatched,
      restoredDsh,
      restoredTarget,
      previous: prevSession,
    };
  }
}

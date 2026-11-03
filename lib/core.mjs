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
 * Fingerprint a raw snapshot payload by its rendered lines. Two reads of an
 * unchanged tree produce the same string, so a caller can tell "the UI moved"
 * from "the read just happened" without trusting a timer.
 * @param {Record<string, any>} raw
 */
export function snapshotFingerprint(raw) {
  const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
  return nodes.map(renderNodeLine).join("\n");
}

/**
 * Keep the frame the engine reported for a node, so visual feedback can aim at
 * a control without a fresh tree walk. Only finite numbers survive: a node
 * without a frame (AXPress-only rows, off-stage windows) must not gain a bogus
 * point at the origin.
 * @param {Record<string, any>} node
 */
function nodeGeometry(node) {
  const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const x = finite(node.x);
  const y = finite(node.y);
  const w = finite(node.w);
  const h = finite(node.h);
  const out = {};
  if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
    out.x = x;
    out.y = y;
    out.w = w;
    out.h = h;
    out.cx = finite(node.cx) ?? x + w / 2;
    out.cy = finite(node.cy) ?? y + h / 2;
  }
  return out;
}

/**
 * Human-readable overlay text for a click, e.g. `点击「导入」`. A raw ref
 * (`k0.3.2`) means nothing to the person watching, so it is the last resort.
 * @param {{ ref?: string, role?: string, title?: string }} target
 * @param {{ x: number, y: number } | null} [point]
 */
export function clickLabel(target = {}, point = null) {
  const title = String(target.title ?? "").trim();
  if (title) return `点击「${title}」`;
  const role = String(target.role ?? "").replace(/^AX/, "");
  const roleWord = ROLE_WORDS[role];
  if (roleWord) return `点击${roleWord}`;
  if (role) return `点击 ${role}`;
  if (point) return `点击 ${Math.round(point.x)},${Math.round(point.y)}`;
  const ref = String(target.ref ?? "").trim();
  return ref ? `点击 ${ref}` : "点击";
}

const ROLE_WORDS = {
  Button: "按钮",
  TextField: "输入框",
  TextArea: "文本区",
  SearchField: "搜索框",
  MenuItem: "菜单项",
  MenuButton: "菜单",
  Row: "行",
  Cell: "单元格",
  Link: "链接",
  CheckBox: "勾选框",
  RadioButton: "单选项",
  PopUpButton: "下拉框",
  TabGroup: "标签页",
  Toolbar: "工具栏",
  Image: "图像",
  StaticText: "文本",
};

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
      // takes a single walk; the plugin's post-action observe (runPostAction)
      // re-reads while the tree is unchanged, so late UI is still caught.
      // Callers may raise settle/maxSettleWalks explicitly.
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

    case "expect": {
      // The engine already polls the tree until the condition holds, so the
      // adapter only has to translate the condition — not re-invent the wait.
      if (!pid) throw new Error("expect requires pid");
      if (params.ref === undefined && params.query === undefined) {
        throw new Error("expect requires ref or query");
      }
      const argv = ["expect", "--pid", String(pid)];
      if (windowId !== undefined) argv.push("--window", String(windowId));
      if (params.ref !== undefined) argv.push("--ref", String(params.ref));
      if (params.query !== undefined) argv.push("--find", String(params.query));
      if (typeof params.enabled === "boolean") argv.push("--enabled", String(params.enabled));
      if (params.value !== undefined) argv.push("--value", String(params.value));
      if (params.contains !== undefined) argv.push("--contains", String(params.contains));
      argv.push("--timeout", String(Math.max(0, Number(params.timeoutMs ?? 2000))));
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
function isDshWindow(window) {
  // Match on the owning app, not the title: a browser tab titled "DeepSeek
  // Harness" must never be mistaken for the DSH window we are allowed to move.
  return String(window?.app ?? "").includes("DeepSeek Harness");
}

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

    /** @type {Map<string, { snapshotId: number, windowId: number | null, refs: Map<string, {ref: string, role: string, title: string, windowId: number | null}>, lines: Map<string, string>, takenAt: number }>} */
    this.snapshots = new Map();

    /**
     * Monotonic snapshot generation. Every observation carries the id it was
     * read from, so a caller can pass it back and prove that the control it
     * means is the one from that observation rather than a same-named control
     * that moved into the same tree slot since.
     */
    this.snapshotSeq = 0;

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

    /** @type {ReturnType<typeof setTimeout> | null} */
    this.sessionTimer = null;
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

  /**
   * Feedback for a click that the engine already accepted: glide to the frame
   * the engine resolved, name the control, then ripple. Deliberately fired
   * *after* `exec` resolves, so a refused or failed click can never look like it
   * landed. Silent no-op without an overlay, and never throws.
   * @param {{ x: number, y: number } | null} point
   * @param {string} label
   */
  showClickFeedback(point, label) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    try {
      this.showAgentCursor(point.x, point.y);
      this.showActionLabel(label, point.x, point.y);
      this.showClickRipple(point.x, point.y);
      return true;
    } catch {
      return false;
    }
  }

  /** Failure feedback: no ripple and no success chip — say what did not happen. */
  showActionFailure(label) {
    try {
      this.writeActivity(`${label || "动作"}未执行`);
      this._cursorWrite({ cmd: "label", text: "", x: 0, y: 0 });
    } catch {
      // best effort
    }
  }

  /**
   * Overlay feedback for one batch click step. Batches call `exec` directly for
   * throughput, so without this a fast multi-click run is completely silent and
   * the watcher cannot tell it from a hang.
   * @param {{ ref?: string, pid?: number, windowId?: number, result: any, ok: boolean }} step
   */
  emitClickStep({ ref, pid, windowId, result, ok }) {
    if (!this.activeSession) return;
    const provenance =
      ref && pid !== undefined ? this.resolveRefProvenance(pid, ref, windowId) : null;
    const rx = Number(result?.x);
    const ry = Number(result?.y);
    const enginePoint =
      Number.isFinite(rx) && Number.isFinite(ry) && (rx !== 0 || ry !== 0)
        ? { x: rx, y: ry }
        : null;
    const cachedPoint =
      provenance && Number.isFinite(provenance.cx) && Number.isFinite(provenance.cy)
        ? { x: provenance.cx, y: provenance.cy }
        : null;
    const point = enginePoint ?? cachedPoint;
    const label = clickLabel(provenance ?? { ref }, point);
    if (ok) this.showClickFeedback(point, label);
    else this.showActionFailure(label);
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
      const timer = setTimeout(() => {
        // A late reply on the shared stdout stream would otherwise be read as the
        // *next* request's answer, and the serialised queue would sit behind a
        // capture nobody is waiting for. Restart the daemon instead.
        const error = new Error("capture daemon timeout");
        error.code = "CAPTURE_TIMEOUT";
        finish(reject, error);
        this.stopCaptureDaemon();
      }, timeoutMs);
      child.stdout.on("data", onData);
      child.once("exit", onExit);
      try {
        child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  /**
   * Ask the menu-bar app to own a real ScreenCaptureKit display stream for this
   * session. macOS then shows its own screen-recording privacy indicator, and
   * our menu-bar item switches to “● CU · REC”, matching Codex's reminder.
   * Fire-and-forget: a missing indicator must never block an action.
   */
  startScreenIndicator() {
    this.exec(["screen-indicator", "--state", "on"]).catch(() => {});
  }

  stopScreenIndicator() {
    this.exec(["screen-indicator", "--state", "off"]).catch(() => {});
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
        // Freshness the caller can check: the daemon reports when the pixels
        // were taken and which display they came from, computed from live window
        // geometry rather than the cached SCShareableContent.
        capturedAt: response.capturedAt ?? null,
        displayId: response.displayId ?? null,
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
          ...(process.env.CU_NO_USER_PAUSE ? { "X-CU-No-User-Pause": "1" } : {}),
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
        // The engine already reports the frame of every node (`main.swift`
        // nodeLine emits x/y/w/h plus cx/cy). Keep it on the cached ref so a
        // click can glide the cursor to the control it is about to hit; the
        // frame the engine resolves at click time still wins for the ripple.
        ...nodeGeometry(node),
      });
      lines.set(ref, line);
      renderedList.push(line);
    }

    const snapshotId = (this.snapshotSeq += 1);
    const takenAt = Date.now();
    this.snapshots.set(key, {
      snapshotId,
      takenAt,
      windowId: windowId ?? null,
      refs,
      lines,
    });

    const truncated = raw.truncated === true;
    if (options.full === true || !previous) {
      return {
        mode: "full",
        snapshotId,
        takenAt,
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
      snapshotId,
      takenAt,
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
   * The snapshot id currently backing refs for this pid/window, or null.
   * @param {number} pid
   * @param {number} [windowId]
   */
  currentSnapshotId(pid, windowId) {
    const entry = this.snapshots.get(`${pid}:${windowId ?? "app"}`);
    return entry?.snapshotId ?? null;
  }

  /**
   * Does this ref belong to the snapshot generation the caller says it does?
   * Returns a reason string when it does not, so an action can refuse instead of
   * hitting whatever control now sits at that path.
   * @param {number} pid
   * @param {string} ref
   * @param {number} [windowId]
   * @param {number} [snapshotId]
   * @returns {string | null}
   */
  refSnapshotMismatch(pid, ref, windowId, snapshotId) {
    if (snapshotId === undefined || snapshotId === null) return null;
    const entry = this.snapshots.get(`${pid}:${windowId ?? "app"}`);
    if (!entry) return "no snapshot is cached for this window";
    if (!entry.refs.has(ref)) return `ref ${ref} is not in the cached snapshot`;
    if (Number(snapshotId) !== entry.snapshotId) {
      return `ref ${ref} came from snapshot ${snapshotId}, the current one is ${entry.snapshotId}`;
    }
    return null;
  }

  /**
   * Fingerprint the last snapshot the manager cached, or null when there is no
   * baseline. A post-action observe compares against this to decide whether the
   * tree moved, instead of assuming one read is enough.
   * @param {number} pid
   * @param {number} [windowId]
   * @returns {string | null}
   */
  cachedFingerprint(pid, windowId) {
    const entry = this.snapshots.get(`${pid}:${windowId ?? "app"}`);
    if (!entry) return null;
    return [...entry.lines.values()].join("\n");
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

      // A long batch is exactly where a ref from an old observation is most
      // likely to point at a same-named control. Refuse the step instead of
      // clicking the wrong one.
      if (step.ref !== undefined && step.snapshotId !== undefined) {
        const mismatch = this.refSnapshotMismatch?.(
          stepPid, String(step.ref), stepWindowId, step.snapshotId
        );
        if (mismatch) {
          results.push({
            ok: false,
            action,
            error: "stale_snapshot",
            message: mismatch,
            hint: "call cu_snapshot again and rebuild the batch from the new observation",
          });
          failed = true;
          failedStepIndex = i;
          failureReason = "stale_snapshot";
          break;
        }
      }

      const stepLabel = action === "type"
        ? `打字 "${step.text?.slice(0, 20) ?? ""}"`
        : action === "key"
        ? `按键 ${step.name ?? ""}`
        : action === "click" || action === "double_click"
        ? clickLabel(
            (step.ref ? this.resolveRefProvenance(stepPid, step.ref, stepWindowId) : null)
              ?? { ref: step.ref },
            step.x !== undefined && step.y !== undefined ? { x: step.x, y: step.y } : null,
          )
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
        if (action === "click" || action === "double_click") {
          this.emitClickStep({ ref: step.ref, pid: stepPid, windowId: stepWindowId, result: res, ok });
        }
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
   * Pick the display that actually holds the target window and return its usable
   * frame, in global top-left points. Falls back to the old window-size heuristic
   * only when the engine cannot report displays; `source` says which happened so
   * a wrong split is diagnosable instead of silent.
   * @param {{ windows: any[], targetWin: any, dshWin: any }} ctx
   * @returns {Promise<{ source: "screens" | "window-heuristic", screen: any | null, usable: { x: number, y: number, width: number, height: number } }>}
   */
  async resolveDisplayLayout({ windows = [], targetWin = null, dshWin = null } = {}) {
    const res = await this.exec(["screens"]).catch(() => null);
    const screens = Array.isArray(res?.screens) ? res.screens : [];
    const bounds = targetWin?.bounds;
    const centre = bounds
      ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      : null;
    const holding = centre
      ? screens.find((screen) => {
          const f = screen.frame;
          return f && centre.x >= f.x && centre.x < f.x + f.width &&
                 centre.y >= f.y && centre.y < f.y + f.height;
        })
      : null;
    const screen = holding ?? screens[0] ?? null;
    if (screen?.visible) {
      return { source: "screens", screen, usable: screen.visible };
    }
    // No display geometry: keep the pre-existing inference so a missing command
    // degrades instead of blocking the session.
    const display =
      windows
        .filter((w) => w.bounds && w.bounds.x <= 1)
        .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0] ||
      dshWin;
    const screenW = Math.round(display?.bounds?.width || dshWin?.bounds?.width * 2 || 1728);
    const topY = Math.max(24, Math.min(40, Math.round(dshWin?.bounds?.y ?? 30)));
    const screenH =
      display?.bounds?.height && display.bounds.x <= 1
        ? Math.round(display.bounds.height)
        : Math.round((dshWin?.bounds?.height ?? 1000) + topY);
    return {
      source: "window-heuristic",
      screen: null,
      usable: { x: 0, y: topY, width: screenW, height: Math.max(400, screenH - topY) },
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
      this.startScreenIndicator();
      this.spawnIndicator(["capsule", "--label", titleLabel, "--seconds", String(seconds)]);
      if (opts.halo !== false && opts.windowId !== undefined) {
        this.spawnIndicator(["halo", "--window", String(opts.windowId), "--label", titleLabel,
                             "--seconds", String(seconds)]);
      }
      if (opts.cursor !== false) {
        try { this.startCursorOverlay(); this.setAgentAura(true); } catch { /* ignore */ }
      }
      this.activeSession = { ...this.activeSession, label: titleLabel };
      this.armSessionTimer(seconds);
      return {
        ok: true, session: "continued", label: titleLabel,
        windowId: opts.windowId ?? null,
        dockedDsh: Boolean(this.dockedDshWindow),
        targetSplit: Boolean(this.savedTargetBounds),
        hiddenApps: this.hiddenApps?.length ?? 0,
        layout: this.lastLayout
          ? {
              source: this.lastLayout.source,
              screen: this.lastLayout.screen?.name ?? null,
              usable: this.lastLayout.usable,
            }
          : null,
      };
    }

    const winList = await this.exec(["windows"]).catch(() => ({ windows: [] }));
    const windows = winList?.windows || [];

    // 1. Codex-style side-by-side layout: DSH shrinks to the right third and
    // the target window takes the left. stopVisualSession restores both.
    // The first auto-session (a click) only shrinks DSH: moving the target
    // would invalidate the element frame that click was resolved against.
    const targetWin = opts.windowId !== undefined
      ? windows.find((w) => w.windowId === opts.windowId)
      : null;
    const targetIsDsh = targetWin ? isDshWindow(targetWin) : false;
    const shouldDock =
      !targetIsDsh &&
      (opts.dockDsh === true || (opts.dockDsh !== false && opts.windowId !== undefined));
    if (shouldDock && !this.dockedDshWindow) {
      const dshWin = windows
        .filter(isDshWindow)
        .sort((a, b) => (b.bounds?.width ?? 0) - (a.bounds?.width ?? 0))[0];
      if (dshWin && dshWin.bounds) {
        this.dockedDshWindow = {
          windowId: dshWin.windowId,
          x: dshWin.bounds.x,
          y: dshWin.bounds.y,
          w: dshWin.bounds.width,
          h: dshWin.bounds.height,
        };

        // Real display geometry from the engine, not inferred from window sizes:
        // a second monitor, a non-zero origin or a docked panel all used to
        // produce a wrong split. Falls back to the old heuristic only when the
        // engine cannot report displays, and says which path was taken.
        const layout = await this.resolveDisplayLayout({ windows, targetWin, dshWin });
        const { usable, source } = layout;
        this.lastLayout = layout;
        const screenW = Math.round(usable.width);
        const dshW = Math.min(640, Math.round(screenW / 3));
        const targetW = screenW - dshW;
        const topY = Math.round(usable.y);
        const usableH = Math.max(400, Math.round(usable.height));

        await this.exec([
          "movewindow", "--window", String(dshWin.windowId),
          "--x", String(Math.round(usable.x) + targetW), "--y", String(topY),
          "--w", String(dshW), "--h", String(usableH),
        ]).catch(() => {});

        if (opts.splitScreen !== false && targetWin?.bounds && !this.savedTargetBounds) {
          this.savedTargetBounds = {
            windowId: targetWin.windowId,
            x: targetWin.bounds.x,
            y: targetWin.bounds.y,
            w: targetWin.bounds.width,
            h: targetWin.bounds.height,
          };
          await this.exec([
            "movewindow", "--window", String(targetWin.windowId),
            "--x", String(Math.round(usable.x)), "--y", String(topY),
            "--w", String(targetW), "--h", String(usableH),
          ]).catch(() => {});
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
    this.startScreenIndicator();
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
      layout: this.lastLayout
        ? {
            source: this.lastLayout.source,
            screen: this.lastLayout.screen?.name ?? null,
            usable: this.lastLayout.usable,
          }
        : null,
      hiddenApps: this.hiddenApps?.length ?? 0,
    };
  }

  /**
   * A session cannot outlive its indicators. If the agent never calls
   * cu_session stop (crash, abandoned turn, host reload), restore the user's
   * windows automatically instead of leaving DSH shrunk forever.
   */
  armSessionTimer(seconds = 900) {
    clearTimeout(this.sessionTimer);
    const budget = Math.max(30, Number(seconds) || 900);
    this.sessionTimer = setTimeout(() => {
      this.stopVisualSession().catch(() => {});
    }, budget * 1000);
    this.sessionTimer.unref?.();
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
    clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    await this.stopVisualIndicatorsOnly();
    this.setAgentAura(false);
    this.stopCursorOverlay();
    this.stopCaptureDaemon();
    this.stopScreenIndicator();
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
    // The host validates tool output as lossless JSON: an auto-started session
    // (cu_click/cu_type) carries no appName, and a raw `previous` object would
    // ship `undefined` values and fail the whole call after the stop side effects.
    return {
      ok: true,
      session: "stopped",
      paused: this.pauseLatched,
      restoredDsh,
      restoredTarget,
      previous: prevSession === null || prevSession === undefined
        ? null
        : {
            windowId: prevSession.windowId ?? null,
            pid: prevSession.pid ?? null,
            app: prevSession.app ?? null,
            label: prevSession.label ?? null,
            startedAt: prevSession.startedAt ?? null,
          },
    };
  }
}

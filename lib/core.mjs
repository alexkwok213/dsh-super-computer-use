import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createActionEventLog, createEventStreamParser } from "./action-events.mjs";

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
    this.explicitPreviewBinary = options.previewBinaryPath;

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

    // Bumped whenever the bound target changes (new session or stop). A preview
    // capture started under an older generation must not publish its late result
    // into the new session (F3). Same-target continuation does not bump.
    this.sessionGeneration = 0;

    // R5: stop closes the input gate and invalidates the session generation
    // BEFORE any queued work can start. Control/cleanup work opts out via
    // exec(argv, signal, {control:true}).
    this.inputGateClosed = false;

    // R1–R4: one retained observation binds every elementToken to a target,
    // a worker generation, a session generation and an observationId. Replies
    // from the resident AX worker are routed by requestId, never by "first line
    // received", so a late/duplicate reply can never satisfy another request.
    this.axGeneration = 0;
    this._axBinding = null;
    this._axObservationSeq = 0;
    this._axRequestSeq = 0;
    this._axPending = new Map();
    this._axReader = null;
    // snapshotId (client cache version) → observationId of the single retained
    // observation that produced both the displayed nodes and the tokens (R2).
    this.snapshotObservations = new Map();

    // Action-event protocol v1: one log per manager, dedupe by eventId then seq.
    this.sessionId = null;
    this.eventLog = createActionEventLog({});
    this._actionSeq = 0;
    this._eventSeq = 0;

    /** @type {Promise<any>} */
    this.queue = Promise.resolve();

    /** @type {ReturnType<typeof setTimeout> | null} */
    this.sessionTimer = null;

    // Idle auto-stop: every cu_* call resets a short timer; once the agent goes
    // quiet for `idleStopSeconds`, the visual session ends on its own instead of
    // lingering (capsule / halo / docked DSH) until the long safety cap.
    // 0 disables it. Configurable via config.idleStopSeconds.
    this.idleStopSeconds = 60;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.idleTimer = null;
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
   * Binary used for the web preview-stream helper.
   *
   * The launchd service may still own a ScreenCaptureKit capture under the
   * main `cu` path; a second process at that exact path is refused window
   * capture on macOS. The installer therefore ships the same signed binary as
   * `cu-preview`, and the Host prefers it. `CU_PREVIEW_BIN` overrides both for
   * a development checkout.
   */
  resolvePreviewBinary() {
    if (this.explicitPreviewBinary && existsSync(this.explicitPreviewBinary)) {
      return this.explicitPreviewBinary;
    }
    if (process.env.CU_PREVIEW_BIN && existsSync(process.env.CU_PREVIEW_BIN)) {
      return process.env.CU_PREVIEW_BIN;
    }
    const main = this.resolveBinaryPath();
    const sibling = join(dirname(main), "cu-preview");
    if (existsSync(sibling)) return sibling;
    return main;
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

  /**
   * R7: the native watch preview is driven through the SAME cursor-helper stdin
   * as the visual feedback, so start / hide / resume / target switch / stop all
   * go through the real plugin session entry rather than a hand-written helper
   * command. Every command carries the session generation; a stale helper card
   * cannot paint an old frame into a new session.
   */
  _previewGeneration() { return Number(this.sessionGeneration ?? 0); }

  startNativePreview(windowId) {
    const wid = Number(windowId);
    if (!Number.isFinite(wid) || wid <= 0) return false;
    this._nativePreviewWindowId = wid;
    return this._cursorWrite({ cmd: "preview.start", windowId: wid, generation: this._previewGeneration() });
  }

  setNativePreviewVisible(visible) {
    return this._cursorWrite({ cmd: "preview.visible", visible: Boolean(visible),
                               generation: this._previewGeneration() });
  }

  /** Stop and forget the preview this session owns; returns whether one existed. */
  stopNativePreview() {
    const had = Boolean(this._nativePreviewWindowId);
    this._nativePreviewWindowId = null;
    this._cursorWrite({ cmd: "preview.stop", generation: this._previewGeneration() });
    return had;
  }

  /** A target switch must retire the old card before a new one is started. */
  switchNativePreview(windowId) {
    const wid = Number(windowId);
    if (this._nativePreviewWindowId === wid && Number.isFinite(wid) && wid > 0) {
      return this.setNativePreviewVisible(true);
    }
    this.stopNativePreview();
    return this.startNativePreview(wid);
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
   * Resident AX worker (Task 8): lazy-started for a real session target. It keeps
   * retained AX objects + epoch across requests so a token from one observation
   * can be dispatched later in the same session. Unit tests never enable it
   * (`_axWorkerAllowed` stays false), so they keep the old one-shot path.
   *
   * R1–R4: every reply is routed by requestId through ONE persistent reader.
   * A worker generation is bumped whenever the worker is (re)bound or
   * destroyed; tokens and the observation binding are dropped at the same time.
   */
  async startAXWorker(pid, windowId) {
    if (this.axWorker && this.axWorker.exitCode === null && !this.axWorker.killed
        && this._axWorkerTargetMatches(pid, windowId)) {
      return this.axWorker;
    }
    // A different target must not reuse the old worker's retained objects.
    if (this.axWorker) this.stopAXWorker();
    const bin = this.resolveBinaryPath();
    if (!existsSync(bin)) return null;
    let child;
    try {
      child = spawn(bin, ["ax-worker", "--pid", String(pid), "--window", String(windowId)],
                    { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return null;
    }
    child.stdout.setEncoding("utf8");
    // Each (re)bind is a new identity generation: nothing minted by the previous
    // worker may be dispatched under this one.
    this.axGeneration = (this.axGeneration ?? 0) + 1;
    this._axBinding = null;
    this._axPending = new Map();
    this._axRequestSeq = 0;
    this.axWorker = child;
    this.axWorkerTarget = { pid: Number(pid), windowId: windowId === undefined ? undefined : Number(windowId) };
    this.axTokens = this.axTokens ?? new Map();
    this.axTokens.clear();
    child.on("exit", () => {
      if (this.axWorker !== child) return;
      this.axWorker = null;
      this.axWorkerTarget = null;
      this._axBinding = null;
      this.axTokens?.clear();
      this._rejectAXPending(new Error("ax worker exited"));
    });
    // Consume the ready banner before any request reads a reply.
    const ready = await new Promise((resolve) => {
      let buffer = "";
      const timer = setTimeout(() => { child.stdout.off("data", onData); resolve(null); }, 4000);
      const onData = (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index >= 0) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          try { resolve({ banner: JSON.parse(buffer.slice(0, index)), rest: buffer.slice(index + 1) }); }
          catch { resolve(null); }
        }
      };
      child.stdout.on("data", onData);
    });
    if (!ready?.banner || ready.banner.axWorker !== "ready") {
      // No usable ready banner: do not hand back a worker whose stdout state is
      // unknown (the banner could later be mistaken for a command reply).
      this.stopAXWorker();
      return null;
    }
    this.axEpoch = ready.banner.epoch ?? null;
    this._ensureAXWorkerReader(child);
    if (ready.rest?.trim()) this._axReader?.feed(ready.rest);
    return child;
  }

  /** True when the live worker is already bound to this exact target. */
  _axWorkerTargetMatches(pid, windowId) {
    const t = this.axWorkerTarget;
    if (!t) return false;
    const wantWindow = windowId === undefined ? undefined : Number(windowId);
    return t.pid === Number(pid) && t.windowId === wantWindow;
  }

  stopAXWorker() {
    const child = this.axWorker;
    this.axWorker = null;
    this.axWorkerTarget = null;
    this._axBinding = null;
    this.axTokens?.clear();
    this.axGeneration = (this.axGeneration ?? 0) + 1;
    this._axRequestSeq = 0;
    this._rejectAXPending(new Error("ax worker stopped"));
    if (this._axReader?.child === child) this._axReader = null;
    if (!child) return;
    try { child.stdin?.end(); } catch { /* ignore */ }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }

  /** Reject every pending request (worker exit / stop / timeout). */
  _rejectAXPending(error) {
    for (const pending of this._axPending?.values?.() ?? []) {
      try { pending.fail(error); } catch { /* ignore */ }
    }
    this._axPending?.clear?.();
  }

  /**
   * ONE persistent stdout reader per worker. A reply is delivered only to the
   * request whose requestId it carries; late, duplicate, out-of-order or
   * unsolicited lines are discarded instead of satisfying the next request.
   */
  _ensureAXWorkerReader(child) {
    if (!child || this._axReader?.child === child) return this._axReader ?? null;
    const reader = { child, buffer: "", onData: null, onExit: null };
    reader.feed = (chunk) => {
      if (this._axReader !== reader) return;
      reader.buffer += chunk;
      let index;
      while ((index = reader.buffer.indexOf("\n")) >= 0) {
        const line = reader.buffer.slice(0, index);
        reader.buffer = reader.buffer.slice(index + 1);
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        const id = parsed?.requestId;
        const pending = id === undefined ? null : this._axPending?.get(String(id));
        if (!pending) continue; // stale / duplicate / unsolicited: drop it
        this._axPending.delete(String(id));
        pending.settle(parsed);
      }
    };
    reader.onData = (chunk) => reader.feed(String(chunk));
    reader.onExit = () => {
      if (this._axReader !== reader) return;
      this._rejectAXPending(new Error("ax worker exited"));
      this.axWorker = null;
      this.axWorkerTarget = null;
      this._axBinding = null;
      this.axTokens?.clear();
    };
    child.stdout.on("data", reader.onData);
    child.on("exit", reader.onExit);
    this._axReader = reader;
    return reader;
  }

  /**
   * A timed-out AX action has an UNKNOWN outcome. It is never auto-replayed,
   * and the worker is destroyed so a late reply cannot be misattributed later.
   * Only a fresh `cu_snapshot` (new observation + new generation) can act again.
   */
  _invalidateAXWorkerAfterTimeout() {
    this.axWorker = null;
    this.axWorkerTarget = null;
    this._axBinding = null;
    this.axTokens?.clear();
    this.axGeneration = (this.axGeneration ?? 0) + 1;
    this._axRequestSeq = 0;
    this._axPending = new Map();
    this._axReader = null;
  }

  _axRequest(obj, timeoutMs = 5000) {
    const child = this.axWorker;
    if (!child || child.exitCode !== null) return Promise.reject(new Error("ax worker unavailable"));
    this._ensureAXWorkerReader(child);
    this._axRequestSeq = (this._axRequestSeq ?? 0) + 1;
    const requestId = `g${this.axGeneration ?? 0}-r${this._axRequestSeq}`;
    const binding = this._axBinding
      ? {
          pid: this._axBinding.pid,
          windowId: this._axBinding.windowId,
          axGeneration: this.axGeneration ?? 0,
          sessionGeneration: this.sessionGeneration ?? 0,
          observationId: this._axBinding.observationId,
          epoch: this.axEpoch ?? null,
        }
      : null;
    const run = () => new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); this._axPending?.delete(requestId); };
      const settle = (parsed) => { if (settled) return; settled = true; cleanup(); resolve(parsed); };
      const fail = (error) => { if (settled) return; settled = true; cleanup(); reject(error); };
      this._axPending = this._axPending ?? new Map();
      this._axPending.set(requestId, { settle, fail });
      const timer = setTimeout(() => {
        if (settled) return;
        this._axPending?.delete(requestId);
        this._invalidateAXWorkerAfterTimeout();
        const error = new Error("ax worker timeout");
        error.outcomeUnknown = true;
        error.actionReplaySafe = false;
        fail(error);
      }, timeoutMs);
      try {
        child.stdin.write(`${JSON.stringify({ ...obj, requestId, binding })}\n`);
      } catch (error) {
        fail(error);
      }
    });
    const chained = (this.axQueue ?? Promise.resolve()).then(run, run);
    this.axQueue = chained.catch(() => {});
    return chained;
  }

  /**
   * Record ONE retained observation: nodes, tokens, target, worker generation,
   * session generation and observationId all come from this single result.
   * Nothing may splice a second traversal into it by path.
   */
  _recordAXObservation(res) {
    if (!res?.ok) return res;
    this.axEpoch = res.epoch ?? this.axEpoch;
    this.axTokens = this.axTokens ?? new Map();
    this.axTokens.clear();
    for (const candidate of res.candidates ?? []) {
      if (candidate?.elementToken) this.axTokens.set(String(candidate.path), String(candidate.elementToken));
    }
    this._axObservationSeq = (this._axObservationSeq ?? 0) + 1;
    const t = this.axWorkerTarget ?? {};
    this._axBinding = {
      observationId: String(res.observationId ?? `ob${this._axObservationSeq}`),
      axGeneration: this.axGeneration ?? 0,
      sessionGeneration: this.sessionGeneration ?? 0,
      epoch: this.axEpoch ?? null,
      pid: Number.isFinite(Number(res.pid)) ? Number(res.pid) : (t.pid ?? null),
      windowId: res.windowId !== undefined && res.windowId !== null ? Number(res.windowId) : (t.windowId ?? null),
      nodes: Array.isArray(res.nodes) ? res.nodes : null,
    };
    return res;
  }

  /** Observe via the resident worker and refresh the ref→elementToken map. */
  async axObserve() {
    const res = await this._axRequest({ cmd: "observe" });
    return this._recordAXObservation(res);
  }

  axTokenFor(ref) { return this.axTokens?.get(String(ref)); }

  _sameAXTarget(a, b) {
    const pidA = Number(a?.pid);
    const pidB = Number(b?.pid);
    if (!Number.isFinite(pidA) || !Number.isFinite(pidB) || pidA !== pidB) return false;
    const win = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
    return win(a?.windowId) === win(b?.windowId);
  }

  /**
   * Resolve a retained token ONLY when the whole identity chain still matches.
   * Returns a structured refusal (never a path fallback) when app, window,
   * worker generation, session generation or observation changed.
   */
  resolveBoundToken(ref, request = {}, observationId) {
    const token = this.axTokens?.get(String(ref));
    if (!token) {
      return { ok: false, error: "identity_unproven", actionReplaySafe: false,
               message: "no retained token for this ref; call cu_snapshot again" };
    }
    const b = this._axBinding;
    if (!b) {
      const t = this.axWorkerTarget ?? this.activeSession ?? null;
      if (!t || !this._sameAXTarget(t, request)) {
        return { ok: false, error: "target_mismatch", actionReplaySafe: false,
                 message: "the retained token is not bound to the requested target; call cu_snapshot again" };
      }
      return { ok: true, token, binding: null };
    }
    if (b.sessionGeneration !== (this.sessionGeneration ?? 0) || b.axGeneration !== (this.axGeneration ?? 0)) {
      return { ok: false, error: "stale_observation", actionReplaySafe: false,
               message: "the observation belongs to a superseded worker/session; call cu_snapshot again" };
    }
    if (observationId !== undefined && observationId !== null && String(observationId) !== b.observationId) {
      return { ok: false, error: "stale_observation", actionReplaySafe: false,
               message: "the ref comes from a different observation; call cu_snapshot again" };
    }
    if (!this._sameAXTarget(b, request)) {
      return { ok: false, error: "target_mismatch", actionReplaySafe: false,
               message: `token is bound to pid=${b.pid}/window=${b.windowId} but the request targets pid=${request.pid}/window=${request.windowId}; call cu_snapshot again` };
    }
    return { ok: true, token, binding: b };
  }

  async axClick(elementToken, action = "AXPress") {
    return this._axRequest({ cmd: "click", elementToken, action });
  }

  async axVerify(elementToken) {
    return this._axRequest({ cmd: "verify", elementToken });
  }

  /** Verify AND write in ONE native command on the retained AX object (R3). */
  async axInput(elementToken, text, mode = "setvalue") {
    return this._axRequest({ cmd: "input", elementToken, text: String(text ?? ""), mode });
  }

  /**
   * Warm the capture daemon off the critical path. Its first capture pays the
   * ScreenCaptureKit stall detection (1.5 s here) plus a screencapture spawn, so
   * every session used to start with a ~1.9 s first preview. Doing that one tiny
   * full-screen frame while the session is starting leaves the first real preview
   * at the warm ~120 ms.
   */
  warmCaptureDaemon() {
    if (this.warmingCapture) return;
    this.warmingCapture = true;
    Promise.resolve()
      .then(() =>
        this.captureShotViaDaemon({ screen: true, maxDimension: 64, format: "jpeg" })
      )
      .catch(() => {})
      .finally(() => {
        this.warmingCapture = false;
      });
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
      // The person watching needs to see why the agent stopped, not just the
      // caller getting an error.
      this.writeActivity("已被用户暂停 · 等待恢复");
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
  exec(argv, signal, options = {}) {
    const eventsVersion = options?.eventsVersion === 1 ? 1 : undefined;
    const eventContext = options?.eventContext;
    const onEvent = options?.onEvent;
    // R5: `control` work (session start/stop cleanup, status, resume) must keep
    // working after the input gate closes. R6: `bypassQueue` keeps an optional
    // preview capture off the serial input-action queue entirely.
    const control = options?.control === true;
    const bypassQueue = options?.bypassQueue === true;
    const generationAtEnqueue = this.sessionGeneration ?? 0;
    const run = async () => {
      if (!control && (this.inputGateClosed || generationAtEnqueue !== (this.sessionGeneration ?? 0))) {
        return { ok: false, error: "cancelled", outcomeUnknown: true, actionReplaySafe: false,
                 message: "the session was stopped before this action could start" };
      }
      if (signal?.aborted) {
        return { ok: false, error: "aborted", message: "Operation aborted before execution" };
      }
      // Cooperative cancellation: our own controller aborts when the user stops
      // the session, independent of the caller's signal.
      const internal = new AbortController();
      this._inflight = this._inflight ?? new Set();
      this._inflight.add(internal);
      const effectiveSignal = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
      try {
        return await this._execRequest(argv, effectiveSignal, { eventsVersion, eventContext, onEvent });
      } catch (error) {
        if (internal.signal.aborted || error?.name === "AbortError") {
          return { ok: false, error: "cancelled", outcomeUnknown: true, actionReplaySafe: false,
                   message: "the action was cancelled; its outcome is unknown" };
        }
        throw error;
      } finally {
        this._inflight.delete(internal);
      }
    };
    if (bypassQueue) return run();
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Abort every in-flight exec; returns how many were signalled. */
  cancelInFlight() {
    let count = 0;
    for (const controller of this._inflight ?? []) {
      try { controller.abort(); count += 1; } catch { /* ignore */ }
    }
    return count;
  }

  async _execRequest(argv, signal, { eventsVersion, eventContext, onEvent } = {}) {
    const { baseUrl, token } = this.readServiceConfig();
    const body = { argv };
    if (eventsVersion === 1) {
      body.eventsVersion = 1;
      if (eventContext) body.eventContext = eventContext;
    }
    const res = await fetch(`${baseUrl}/v1/exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-CU-Caller-Pid": String(process.pid),
        "X-CU-Caller-Name": "dsh-computer-use",
        ...(process.env.CU_NO_USER_PAUSE ? { "X-CU-No-User-Pause": "1" } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (eventsVersion === 1) {
      const parser = createEventStreamParser({ onEvent });
      const contentType = String(res.headers?.get?.("content-type") ?? "");
      const canStream = res.body && typeof res.body.getReader === "function" && !contentType.includes("application/json");
      if (canStream) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode());
      } else {
        parser.push(await res.text());
      }
      const final = parser.end();
      const result = final.ok
        ? final.result
        : { ok: false, error: final.error, message: final.message, events: final.events };
      if (result?.error === "paused_by_user") this.pauseLatched = true;
      return result;
    }
    const result = await res.json();
    if (result?.error === "paused_by_user") {
      this.pauseLatched = true;
    }
    return result;
  }


  /** Next monotonic adapter action id. */
  nextActionId(kind) {
    this._actionSeq = (this._actionSeq ?? 0) + 1;
    return `a${this._actionSeq}-${kind}`;
  }

  /** Build an adapter-sourced event (seq assigned by publishActionEvent). */
  adapterEvent({ actionId, kind, phase, target = null, ...rest }) {
    this._eventSeq = (this._eventSeq ?? 0) + 1;
    return {
      version: 1,
      sessionId: this.sessionId ?? "no-session",
      actionId,
      eventId: `ev${this._eventSeq}`,
      source: "adapter",
      phase,
      kind,
      target,
      clockDomain: "adapter",
      emittedNs: String(BigInt(Date.now()) * 1_000_000n),
      ...rest,
    };
  }

  /**
   * Publish one action event: dedupe by eventId, then assign seq, then record.
   * Native events also drive the visual layer from the SAME normalized event;
   * adapter events already emit their overlay commands at the tool site.
   */
  publishActionEvent(eventWithoutSeq) {
    const published = this.eventLog.publish(eventWithoutSeq);
    if (!published.ok) return published;
    if (published.event.source === "native") this._applyActionEvent(published.event);
    return published;
  }

  _applyActionEvent(event) {
    try {
      switch (event.phase) {
        case "targetReady":
          if (event.point) this.showAgentCursor(event.point.x, event.point.y, { glide: true });
          if (event.label) this.showActionLabel(event.label, event.point?.x ?? 0, event.point?.y ?? 0);
          break;
        case "dispatched":
          if (event.kind === "click" && event.point) this.showClickRipple(event.point.x, event.point.y);
          break;
        case "waiting":
          if (event.reason) this.writeActivity(event.reason);
          break;
        case "failed":
          this.showActionFailure(event.label ?? event.kind);
          break;
        default:
          break;
      }
    } catch {
      // visual feedback must never break the real action
    }
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
    // Blind settle between steps is the batch's largest fixed cost (60 ms each
    // by default). Report it separately so it is a number to argue with, not an
    // invisible tax; a caller that knows the real condition should use an
    // `expect` step instead.
    let settleTotal = 0;
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
        const stepStarted = Date.now();
        const res = await this.exec(argv, signal);
        const ok = Boolean(res?.ok);
        // Wall clock per step, so `timings` can separate engine work from the
        // adapter's own overhead instead of attributing everything to the batch.
        results.push({ ok, action, ...res, ms: Date.now() - stepStarted });
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
        if (slice > 0) {
          await new Promise((resolve) => setTimeout(resolve, slice));
          settleTotal += slice;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    // A single-step batch used to return ok:true with no hint that it blew its
    // budget, because the deadline was only checked when another step followed.
    // The action may well have landed; the caller still has to know the budget
    // was exceeded rather than treat it as a clean, fast success.
    const overBudget = durationMs > timeoutMs && !failed;
    const stepMs = results.reduce((sum, r) => sum + (Number(r.ms) || 0), 0);
    return {
      ok: !failed,
      completedSteps: results.filter((r) => r.ok).length,
      totalSteps: steps.length,
      durationMs,
      budgetMs: timeoutMs,
      timings: { steps: stepMs, settleMs: settleTotal, overheadMs: Math.max(0, durationMs - stepMs - settleTotal) },
      ...(overBudget ? { budgetExceeded: true } : {}),
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
    this._axWorkerAllowed = true;
    // A stop is a hard gate; only an explicit new/continued session re-opens it.
    this.inputGateClosed = false;
    if (!sameTarget) {
      // A new target is a new session generation: queued work from the previous
      // target must never start under the new one (R5).
      this.sessionGeneration = (this.sessionGeneration ?? 0) + 1;
      this._axBinding = null;
      this.stopNativePreview();
    }

    await this.stopVisualIndicatorsOnly();
    // Only an explicit start/resume may clear a user-triggered pause. A new
    // target discovered by the autoSession click path is not consent: the user
    // stopped the desktop, and the next coordinate click must stay refused
    // until cu_session start/resume (or the caller passes force/resume).
    if (opts.explicit === true || opts.resume === true || opts.force === true) {
      this.clearPauseLatch();
    }
    if (!sameTarget) {
      // New target: drop the previous worker so its tokens/objects can't leak in.
      if (typeof this.stopAXWorker === "function") this.stopAXWorker();
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
      if (opts.capsule !== false) {
        this.spawnIndicator(["capsule", "--label", titleLabel, "--seconds", String(seconds)]);
      }
      if (opts.halo !== false && opts.windowId !== undefined) {
        this.spawnIndicator(["halo", "--window", String(opts.windowId), "--label", titleLabel,
                             "--seconds", String(seconds)]);
      }
      if (opts.cursor !== false) {
        try {
          this.startCursorOverlay();
          // R7: the watch preview lives in the same helper process. A continued
          // session just re-shows it; hiding/resuming is explicit below.
          if (opts.nativePreview !== false && opts.windowId !== undefined) {
            this.startNativePreview(opts.windowId);
          }
          // The full-screen rim is a demo aid, not the default read of "what is
          // happening": the halo, cursor and capsule already say it.
          if (this.rimEnabled !== false) this.setAgentAura(true);
        } catch { /* ignore */ }
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
    if (opts.capsule !== false) {
      this.spawnIndicator(["capsule", "--label", titleLabel, "--seconds", String(seconds)]);
    }

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
        if (this.rimEnabled !== false) this.setAgentAura(true);
      } catch {
        // ignore
      }
    }
    // R7: wire the native watch preview into the real session start path.
    if (opts.nativePreview !== false && opts.windowId !== undefined) {
      try { this.startNativePreview(opts.windowId); } catch { /* best-effort */ }
    }

    // Pay the capture daemon's cold start here, not in the first preview. A
    // caller that previews in the same call skips this: the preview itself warms
    // the daemon, and serialising a warm-up in front of it only adds latency.
    if (opts.warmCapture !== false) this.warmCaptureDaemon();

    this.activeSession = {
      windowId: opts.windowId,
      pid: opts.pid,
      app: opts.appName,
      label: titleLabel,
      startedAt: Date.now(),
    };
    this.sessionGeneration = (this.sessionGeneration ?? 0) + 1;
    this.sessionId = `s${Date.now()}-${this.sessionGeneration}`;
    this.eventLog.setSession(this.sessionId);

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
   * Reset the idle auto-stop timer. Every cu_* tool call re-arms it (see the
   * execute wrapper in index.mjs); if no activity arrives within
   * `idleStopSeconds`, the visual session is stopped automatically so the user
   * never inherits a stuck capsule/halo or a shrunk DSH window. A value <= 0
   * disables the feature.
   */
  armIdleStop(seconds = this.idleStopSeconds ?? 60) {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const budget = Number(seconds);
    if (!this.activeSession || !(budget > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeSession) this.stopVisualSession().catch(() => {});
    }, Math.max(5, budget) * 1000);
    this.idleTimer.unref?.();
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
    // R5: close the input gate and invalidate the session generation IMMEDIATELY,
    // before any awaited cleanup. Queued actions capture the generation at
    // enqueue and refuse to start once it changed.
    this.inputGateClosed = true;
    // A user stop must be latched before cleanup, not after it: the cleanup
    // awaits are exactly the window in which a queued input could otherwise
    // slip through. Natural/turn-end stops pass pause:false.
    if (opts.pause === true) this.pauseLatched = true;
    this.sessionGeneration = (this.sessionGeneration ?? 0) + 1;
    this._axBinding = null;
    const inFlightCancelled = this.cancelInFlight?.() ?? 0;
    // R7: the native watch preview is owned by the cursor helper; stop it as
    // part of this session, not as a separate best-effort command.
    const nativePreviewStopped = this.stopNativePreview?.() ?? false;
    clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
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
      ], undefined, { control: true }).catch(() => {});
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
      ], undefined, { control: true }).catch(() => {});
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

    this._axWorkerAllowed = false;
    this.stopAXWorker();
    const prevSession = this.activeSession;
    this.activeSession = null;
    this.sessionId = null;
    this.eventLog.setSession(null);
    // R5: report stop evidence separately. `inFlightCancelled` only proves the
    // abort was signalled; native input release / descendant cleanup cannot be
    // proven from the adapter, so cleanupState stays "unknown" rather than
    // claiming everything is finished (Spec §7.5).
    return {
      ok: true,
      session: "stopped",
      paused: this.pauseLatched,
      inputGateClosed: true,
      cleanupState: "unknown",
      cancelledActions: inFlightCancelled,
      nativePreviewStopped,
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

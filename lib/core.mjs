import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { NativePreviews } from "./native-previews.mjs";
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
  if (node.occluded === true) {
    parts.push("occluded");
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
  const isForegroundAuth = Boolean(manager?.isForegroundAuthorized?.(params.targetId));
  const foreground = params.foreground === true || (params.foreground !== false && isForegroundAuth);
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
        const prov = manager?.resolveRefProvenance(pid, String(params.ref), windowId, params.targetId ?? null);
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
        const prov = manager?.resolveRefProvenance(pid, String(params.ref), windowId, params.targetId ?? null);
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
      const prov = manager?.resolveRefProvenance(pid, String(params.ref), windowId, params.targetId ?? null);
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
      const prov = manager?.resolveRefProvenance(pid, String(params.ref), windowId, params.targetId ?? null);
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

    case "drag": {
      const points = [params.from?.x, params.from?.y, params.to?.x, params.to?.y];
      if (!points.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error("drag requires finite from and to coordinates");
      }
      if (!pid || windowId === undefined) throw new Error("drag requires pid and windowId");
      const argv = ["drag", "--from", `${points[0]},${points[1]}`, "--to", `${points[2]},${points[3]}`, "--pid", String(pid), "--window", String(windowId)];
      if (!foreground) argv.push("--background");
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

/**
 * Target identity is (application pid, window). A pid alone is not a target:
 * one process can own several windows, and those windows must not share a
 * snapshot cache, a queue or a stop gate.
 */
export function targetKeyFor(pid, windowId) {
  if (pid === undefined || pid === null || !Number.isFinite(Number(pid))) return null;
  const win = windowId === undefined || windowId === null ? "app" : String(Number(windowId));
  return `${Number(pid)}:${win}`;
}

function sameTargetDescriptor(a, b) {
  if (!a || !b) return false;
  return Number(a.pid) === Number(b.pid) && String(a.windowId ?? "app") === String(b.windowId ?? "app");
}

export class CuSessionManager {
  /**
   * @param {{ stateDir?: string, serviceUrl?: string, token?: string, binaryPath?: string }} [options]
   */
  constructor(options = {}) {
    // Same contract as the native helper: an explicit option wins, then
    // CU_STATE_DIR, then ~/.cu. Honouring the environment is what lets the
    // test runner put every spawned helper, config and pause latch in a
    // throwaway directory instead of the person's real ~/.cu.
    this.stateDir =
      options.stateDir ?? (process.env.CU_STATE_DIR || join(homedir(), ".cu"));
    this._stateDirExplicit = Boolean(options.stateDir) || Boolean(process.env.CU_STATE_DIR);
    this.explicitUrl = options.serviceUrl ?? options.explicitUrl;
    this.explicitToken = options.token ?? options.explicitToken;
    this.explicitBinary = options.binaryPath ?? options.explicitBinary;
    this.explicitPreviewBinary = options.previewBinaryPath ?? options.explicitPreviewBinary;

    /** @type {boolean} */
    this.pauseLatched = false;

    // Development reload gate. A tool that is still executing must not have its
    // plugin generation replaced underneath it, and a mutating tool gets a short
    // grace window before the next generation may replace the card it just
    // updated. Both are plain counters, not timers or services.
    this.inFlightOps = 0;
    this.lastMutatingToolAt = 0;

    /** @type {Map<string, { snapshotId: number, windowId: number | null, refs: Map<string, {ref: string, role: string, title: string, windowId: number | null}>, lines: Map<string, string>, takenAt: number }>} */
    this.snapshots = new Map();

    /**
     * Delta baselines, one per chat and pid/window pair. Keyed by
     * `<owner>\0<pid>:<windowId>` so a fresh chat always gets a full tree.
     * @type {Map<string, any>}
     */
    this.snapshotBaselines = new Map();

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
    // Native settings → "restore hidden apps when finished". Kept on the
    // manager so a volatile config update can change it without replacing the
    // running session.
    this.unhideOnFinish = true;

    /** @type {{ windowId?: number, pid?: number, app?: string, label?: string, startedAt: number } | null} */
    this.activeSession = null;

    // One chat can drive several windows at once. `targets` is the authoritative
    // per-window state; `activeSession` remains the compatibility view of the
    // most recently selected target. Every target owns its generation, stop
    // gate, execution queue, snapshot cache and indicator set.
    /** @type {Map<string, any>} */
    this.targets = new Map();
    /** @type {string[]} */
    this.targetOrder = [];
    /** @type {string | null} */
    this.currentTargetKey = null;
    this.targetGenerationSeq = 0;
    /** @type {Map<string, Promise<any>>} */
    this.targetQueues = new Map();
    /** @type {Map<AbortController, string | null>} */
    this._inflightTargets = new Map();
    /** Target-scoped indicators / preview bookkeeping. */
    this.targetIndicators = new Map();
    this._visualStarted = false;
    this._autoTargetSession = false;
    this._capsuleChild = null;
    this._stopAllInFlight = null;

    // Bumped when the whole session starts or stops. A preview capture started
    // under an older session must not publish a late result into the new one.
    // Starting an additional target does NOT bump it.
    this.sessionGeneration = 0;

    // R5: stop closes the input gate and invalidates the session generation
    // BEFORE any queued work can start. A single-target stop closes only that
    // target's gate; a stop-all closes this global gate. Control/cleanup work
    // opts out via exec(argv, signal, {control:true}).
    this.inputGateClosed = false;
    this.sessionForegroundAuthorized = false;
    this.authorizeForeground = false;
    this.sessionAutoPreview = false;
    this._targetForegroundAuth = new Set();

    // R1–R4: one retained observation binds every elementToken to a target,
    // a worker generation, a session generation and an observationId. Replies
    // from the resident AX worker are routed by requestId, never by "first line
    // received", so a late/duplicate reply can never satisfy another request.
    // One resident AX state per target. The legacy single-target fields are
    // accessors over a default state so existing callers/tests keep working.
    this._axDefaultState = this._newAXState();
    this._axStates = new Map();
    // AX worker requests bypass the service's pid lanes, so the Host keeps its
    // own per-process lock. Same pid (including two windows) serializes; other
    // apps remain concurrent.
    this._axPidQueues = new Map();
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
    this.sessionTimeoutSeconds = 900;
    this.sessionHasTimedIndicators = false;

    // Idle auto-stop: every cu_* call resets a short timer; once the agent goes
    // quiet for `idleStopSeconds`, the visual session ends on its own instead of
    // lingering (capsule / halo / docked DSH) until the long safety cap.
    // 0 disables it. Configurable via config.idleStopSeconds.
    this.idleStopSeconds = 300;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.idleTimer = null;

    // Effect-scoped observers of "this engine session ended". The UI registry
    // subscribes here so it never runs a second timer that guesses whether the
    // engine is still alive (S2).
    /** @type {Set<(notice: any) => void>} */
    this.sessionEndListeners = new Set();

    // Lifecycle reclamation guards
    this._disposed = false;
    this._startingServiceAbortController = null;
    this._startingServicePromise = null;
    this.managedServiceProcess = null;
    this._managedToken = null;
    this._managedPort = null;
  }

  /** Public, lossless view of one target. */
  _publicTarget(record) {
    if (!record) return null;
    return {
      targetId: record.id,
      pid: record.pid ?? null,
      windowId: record.windowId ?? null,
      app: record.app ?? null,
      label: record.label ?? null,
      startedAt: record.startedAt ?? null,
      generation: record.generation ?? 0,
      gateClosed: record.gateClosed === true,
      stopped: record.stopped === true,
      closed: record.closed === true,
      nativePreview: record.nativePreview ?? null,
    };
  }

  /** The compatibility `activeSession` view of the current target. */
  _setPrimaryTarget(record) {
    if (!record) {
      this.currentTargetKey = null;
      this.activeSession = null;
      return;
    }
    this.currentTargetKey = record.id;
    this.activeSession = {
      targetId: record.id,
      windowId: record.windowId ?? null,
      pid: record.pid ?? null,
      app: record.app ?? null,
      label: record.label ?? null,
      startedAt: record.startedAt ?? null,
      generation: record.generation ?? 0,
    };
  }

  /**
   * Resolve a tool argument set to ONE atomic pid+window target. Omitted values
   * inherit the current target only as a whole; an explicit pid never inherits
   * another app's window.
   */
  resolveTargetArgs(args = {}) {
    const source = args && typeof args === "object" ? args : {};
    if (typeof source.targetId === "string" && source.targetId) {
      const known = this.targets.get(source.targetId);
      if (known) {
        return {
          ...source,
          targetId: known.id,
          pid: known.pid,
          windowId: known.windowId ?? undefined,
        };
      }
    }
    const current = this.targets.get(this.currentTargetKey) ?? (
      this.activeSession &&
      this.activeSession.pid !== undefined &&
      this.activeSession.pid !== null
        ? {
            id: null,
            pid: this.activeSession.pid,
            windowId: this.activeSession.windowId ?? null,
          }
        : null
    );
    const hasPid = source.pid !== undefined && source.pid !== null;
    const hasWindow = source.windowId !== undefined && source.windowId !== null;
    if (!hasPid && !hasWindow) {
      if (!current) return source;
      return {
        ...source,
        ...(current.id ? { targetId: current.id } : {}),
        pid: current.pid,
        windowId: current.windowId ?? undefined,
      };
    }
    if (hasPid && !hasWindow) {
      const sameApp = current && Number(source.pid) === Number(current.pid);
      return {
        ...source,
        pid: source.pid,
        windowId: sameApp ? (current.windowId ?? undefined) : undefined,
        ...(sameApp && current.id ? { targetId: current.id } : {}),
      };
    }
    if (hasWindow && !hasPid) {
      const sameWindow = current && Number(source.windowId) === Number(current.windowId);
      return {
        ...source,
        ...(sameWindow && current.pid ? { pid: current.pid } : {}),
        ...(sameWindow && current.id ? { targetId: current.id } : {}),
      };
    }
    const key = targetKeyFor(source.pid, source.windowId);
    const known = key ? this.targets.get(key) : null;
    return { ...source, ...(known ? { targetId: known.id } : {}) };
  }

  /**
   * Find or create the state for a target. Creation does not start visual
   * resources; callers start them explicitly so a read-only observation never
   * claims the desktop or moves a window.
   *
   * @returns {any | null}
   */
  ensureTarget(args = {}, options = {}) {
    const resolved = this.resolveTargetArgs(args);
    if (resolved.pid === undefined || resolved.pid === null) return null;
    const key = targetKeyFor(resolved.pid, resolved.windowId);
    if (!key) return null;
    let record = this.targets.get(key);
    const explicit = options.explicit === true;
    if (record) {
      if (record.stopped) {
        // A user stop is a hard gate for that target. Only an explicit
        // cu_session start on the same window may reopen it.
        if (!explicit) return record;
        record.stopped = false;
        record.gateClosed = false;
        record.closed = false;
        record.generation = ++this.targetGenerationSeq;
        record.startedAt = Date.now();
        this.stopAXWorker?.(record.id);
        this._dropTargetSnapshots(record.id);
      } else if (record.closed) {
        record.closed = false;
        record.gateClosed = false;
        record.generation = ++this.targetGenerationSeq;
        record.startedAt = Date.now();
        this.stopAXWorker?.(record.id);
        this._dropTargetSnapshots(record.id);
      }
      if (typeof options.app === "string" && options.app) record.app = options.app;
      if (typeof options.label === "string" && options.label) record.label = options.label;
      if (options.makePrimary !== false || !this.currentTargetKey) this._setPrimaryTarget(record);
      return record;
    }
    record = {
      id: key,
      pid: Number(resolved.pid),
      windowId:
        resolved.windowId === undefined || resolved.windowId === null
          ? null
          : Number(resolved.windowId),
      app: typeof options.app === "string" ? options.app : null,
      label: typeof options.label === "string" ? options.label : null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      generation: ++this.targetGenerationSeq,
      gateClosed: false,
      stopped: false,
      closed: false,
      indicators: new Set(),
      previewChild: null,
    };
    if (this.targets.size === 0 && this._visualStarted !== true) {
      // A target created by an ordinary action is not a visible session. Only
      // an explicit start (or a manually seeded session in tests/clients) may
      // paint cursor/halo feedback. This keeps observation from claiming the
      // screen while still letting an already-live session show feedback.
      this._autoTargetSession = !this.activeSession;
    }
    this.targets.set(key, record);
    this.targetOrder.push(key);
    if (this.targetOrder.length > 32) {
      // Bound long chats. Stop-gated records stay until the session ends, but a
      // target that was never used again may be retired without affecting the
      // live ones.
      for (const oldKey of [...this.targetOrder]) {
        const old = this.targets.get(oldKey);
        if (this.targetOrder.length <= 24) break;
        if (old && old !== record && old.gateClosed && old.stopped) {
          this.targets.delete(oldKey);
          this.targetOrder = this.targetOrder.filter((item) => item !== oldKey);
        }
      }
    }
    if (!this.sessionId) {
      // Preserve a generation a caller/test already established (for example an
      // in-flight preview baseline); only a brand-new session starts at 1.
      if (!(this.sessionGeneration > 0)) this.sessionGeneration = 1;
      this.sessionId = `s${Date.now()}-${this.sessionGeneration}`;
      this.eventLog.setSession(this.sessionId);
    }
    // A read-only observation in another chat must not steal the current target
    // from the owning chat. The first target still becomes primary; a later
    // read-only one only does so when no target is selected.
    if (options.makePrimary !== false || !this.currentTargetKey) this._setPrimaryTarget(record);
    return record;
  }

  /** The target named by a tool argument set, if it already exists. */
  targetForKey(key) {
    return key ? this.targets.get(key) ?? null : null;
  }

  listTargets() {
    return this.targetOrder
      .map((key) => this.targets.get(key))
      .filter(Boolean)
      .map((record) => this._publicTarget(record));
  }

  activeTargets() {
    return this.listTargets().filter((target) => !target.stopped && !target.closed && !target.gateClosed);
  }

  /** Remove any cached refs/observations for a target generation. */
  _dropTargetSnapshots(targetId) {
    if (!targetId) return;
    for (const [key, entry] of this.snapshots.entries()) {
      if (entry?.targetId === targetId) this.snapshots.delete(key);
    }
    for (const [key, entry] of this.snapshotBaselines.entries()) {
      if (entry?.targetId === targetId) this.snapshotBaselines.delete(key);
    }
    for (const [snapshotId, entry] of this.snapshotObservations.entries()) {
      if (entry?.targetId === targetId) this.snapshotObservations.delete(snapshotId);
    }
    if (targetId) {
      this.clearAXBinding?.(targetId);
    } else if (this._axBinding?.targetId === targetId) {
      this._axBinding = null;
      this.axTokens?.clear();
    }
  }

  /** A target disappeared or was replaced; old refs must never be reused. */
  invalidateTarget(targetId, reason = "target_closed") {
    const record = this.targets.get(targetId);
    if (!record) return null;
    this._stopTargetIndicators(record);
    this.stopNativePreview?.(targetId);
    record.closed = true;
    record.gateClosed = true;
    record.generation = ++this.targetGenerationSeq;
    record.updatedAt = Date.now();
    record.closedReason = reason;
    this.stopAXWorker?.(targetId);
    this._dropTargetSnapshots(targetId);
    if (this.currentTargetKey === targetId) {
      const next = this.activeTargets()[0] ?? null;
      this._setPrimaryTarget(next ? this.targets.get(next.targetId) : null);
    }
    return this._publicTarget(record);
  }

  /**
   * Reclaim managed background resources and permanently disallow further launches.
   */
  dispose() {
    this._disposed = true;
    if (this._startingServiceAbortController) {
      try { this._startingServiceAbortController.abort(); } catch {}
      this._startingServiceAbortController = null;
    }
    this.stopNativePreview?.();
    this.stopManagedService();
    this.stopAXWorker?.();
    this.stopAllSessions?.();
    for (const record of this.targets.values()) {
      record.gateClosed = true;
      record.closed = true;
    }
    this.targets.clear();
    this.targetOrder = [];
    this.targetQueues.clear();
    this._setPrimaryTarget(null);
  }

  /**
   * Subscribe to session-end notices. Returns an unsubscribe function.
   * Notice shape: {sessionId, generation, reason, cleanupState}.
   * @param {(notice: any) => void} listener
   */
  onSessionEnd(listener) {
    if (typeof listener !== "function") return () => {};
    this.sessionEndListeners.add(listener);
    return () => this.sessionEndListeners.delete(listener);
  }

  _emitSessionEnd(notice) {
    for (const listener of [...this.sessionEndListeners]) {
      try {
        listener(notice);
      } catch {
        // A UI observer must never break session teardown.
      }
    }
  }

  /**
   * Read ~/.cu/config.json for port & bearer token.
   */
  readServiceConfig() {
    if (this._managedToken && this._managedPort) {
      return {
        baseUrl: this.explicitUrl ?? `http://127.0.0.1:${this._managedPort}`,
        token: this.explicitToken ?? this._managedToken,
      };
    }
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
      baseUrl: this.explicitUrl ?? `http://127.0.0.1:${this._managedPort ?? port}`,
      token: this.explicitToken ?? this._managedToken ?? token,
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
      // Packaged universal binary shipped inside this plugin package
      resolve(__dirname, "../bin/cu"),
      // Bundled engine inside this repository (built by engine/build.sh or scripts/build-universal.sh)
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

  requestNativeTargetStop(targetId, reason) {
    return Promise.resolve(this.nativeTargetStopHandler
      ? this.nativeTargetStopHandler(targetId, reason)
      : this.stopTarget(targetId, { reason }));
  }

  _previewGeneration() { return Number(this.sessionGeneration ?? 0); }

  _previewWindows() {
    if (!this.nativePreviews) this.nativePreviews = new NativePreviews({
      launch: (identity) => spawn(this.resolvePreviewBinary(),
        ["preview", "--window", String(identity.windowId), "--seconds", String(Math.max(30, Math.round(Number(this.sessionTimeoutSeconds ?? 900))))], {
          stdio: ["pipe", "pipe", "ignore"],
          detached: true,
          env: { ...process.env, CU_PREVIEW_OWNED_BY_HELPER: "1",
            CU_PREVIEW_SLOT: String(identity.slot ?? 0) },
        }),
      onEvent: (identity, event) => {
        const target = this.targets.get(identity.targetId);
        if (!target || target.generation !== identity.generation || target.stopped) return;
        if (event.error === "preview_process_ended") {
          target.nativePreview = { ...target.nativePreview, visible: false };
        }
        if (event.event === "preview-geometry" && Number.isInteger(event.previewWindowId) && event.previewWindowId > 0) {
          const frame = event.frame;
          if (frame && [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) && frame.width > 0 && frame.height > 0) {
            target.nativePreview = { ...target.nativePreview, windowId: event.previewWindowId,
              frame: { ...frame }, coordinateSpace: "screen-points-top-left", visible: true };
          }
        }
        if (event.cmd === "visible" && typeof event.visible === "boolean") {
          target.nativePreview = { ...target.nativePreview, visible: event.visible };
        }
        if (event.ok === false && !(event.error === "preview_process_ended" && target.nativePreview?.status === "unavailable")) {
          target.nativePreview = { ...target.nativePreview, status: "unavailable", error: event.error ?? event.reason ?? "capture_failed" };
        } else if (event.preview === "starting" || event.preview === "live") {
          target.nativePreview = { ...target.nativePreview, status: event.preview, error: null };
        } else if (event.preview === "degraded") {
          target.nativePreview = { ...target.nativePreview, status: "stale", error: event.reason ?? "live_preview_unavailable" };
        }
        if (event.event === "stop-target") {
          this.requestNativeTargetStop(identity.targetId, "native_preview_stop").catch(() => {});
        } else if (event.event === "close-preview") {
          target.previewDismissed = true;
          target.nativePreview = { ...target.nativePreview, status: "closed", visible: false };
          this.nativePreviews.close(identity.targetId);
        }
      },
    });
    return this.nativePreviews;
  }

  startNativePreview(windowId) {
    const wid = Number(windowId);
    const target = [...this.targets.values()].find(t => Number(t.windowId) === wid && !t.stopped);
    if (!target || target.previewDismissed) return false;
    this._nativePreviewWindowId = wid;
    this.ensureScreenIndicator();
    const previews = this._previewWindows();
    const occupied = new Set([...previews.entries.values()]
      .filter(entry => entry.identity.targetId !== target.id).map(entry => entry.identity.slot));
    let slot = 0;
    while (occupied.has(slot)) slot += 1;
    return previews.open({ targetId: target.id, generation: target.generation, windowId: wid, slot });
  }

  setNativePreviewVisible(visible, targetId) {
    let written = false;
    for (const id of this.nativePreviews?.entries.keys() ?? []) {
      if (!targetId || targetId === id) {
        written = this.nativePreviews.send(id, { cmd: "visible", visible: Boolean(visible) }) || written;
      }
    }
    return written;
  }

  stopNativePreview(targetId, verifiedPreviews) {
    for (const target of targetId ? [this.targets.get(targetId)] : this.targets.values()) {
      if (target?.nativePreview) target.nativePreview = { ...target.nativePreview, status: "closed", visible: false };
    }
    if (!targetId) this._nativePreviewWindowId = null;
    return this.nativePreviews?.close(targetId, verifiedPreviews) ?? false;
  }

  switchNativePreview(windowId) { return this.startNativePreview(windowId); }

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
  _visualFeedbackActive() {
    return this._visualStarted === true || this._autoTargetSession !== true;
  }

  emitClickStep({ ref, pid, windowId, targetId = null, result, ok }) {
    if (!this._visualFeedbackActive()) return;
    const provenance =
      ref && pid !== undefined
        ? this.resolveRefProvenance(pid, ref, windowId, targetId)
        : null;
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
    this.ensureScreenIndicator();
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
   *
   * `control` matters: a stop that races a start closes the input gate, and a
   * non-control command is answered locally with "cancelled" before it reaches
   * the service.
   */
  /**
   * Raise the menu-bar recording indicator at most once per session, on the
   * first frame we actually capture. Pure AX sessions never touch
   * ScreenCaptureKit, so they never trigger the system capture consent.
   */
  ensureScreenIndicator() {
    if (this._screenIndicatorOn === true) return;
    this._screenIndicatorOn = true;
    this.startScreenIndicator();
  }

  startScreenIndicator() {
    this.exec(["screen-indicator", "--state", "on"], undefined, { control: true })
      .then((res) => { this.screenIndicatorListenerMissing = res?.applied === false; })
      .catch(() => {});
  }

  /**
   * Release the system sharing indicator and verify the service took it.
   *
   * This used to be a plain fire-and-forget `exec()`. Two things went wrong.
   * `stopVisualSession()` closes the input gate a few lines before calling it,
   * so the request was answered locally with `{ error: "cancelled" }` and never
   * left the process — every stop, graceful or not, leaked the stream. And the
   * ScreenCaptureKit stream lives in the launchd `cu` service, which DSH does
   * not own, so the leak outlived the app: macOS kept showing “Currently
   * Sharing” for a session that no longer existed, and restarting DSH could not
   * clear it. `control` + timeout + retry + a read-back of `screenIndicator` are
   * what make the off command stick.
   *
   * @returns {Promise<boolean>} true when the service reported `off`.
   */
  async stopScreenIndicator({ attempts = 2, timeoutMs = 1200 } = {}) {
    const tries = Math.max(1, Number(attempts) || 1);
    let lastError = null;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      try {
        const res = await this.exec(
          ["screen-indicator", "--state", "off"],
          AbortSignal.timeout(Math.max(200, Number(timeoutMs) || 1200)),
          { control: true },
        );
        if (res?.ok === false) {
          lastError = res.error ?? res.message ?? "indicator_off_failed";
        } else if ((res?.screenIndicator ?? "off") === "off") {
          this.lastIndicatorError = null;
          // `applied: false` means the launchd service relayed the request but no
          // menu-bar app was listening — the stream was never closed because it
          // was never opened. Report it as released (nothing to leak) while
          // keeping the missing listener visible to callers.
          this.screenIndicatorListenerMissing = res?.applied === false;
          // Only a stream that was actually on can be a leak; a clean boot sees
          // "previous":"off" and must not be reported as a recovery.
          this.screenIndicatorWasOn = res?.previous === "on";
          this._screenIndicatorOn = false;
          return true;
        } else {
          lastError = `indicator_state_${res?.screenIndicator}`;
        }
      } catch (error) {
        lastError = error?.message ?? String(error);
      }
      if (attempt < tries) await new Promise((done) => setTimeout(done, 150));
    }
    this.lastIndicatorError = lastError ?? "indicator_off_failed";
    return false;
  }

  /**
   * Last-resort synchronous release for `process.on("exit")`: a quitting host
   * runs no async cleanup, and only a blocking child can still reach the
   * service from an exit hook. Best effort, never throws, bounded by `timeout`.
   */
  stopScreenIndicatorSync(timeout = 1500) {
    const bin = this.resolveBinaryPath();
    if (!bin || !existsSync(bin)) return false;
    try {
      execFileSync(bin, ["screen-indicator", "--state", "off"], {
        timeout: Math.max(200, Number(timeout) || 1500),
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
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
  _newAXState() {
    return {
      worker: null,
      target: null,
      binding: null,
      pending: new Map(),
      reader: null,
      generation: 0,
      tokens: new Map(),
      epoch: null,
      queue: Promise.resolve(),
      requestSeq: 0,
      observationSeq: 0,
    };
  }

  // Compatibility accessors for the original single-worker fields. They point
  // at the default state; target tools use the per-target map below.
  get axWorker() { return this._axDefaultState?.worker ?? null; }
  set axWorker(value) { this._axDefaultState.worker = value; }
  get axWorkerTarget() { return this._axDefaultState?.target ?? null; }
  set axWorkerTarget(value) { this._axDefaultState.target = value; }
  get _axBinding() { return this._axDefaultState?.binding ?? null; }
  set _axBinding(value) { this._axDefaultState.binding = value; }
  get _axPending() { return this._axDefaultState?.pending; }
  set _axPending(value) { this._axDefaultState.pending = value; }
  get _axReader() { return this._axDefaultState?.reader ?? null; }
  set _axReader(value) { this._axDefaultState.reader = value; }
  get axGeneration() { return this._axDefaultState?.generation ?? 0; }
  set axGeneration(value) { this._axDefaultState.generation = value; }
  get axTokens() { return this._axDefaultState?.tokens; }
  set axTokens(value) { this._axDefaultState.tokens = value; }
  get axEpoch() { return this._axDefaultState?.epoch ?? null; }
  set axEpoch(value) { this._axDefaultState.epoch = value; }
  get axQueue() { return this._axDefaultState?.queue; }
  set axQueue(value) { this._axDefaultState.queue = value; }
  get _axRequestSeq() { return this._axDefaultState?.requestSeq ?? 0; }
  set _axRequestSeq(value) { this._axDefaultState.requestSeq = value; }
  get _axObservationSeq() { return this._axDefaultState?.observationSeq ?? 0; }
  set _axObservationSeq(value) { this._axDefaultState.observationSeq = value; }

  _axState(targetId = null, create = false) {
    if (!targetId) return this._axDefaultState;
    let state = this._axStates.get(targetId);
    if (!state && create) {
      state = this._newAXState();
      this._axStates.set(targetId, state);
    }
    return state ?? null;
  }

  _axStateTargetMatches(state, pid, windowId) {
    const target = state?.target;
    if (!target) return false;
    const wantWindow = windowId === undefined ? undefined : Number(windowId);
    return target.pid === Number(pid) && target.windowId === wantWindow;
  }

  /**
   * Resident AX worker (Task 8): lazy-started for a real session target. There
   * is one worker per target, so observing B cannot invalidate A's retained
   * tokens. Each worker has its own request sequence, pending map, epoch,
   * queue and generation.
   */
  async startAXWorker(pid, windowId, targetId = null) {
    const state = this._axState(targetId, true);
    const existing = state.worker;
    if (
      existing &&
      existing.exitCode === null &&
      !existing.killed &&
      this._axStateTargetMatches(state, pid, windowId)
    ) {
      return existing;
    }
    if (existing) this._stopAXState(state);
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
    state.generation += 1;
    state.binding = null;
    state.pending = new Map();
    state.requestSeq = 0;
    state.tokens = new Map();
    state.worker = child;
    state.target = {
      pid: Number(pid),
      windowId: windowId === undefined ? undefined : Number(windowId),
      targetId: targetId ?? null,
    };
    child.on("exit", () => {
      if (state.worker !== child) return;
      state.worker = null;
      state.target = null;
      state.binding = null;
      state.tokens = new Map();
      this._rejectAXPending(new Error("ax worker exited"), state);
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
      this.stopAXWorker(targetId);
      return null;
    }
    state.epoch = ready.banner.epoch ?? null;
    this._ensureAXWorkerReader(child, state);
    if (ready.rest?.trim()) state.reader?.feed(ready.rest);
    return child;
  }

  /** True when the live worker is already bound to this exact target. */
  _axWorkerTargetMatches(pid, windowId, targetId = null) {
    const state = this._axState(targetId, false);
    return this._axStateTargetMatches(state, pid, windowId);
  }

  _stopAXState(state) {
    if (!state) return;
    const child = state.worker;
    state.worker = null;
    state.target = null;
    state.binding = null;
    state.tokens = new Map();
    state.generation += 1;
    state.requestSeq = 0;
    this._rejectAXPending(new Error("ax worker stopped"), state);
    if (state.reader?.child === child) state.reader = null;
    if (!child) return;
    try { child.stdin?.end(); } catch { /* ignore */ }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }

  /**
   * Stop one target's worker, or every worker when no target is named. A stop
   * of A must not destroy B's retained objects.
   */
  stopAXWorker(targetId = null) {
    if (targetId) {
      const state = this._axStates.get(targetId);
      if (!state) return;
      this._stopAXState(state);
      this._axStates.delete(targetId);
      return;
    }
    for (const state of this._axStates.values()) this._stopAXState(state);
    this._axStates.clear();
    this._stopAXState(this._axDefaultState);
    this._axPidQueues.clear();
  }

  /** Reject every pending request for a worker state. */
  _rejectAXPending(error, state = this._axDefaultState) {
    for (const pending of state?.pending?.values?.() ?? []) {
      try { pending.fail(error); } catch { /* ignore */ }
    }
    state?.pending?.clear?.();
  }

  /**
   * ONE persistent stdout reader per worker state. A reply is delivered only to
   * the request whose requestId it carries; late/duplicate lines are dropped.
   */
  _ensureAXWorkerReader(child, state) {
    if (!child || state.reader?.child === child) return state.reader ?? null;
    const reader = { child, buffer: "", onData: null, onExit: null };
    reader.feed = (chunk) => {
      if (state.reader !== reader) return;
      reader.buffer += chunk;
      let index;
      while ((index = reader.buffer.indexOf("\n")) >= 0) {
        const line = reader.buffer.slice(0, index);
        reader.buffer = reader.buffer.slice(index + 1);
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        const id = parsed?.requestId;
        const pending = id === undefined ? null : state.pending?.get(String(id));
        if (!pending) continue; // stale / duplicate / unsolicited: drop it
        state.pending.delete(String(id));
        pending.settle(parsed);
      }
    };
    reader.onData = (chunk) => reader.feed(String(chunk));
    reader.onExit = () => {
      if (state.reader !== reader) return;
      this._rejectAXPending(new Error("ax worker exited"), state);
      state.worker = null;
      state.target = null;
      state.binding = null;
      state.tokens = new Map();
    };
    child.stdout.on("data", reader.onData);
    child.on("exit", reader.onExit);
    state.reader = reader;
    return reader;
  }

  /**
   * A timed-out AX action has an UNKNOWN outcome. It is never auto-replayed,
   * and only that target's worker is destroyed.
   */
  _invalidateAXWorkerAfterTimeout(state) {
    if (!state) return;
    const child = state.worker;
    state.worker = null;
    state.target = null;
    state.binding = null;
    state.tokens = new Map();
    state.generation += 1;
    state.requestSeq = 0;
    state.pending = new Map();
    state.reader = null;
    try { child?.kill("SIGTERM"); } catch { /* ignore */ }
  }

  _axRequest(obj, timeoutMs = 5000, targetId = null) {
    const state = this._axState(targetId, false) ?? this._axDefaultState;
    const child = state.worker;
    if (!child || child.exitCode !== null) return Promise.reject(new Error("ax worker unavailable"));
    this._ensureAXWorkerReader(child, state);
    state.requestSeq += 1;
    const requestId = `g${state.generation ?? 0}-r${state.requestSeq}`;
    const binding = state.binding
      ? {
          pid: state.binding.pid,
          windowId: state.binding.windowId,
          axGeneration: state.generation ?? 0,
          sessionGeneration: this.sessionGeneration ?? 0,
          observationId: state.binding.observationId,
          epoch: state.epoch ?? null,
          targetId: state.binding.targetId ?? null,
        }
      : null;
    const run = () => new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); state.pending?.delete(requestId); };
      const settle = (parsed) => { if (settled) return; settled = true; cleanup(); resolve(parsed); };
      const fail = (error) => { if (settled) return; settled = true; cleanup(); reject(error); };
      state.pending = state.pending ?? new Map();
      state.pending.set(requestId, { settle, fail });
      const timer = setTimeout(() => {
        if (settled) return;
        state.pending?.delete(requestId);
        this._invalidateAXWorkerAfterTimeout(state);
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
    const pidKey = Number.isFinite(Number(state.target?.pid)) ? `pid:${Number(state.target.pid)}` : null;
    const previous = pidKey
      ? (this._axPidQueues.get(pidKey) ?? Promise.resolve())
      : (state.queue ?? Promise.resolve());
    const chained = previous.then(run, run);
    if (pidKey) this._axPidQueues.set(pidKey, chained.catch(() => {}));
    state.queue = chained.catch(() => {});
    return chained;
  }

  /**
   * Record ONE retained observation for a target: nodes, tokens, target,
   * worker generation, session generation and observationId all come from this
   * single result.
   */
  _recordAXObservation(res, targetId = null) {
    if (!res?.ok) return res;
    const state = this._axState(targetId, false);
    if (!state) return res;
    state.epoch = res.epoch ?? state.epoch;
    state.tokens = state.tokens ?? new Map();
    state.tokens.clear();
    for (const candidate of res.candidates ?? []) {
      if (candidate?.elementToken) state.tokens.set(String(candidate.path), String(candidate.elementToken));
    }
    state.observationSeq += 1;
    const target = state.target ?? {};
    state.binding = {
      observationId: String(res.observationId ?? `ob${state.observationSeq}`),
      axGeneration: state.generation ?? 0,
      sessionGeneration: this.sessionGeneration ?? 0,
      epoch: state.epoch ?? null,
      pid: Number.isFinite(Number(res.pid)) ? Number(res.pid) : (target.pid ?? null),
      windowId: res.windowId !== undefined && res.windowId !== null ? Number(res.windowId) : (target.windowId ?? null),
      targetId: target.targetId ?? null,
      nodes: Array.isArray(res.nodes) ? res.nodes : null,
    };
    return res;
  }

  /** Observe via the target's resident worker and refresh its token map. */
  async axObserve(targetId = null) {
    const res = await this._axRequest({ cmd: "observe" }, 5000, targetId);
    return this._recordAXObservation(res, targetId);
  }

  _axStateOrLegacy(targetId, request = {}) {
    const state = this._axState(targetId, false);
    if (state) return state;
    if (!targetId) return this._axDefaultState;
    const fallback = this._axDefaultState;
    if (!fallback?.tokens?.size) return null;
    if (!fallback.target || this._sameAXTarget(fallback.target, request)) return fallback;
    return null;
  }

  axTokenFor(ref, targetId = null, request = null) {
    const state = this._axStateOrLegacy(targetId, request ?? { targetId });
    return state?.tokens?.get(String(ref)) ?? null;
  }

  axTokensFor(targetId = null) {
    return this._axStateOrLegacy(targetId, { targetId })?.tokens ?? null;
  }

  axBinding(targetId = null) {
    return this._axState(targetId, false)?.binding ?? null;
  }

  clearAXBinding(targetId = null) {
    const state = this._axState(targetId, false);
    if (!state) return;
    state.binding = null;
    state.tokens?.clear?.();
  }

  /**
   * A ref for target B must use B's own worker. If B has no retained worker
   * (or its worker/tokens were lost), use the one-shot identity path with
   * pid/window/snapshot provenance rather than interpreting A's token.
   */
  foreignAXTokenFor(ref, request = {}) {
    const targetId = typeof request.targetId === "string" ? request.targetId : null;
    if (!targetId) return null;
    const key = String(ref);
    const own = this._axStates.get(targetId);
    if (own?.tokens?.has(key)) return null;
    const fallback = this._axDefaultState;
    if (
      fallback?.tokens?.has(key) &&
      (!fallback.target || !this._sameAXTarget(fallback.target, request))
    ) {
      return fallback.target?.targetId ?? "legacy";
    }
    for (const [id, state] of this._axStates) {
      if (id !== targetId && state.tokens?.has(key)) return id;
    }
    return null;
  }

  axTokenUsableFor(request = {}) {
    const targetId = typeof request.targetId === "string" ? request.targetId : null;
    if (!targetId) return true;
    const state = this._axStates.get(targetId);
    if (state) return Boolean(state.worker || state.tokens?.size);
    // One-target compatibility: the default state may back this target until
    // the caller takes a real per-target observation.
    const fallback = this._axDefaultState;
    return Boolean(
      fallback &&
        (fallback.worker || fallback.tokens?.size) &&
        (!fallback.target || this._sameAXTarget(fallback.target, request)),
    );
  }

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
    const targetId = typeof request.targetId === "string" ? request.targetId : null;
    const state = this._axStateOrLegacy(targetId, request);
    const token = state?.tokens?.get(String(ref));
    if (!token) {
      return { ok: false, error: "identity_unproven", actionReplaySafe: false,
               message: "no retained token for this ref; call cu_snapshot again" };
    }
    const b = state?.binding ?? null;
    if (!b) {
      const t = state?.target ?? this.axWorkerTarget ?? this.activeSession ?? null;
      if (!t || !this._sameAXTarget(t, request)) {
        return { ok: false, error: "target_mismatch", actionReplaySafe: false,
                 message: "the retained token is not bound to the requested target; call cu_snapshot again" };
      }
      return { ok: true, token, binding: null };
    }
    if (b.sessionGeneration !== (this.sessionGeneration ?? 0) || b.axGeneration !== (state.generation ?? 0)) {
      return { ok: false, error: "stale_observation", actionReplaySafe: false,
               message: "the observation belongs to a superseded worker/session; call cu_snapshot again" };
    }
    if (request.targetId && b.targetId && request.targetId !== b.targetId) {
      return { ok: false, error: "target_mismatch", actionReplaySafe: false,
               message: "the retained token belongs to a different target; call cu_snapshot again" };
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

  isForegroundAuthorized(targetId = null) {
    if (this.sessionForegroundAuthorized) return true;
    if (this.authorizeForeground) return true;
    if (targetId && this._targetForegroundAuth?.has(targetId)) return true;
    return false;
  }

  async axClick(elementToken, action = "AXPress", targetId = null, options = {}) {
    return this._axRequest({
      cmd: "click",
      elementToken,
      action,
      button: options.button || "left",
      count: options.count || 1,
      foreground: options.foreground === true,
    }, 5000, targetId);
  }

  async axVerify(elementToken, targetId = null) {
    return this._axRequest({ cmd: "verify", elementToken }, 5000, targetId);
  }

  /** Verify AND write in ONE native command on the retained AX object (R3). */
  async axInput(elementToken, text, mode = "setvalue", targetId = null, options = {}) {
    return this._axRequest({
      cmd: "input",
      elementToken,
      text: String(text ?? ""),
      mode,
      foreground: options.foreground === true,
    }, 5000, targetId);
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
   * Capture via the warm daemon (preferring the live SCStream frame buffer when
   * streaming a window) and write PNG/JPEG bytes directly to `opts.out`, avoiding
   * base64 JSON serialization overhead on high-frequency painting verification.
   */
  async captureShotToFile(opts = {}) {
    if (!opts.out) return { ok: false, error: "missing_out" };
    try {
      const request = {
        cmd: "shot",
        out: String(opts.out),
        format: opts.format ?? "png",
        quality: opts.quality ?? 0.92,
        stream: opts.stream !== false,
      };
      if (opts.screen === true) request.screen = true;
      if (opts.windowId !== undefined) request.windowId = Number(opts.windowId);
      if (opts.display !== undefined) request.display = Number(opts.display);
      if (opts.maxDimension !== undefined) request.maxDim = Number(opts.maxDimension);
      if (opts.minTimestampNs !== undefined && opts.minTimestampNs !== null) {
        request.minTimestampNs = String(opts.minTimestampNs);
      }
      if (opts.waitMs !== undefined) request.waitMs = Number(opts.waitMs);
      const response = await this._captureRequest(request);
      if (!response?.ok) {
        return { ok: false, error: response?.error ?? "capture_failed" };
      }
      return {
        ok: true,
        out: response.out ?? String(opts.out),
        source: response.source ?? "daemon",
        timestampNs: response.timestampNs ?? null,
        mimeType: response.mimeType,
        width: response.width,
        height: response.height,
        origin: response.origin ?? { x: 0, y: 0 },
        size: response.size ?? { width: 0, height: 0 },
        scale: response.scale ?? 1,
        capturedAt: response.capturedAt ?? null,
        displayId: response.displayId ?? null,
        windowId: opts.windowId ?? null,
        screen: Boolean(opts.screen),
      };
    } catch (error) {
      return {
        ok: false,
        error: "capture_daemon_unavailable",
        message: String(error?.message ?? error).slice(0, 200),
      };
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
  assertCanAct(actionName, signal, targetId = null) {
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
    if (targetId) {
      const target = this.targets.get(targetId);
      if (target && (target.gateClosed || target.stopped || target.closed)) {
        this.writeActivity("该目标已停止");
        const err = new Error(
          `Target ${targetId} was stopped. Other targets may continue; start this target again explicitly with cu_session before acting on it.`,
        );
        err.code = target.closed ? "TARGET_CLOSED" : "TARGET_STOPPED";
        throw err;
      }
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

  _findAvailablePort(preferredPort = 47777) {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", (err) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        const s2 = createServer();
        s2.once("error", reject);
        s2.listen(0, "127.0.0.1", () => {
          const { port } = s2.address();
          s2.close(() => resolve(port));
        });
      } else {
        reject(err);
      }
    });
    s.listen(preferredPort, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

  /**
   * Fail closed when a test process would touch the person's real ~/.cu.
   *
   * A test that forgets `stateDir` used to spawn the helper without
   * CU_STATE_DIR, so the helper rewrote the real config.json with its own port
   * and token, then died with the test. The running plugin was left pointing at
   * a port nothing listened on. Isolated tests pass an explicit stateDir or run
   * with CU_STATE_DIR; anything else in a Node test context is refused instead
   * of silently borrowing (and corrupting) the real installation.
   */
  _testIsolationViolation() {
    if (!process.env.NODE_TEST_CONTEXT) return null;
    if (this._stateDirExplicit) return null;
    return {
      ok: false,
      error: "test_isolation_required",
      message:
        "this test process would use the real ~/.cu; pass stateDir or set CU_STATE_DIR to a temporary directory",
    };
  }

  /**
   * Check if the service at baseUrl is responsive; if not, automatically
   * start the bundled `bin/cu service` as a managed background child process.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ ok: boolean, error?: string, managed?: boolean }>}
   */
  async ensureServiceRunning(signal) {
    if (this._disposed) {
      return { ok: false, error: "disposed", message: "Manager is disposed." };
    }
    const isolation = this._testIsolationViolation();
    if (isolation) return isolation;
    if (this._startingServicePromise) {
      return this._startingServicePromise;
    }

    const abortCtrl = new AbortController();
    this._startingServiceAbortController = abortCtrl;
    const combinedSignal = signal
      ? AbortSignal.any([signal, abortCtrl.signal])
      : abortCtrl.signal;

    this._startingServicePromise = (async () => {
      let child = null;
      try {
        const { baseUrl, token } = this.readServiceConfig();
        try {
          const probe = await fetch(`${baseUrl}/v1/status`, {
            method: "GET",
            signal: combinedSignal,
          });
          if (probe.ok) {
            let authRejected = false;
            try {
              const authProbe = await fetch(`${baseUrl}/v1/exec`, {
                method: "POST",
                headers: {
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ action: "frontmost" }),
                signal: AbortSignal.timeout(600),
              });
              if (authProbe.status === 401) {
                authRejected = true;
              }
            } catch {
              // ignore network errors during auth check
            }
            if (authRejected) {
              if (this.explicitUrl) {
                return {
                  ok: false,
                  error: "foreign_service_unauthorized",
                  message: `Service at ${baseUrl} rejected authentication with expected token.`,
                };
              }
              // Not an explicit URL: default port is held by foreign/unauthorized service.
              // Fall through to launch our own managed service on an isolated free port.
            } else {
              return { ok: true, managed: Boolean(this.managedServiceProcess) };
            }
          }
        } catch {
          // not yet reachable
        }

        if (combinedSignal.aborted) return { ok: false, error: "aborted" };
        if (this._disposed) return { ok: false, error: "disposed" };

        const bin = this.resolveBinaryPath();
        if (!bin || !existsSync(bin)) {
          return {
            ok: false,
            error: "binary_missing",
            message: `CU binary not found at ${bin}. Ensure universal binary exists at bin/cu.`,
          };
        }

        let port = 47777;
        try {
          const u = new URL(baseUrl);
          if (u.port) port = Number(u.port);
        } catch {
          // default 47777
        }

        if (!this.explicitUrl) {
          try {
            port = await this._findAvailablePort(port);
          } catch {
            // fallback to port
          }
        }

        const chosenToken = this.explicitToken || (this._managedToken ?? randomBytes(24).toString("hex"));
        this._managedToken = chosenToken;
        this._managedPort = port;

        const env = {
          ...process.env,
          CU_AUTH_TOKEN: chosenToken,
          CU_STATE_DIR: this.stateDir,
        };
        child = spawn(bin, ["service", "--port", String(port), "--watch-parent"], {
          env,
          detached: false,
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.unref();
        this.managedServiceProcess = child;

        child.on("exit", () => {
          if (this.managedServiceProcess === child) {
            this.managedServiceProcess = null;
          }
        });

        const deadline = Date.now() + 4500;
        while (Date.now() < deadline) {
          if (combinedSignal.aborted || this._disposed) {
            try { child.kill("SIGKILL"); } catch {}
            this.managedServiceProcess = null;
            return { ok: false, error: this._disposed ? "disposed" : "aborted" };
          }
          await new Promise((r) => setTimeout(r, 100));
          try {
            const res = await fetch(`http://127.0.0.1:${port}/v1/status`, {
              method: "GET",
              signal: AbortSignal.timeout(400),
            });
            if (res.ok) {
              return { ok: true, managed: true };
            }
          } catch {
            // keep waiting
          }
        }
        try { child.kill("SIGKILL"); } catch {}
        this.managedServiceProcess = null;
        return { ok: false, error: "timeout_waiting_for_service" };
      } catch (err) {
        if (child) {
          try { child.kill("SIGKILL"); } catch {}
        }
        this.managedServiceProcess = null;
        return { ok: false, error: "spawn_failed", message: err.message };
      } finally {
        this._startingServicePromise = null;
        this._startingServiceAbortController = null;
      }
    })();

    return this._startingServicePromise;
  }

  /**
   * Stop the managed background service process if one was started by this instance.
   */
  stopManagedService() {
    if (this._startingServiceAbortController) {
      try { this._startingServiceAbortController.abort(); } catch {}
      this._startingServiceAbortController = null;
    }
    if (this.managedServiceProcess) {
      const child = this.managedServiceProcess;
      this.managedServiceProcess = null;
      try {
        child.stdin?.end();
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          process.kill(child.pid, 0);
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, 600).unref();
    }
  }

  /**
   * The System Settings URL for a permission pane. Kept separate from opening
   * it so the mapping is testable without launching System Settings.
   * @param {"accessibility"|"screenRecording"|"screen"} target
   */
  static systemSettingsUrl(target) {
    if (target === "screenRecording" || target === "screen") {
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    }
    return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
  }

  /**
   * Open macOS System Settings pane for Accessibility or Screen Recording.
   * @param {"accessibility"|"screenRecording"|"screen"} target
   */
  openSystemSettings(target) {
    const url = CuSessionManager.systemSettingsUrl(target);
    try {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Query GET /v1/status from the local CU service.
   * @param {AbortSignal} [signal]
   */
  async getStatus(signal) {
    try {
      const { baseUrl } = this.readServiceConfig();
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
      // Auto-heal: attempt to launch bundled service if unreachable
      const autoStart = await this.ensureServiceRunning(signal);
      if (autoStart.ok) {
        try {
          const { baseUrl } = this.readServiceConfig();
          const res = await fetch(`${baseUrl}/v1/status`, {
            method: "GET",
            signal,
          });
          const data = await res.json();
          if (data.paused === true) {
            this.pauseLatched = true;
          }
          return data;
        } catch {
          // fall through to error
        }
      }
      const { baseUrl } = this.readServiceConfig();
      return {
        ok: false,
        error: "service_unreachable",
        message: `CU local service at ${baseUrl} is not reachable: ${err.message}`,
        nextSteps: ["Ensure bin/cu is executable, or start cu service on port 47777"],
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
    const targetId = typeof options?.targetId === "string" && options.targetId ? options.targetId : null;
    const targetAtEnqueue = targetId ? this.targets.get(targetId) ?? null : null;
    const generationAtEnqueue = this.sessionGeneration ?? 0;
    const targetGenerationAtEnqueue = targetAtEnqueue?.generation ?? null;

    const gateRefusal = (code, message) => ({
      ok: false,
      error: code,
      ...(targetId ? { targetId } : {}),
      outcomeUnknown: true,
      actionReplaySafe: false,
      message,
    });

    const run = async () => {
      if (!control && this.inputGateClosed) {
        return gateRefusal("cancelled", "the session was stopped before this action could start");
      }
      // A stop of THIS target must not cancel another target's queue. The
      // session-generation check only covers a stop-all.
      if (!control && generationAtEnqueue !== (this.sessionGeneration ?? 0)) {
        return gateRefusal("cancelled", "the session was stopped before this action could start");
      }
      if (!control && targetId) {
        const target = this.targets.get(targetId);
        if (!target || target !== targetAtEnqueue || target.generation !== targetGenerationAtEnqueue) {
          return gateRefusal("target_closed", "the target was closed or replaced before this action could start");
        }
        if (target.gateClosed || target.stopped || target.closed) {
          return gateRefusal(
            target.closed ? "target_closed" : "target_stopped",
            `target ${targetId} was stopped; other targets may continue`,
          );
        }
      }
      if (signal?.aborted) {
        return gateRefusal("aborted", "Operation aborted before execution");
      }
      // Cooperative cancellation: our own controller aborts when the user stops
      // the session, independent of the caller's signal.
      const internal = new AbortController();
      this._inflight = this._inflight ?? new Set();
      this._inflight.add(internal);
      this._inflightTargets = this._inflightTargets ?? new Map();
      this._inflightTargets.set(internal, targetId);
      const effectiveSignal = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
      try {
        const result = await this._execRequest(argv, effectiveSignal, { eventsVersion, eventContext, onEvent });
        // A native `window_gone` is authoritative: retire this target
        // incarnation so its old refs/snapshotIds cannot be reused against a
        // replacement window that happens to reuse an id.
        if (targetId && result?.error === "window_gone") {
          this.invalidateTarget(targetId, "window_gone");
        }
        return result;
      } catch (error) {
        if (internal.signal.aborted || error?.name === "AbortError") {
          return gateRefusal("cancelled", "the action was cancelled; its outcome is unknown");
        }
        throw error;
      } finally {
        this._inflight.delete(internal);
        this._inflightTargets.delete(internal);
      }
    };
    if (bypassQueue) return run();
    if (targetId) {
      const previous = this.targetQueues.get(targetId) ?? Promise.resolve();
      const next = previous.then(run, run);
      this.targetQueues.set(targetId, next.catch(() => {}));
      return next;
    }
    // Unscoped reads (windows/status/launch) still have one compatibility queue.
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Abort in-flight exec. With a targetId only that target's work is cancelled,
   * so stopping A cannot silently abort B.
   * @param {string | null} [targetId]
   */
  cancelInFlight(targetId = null) {
    let count = 0;
    for (const controller of this._inflight ?? []) {
      if (targetId) {
        const owner = this._inflightTargets?.get(controller) ?? null;
        if (owner !== targetId) continue;
      }
      try { controller.abort(); count += 1; } catch { /* ignore */ }
    }
    return count;
  }

  async _execRequest(argv, signal, { eventsVersion, eventContext, onEvent } = {}) {
    const isolation = this._testIsolationViolation();
    if (isolation) return isolation;
    const body = { argv };
    if (eventsVersion === 1) {
      body.eventsVersion = 1;
      if (eventContext) body.eventContext = eventContext;
    }
    let res;
    const send = () => {
      const { baseUrl, token } = this.readServiceConfig();
      return fetch(`${baseUrl}/v1/exec`, {
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
    };
    try {
      res = await send();
      if (res.status === 401 && !this.managedServiceProcess && !this.explicitToken) {
        const started = await this.ensureServiceRunning(signal);
        if (started.ok) {
          res = await send();
        }
      }
    } catch (fetchErr) {
      if (signal?.aborted) throw fetchErr;
      const started = await this.ensureServiceRunning(signal);
      if (started.ok) {
        res = await send();
      } else {
        throw fetchErr;
      }
    }
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
    this._previewActionFeedback(published.event);
    return published;
  }

  _previewActionFeedback(event) {
    if (!event.point || !event.target || !this.nativePreviews) return;
    // Adapter events use epoch nanoseconds. Unknown clock origins cannot prove
    // freshness, so they must not be replayed into a current preview.
    if (event.clockDomain !== "adapter") return;
    const emittedMs = Number(event.emittedNs) / 1_000_000;
    if (!Number.isFinite(emittedMs) || Math.abs(Date.now() - emittedMs) > 1000) return;
    if (event.phase !== "targetReady" && !(event.phase === "dispatched" && event.kind === "click")) return;
    const target = event.target.targetId
      ? this.targets.get(event.target.targetId)
      : [...this.targets.values()].find(t => t.pid === event.target.pid && t.windowId === event.target.windowId);
    if (!target || target.stopped || target.gateClosed ||
        target.pid !== event.target.pid || target.windowId !== event.target.windowId ||
        target.generation !== event.target.targetGeneration) return;
    const observation = this.snapshotGeometry(target.pid, target.windowId, null, target.id);
    if (!observation?.bounds) return;
    this.nativePreviews.send(target.id, { cmd: "feedback", point: event.point,
      bounds: observation.bounds, click: event.phase === "dispatched", sentAt: emittedMs });
  }

  _applyActionEvent(event) {
    try {
      switch (event.phase) {
        case "pointer":
          if (event.kind === "drag" && event.point) this.showAgentCursor(event.point.x, event.point.y, { glide: false });
          break;
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
   *
   * The delta baseline is scoped to the chat that took the observation
   * (`options.owner`, the host session id). A new chat used to inherit another
   * chat's baseline and receive a delta on its very first snapshot, which hid
   * the whole tree it had never seen.
   *
   * `options.bounds` records the target window frame at observation time so a
   * later coordinate click can tell that the window moved or resized.
   *
   * @param {number} pid
   * @param {number | undefined} windowId
   * @param {Record<string, any>} raw
   * @param {{ full?: boolean, owner?: string | null, bounds?: {x:number,y:number,width:number,height:number} | null }} [options]
   */
  _snapshotKey(pid, windowId, targetId = null) {
    const base = `${Number(pid)}:${windowId === undefined || windowId === null ? "app" : Number(windowId)}`;
    return targetId ? `${targetId}|${base}` : base;
  }

  recordSnapshot(pid, windowId, raw, options = {}) {
    const targetId = typeof options.targetId === "string" && options.targetId ? options.targetId : null;
    const key = this._snapshotKey(pid, windowId, targetId);
    const owner = options.owner ?? null;
    const baselineKey = `${owner ?? ""}\u0000${key}`;
    const previous = this.snapshotBaselines.get(baselineKey);
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
    const entry = {
      snapshotId,
      takenAt,
      windowId: windowId ?? null,
      targetId,
      targetGeneration: targetId ? (this.targets.get(targetId)?.generation ?? null) : null,
      owner,
      bounds: options.bounds ?? null,
      refs,
      lines,
    };
    // The newest entry backs ref provenance and stale-snapshot checks; the
    // per-owner index backs delta computation only.
    this.snapshots.set(key, entry);
    this.snapshotBaselines.set(baselineKey, entry);
    if (this.snapshotBaselines.size > 128) {
      this.snapshotBaselines.delete(this.snapshotBaselines.keys().next().value);
    }

    const truncated = raw.truncated === true;
    if (options.full === true || !previous) {
      return {
        mode: "full",
        coordinateSpace: "screen-points-top-left",
        snapshotId,
        takenAt,
        pid,
        windowId: windowId ?? null,
        ...(targetId ? { targetId } : {}),
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
      coordinateSpace: "screen-points-top-left",
      snapshotId,
      takenAt,
      pid,
      windowId: windowId ?? null,
      ...(targetId ? { targetId } : {}),
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
  resolveRefProvenance(pid, ref, windowId, targetId = null) {
    const key = this._snapshotKey(pid, windowId, targetId);
    const entry = this.snapshots.get(key);
    if (!entry) return null;
    if (windowId !== undefined && entry.windowId !== null && entry.windowId !== windowId) {
      return null;
    }
    if (targetId) {
      const target = this.targets.get(targetId);
      if (!target || entry.targetGeneration !== target.generation) return null;
    }
    return entry.refs.get(ref) ?? null;
  }

  /**
   * The snapshot id currently backing refs for this pid/window, or null.
   * @param {number} pid
   * @param {number} [windowId]
   */
  currentSnapshotId(pid, windowId, targetId = null) {
    const entry = this.snapshots.get(this._snapshotKey(pid, windowId, targetId));
    if (!entry) return null;
    if (targetId) {
      const target = this.targets.get(targetId);
      if (!target || entry.targetGeneration !== target.generation) return null;
    }
    return entry.snapshotId ?? null;
  }

  /**
   * Does this ref belong to the snapshot generation the caller says it does?
   * Returns a reason string when it does not, so an action can refuse instead of
   * hitting whatever control now sits at that path.
   * @param {number} pid
   * @param {string} ref
   * @param {number} [windowId]
   * @param {number} [snapshotId]
   * @param {string | null} [owner] the chat that took the observation
   * @returns {string | null}
   */
  refSnapshotMismatch(pid, ref, windowId, snapshotId, owner = null, targetId = null) {
    if (snapshotId === undefined || snapshotId === null) return null;
    const key = this._snapshotKey(pid, windowId, targetId);
    const entry =
      this.snapshotBaselines.get(`${owner ?? ""}\u0000${key}`) ?? this.snapshots.get(key);
    if (!entry) return "no snapshot is cached for this window";
    if (targetId) {
      const target = this.targets.get(targetId);
      if (!target) return `target ${targetId} no longer exists`;
      if (entry.targetGeneration !== target.generation) {
        return `target ${targetId} was closed or replaced; this ref belongs to an older window generation`;
      }
    }
    if (!entry.refs.has(ref)) return `ref ${ref} is not in the cached snapshot`;
    if (Number(snapshotId) !== entry.snapshotId) {
      return `ref ${ref} came from snapshot ${snapshotId}, the current one is ${entry.snapshotId}`;
    }
    return null;
  }

  /**
   * Geometry recorded with the observation this chat last took for a target.
   * A coordinate click compares it with the window's frame right now: after a
   * move or resize the old point no longer names the control it was read from.
   * @param {number} pid
   * @param {number | undefined} windowId
   * @param {string | null} owner
   */
  snapshotGeometry(pid, windowId, owner = null, targetId = null) {
    const key = this._snapshotKey(pid, windowId, targetId);
    const entry =
      this.snapshotBaselines.get(`${owner ?? ""}\u0000${key}`) ?? this.snapshots.get(key);
    if (!entry) return null;
    if (targetId) {
      const target = this.targets.get(targetId);
      if (!target || entry.targetGeneration !== target.generation) return null;
    }
    return {
      snapshotId: entry.snapshotId,
      takenAt: entry.takenAt,
      bounds: entry.bounds ?? null,
    };
  }

  /**
   * Fingerprint the last snapshot the manager cached, or null when there is no
   * baseline. A post-action observe compares against this to decide whether the
   * tree moved, instead of assuming one read is enough.
   * @param {number} pid
   * @param {number} [windowId]
   * @param {string | null} [owner]
   * @returns {string | null}
   */
  cachedFingerprint(pid, windowId, owner = null, targetId = null) {
    const key = this._snapshotKey(pid, windowId, targetId);
    const entry =
      this.snapshotBaselines.get(`${owner ?? ""}\u0000${key}`) ?? this.snapshots.get(key);
    if (!entry) return null;
    if (targetId) {
      const target = this.targets.get(targetId);
      if (!target || entry.targetGeneration !== target.generation) return null;
    }
    return [...entry.lines.values()].join("\n");
  }

  /**
   * Spawn a detached floating indicator (`capsule` and/or `halo`) and monitor for user stop.
   * @param {string[]} args
   */
  _spawnTargetIndicator(target, args) {
    const generation = target?.generation;
    const child = this.spawnIndicator(args, {
      targetScoped: true,
      onEvent: (event) => {
        if (!target || target.generation !== generation || target.stopped || this._disposed) return;
        if (event.halo === "stopped") {
          this.requestNativeTargetStop(target.id, "halo_stop").catch(() => {});
        }
      },
    });
    if (!child || !target) return child;
    target.indicators = target.indicators ?? new Set();
    target.indicators.add(child);
    child.on("exit", () => {
      target.indicators?.delete(child);
    });
    return child;
  }

  _stopTargetIndicators(target) {
    if (!target) return 0;
    let stopped = 0;
    for (const child of [...(target.indicators ?? [])]) {
      try {
        child.kill("SIGTERM");
        stopped += 1;
      } catch {
        // already exited
      }
      target.indicators.delete(child);
    }
    return stopped;
  }

  spawnIndicator(args, options = {}) {
    const bin = this.resolveBinaryPath();
    if (!existsSync(bin)) return null;
    const child = spawn(bin, args, {
      stdio: options.onEvent ? ["ignore", "pipe", "ignore"] : "ignore",
      detached: true,
      env: { ...process.env, ...(options.targetScoped ? { CU_INDICATOR_TARGET_SCOPED: "1" } : {}) },
    });
    if (options.onEvent) {
      let pending = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        pending += chunk;
        if (pending.length > 16384) { pending = ""; return; }
        let boundary;
        while ((boundary = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, boundary);
          pending = pending.slice(boundary + 1);
          try { options.onEvent(JSON.parse(line)); } catch { /* optional indicator */ }
        }
      });
      child.stdout.unref?.();
    }
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
    this.assertCanAct("batch", signal, params.targetId ?? null);
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
          stepPid, String(step.ref), stepWindowId, step.snapshotId, null, params.targetId ?? null
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
            (step.ref ? this.resolveRefProvenance(stepPid, step.ref, stepWindowId, params.targetId ?? null) : null)
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
          foreground: step.foreground ?? (params.foreground === true),
          pid: stepPid,
          windowId: stepWindowId,
          ...(params.targetId ? { targetId: params.targetId } : {}),
        };
        const argv = buildCommandArgv(action, mergedParams, this);
        const stepStarted = Date.now();
        const res = await this.exec(argv, signal, {
          ...(params.targetId ? { targetId: params.targetId } : {}),
        });
        const ok = Boolean(res?.ok);
        // Wall clock per step, so `timings` can separate engine work from the
        // adapter's own overhead instead of attributing everything to the batch.
        results.push({ ok, action, ...res, ms: Date.now() - stepStarted });
        if (action === "click" || action === "double_click") {
          this.emitClickStep({
            ref: step.ref,
            pid: stepPid,
            windowId: stepWindowId,
            targetId: params.targetId ?? null,
            result: res,
            ok,
          });
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
    // An explicit start must not race an in-progress stop: wait for its cleanup
    // so the new session cannot be cleared by the previous completion.
    if (this._stopInFlight) {
      try {
        await this._stopInFlight;
      } catch {
        // The stop reports its own failure; starting still proceeds.
      }
    }
    if (this._disposed) return { ok: false, error: "disposed" };
    const explicit = opts.explicit === true || opts.resume === true || opts.force === true;
    let pid = opts.pid !== undefined && opts.pid !== null ? Number(opts.pid) : null;
    let windowId = opts.windowId !== undefined && opts.windowId !== null ? Number(opts.windowId) : null;
    let appName = opts.appName ?? null;

    // A window without a pid is still resolvable without activating anything:
    // the window list already names its owner. `cu stage` is never implied.
    if ((pid === null || !Number.isFinite(pid)) && windowId !== null) {
      const listing = await this.exec(["windows"]).catch(() => null);
      const window = (listing?.windows ?? []).find((entry) => Number(entry.windowId) === windowId);
      if (window) {
        pid = Number(window.pid);
        if (!appName) appName = window.app ?? null;
      }
    }
    if (pid === null || !Number.isFinite(pid)) {
      return {
        ok: false,
        error: "target_required",
        message: "a background target needs a pid or a window that belongs to one; nothing was activated",
      };
    }
    const previous = this.targets.get(this.currentTargetKey) ?? null;
    const target = this.ensureTarget(
      { pid, windowId: windowId ?? undefined },
      { explicit, app: appName, label: opts.label },
    );
    if (!target) return { ok: false, error: "target_required" };
    if (target.gateClosed && !explicit) {
      return {
        ok: false,
        error: "target_stopped",
        targetId: target.id,
        message: "this target was stopped by the user; another target may continue, or start this one explicitly",
      };
    }
    const sameTarget =
      previous &&
      sameTargetDescriptor(previous, target) &&
      !opts.force &&
      !opts.resume &&
      !previous.stopped;
    target.gateClosed = false;
    target.stopped = false;
    if (explicit) target.previewDismissed = false;
    target.updatedAt = Date.now();
    this._setPrimaryTarget(target);
    const isCreativeApp = /剪映|VideoFusion|Jianying|CapCut|Premiere|Final Cut|Photoshop|Blender/i.test(appName ?? "") || /剪映|VideoFusion|Jianying|CapCut|Premiere|Final Cut|Photoshop|Blender/i.test(opts.label ?? "");
    const authorizeForeground = opts.authorizeForeground === true || opts.interactive === true || isCreativeApp;
    if (authorizeForeground) {
      this.sessionForegroundAuthorized = true;
      this.authorizeForeground = true;
      if (!this._targetForegroundAuth) this._targetForegroundAuth = new Set();
      this._targetForegroundAuth.add(target.id);
    }
    if (authorizeForeground || opts.preview !== false) {
      this.sessionAutoPreview = true;
    }
    this._axWorkerAllowed = true;
    // Only an explicit start/resume may clear the global user stop. A target
    // stop is scoped and does not close the global gate at all.
    if (explicit) this.inputGateClosed = false;
    if (explicit) this.clearPauseLatch();

    const cursorOnDesktop = opts.cursor !== false && opts.nativePreview === false;
    if (!this._visualStarted) {
      this._visualStarted = true;
      // No ScreenCaptureKit stream at session start. Starting one here made every
      // control session open a capture stream it never used, and macOS 15 answers
      // that with its "bypass the private window picker" screen-capture consent
      // dialog — the one that reappears whenever the helper binary is re-signed.
      // The indicator now follows the first real capture instead.
      try {
        if (cursorOnDesktop) this.startCursorOverlay();
        if (this.rimEnabled !== false && cursorOnDesktop) this.setAgentAura(true);
      } catch {
        // Visual feedback is optional; an absent overlay never blocks control.
      }
    } else if (cursorOnDesktop) {
      // A second target joins the existing visual session; do not restart the
      // cursor process or clear the first target's halo.
      try { this.startCursorOverlay(); } catch { /* best effort */ }
    }

    // Re-opening a stopped/closed target is a new incarnation. A continuation
    // of the same live target keeps its generation and queue.
    if (!sameTarget) {
      this._dropTargetSnapshots(target.id);
    }

    const rawSeconds = Number(opts.seconds ?? 900);
    const seconds = Number.isFinite(rawSeconds)
      ? Math.max(30, Math.min(86400, Math.round(rawSeconds)))
      : 900;
    this.sessionTimeoutSeconds = seconds;
    this.sessionHasTimedIndicators = Boolean(
      opts.capsule !== false ||
      (opts.halo !== false && target.windowId !== null) ||
      (opts.nativePreview !== false && target.windowId !== null),
    );
    const titleLabel =
      opts.label ||
      (appName ? `${appName} — DSH 操控中` : "DeepSeek 正在操控电脑");
    target.label = titleLabel;

    if (explicit) {
      // `resume` re-opens the native service gate. This does not activate or
      // move any application.
      await this.exec(["resume"], undefined, { control: true }).catch(() => {});
    }
    this.writeActivity(sameTarget ? "会话继续" : "后台会话已启动");

    // One non-activating capsule for the whole chat; one halo per target.
    if (opts.capsule !== false) {
      const alive = this._capsuleChild && this._capsuleChild.exitCode === null && !this._capsuleChild.killed;
      if (!alive) {
        const count = this.activeTargets().length;
        const capsuleLabel = count > 1 ? `DSH 操控中 · ${count} 个目标` : titleLabel;
        this._capsuleChild = this.spawnIndicator([
          "capsule", "--label", capsuleLabel, "--seconds", String(seconds),
        ]);
      }
    }
    if (opts.halo !== false && target.windowId !== null && (target.indicators?.size ?? 0) === 0) {
      this._spawnTargetIndicator(target, [
        "halo", "--window", String(target.windowId), "--label", titleLabel,
        "--seconds", String(seconds),
      ]);
    }
    if (opts.nativePreview !== false && target.windowId !== null) {
      try { this.startNativePreview(target.windowId); } catch { /* optional preview */ }
    }

    // Desktop layout changes are opt-in. The old default moved DSH and the
    // target window on every start, which is exactly the user interruption this
    // plugin must not cause while working in another app.
    let layoutApplied = false;
    let hiddenApps = 0;
    let layout = null;
    if (opts.dockDsh === true || opts.layout === true) {
      const winList = await this.exec(["windows"]).catch(() => ({ windows: [] }));
      const windows = winList?.windows || [];
      const targetWin = target.windowId !== null
        ? windows.find((w) => Number(w.windowId) === Number(target.windowId))
        : null;
      const targetIsDsh = targetWin ? isDshWindow(targetWin) : false;
      const shouldDock = !targetIsDsh && (opts.dockDsh === true || opts.layout === true);
      if (shouldDock && !this.dockedDshWindow) {
        const dshWin = windows
          .filter(isDshWindow)
          .sort((a, b) => (b.bounds?.width ?? 0) - (a.bounds?.width ?? 0))[0];
        if (dshWin?.bounds) {
          this.dockedDshWindow = {
            windowId: dshWin.windowId,
            x: dshWin.bounds.x,
            y: dshWin.bounds.y,
            w: dshWin.bounds.width,
            h: dshWin.bounds.height,
          };
          const resolved = await this.resolveDisplayLayout({ windows, targetWin, dshWin });
          layout = {
            source: resolved.source,
            screen: resolved.screen?.name ?? null,
            usable: resolved.usable,
          };
          this.lastLayout = resolved;
          const { usable } = resolved;
          const screenW = Math.round(usable.width);
          const dshW = Math.min(640, Math.round(screenW / 3));
          const targetW = screenW - dshW;
          const topY = Math.round(usable.y);
          const usableH = Math.max(400, Math.round(usable.height));
          await this.exec([
            "movewindow", "--window", String(dshWin.windowId),
            "--x", String(Math.round(usable.x) + targetW), "--y", String(topY),
            "--w", String(dshW), "--h", String(usableH),
          ], undefined, { control: true }).catch(() => {});
          if (opts.splitScreen === true && targetWin?.bounds && !this.savedTargetBounds) {
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
            ], undefined, { control: true }).catch(() => {});
          }
          layoutApplied = true;
        }
      }
    }
    if (opts.hideOtherApps === true) {
      const keepList = [appName, "DeepSeek Harness", "Electron"].filter(Boolean);
      this.hiddenApps = await hideUnrelatedApps(keepList);
      hiddenApps = this.hiddenApps.length;
    }

    // Bringing a Stage Manager thumbnail on stage changes the visible desktop.
    // It is never implied; only an explicit request may do it.
    if (target.windowId !== null && opts.bringOnStage === true) {
      await this.exec([
        "stage", "--window", String(target.windowId), "--no-stage-switch",
      ], undefined, { control: true }).catch(() => {});
    }

    // Warming spends one real screen capture so the first preview is fast. A
    // control-only session shows no preview, so that capture bought nothing and
    // cost a ScreenCaptureKit consent dialog. Warm only when a preview is coming.
    if (opts.warmCapture !== false && opts.nativePreview !== false) this.warmCaptureDaemon();
    this.armSessionTimer(seconds);
    this.armIdleStop();

    return {
      ok: true,
      session: sameTarget ? "continued" : "started",
      targetId: target.id,
      label: titleLabel,
      windowId: target.windowId,
      pid: target.pid,
      dockedDsh: Boolean(this.dockedDshWindow),
      targetSplit: Boolean(this.savedTargetBounds),
      desktopTouched: layoutApplied || Boolean(opts.bringOnStage),
      backgroundSafe: !layoutApplied && opts.bringOnStage !== true,
      hiddenApps,
      activeTargets: this.activeTargets().length,
      layout: layout
        ? { source: layout.source, screen: layout.screen ?? null, usable: layout.usable }
        : null,
    };
  }

  /**
   * Reset the idle auto-stop timer. Every cu_* tool call re-arms it (see the
   * execute wrapper in index.mjs); if no activity arrives within
   * `idleStopSeconds`, the visual session is stopped automatically so the user
   * never inherits a stuck capsule/halo or a shrunk DSH window. A value <= 0
   * disables the feature.
   */
  armIdleStop(seconds = this.idleStopSeconds ?? 300) {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const budget = Number(seconds);
    if ((this.activeTargets().length === 0 && !this.activeSession) || !(budget > 0)) return;
    const arm = (delayMs) => {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.activeTargets().length === 0 && !this.activeSession) return;
        // An in-flight native action is real activity even though no new tool
        // call has arrived. Cutting it off would leave a half-dispatched input;
        // defer the reclaim instead of timing out a working action.
        if ((this._inflight?.size ?? 0) > 0) {
          arm(5000);
          return;
        }
        this.stopVisualSession({ reason: "idle_timeout" }).catch(() => {});
      }, delayMs);
      this.idleTimer.unref?.();
    };
    arm(Math.max(5, budget) * 1000);
  }

  /**
   * A session cannot outlive its indicators. If the agent never calls
   * cu_session stop (crash, abandoned turn, host reload), restore the user's
   * windows automatically instead of leaving DSH shrunk forever.
   */
  armSessionTimer(seconds = this.sessionTimeoutSeconds ?? 900) {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    const budget = Math.max(30, Number(seconds) || 900);
    this.sessionTimeoutSeconds = budget;
    const arm = (delayMs) => {
      this.sessionTimer = setTimeout(() => {
        this.sessionTimer = null;
        // An in-flight native action is real activity; never cancel it mid-dispatch.
        if ((this._inflight?.size ?? 0) > 0) {
          arm(5000);
          return;
        }
        this.stopVisualSession({ reason: "session_timeout" }).catch(() => {});
      }, delayMs);
      this.sessionTimer.unref?.();
    };
    arm(budget * 1000);
  }

  /**
   * Slide the session timeout forward on active desktop work when no
   * fixed-lifetime native indicators (capsule/halo/nativePreview) exist, so
   * long unbroken workflows are not cancelled mid-task at 900s while idle
   * sessions still terminate via armIdleStop.
   */
  refreshSessionTimer() {
    if (!this.activeSession || this.sessionHasTimedIndicators || !this.sessionTimer) return false;
    this.armSessionTimer(this.sessionTimeoutSeconds ?? 900);
    return true;
  }

  async stopVisualIndicatorsOnly() {
    this._capsuleChild = null;
    for (const target of this.targets.values()) {
      target.indicators?.clear?.();
    }
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
   * Stop ONE target without closing the desktop for the other targets in the
   * same chat. The gate and generation are invalidated synchronously, before
   * any awaited cleanup, so queued work for this target cannot run.
   */
  async stopTarget(targetId, opts = {}) {
    const target = typeof targetId === "string" ? this.targets.get(targetId) : null;
    if (!target || target.stopped || target.gateClosed) {
      return {
        ok: true,
        alreadyStopped: true,
        targetId: targetId ?? null,
        cleanupState: "clean",
        cancelledActions: 0,
      };
    }
    target.gateClosed = true;
    target.stopped = true;
    target.updatedAt = Date.now();
    target.generation = ++this.targetGenerationSeq;
    this._dropTargetSnapshots(target.id);
    const inFlightCancelled = this.cancelInFlight(target.id);
    this._targetForegroundAuth?.delete(target.id);
    const nativePreviewStopped = this.stopNativePreview?.(target.id) ?? false;
    const indicatorsStopped = this._stopTargetIndicators(target);
    this.targetQueues.delete(target.id);
    this.stopAXWorker?.(target.id);

    const remaining = this.activeTargets();
    if (remaining.length === 0) {
      // The last target ends the whole visual session (capsule, screen
      // indicator, cursor overlay, docked layout, helper children).
      const all = await this.stopVisualSession({
        pause: opts.pause === true,
        reason: typeof opts.reason === "string" ? opts.reason : "target_stop",
      });
      return {
        ...all,
        targetId: target.id,
        target: this._publicTarget(target),
        remainingTargets: 0,
        indicatorsStopped,
        nativePreviewStopped,
        cleanupState: all.cleanupState ?? (inFlightCancelled > 0 ? "unknown" : "clean"),
      };
    }

    const next = this.targets.get(remaining[0].targetId) ?? null;
    this._setPrimaryTarget(next);
    this.armIdleStop();
    return {
      ok: true,
      session: "target_stopped",
      targetId: target.id,
      target: this._publicTarget(target),
      remainingTargets: remaining.length,
      activeTargetIds: remaining.map((item) => item.targetId),
      cancelledActions: inFlightCancelled,
      nativePreviewStopped,
      indicatorsStopped,
      inputGateClosed: false,
      targetGateClosed: true,
      cleanupState: inFlightCancelled > 0 ? "unknown" : "clean",
    };
  }

  /**
   * Stop the active Computer Use session, dismiss floating indicators, and restore DSH & target window bounds.
   * @param {{ pause?: boolean }} [opts]
   */
  /**
   * Latch the user pause without running session cleanup. Used when the UI
   * Stop button is clicked after the session already ended naturally; the
   * cleanup must not run again, but the next ordinary action must still be
   * refused until an explicit start/resume.
   */
  latchUserPause() {
    this.pauseLatched = true;
    this.inputGateClosed = true;
    const { baseUrl, token } = this.readServiceConfig();
    return fetch(`${baseUrl}/v1/pause`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  async stopVisualSession(opts = {}) {
    // A stop is idempotent per engine session: overlapping UI/turn-end/idle
    // stops share one cleanup and emit one end notice. Two cleanups would
    // otherwise let the second one retire whatever session exists by then.
    if (this._stopInFlight) return this._stopInFlight;
    const pending = this._stopVisualSessionOnce(opts);
    this._stopInFlight = pending;
    pending
      .finally(() => {
        if (this._stopInFlight === pending) this._stopInFlight = null;
      })
      .catch(() => {});
    return pending;
  }

  async _stopVisualSessionOnce(opts = {}) {
    // R5: close the input gate and invalidate the session generation IMMEDIATELY,
    // before any awaited cleanup. Queued actions capture the generation at
    // enqueue and refuse to start once it changed.
    this.inputGateClosed = true;
    // Capture the identity still in force so the end notice names the session
    // that just ended, not whatever may exist by the time cleanup finishes.
    const endedSessionId = this.sessionId;
    const endedGeneration = this.sessionGeneration ?? 0;
    const endedOwnerId = this._uiOwnerId ?? null;
    const endedActiveSession = this.activeSession;
    const hadSession = Boolean(this.activeSession || endedSessionId);
    // A user stop must be latched before cleanup, not after it: the cleanup
    // awaits are exactly the window in which a queued input could otherwise
    // slip through. Natural/turn-end stops pass pause:false.
    if (opts.pause === true) this.pauseLatched = true;
    this.sessionGeneration = (this.sessionGeneration ?? 0) + 1;
    this._axBinding = null;
    // Invalidate every target generation synchronously. A queued action for A
    // and one for B both carry their enqueue generation, so neither can start
    // after the stop-all, even if its promise settles later.
    for (const target of this.targets.values()) {
      target.gateClosed = true;
      target.stopped = true;
      target.closed = false;
      target.generation = ++this.targetGenerationSeq;
      target.updatedAt = Date.now();
      this._dropTargetSnapshots(target.id);
      this._stopTargetIndicators(target);
    }
    this.targetQueues.clear();
    this.sessionForegroundAuthorized = false;
    this.authorizeForeground = false;
    this.sessionAutoPreview = false;
    this._targetForegroundAuth?.clear();
    const inFlightCancelled = this.cancelInFlight?.() ?? 0;
    // R7: the native watch preview is owned by the cursor helper; stop it as
    // part of this session, not as a separate best-effort command.
    const nativePreviewStopped = this.stopNativePreview?.(undefined, opts.reason === "turn_end" ? opts.verifiedPreviews : undefined) ?? false;
    clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    this.sessionHasTimedIndicators = false;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await this.stopVisualIndicatorsOnly();
    this.setAgentAura(false);
    this.stopCursorOverlay();
    this.stopCaptureDaemon();
    // Awaited, not fire-and-forget: this is the one place that can still reach
    // the launchd `cu` service, and only it owns the system sharing indicator.
    await this.stopScreenIndicator({ attempts: 2, timeoutMs: 1200 });
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
      const toRestore = this.unhideOnFinish === false ? [] : this.hiddenApps;
      this.hiddenApps = [];
      // Clearing the list even when restore is disabled prevents a stale
      // unhide on a later session. We never claim the apps were restored.
      if (toRestore.length > 0) await restoreHiddenApps(toRestore).catch(() => {});
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
    this._visualStarted = false;
    this._autoTargetSession = false;
    this._capsuleChild = null;
    // Only clear the fields this stop owned. A newer session that started while
    // cleanup was in flight must not be erased by the old completion.
    const prevSession = endedActiveSession;
    if (this.activeSession === endedActiveSession) {
      this.activeSession = null;
      this.currentTargetKey = null;
    }
    for (const target of this.targets.values()) {
      target.indicators?.clear?.();
    }
    this.targets.clear();
    this.targetOrder = [];
    this.targetQueues.clear();
    if (this.sessionId === endedSessionId) this.sessionId = null;
    if (this.sessionId === null) this.eventLog.setSession(null);
    if (hadSession) {
      this._emitSessionEnd({
        sessionId: endedSessionId,
        generation: endedGeneration,
        ownerId: endedOwnerId,
        reason: typeof opts.reason === "string" && opts.reason ? opts.reason : "stop",
        cleanupState: "unknown",
      });
    }
    if (this._uiOwnerId === endedOwnerId) this._uiOwnerId = null;
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
      targetsStopped: true,
      previous: prevSession === null || prevSession === undefined
        ? null
        : {
            targetId: prevSession.targetId ?? null,
            windowId: prevSession.windowId ?? null,
            pid: prevSession.pid ?? null,
            app: prevSession.app ?? null,
            label: prevSession.label ?? null,
            startedAt: prevSession.startedAt ?? null,
          },
    };
  }
}

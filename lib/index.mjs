import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CuSessionManager,
  buildCommandArgv,
  sniffImageMediaType,
} from "./core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let hostDefineTool = (def) => def;
try {
  const toolsMod = await import("@deepseek-ai/dsh-tools");
  if (typeof toolsMod.defineTool === "function") {
    hostDefineTool = toolsMod.defineTool;
  }
} catch {
  // Fallback identity when imported in standalone Node test runner outside DSH app.asar
}

let Schema = {
  object: (shape) => ({ type: "object", shape }),
  string: () => ({ description: () => ({}) }),
  boolean: () => ({ default: () => ({ description: () => ({}) }) }),
  number: () => ({ default: () => ({ description: () => ({}) }) }),
};
try {
  const schemaMod = await import("@deepseek-ai/schemastery");
  if (schemaMod?.default) {
    Schema = schemaMod.default;
  }
} catch {
  // Fallback stub when imported outside DSH runtime
}

export const name = "dsh-computer-use";
export const inject = ["tools"];

export const Config = Schema.object({
  serviceUrl: Schema.string().description("Local CU service URL (default http://127.0.0.1:47777)"),
  autoSession: Schema.boolean()
    .default(true)
    .description("Automatically show top-right floating capsule when acting on a target window"),
  defaultPreviewMaxDim: Schema.number()
    .default(960)
    .description("Default max dimension in pixels for inline window preview screenshots"),
});

const SKILL_PATH = join(__dirname, "../skill/SKILL.md");
const SKILL_CONTENT = existsSync(SKILL_PATH)
  ? readFileSync(SKILL_PATH, "utf8")
  : "# dsh-computer-use\nUse cu_* tools for macOS desktop automation.";

/**
 * Check if the calling agent's active model route accepts image inputs.
 */
async function isImageCapableRoute(ctx, exec) {
  const llm = ctx?.get?.("llm");
  const provider =
    exec?.agent?.session?.requestHeader?.()?.config?.provider ??
    exec?.agent?.options?.provider;
  const model =
    exec?.agent?.session?.requestHeader?.()?.config?.model ??
    exec?.agent?.options?.model;
  if (!llm || !provider || !model) return false;
  try {
    const info = await llm.resolveModelInfo(provider, model, exec?.signal);
    return info?.inputModalities?.includes("image") ?? false;
  } catch {
    return false;
  }
}

/**
 * Save screenshot bytes into DSH's attachment store when supported by the current route.
 */
async function trySaveImageAttachment(ctx, exec, bytes, filename) {
  const attachments = ctx?.get?.("attachments");
  if (!attachments) return undefined;
  const mediaType = sniffImageMediaType(bytes);
  if (!mediaType) return undefined;
  if (
    attachments.imageLimits?.mediaTypes &&
    !attachments.imageLimits.mediaTypes.includes(mediaType)
  ) {
    return undefined;
  }
  const maxBytes = Math.min(
    attachments.imageLimits?.maxImageBytes ?? Infinity,
    attachments.imageLimits?.maxMessageImageBytes ?? Infinity
  );
  if (bytes.byteLength > maxBytes) return undefined;
  if (!(await isImageCapableRoute(ctx, exec))) return undefined;
  try {
    const ref = await attachments.saveImage({
      data: bytes,
      mediaType,
      name: filename,
    });
    if (!ref) return undefined;
    return {
      attachmentId: String(ref.attachmentId),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name !== undefined ? { name: ref.name } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Capture a target window or screen preview and package it for DSH output rendering.
 */
async function capturePreviewObject(ctx, exec, manager, opts = {}) {
  const maxDimension = opts.maxDimension ?? 960;
  const format = opts.format ?? "jpeg";
  const quality = opts.quality ?? 0.75;
  // Prefer the warm capture daemon (measured ~2x faster: ~120 ms vs ~240 ms for
  // a per-shot screencapture spawn). Any daemon failure falls back to the
  // engine's normal shot path, so this is a pure optimisation.
  let shot = null;
  if (!opts.region && typeof manager.captureShotViaDaemon === "function") {
    shot = await manager.captureShotViaDaemon({
      windowId: opts.windowId,
      screen: opts.screen,
      display: opts.display,
      maxDimension,
      format,
      quality,
    });
    if (!shot?.ok) shot = null;
  }
  if (!shot) {
    const shotArgv = buildCommandArgv("shot", {
      windowId: opts.windowId,
      screen: opts.screen,
      display: opts.display,
      maxDimension,
      region: opts.region,
      format,
      quality,
    });
    shot = await manager.exec(shotArgv, exec?.signal);
  }
  if (!shot?.ok || !shot?.base64) {
    return { ok: false, error: shot?.error ?? "capture_failed", detail: shot };
  }
  const bytes = Buffer.from(shot.base64, "base64");
  const ext = shot.mimeType === "image/png" ? "png" : "jpg";
  const filename = `cu-preview-${opts.windowId ?? "screen"}-${Date.now()}.${ext}`;
  const imageRef = await trySaveImageAttachment(ctx, exec, bytes, filename);
  let savedPath;
  if (!imageRef) {
    savedPath = join(tmpdir(), filename);
    writeFileSync(savedPath, bytes);
  }
  return {
    ok: true,
    windowId: shot.windowId ?? opts.windowId ?? null,
    screen: Boolean(shot.screen ?? opts.screen),
    mimeType: shot.mimeType ?? (ext === "png" ? "image/png" : "image/jpeg"),
    byteSize: bytes.byteLength,
    width: Math.round((shot.size?.width ?? 0) * (shot.scale ?? 1)),
    height: Math.round((shot.size?.height ?? 0) * (shot.scale ?? 1)),
    logicalWidth: shot.size?.width ?? 0,
    logicalHeight: shot.size?.height ?? 0,
    origin: shot.origin ?? { x: 0, y: 0 },
    scale: shot.scale ?? 1,
    ...(savedPath ? { path: savedPath } : {}),
    ...(imageRef ? { image: imageRef } : {}),
  };
}

/**
 * Render helper that outputs JSON text plus an inline DSH image block when `value.image` or `value.preview?.image` is present.
 */
function renderWithOptionalImage(summaryPrefix) {
  return (_args, value) => {
    const img = value?.image ?? value?.preview?.image;
    const text = summaryPrefix
      ? `${summaryPrefix}\n${JSON.stringify(value, null, 2)}`
      : JSON.stringify(value, null, 2);
    const blocks = [{ type: "text", text }];
    if (img && img.attachmentId) {
      blocks.push({
        type: "image",
        attachment: {
          attachmentId: img.attachmentId,
          mediaType: img.mediaType,
          bytes: img.bytes,
          width: img.width,
          height: img.height,
          ...(img.name !== undefined ? { name: img.name } : {}),
        },
      });
    }
    return blocks;
  };
}

/**
 * Build and register all `cu_*` tools.
 * @param {{ ctx: any, manager: CuSessionManager, defineTool?: typeof hostDefineTool, config?: any }} deps
 */
export function registerCuTools(deps) {
  const { ctx, manager, config = {} } = deps;
  const define = deps.defineTool ?? hostDefineTool;
  const disposers = [];

  const register = (toolDef) => {
    const dispose = ctx.tools.register(define(toolDef));
    disposers.push(dispose);
  };

  try {
    // 1. cu_status
    register({
      name: "cu_status",
      description:
        "Check macOS Computer Use service health, Accessibility & Screen Recording permissions, frontmost app, pause state, and active session.",
      parameters: {},
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const status = await manager.getStatus(exec?.signal);
        return {
          ...status,
          pauseLatched: manager.pauseLatched,
          activeSession: manager.activeSession,
          dockedDshWindow: manager.dockedDshWindow,
          settingsHints: {
            accessibilityUrl:
              "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            screenRecordingUrl:
              "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
          },
        };
      },
    });

    // 2. cu_session
    register({
      name: "cu_session",
      description:
        "Manage a visible macOS Computer Use session: 'start' shows the top-right floating capsule + optional target window halo (Claude style), optionally docks DSH to the side, and captures an inline target window preview thumbnail in chat (Codex style); 'preview' refreshes the target preview; 'stop' dismisses indicators and restores window bounds; 'resume' clears a user pause.",
      parameters: {
        action: {
          type: "string",
          enum: ["start", "stop", "preview", "resume"],
          required: true,
          description: "Session operation to perform.",
        },
        windowId: {
          type: "integer",
          description: "Target windowId to highlight and preview.",
        },
        pid: {
          type: "integer",
          description: "Target application pid.",
        },
        appName: {
          type: "string",
          description: "Target application display name (e.g. '剪映专业版').",
        },
        label: {
          type: "string",
          description: "Custom text shown in the top-right floating capsule and window halo.",
        },
        halo: {
          type: "boolean",
          description: "Draw glowing border halo around target windowId (default true).",
        },
        dockDsh: {
          type: "boolean",
          description:
            "Temporarily dock DeepSeek Harness window to the right side of the screen and restore on stop (default false).",
        },
        splitScreen: {
          type: "boolean",
          description:
            "Position the target window on the left and DSH on the right for clean side-by-side split screen (default true when windowId is set).",
        },
        hideOtherApps: {
          type: "boolean",
          description:
            "Temporarily hide unrelated desktop apps to keep the main stage unoccluded and restore on stop (default false).",
        },
        preview: {
          type: "boolean",
          description:
            "Capture and attach an inline preview thumbnail of the target window in chat (default true when windowId is provided).",
        },
        pause: {
          type: "boolean",
          description: "When action='stop', also latch pause on the engine (default false).",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (args.action === "resume") {
          manager.clearPauseLatch();
          const res = await manager.exec(["resume"], exec?.signal);
          manager.writeActivity("已恢复操作");
          return { ok: true, action: "resume", service: res };
        }
        if (args.action === "stop") {
          return await manager.stopVisualSession({ pause: args.pause === true });
        }
        if (args.action === "preview") {
          const targetWin = args.windowId ?? manager.activeSession?.windowId;
          if (args.label) manager.writeActivity(args.label);
          const preview = await capturePreviewObject(ctx, exec, manager, {
            windowId: targetWin,
            screen: targetWin === undefined,
            maxDimension: config.defaultPreviewMaxDim ?? 960,
          });
          return {
            ok: preview.ok,
            action: "preview",
            session: manager.activeSession,
            preview,
            ...(preview.image ? { image: preview.image } : {}),
          };
        }
        // action === "start"
        const started = await manager.startVisualSession({
          windowId: args.windowId,
          pid: args.pid,
          appName: args.appName,
          label: args.label,
          halo: args.halo,
          dockDsh: args.dockDsh === true,
          splitScreen: args.splitScreen,
          hideOtherApps: args.hideOtherApps,
          force: args.resume === true,
        });
        let preview;
        if (args.preview !== false && args.windowId !== undefined) {
          preview = await capturePreviewObject(ctx, exec, manager, {
            windowId: args.windowId,
            maxDimension: config.defaultPreviewMaxDim ?? 960,
          });
        }
        return {
          ...started,
          ...(preview ? { preview } : {}),
          ...(preview?.image ? { image: preview.image } : {}),
        };
      },
    });

    // 3. cu_windows
    register({
      name: "cu_windows",
      description:
        "List on-screen macOS windows (windowId, pid, app, title, bounds, frontmost) and optionally all running applications.",
      parameters: {
        app: {
          type: "string",
          description: "Optional substring filter on application name or title.",
        },
        includeApps: {
          type: "boolean",
          description: "Also include background/windowless running applications (default false).",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const winRes = await manager.exec(["windows"], exec?.signal);
        let windows = Array.isArray(winRes.windows) ? winRes.windows : [];
        if (args.app) {
          const q = String(args.app).toLowerCase();
          windows = windows.filter(
            (w) =>
              String(w.app ?? "").toLowerCase().includes(q) ||
              String(w.title ?? "").toLowerCase().includes(q)
          );
        }
        let apps;
        if (args.includeApps === true) {
          const appRes = await manager.exec(["apps"], exec?.signal);
          apps = appRes.apps ?? [];
        }
        return {
          ok: Boolean(winRes.ok),
          frontmost: winRes.frontmost ?? null,
          count: windows.length,
          windows,
          ...(apps !== undefined ? { apps } : {}),
        };
      },
    });

    // 4. cu_launch
    register({
      name: "cu_launch",
      description:
        "Launch an application by bundle ID or .app path (e.g. 'com.lemon.lvpro' or '/Applications/VideoFusion-macOS.app'), or bring a window onto the current stage.",
      parameters: {
        app: {
          type: "string",
          description: "Bundle ID or full .app path to launch.",
        },
        windowId: {
          type: "integer",
          description: "Optional windowId to activate or bring onto current stage.",
        },
        bringOnStage: {
          type: "boolean",
          description: "If true and windowId is set, bring an off-stage Stage Manager window onto the active stage.",
        },
        preview: {
          type: "boolean",
          description: "Capture and attach an inline preview of the window after launching (default false).",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        manager.assertCanAct("cu_launch", exec?.signal);
        const results = {};
        if (args.app) {
          manager.writeActivity(`启动应用 ${args.app}`);
          results.launch = await manager.exec(["launch", "--app", String(args.app)], exec?.signal);
        }
        if (args.windowId !== undefined) {
          const cmd = args.bringOnStage ? "stage" : "activate";
          manager.writeActivity(`激活窗口 #${args.windowId}`);
          results.window = await manager.exec([cmd, "--window", String(args.windowId)], exec?.signal);
        }
        let preview;
        if (args.preview === true && args.windowId !== undefined) {
          preview = await capturePreviewObject(ctx, exec, manager, {
            windowId: args.windowId,
            maxDimension: config.defaultPreviewMaxDim ?? 960,
          });
        }
        return {
          ok: true,
          ...results,
          ...(preview ? { preview } : {}),
          ...(preview?.image ? { image: preview.image } : {}),
        };
      },
    });

    // 5. cu_snapshot
    register({
      name: "cu_snapshot",
      description:
        "Inspect the Accessibility (AX) element tree of a target application/window. Returns numbered refs (e1, e2, ...) and compact deltas (+added, -removed, ~changed) on subsequent calls.",
      parameters: {
        pid: {
          type: "integer",
          required: true,
          description: "Target application process ID (from cu_windows).",
        },
        windowId: {
          type: "integer",
          description: "Target windowId to scope the snapshot to a single window (strongly recommended).",
        },
        full: {
          type: "boolean",
          description: "Return full element list instead of delta against previous snapshot (default false).",
        },
        all: {
          type: "boolean",
          description: "Include zero-size elements (default false).",
        },
        maxNodes: {
          type: "integer",
          description:
            "Element budget for this walk (default 800, max 3000). Large editors can exceed 800; raise it when a result reports truncated:true and you need the rest.",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const argv = buildCommandArgv("snapshot", args, manager);
        const raw = await manager.exec(argv, exec?.signal);
        if (!raw?.ok) return raw;
        return {
          ok: true,
          ...manager.recordSnapshot(args.pid, args.windowId, raw, { full: args.full === true }),
        };
      },
    });

    // 6. cu_screenshot
    register({
      name: "cu_screenshot",
      description:
        "Capture a screenshot of a specific window (even in background) or the full screen, returning an inline preview image and coordinate scaling metadata.",
      parameters: {
        windowId: {
          type: "integer",
          description: "Target windowId to capture (preferred over full screen).",
        },
        screen: {
          type: "boolean",
          description: "Capture entire screen when true.",
        },
        display: {
          type: "integer",
          description: "Display index when screen=true (default 0).",
        },
        region: {
          type: "string",
          description: "Optional crop region 'x,y,width,height' in logical points.",
        },
        maxDimension: {
          type: "integer",
          description: "Maximum pixel dimension (default 1280).",
        },
        format: {
          type: "string",
          enum: ["jpeg", "png"],
          description: "Image encoding format (default 'jpeg' for fast low-token preview).",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return await capturePreviewObject(ctx, exec, manager, {
          windowId: args.windowId,
          screen: args.screen,
          display: args.display,
          region: args.region,
          maxDimension: args.maxDimension ?? 1280,
          format: args.format ?? "jpeg",
        });
      },
    });

    // Resolve where a click visually lands: explicit coordinates, else the
    // cached ref's centre from the last snapshot. Returns null when unknown.
    const clickVisualPoint = (args) => {
      if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
        return { x: Number(args.x), y: Number(args.y) };
      }
      if (args.ref && args.pid !== undefined) {
        const node = manager.resolveRefProvenance(args.pid, args.ref, args.windowId);
        if (node && Number.isFinite(node.x) && Number.isFinite(node.w) &&
            Number.isFinite(node.y) && Number.isFinite(node.h)) {
          return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
        }
      }
      return null;
    };

    // Helper for post-action observation + optional preview
    const runPostAction = async (args, exec) => {
      const extra = {};
      // The action was already dispatched successfully. Optional observation
      // failures must not erase that result or encourage the caller to replay it.
      // Observation and preview are independent read-only reads, so they run
      // concurrently: warm measurements are ~222 ms snapshot + ~105 ms preview
      // serially, versus ~222 ms when overlapped. Each branch keeps its own
      // error isolation.
      const wantObserve = args.observe !== false && args.pid !== undefined;
      const wantPreview = args.preview === true && args.windowId !== undefined;

      const observeTask = async () => {
        if (!wantObserve) return;
        try {
          const snapArgv = buildCommandArgv(
            "snapshot", { pid: args.pid, windowId: args.windowId, noActions: true }, manager
          );
          const snapRaw = await manager.exec(snapArgv, exec?.signal);
          if (!snapRaw?.ok) throw new Error(snapRaw?.error ?? "snapshot unavailable");
          extra.observation = manager.recordSnapshot(args.pid, args.windowId, snapRaw, {
            full: false,
          });
        } catch (error) {
          extra.observation = {
            ok: false,
            error: "post_action_observation_failed",
            message: String(error?.message ?? error).slice(0, 300),
            actionReplaySafe: false,
          };
        }
      };

      const previewTask = async () => {
        if (!wantPreview) return;
        try {
          if (exec?.signal?.aborted) throw new Error("observation cancelled after action");
          const preview = await capturePreviewObject(ctx, exec, manager, {
            windowId: args.windowId,
            maxDimension: config.defaultPreviewMaxDim ?? 960,
          });
          extra.preview = preview;
          if (preview.image) extra.image = preview.image;
        } catch (error) {
          extra.preview = {
            ok: false,
            error: "post_action_preview_failed",
            message: String(error?.message ?? error).slice(0, 300),
            actionReplaySafe: false,
          };
        }
      };

      await Promise.all([observeTask(), previewTask()]);
      return extra;
    };

    // 7. cu_click
    register({
      name: "cu_click",
      description:
        "Click a control in a macOS app by snapshot ref (e.g. 'e12') or coordinates (x, y). Runs in background by default without moving the user's mouse or stealing focus, and returns an automatic AX delta observation.",
      parameters: {
        pid: {
          type: "integer",
          description: "Target application pid (required when clicking by ref).",
        },
        windowId: {
          type: "integer",
          description: "Target windowId.",
        },
        ref: {
          type: "string",
          description: "Snapshot element ref (e.g. 'e12') from cu_snapshot.",
        },
        x: {
          type: "number",
          description: "Logical screen X coordinate (when not using ref).",
        },
        y: {
          type: "number",
          description: "Logical screen Y coordinate (when not using ref).",
        },
        button: {
          type: "string",
          enum: ["left", "right"],
          description: "Mouse button (default 'left').",
        },
        count: {
          type: "integer",
          description: "Click count: 1 for single click, 2 for double click (default 1).",
        },
        foreground: {
          type: "boolean",
          description: "Bring window to front and use foreground click (default false = background).",
        },
        force: {
          type: "boolean",
          description: "Bypass disabled-control or modal guard when explicitly required.",
        },
        observe: {
          type: "boolean",
          description: "Automatically take a delta AX snapshot after clicking (default true when pid is set).",
        },
        preview: {
          type: "boolean",
          description: "Attach an inline target window preview thumbnail after clicking (default false).",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        manager.assertCanAct("cu_click", exec?.signal);
        if (config.autoSession !== false && !manager.activeSession && args.windowId !== undefined) {
          await manager.startVisualSession({ windowId: args.windowId, pid: args.pid, halo: false });
        }
        manager.writeActivity(`点击 ${args.ref ?? `(${args.x},${args.y})`}`);
        const argv = buildCommandArgv("click", args, manager);
        // Show the agent cursor gliding to the target and ripple when the click
        // lands. Fire-and-forget so visual feedback never delays the action.
        if (manager.activeSession) {
          try {
            const point = clickVisualPoint(args);
            if (point) {
              manager.showAgentCursor(point.x, point.y);
              manager.showActionLabel(`点击 ${args.ref ?? `${point.x},${point.y}`}`, point.x, point.y);
              manager.showClickRipple(point.x, point.y);
            }
          } catch {
            // ignore visual errors
          }
        }
        const result = await manager.exec(argv, exec?.signal);
        if (!result?.ok) return result;
        const post = await runPostAction(args, exec);
        return { ...result, ...post };
      },
    });

    // 8. cu_type
    register({
      name: "cu_type",
      description:
        "Enter text into a macOS application control in the background (Unicode & Chinese safe). Supports 'type' (PID key/AX events), 'setvalue' (direct AXValue write with read-back), or 'action' (perform named AX action like AXPress/AXShowMenu).",
      parameters: {
        mode: {
          type: "string",
          enum: ["type", "setvalue", "action"],
          description: "Input mechanism (default 'type'; use 'setvalue' for direct field replacement).",
        },
        pid: {
          type: "integer",
          required: true,
          description: "Target application pid.",
        },
        windowId: {
          type: "integer",
          description: "Target windowId.",
        },
        ref: {
          type: "string",
          description: "Target element ref from cu_snapshot (e.g. 'e5').",
        },
        text: {
          type: "string",
          description: "Text string to enter (for mode='type' or 'setvalue').",
        },
        actionName: {
          type: "string",
          description: "AX action name when mode='action' (e.g. 'AXPress', 'AXConfirm').",
        },
        foreground: {
          type: "boolean",
          description: "Use foreground paste/typing (default false = background).",
        },
        observe: {
          type: "boolean",
          description: "Return post-input AX delta snapshot (default true).",
        },
        preview: {
          type: "boolean",
          description: "Attach inline target window preview after input (default false).",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        manager.assertCanAct("cu_type", exec?.signal);
        const mode = args.mode ?? "type";
        manager.writeActivity(
          mode === "action" ? `执行动作 ${args.actionName}` : `输入文字 (${(args.text ?? "").length}字)`
        );
        const cmdParams =
          mode === "action" ? { ...args, name: args.actionName ?? "AXPress" } : args;
        const argv = buildCommandArgv(mode, cmdParams, manager);
        const result = await manager.exec(argv, exec?.signal);
        if (!result?.ok) return result;
        const post = await runPostAction(args, exec);
        return { ...result, ...post };
      },
    });

    // 9. cu_key
    register({
      name: "cu_key",
      description:
        "Send a key or keyboard shortcut (e.g. name='return', 'escape', 'tab', or name='g' with mods='cmd,shift') to a target application in background or foreground.",
      parameters: {
        name: {
          type: "string",
          required: true,
          description: "Key name (e.g. 'return', 'escape', 'tab', 'space', 'delete', 'a', 'g').",
        },
        mods: {
          type: "string",
          description: "Comma-separated modifiers: 'cmd', 'shift', 'alt', 'ctrl'.",
        },
        pid: {
          type: "integer",
          description: "Target application pid.",
        },
        windowId: {
          type: "integer",
          description: "Target windowId.",
        },
        foreground: {
          type: "boolean",
          description: "Send key in foreground (default false = background PID event).",
        },
        observe: {
          type: "boolean",
          description: "Return post-key AX delta snapshot (default true when pid is set).",
        },
        preview: {
          type: "boolean",
          description: "Attach inline target window preview after key press (default false).",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        manager.assertCanAct("cu_key", exec?.signal);
        manager.writeActivity(`按键 ${args.mods ? `${args.mods}+` : ""}${args.name}`);
        const argv = buildCommandArgv("key", args, manager);
        const result = await manager.exec(argv, exec?.signal);
        if (!result?.ok) return result;
        const post = await runPostAction(args, exec);
        return { ...result, ...post };
      },
    });

    // 10. cu_scroll
    register({
      name: "cu_scroll",
      description:
        "Scroll a target macOS application window vertically (dy, negative scrolls down) or horizontally (dx) in the background.",
      parameters: {
        pid: {
          type: "integer",
          description: "Target application pid.",
        },
        windowId: {
          type: "integer",
          description: "Target windowId.",
        },
        dy: {
          type: "number",
          required: true,
          description: "Vertical scroll delta (negative scrolls down, positive scrolls up).",
        },
        dx: {
          type: "number",
          description: "Horizontal scroll delta (default 0).",
        },
        x: {
          type: "number",
          description: "Optional X coordinate for foreground scroll.",
        },
        y: {
          type: "number",
          description: "Optional Y coordinate for foreground scroll.",
        },
        foreground: {
          type: "boolean",
          description: "Scroll in foreground at cursor coordinates (default false = background PID scroll).",
        },
        observe: {
          type: "boolean",
          description: "Return post-scroll AX delta snapshot (default false).",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        manager.assertCanAct("cu_scroll", exec?.signal);
        manager.writeActivity(`滚动 dy=${args.dy}`);
        const argv = buildCommandArgv("scroll", args, manager);
        const result = await manager.exec(argv, exec?.signal);
        if (!result?.ok) return result;
        const post = await runPostAction({ ...args, observe: args.observe === true }, exec);
        return { ...result, ...post };
      },
    });

    // 11. cu_find
    register({
      name: "cu_find",
      description:
        "Find UI controls or on-screen text by query: searches the fast Accessibility (AX) tree first and falls back to Apple Vision OCR with bounding boxes.",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "Text or control title substring to search for.",
        },
        pid: {
          type: "integer",
          description: "Target application pid (for AX search).",
        },
        windowId: {
          type: "integer",
          description: "Target windowId (for scoped AX and OCR search).",
        },
        mode: {
          type: "string",
          enum: ["auto", "ax", "ocr"],
          description: "Search engine: 'auto' (AX first, then OCR fallback), 'ax' only, or 'ocr' only.",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const mode = args.mode ?? "auto";
        let axResult = null;
        if ((mode === "auto" || mode === "ax") && args.pid !== undefined) {
          const axArgv = ["ax", "--pid", String(args.pid), "--find", String(args.query)];
          if (args.windowId !== undefined) axArgv.push("--window", String(args.windowId));
          axResult = await manager.exec(axArgv, exec?.signal);
          if (
            mode === "ax" ||
            (axResult?.ok && Array.isArray(axResult.matches) && axResult.matches.length > 0)
          ) {
            return { ok: Boolean(axResult?.ok), engine: "ax", ...axResult };
          }
        }
        if (mode === "auto" || mode === "ocr") {
          const ocrArgv = ["ocr", "--find", String(args.query)];
          if (args.windowId !== undefined) {
            ocrArgv.push("--window", String(args.windowId));
          } else {
            ocrArgv.push("--screen");
          }
          const ocrResult = await manager.exec(ocrArgv, exec?.signal);
          return {
            ok: Boolean(ocrResult?.ok),
            engine: "ocr",
            ...(axResult ? { axChecked: true } : {}),
            ...ocrResult,
          };
        }
        return {
          ok: false,
          error: "missing_target",
          message: "Provide pid for AX search or windowId for OCR search",
        };
      },
    });

    // 12. cu_batch
    register({
      name: "cu_batch",
      description:
        "Execute a fast local sequence of macOS actions (click, type, setvalue, key, scroll, wait, action) without LLM roundtrip lag. Returns composite step results, post-batch AX delta, and optional inline window preview.",
      parameters: {
        pid: {
          type: "integer",
          description: "Default target application pid inherited by steps.",
        },
        windowId: {
          type: "integer",
          description: "Default target windowId inherited by steps.",
        },
        steps: {
          type: "array",
          required: true,
          description:
            "Array of action steps: e.g. [{action:'click',ref:'k1.29'},{action:'type',text:'abc'},{action:'key',name:'return'}].",
        },
        timeoutMs: {
          type: "integer",
          description: "Max total execution budget in milliseconds (default 20000).",
        },
        stopOnError: {
          type: "boolean",
          description: "Stop batch on first step error (default true).",
        },
        observe: {
          type: "boolean",
          description: "Capture and return AX delta after batch completes (default true).",
        },
        preview: {
          type: "boolean",
          description:
            "Capture and attach inline window preview after batch completes (default true when windowId is set).",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        manager.assertCanAct("cu_batch", exec?.signal);
        const batchResult = await manager.executeBatch(
          {
            pid: args.pid,
            windowId: args.windowId,
            steps: args.steps,
            timeoutMs: args.timeoutMs,
            stopOnError: args.stopOnError,
          },
          exec?.signal
        );

        const targetPid = args.pid ?? batchResult.results?.[0]?.pid;
        const targetWin = args.windowId ?? manager.activeSession?.windowId;
        const shouldPreview = args.preview !== false && targetWin !== undefined;
        const extra = await runPostAction(
          {
            pid: targetPid,
            windowId: targetWin,
            observe: args.observe !== false,
            preview: shouldPreview,
          },
          exec
        );

        return {
          ...batchResult,
          ...extra,
        };
      },
    });
  } catch (err) {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        // ignore rollback error
      }
    }
    throw err;
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        // ignore
      }
    }
  };
}

/**
 * Register the embedded `dsh-computer-use` skill on the context and any active/created agents.
 * Exposes aliases `computer-use` and `cu` so users can trigger it via /cu or /computer-use in the UI.
 */
function registerCuSkill(ctx) {
  const SKILL_NAMES = ["computer-use", "dsh-computer-use", "cu"];
  const registerOnScope = (scopeCtx) => {
    const skills = scopeCtx?.get?.("skills");
    if (!skills || typeof skills.register !== "function") return () => {};
    const unregs = SKILL_NAMES.map((sName) =>
      skills.register({
        name: sName,
        description:
          "Control macOS desktop applications (Jianying/CapCut, WeChat, Finder, Notes) with background AX actions, floating status capsule/halo, and inline target window previews.",
        content: SKILL_CONTENT,
        source: "user",
        resourceBase: {
          kind: "directory",
          path: join(__dirname, "../skill"),
        },
      })
    );
    return () => unregs.forEach((u) => u?.());
  };

  const disposers = [registerOnScope(ctx)];
  const agentMap = new Map();
  const registerForAgent = (agent) => {
    if (!agent?.ctx || agentMap.has(agent)) return;
    agentMap.set(agent, registerOnScope(agent.ctx));
  };

  if (typeof ctx.on === "function") {
    disposers.push(
      ctx.on("agent/created", ({ agent }) => registerForAgent(agent)),
      ctx.on("agent/disposed", ({ agent }) => {
        const d = agentMap.get(agent);
        agentMap.delete(agent);
        d?.();
      })
    );
  }
  const agents = ctx?.get?.("agents");
  if (agents && typeof agents.list === "function") {
    for (const agent of agents.list()) registerForAgent(agent);
  }

  return () => {
    for (const d of agentMap.values()) d?.();
    agentMap.clear();
    for (const d of disposers.reverse()) d?.();
  };
}

export function apply(ctx, config = {}) {
  const manager = new CuSessionManager({
    serviceUrl: config?.serviceUrl,
  });

  const disposeTools = registerCuTools({ ctx, manager, config });
  const disposeSkill = registerCuSkill(ctx);

  ctx.effect(() => async () => {
    disposeSkill();
    disposeTools();
    await manager.stopVisualSession();
  });
}

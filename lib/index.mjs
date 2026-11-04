import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CuSessionManager,
  buildCommandArgv,
  clickLabel,
  sniffImageMediaType,
  snapshotFingerprint,
} from "./core.mjs";
import { PreviewDeadlineError, createPreviewDeadline } from "./preview-deadline.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * One line per plugin lifecycle event, appended to ~/.cu/plugin-boot.log.
 *
 * A plugin that fails to load is invisible from the outside: no tools, no error,
 * nothing in the UI. This is the only place that survives to explain why, so
 * module evaluation, apply, and each rejected tool definition write here.
 */
function logBoot(line) {
  try {
    const dir = join(homedir(), ".cu");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "plugin-boot.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A diagnostic must never be the reason a plugin fails.
  }
}

logBoot(`module evaluated (pid ${process.pid})`);

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

export const name = "super-computer-use";
export const inject = ["tools"];

export const Config = Schema.object({
  serviceUrl: Schema.string().description("Local CU service URL (default http://127.0.0.1:47777)"),
  autoSession: Schema.boolean()
    .default(true)
    .description("Automatically show top-right floating capsule when acting on a target window"),
  autoDockDsh: Schema.boolean()
    .default(true)
    .description("Shrink the DeepSeek Harness window to the right side when a CU session starts (restored when it stops)"),
  idleStopSeconds: Schema.number()
    .default(60)
    .description("Auto-end the visual CU session after this many seconds with no cu_* activity, so a capsule/halo/docked DSH window never lingers after the agent stops. 0 disables it."),
  defaultPreviewMaxDim: Schema.number()
    .default(960)
    .description("Default max dimension in pixels for inline window preview screenshots"),
  previewBudgetMs: Schema.number()
    .default(600)
    .description("Budget for a preview attached to an action; it degrades instead of holding the result"),
  observeBudgetMs: Schema.number()
    .default(300)
    .description("How long a post-action observation keeps re-reading while the AX tree is unchanged"),
  rim: Schema.boolean()
    .default(false)
    .description("Light the full-screen edge rim whenever the agent acts (a demo aid, off by default; halo/cursor/capsule stay on)"),
});

const SKILL_PATH = join(__dirname, "../skill/SKILL.md");
const SKILL_CONTENT = existsSync(SKILL_PATH)
  ? readFileSync(SKILL_PATH, "utf8")
  : "# super-computer-use\nUse cu_* tools for macOS desktop automation.";

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
/** Why this many bytes cannot be delivered as an inline image, if they cannot. */
function imageUndeliverableReason(bytes, mediaType, limits) {
  if (!mediaType) return "unrecognised image encoding";
  if (limits?.mediaTypes && !limits.mediaTypes.includes(mediaType)) {
    return `this host does not accept ${mediaType}`;
  }
  const maxBytes = Math.min(
    limits?.maxImageBytes ?? Infinity,
    limits?.maxMessageImageBytes ?? Infinity
  );
  if (bytes.byteLength > maxBytes) {
    return `image is ${bytes.byteLength} bytes, the host limit is ${maxBytes}`;
  }
  return null;
}

/**
 * Explain the image route rather than only answering yes/no: an unresolved model
 * route is not the same as one that cannot take images, and the caller has to
 * know which it is before trusting a screenshot as evidence.
 */
async function describeVisionRoute(ctx, exec) {
  const llm = ctx?.get?.("llm");
  const provider =
    exec?.agent?.session?.requestHeader?.()?.config?.provider ??
    exec?.agent?.options?.provider ?? null;
  const model =
    exec?.agent?.session?.requestHeader?.()?.config?.model ??
    exec?.agent?.options?.model ?? null;
  if (!provider || !model) {
    return { supported: null, provider, model, reason: "the calling model route is unknown" };
  }
  if (!llm) {
    return { supported: null, provider, model, reason: "this host exposes no model catalogue" };
  }
  try {
    const info = await llm.resolveModelInfo(provider, model, exec?.signal);
    return {
      supported: Boolean(info?.inputModalities?.includes("image")),
      provider,
      model,
      reason: null,
    };
  } catch (error) {
    return {
      supported: null,
      provider,
      model,
      reason: `model capabilities could not be read: ${String(error?.message ?? error).slice(0, 120)}`,
    };
  }
}

/**
 * Save screenshot bytes into DSH's attachment store when the current route can
 * actually receive an image. Returns `{ image }` or `{ reason }`: a preview that
 * only lands on disk must say why, because "the model cannot see this" is very
 * different from "the capture failed".
 */
async function trySaveImageAttachment(ctx, exec, bytes, filename) {
  const attachments = ctx?.get?.("attachments");
  const mediaType = sniffImageMediaType(bytes);
  if (!attachments) return { reason: "this host has no attachment store" };
  const undeliverable = imageUndeliverableReason(bytes, mediaType, attachments.imageLimits);
  if (undeliverable) return { reason: undeliverable };
  if (!(await isImageCapableRoute(ctx, exec))) {
    return { reason: "the active model route does not accept image input" };
  }
  try {
    const ref = await attachments.saveImage({ data: bytes, mediaType, name: filename });
    if (!ref) return { reason: "the attachment store rejected the image" };
    return {
      image: {
        attachmentId: String(ref.attachmentId),
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name !== undefined ? { name: ref.name } : {}),
      },
    };
  } catch (error) {
    return { reason: `the attachment store failed: ${String(error?.message ?? error).slice(0, 120)}` };
  }
}

/**
 * Capture a target window or screen preview and package it for DSH output rendering.
 *
 * A preview is optional evidence attached to someone else's result, so a sick
 * capture must not hold an action's answer hostage. The WHOLE chain — queue,
 * capture, fallback shot, attachment save and publish — runs under one
 * `createPreviewDeadline`. When it is spent (budget / cancel / stale generation)
 * the abandoned capture is not allowed to fall back to an engine `shot` (which
 * would land in the action's shared queue and block the next action) and a late
 * attachment result is not allowed to overwrite `lastImage` (F3).
 */
async function capturePreviewObject(ctx, exec, manager, opts = {}) {
  const maxDimension = opts.maxDimension ?? 960;
  const format = opts.format ?? "jpeg";
  const quality = opts.quality ?? 0.75;
  const budgetMs = Math.max(0, Number(opts.budgetMs ?? 0));
  const externalSignal = opts.signal ?? exec?.signal;
  const generation =
    opts.generation !== undefined ? opts.generation : manager?.sessionGeneration ?? null;
  const isCurrent =
    opts.isCurrent ??
    (generation === null || manager?.sessionGeneration === undefined
      ? undefined
      : () => manager?.sessionGeneration === generation);
  const deadline =
    opts.deadline ?? createPreviewDeadline({ budgetMs, signal: externalSignal, generation, isCurrent });
  const began = Date.now();

  // R6: one shared cancellation for the WHOLE preview capture chain. When the
  // deadline is spent (budget / external cancel / stale generation) the in-flight
  // fallback shot is aborted instead of merely letting the caller stop waiting.
  const captureController = new AbortController();
  deadline.expired?.catch?.(() => captureController.abort());
  const captureSignal = externalSignal
    ? AbortSignal.any([externalSignal, captureController.signal])
    : captureController.signal;

  const degraded = (code, error) => {
    // Any abandoned capture must not leave a zombie in front of the next action.
    captureController.abort();
    manager.stopCaptureDaemon?.();
    return {
      ok: false,
      error: code,
      message: error?.message ?? String(error),
      budgetMs,
      ms: Date.now() - began,
      retryable: true,
      degraded: true,
      actionReplaySafe: false,
      ...(error?.code ? { reason: error.code } : {}),
    };
  };

  // Resolve/reject alongside the deadline's remaining time WITHOUT leaking the
  // loser. The losing capture keeps running to its own timeout; its rejection is
  // swallowed so a degraded preview never becomes an unhandled rejection.
  const raceDeadline = (promise) => {
    promise.catch(() => {});
    const remaining = deadline.remainingMs();
    if (!Number.isFinite(remaining)) return promise;
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new PreviewDeadlineError("PREVIEW_BUDGET_EXCEEDED", `preview exceeded its ${budgetMs} ms budget`, {
              budgetMs,
            })
          ),
        remaining
      );
      if (typeof timer.unref === "function") timer.unref();
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  };

  const capture = async () => {
    deadline.check(); // never start work for an already-spent preview
    // Prefer the warm capture daemon (measured ~2x faster: ~120 ms vs ~240 ms for
    // a per-shot screencapture spawn). Any daemon failure falls back to the
    // engine's normal shot path, so this is a pure optimisation.
    let shot = null;
    let via = "daemon";
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
    // F3: after the budget/cancel/generation went stale, the abandoned daemon
    // result must NOT fall through to an engine shot.
    deadline.check();
    if (!shot) {
      via = "engine";
      const shotArgv = buildCommandArgv("shot", {
        windowId: opts.windowId,
        screen: opts.screen,
        display: opts.display,
        maxDimension,
        region: opts.region,
        format,
        quality,
      });
      deadline.check();
      // R6: a preview read is NOT an input action. It must never occupy the
      // serial input queue (a slow/deadline-abandoned shot used to block the
      // next click/key). It also carries the deadline's own abort signal.
      shot = await manager.exec(shotArgv, captureSignal, { bypassQueue: true });
    }
    return { shot, via };
  };

  let captured;
  try {
    captured = await raceDeadline(capture());
  } catch (error) {
    if (error?.previewDeadline) {
      const code =
        error.code === "PREVIEW_CANCELLED"
          ? "preview_cancelled"
          : error.code === "PREVIEW_STALE_GENERATION"
          ? "preview_stale_generation"
          : "preview_budget_exceeded";
      return degraded(code, error);
    }
    // A non-deadline capture failure (e.g. the engine shot threw) keeps the
    // caller's existing error contract: the post-action wrapper labels it
    // post_action_preview_failed rather than inventing a new success shape.
    throw error;
  }

  const { shot, via } = captured;
  const captureMs = Date.now() - began;
  if (!shot?.ok || !shot?.base64) {
    return {
      ok: false,
      error: shot?.error ?? "capture_failed",
      via,
      captureMs,
      detail: shot,
    };
  }
  const bytes = Buffer.from(shot.base64, "base64");
  const ext = shot.mimeType === "image/png" ? "png" : "jpg";
  const filename = `cu-preview-${opts.windowId ?? "screen"}-${Date.now()}.${ext}`;
  const savedAt = Date.now();

  // The budget covers attachment handling too (F3): a slow save must degrade the
  // preview instead of extending the action's answer.
  let delivery;
  try {
    deadline.check();
    delivery = await raceDeadline(trySaveImageAttachment(ctx, exec, bytes, filename));
    deadline.check(); // a late save from a superseded session must not publish
  } catch (error) {
    if (error?.previewDeadline) {
      const code =
        error.code === "PREVIEW_CANCELLED"
          ? "preview_cancelled"
          : error.code === "PREVIEW_STALE_GENERATION"
          ? "preview_stale_generation"
          : "preview_budget_exceeded";
      return degraded(code, error);
    }
    delivery = {
      reason: `the attachment store failed: ${String(error?.message ?? error).slice(0, 120)}`,
    };
  }
  const imageRef = delivery.image;
  let savedPath;
  if (!imageRef) {
    savedPath = join(tmpdir(), filename);
    writeFileSync(savedPath, bytes);
  }
  // Record what the model actually received, so `cu_status` can answer "did the
  // last screenshot reach you" instead of leaving it to guesswork.
  const lastImage = {
    at: Date.now(),
    delivered: Boolean(imageRef),
    ...(imageRef ? {} : { reason: delivery.reason ?? "not delivered" }),
    bytes: bytes.byteLength,
    via,
    windowId: opts.windowId ?? null,
  };
  if (manager && typeof manager === "object") manager.lastImage = lastImage;
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
    // global = origin + pixel/scale, and capturedAt says whether this frame
    // predates a move/resize the caller already knows about.
    capturedAt: shot.capturedAt ?? null,
    displayId: shot.displayId ?? null,
    // Where the pixels came from and how long each stage took, so a slow preview
    // can be attributed instead of guessed at.
    via,
    captureMs,
    saveMs: Date.now() - savedAt,
    ms: Date.now() - began,
    // Present when the pixels could not be delivered as an image: the file path
    // is still returned, but nothing pretends the model saw it.
    ...(imageRef ? {} : { imageDelivered: false, imageDeliveryReason: lastImage.reason }),
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
  // The rim is the only effect that paints over the whole desktop, so it is the
  // one a user can turn off without losing the cursor, halo or capsule.
  if (config.rim === false) manager.rimEnabled = false;
  if (Number.isFinite(Number(config.idleStopSeconds))) {
    manager.idleStopSeconds = Number(config.idleStopSeconds);
  }

  const registrationErrors = [];
  // The host validates every tool definition while registering it and throws on
  // failure. That used to take down `apply` and with it every other tool, so one
  // bad parameter meant the whole plugin disappeared. Register defensively: a
  // rejected definition costs its own tool and is reported, not the rest.
  const register = (toolDef) => {
    try {
      // Idle auto-stop: every tool call re-arms a short timer on the shared
      // manager, so an auto-started visual session (capsule/halo + docked DSH)
      // tears itself down shortly after the agent stops acting instead of
      // lingering until the long safety cap. Only armed while a session is live.
      if (toolDef && typeof toolDef.execute === "function") {
        const origExecute = toolDef.execute;
        toolDef = {
          ...toolDef,
          execute: async (...args) => {
            try {
              return await origExecute.apply(toolDef, args);
            } finally {
              if (manager.activeSession) manager.armIdleStop();
            }
          },
        };
      }
      const dispose = ctx.tools.register(define(toolDef));
      disposers.push(dispose);
      return true;
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      registrationErrors.push({ tool: toolDef?.name ?? "<unnamed>", error: message });
      logBoot(`tool ${toolDef?.name ?? "<unnamed>"} rejected: ${message}`);
      return false;
    }
  };

  // Shared post-condition argument for mutating tools. The engine already polls
  // the tree with a timeout, so an action can declare what it expects to see
  // and get a straight verified/failed answer instead of an `ok` to interpret.
  // Optional proof of which observation a ref came from. Only checked when the
  // caller supplies it, so existing flows keep working.
  const SNAPSHOT_ID_PARAM = {
    type: "integer",
    description:
      "The observation.snapshotId this ref came from. When supplied, the action is refused with stale_snapshot if the cached tree has moved to a newer snapshot, instead of acting on whatever control now sits at that path.",
  };

  // The host's parameter DSL requires an explicit `properties`/`additionalProperties`
  // contract for every object parameter: an object without them is rejected at
  // registration time, which takes the whole plugin down rather than one tool.
  const EXPECT_PARAM = {
    type: "object",
    additionalProperties: false,
    properties: {
      ref: { type: "string", description: "Snapshot ref whose existence must hold." },
      query: { type: "string", description: "Label or value text the control must contain." },
      enabled: { type: "boolean", description: "Require this enabled state." },
      value: { type: "string", description: "Require this exact value." },
      contains: { type: "string", description: "Require the value or label to contain this text." },
      timeoutMs: { type: "integer", description: "Poll for this long (default 2000)." },
    },
    description:
      "Optional post-condition polled after the action. query matches a control's label or value text; timeoutMs defaults to 2000. " +
      "The result carries verified:true|false. verified:false means the action was dispatched but the app never showed that state — re-observe before retrying.",
  };

  try {
    // 1. cu_status
    register({
      name: "cu_status",
      description:
        "Check macOS Computer Use service health, Accessibility & Screen Recording permissions, frontmost app, pause state, active session, and whether the current model can actually see screenshots (vision route + last image delivery).",
      parameters: {},
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const status = await manager.getStatus(exec?.signal);
        // "Can this route see an image?" decides whether a screenshot is evidence
        // or just a file path. Answer it explicitly instead of letting the model
        // assume it saw something, and record what the last capture delivered.
        const vision = await describeVisionRoute(ctx, exec);
        return {
          ...status,
          pauseLatched: manager.pauseLatched,
          activeSession: manager.activeSession,
          dockedDshWindow: manager.dockedDshWindow,
          vision,
          lastImage: manager.lastImage ?? null,
          lastRoute: manager.lastRoute ?? null,
          registrationErrors: manager.registrationErrors ?? [],
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
            "Shrink the DeepSeek Harness window to the right side of the screen and restore on stop (default true).",
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
          const res = await manager.exec(["resume"], exec?.signal, { control: true });
          // R7: resuming re-shows the watch preview through the same helper.
          manager.setNativePreviewVisible?.(true);
          manager.writeActivity("已恢复操作");
          return { ok: true, action: "resume", service: res };
        }
        if (args.action === "visible" || args.action === "hide") {
          // R7: host visibility toggles the native watch preview (hide pauses the
          // stream inside the helper; resume does not replay stale frames).
          const visible = args.action === "visible" ? (args.visible !== false) : (args.visible === true);
          const written = manager.setNativePreviewVisible?.(visible) ?? false;
          return { ok: true, action: args.action, visible, previewControl: written };
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
            budgetMs: Number(config.sessionPreviewBudgetMs ?? 2500),
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
        // F7: decide "is this session previewing a window" ONCE. The warm-up is
        // exactly its inverse, so the default path can never both warm the daemon
        // and then capture the preview (which used to grab two frames).
        const shouldPreview = args.preview !== false && args.windowId !== undefined;
        const started = await manager.startVisualSession({
          windowId: args.windowId,
          pid: args.pid,
          appName: args.appName,
          label: args.label,
          halo: args.halo,
          // Layout is on by default, matching what users see in Codex: the DSH
          // window shrinks to the right and the target takes the left. Pass
          // dockDsh: false to keep the desktop untouched.
          dockDsh: args.dockDsh !== false,
          splitScreen: args.splitScreen,
          hideOtherApps: args.hideOtherApps,
          force: args.resume === true,
          warmCapture: !shouldPreview,
          nativePreview: args.nativePreview !== false,
        });
        let preview;
        if (shouldPreview) {
          preview = await capturePreviewObject(ctx, exec, manager, {
            windowId: args.windowId,
            maxDimension: config.defaultPreviewMaxDim ?? 960,
            budgetMs: Number(config.sessionPreviewBudgetMs ?? 2500),
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
            budgetMs: Number(config.sessionPreviewBudgetMs ?? 2500),
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
          description:
            "Target application process ID (from cu_windows). Omit to use the active session target.",
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
      async execute(rawArgs, exec) {
        const args = resolveTargetArgs(rawArgs);
        // R2: nodes AND elementTokens must come from ONE retained observation.
        // Running an engine snapshot first and then a worker observation used to
        // splice two traversals together by path; a control that slid into the
        // same path between them could be displayed as A while the token hit B.
        if (manager._axWorkerAllowed && typeof manager.startAXWorker === "function" && args.pid !== undefined) {
          try {
            await manager.startAXWorker(Number(args.pid), args.windowId);
            const observation = await manager.axObserve();
            if (observation?.ok && Array.isArray(observation.nodes)) {
              const raw = {
                ok: true,
                pid: observation.pid ?? args.pid,
                windowId: observation.windowId ?? args.windowId,
                app: observation.app ?? "",
                count: observation.nodes.length,
                nodes: observation.nodes,
                ...(observation.truncated ? { truncated: true, limit: observation.limit } : {}),
              };
              const recorded = manager.recordSnapshot(args.pid, args.windowId, raw, { full: args.full === true });
              const observationId = manager._axBinding?.observationId ?? null;
              if (observationId) {
                manager.snapshotObservations = manager.snapshotObservations ?? new Map();
                manager.snapshotObservations.set(recorded.snapshotId, observationId);
                // Bound history: this is a session-local provenance cache, not
                // an unbounded audit log of every observation ever taken.
                if (manager.snapshotObservations.size > 64) {
                  manager.snapshotObservations.delete(manager.snapshotObservations.keys().next().value);
                }
              }
              const elementTokens = manager.axTokens
                ? Object.fromEntries(manager.axTokens) : undefined;
              return {
                ok: true,
                ...recorded,
                observationId,
                ...(elementTokens ? { elementTokens } : {}),
              };
            }
          } catch {
            // A failed retained observation must NOT silently fall back to a
            // second traversal and then attach tokens from the first one. Drop
            // the stale binding and continue with a snapshot-only read.
            manager._axBinding = null;
            manager.axTokens?.clear?.();
          }
        }
        const argv = buildCommandArgv("snapshot", args, manager);
        const raw = await manager.exec(argv, exec?.signal);
        if (!raw?.ok) return raw;
        const recorded = manager.recordSnapshot(args.pid, args.windowId, raw, { full: args.full === true });
        return { ok: true, ...recorded };
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
      async execute(rawArgs, exec) {
        const args = resolveTargetArgs(rawArgs);
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

    // Where a click is aimed, known before dispatch: explicit coordinates are
    // exact; a ref only carries the frame from the snapshot the caller read, so
    // it is a pre-hint. The frame the engine resolves at click time is the truth
    // for the ripple, because it is what the action actually hit.
    const aimedClickPoint = (args) => {
      if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
        return { x: Number(args.x), y: Number(args.y) };
      }
      if (args.ref && args.pid !== undefined) {
        const node = manager.resolveRefProvenance(args.pid, args.ref, args.windowId);
        if (node && Number.isFinite(node.cx) && Number.isFinite(node.cy)) {
          return { x: node.cx, y: node.cy };
        }
      }
      return null;
    };

    // Snapshot provenance for a ref: role/title for the overlay label.
    const clickTarget = (args) => {
      if (!args.ref || args.pid === undefined) return {};
      return manager.resolveRefProvenance(args.pid, args.ref, args.windowId) ?? {};
    };

    // The engine echoes the frame it resolved (`x`/`y` in every click payload).
    // AXPress-only controls have no frame, so fall back to the snapshot frame
    // purely as an overlay hint instead of dropping the feedback entirely.
    const landedClickPoint = (args, result) => {
      const x = Number(result?.x);
      const y = Number(result?.y);
      if (Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0)) {
        return { x, y };
      }
      return aimedClickPoint(args);
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

      const observeStarted = Date.now();
      const observeTask = async () => {
        if (!wantObserve) return;
        // A single read straight after the action is the fast path, but a
        // window, search result or sheet that appears 150 ms later used to be
        // missed entirely. Re-read while the tree is still identical to the
        // pre-action baseline, and say how long it took. The budget gates extra
        // *waits*, not the tree walks themselves, so the tail is one budget plus
        // one read (measured ~170 ms on a 500-node tree); a tree that already
        // moved costs exactly the old single read. "The tree moved" is a
        // re-observe signal, never proof of success.
        const budgetMs = Math.max(0, Number(config.observeBudgetMs ?? 300));
        const pollMs = Math.max(40, Number(config.observePollMs ?? 100));
        const maxReads = Math.max(1, Number(config.observeMaxReads ?? 3));
        const started = Date.now();
        let reads = 0;
        try {
          const snapArgv = buildCommandArgv(
            "snapshot", { pid: args.pid, windowId: args.windowId, noActions: true }, manager
          );
          const baseline =
            typeof manager.cachedFingerprint === "function"
              ? manager.cachedFingerprint(args.pid, args.windowId)
              : null;
          let snapRaw = await manager.exec(snapArgv, exec?.signal);
          if (!snapRaw?.ok) throw new Error(snapRaw?.error ?? "snapshot unavailable");
          reads += 1;
          let changed =
            baseline === null ? null : snapshotFingerprint(snapRaw) !== baseline;
          while (
            changed === false &&
            reads < maxReads &&
            Date.now() - started < budgetMs &&
            !exec?.signal?.aborted
          ) {
            const wait = Math.min(pollMs, budgetMs - (Date.now() - started));
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
            const next = await manager.exec(snapArgv, exec?.signal);
            if (!next?.ok) break;
            reads += 1;
            snapRaw = next;
            changed = snapshotFingerprint(snapRaw) !== baseline;
          }
          const observation = manager.recordSnapshot(args.pid, args.windowId, snapRaw, {
            full: false,
          });
          extra.observation = {
            ...observation,
            // null when there was no baseline to compare against (first read).
            changed,
            waitedMs: Date.now() - started,
            reads,
          };
          extra.timings = { ...(extra.timings ?? {}), observeMs: Date.now() - observeStarted };
        } catch (error) {
          extra.observation = {
            ok: false,
            error: "post_action_observation_failed",
            message: String(error?.message ?? error).slice(0, 300),
            actionReplaySafe: false,
            waitedMs: Date.now() - started,
            reads,
          };
        }
      };

      const previewTask = async () => {
        if (!wantPreview) return;
        try {
          if (exec?.signal?.aborted) throw new Error("observation cancelled after action");
          // Optional evidence attached to someone else's result: bounded, so a
          // sick capture degrades to "preview unavailable" instead of holding the
          // action's answer for the daemon's 8 s cap plus the 12 s request cap.
          const preview = await capturePreviewObject(ctx, exec, manager, {
            windowId: args.windowId,
            maxDimension: config.defaultPreviewMaxDim ?? 960,
            budgetMs: Number(config.previewBudgetMs ?? 600),
          });
          extra.preview = preview;
          extra.timings = { ...(extra.timings ?? {}), previewMs: preview.ms ?? null };
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

    // A live session already names the window being driven, so an omitted
    // target falls back to the session's. But pid and windowId are ONE target
    // (Spec §7.1, F1): filling them independently let "explicit pid B, no
    // window" inherit session A's window, so the engine handed B's action to
    // A's window. Resolve the pair atomically instead.
    const resolveTargetArgs = (args) => {
      const session = manager.activeSession;
      if (!session) return args;
      const hasPid = args.pid !== undefined && args.pid !== null;
      const hasWindow = args.windowId !== undefined && args.windowId !== null;

      // No explicit target at all: inherit the whole session target.
      if (!hasPid && !hasWindow) {
        return { ...args, pid: session.pid ?? undefined, windowId: session.windowId ?? undefined };
      }

      // Explicit pid, no window. Keep the session window only when it is the
      // same application; a different app starts at app scope and must never
      // carry the old window across.
      if (hasPid && !hasWindow) {
        const sameApp = session.pid !== undefined && Number(args.pid) === Number(session.pid);
        return {
          ...args,
          pid: args.pid,
          windowId: sameApp ? (session.windowId ?? undefined) : undefined,
        };
      }

      // Explicit window (with or without pid). Keep it verbatim; when a pid is
      // also present the engine checks the owner and returns target_mismatch
      // instead of silently overriding pid from the window owner.
      return { ...args, pid: hasPid ? args.pid : undefined, windowId: args.windowId };
    };

    // Publish adapter phases into the unified action-event log. The tools still
    // own their immediate overlay commands; the log is the auditable state that
    // native rendering (and the final verifier) consume.
    const actionTargetFor = (args) => {
      const pid = args.pid ?? manager.activeSession?.pid;
      if (pid === undefined) return null;
      return {
        pid: Number(pid),
        windowId: args.windowId ?? manager.activeSession?.windowId ?? null,
        targetGeneration: Number(manager.sessionGeneration ?? 0),
        geometryVersion: 0,
      };
    };
    const publishPhase = (actionId, kind, phase, extra = {}) => {
      try {
        manager.publishActionEvent?.(manager.adapterEvent({ actionId, kind, phase, ...extra }));
      } catch {
        // event recording must never break the action
      }
    };
    // R9: ask the service for the native NDJSON phase stream on real actions.
    // Native phases arrive at the actual dispatch boundary and are normalized
    // through the same publishActionEvent entry as adapter phases. An old
    // service that ignores eventsVersion returns one JSON result (safe fallback).
    const execWithNativeEvents = (argv, exec, actionId, kind) =>
      manager.exec(argv, exec?.signal, {
        eventsVersion: 1,
        eventContext: {
          sessionId: manager.sessionId ?? "no-session",
          actionId,
          targetGeneration: Number(manager.sessionGeneration ?? 0),
        },
        onEvent: (event) => {
          try { manager.publishActionEvent?.(event); } catch { /* never break the action */ }
        },
      });

    // Refuse a ref that provably belongs to an observation the caller has moved
    // past. The engine already rejects a path whose role/title changed; this
    // catches the case where a *same-named* control slid into that path, which
    // path+role+title cannot tell apart.
    const staleSnapshotResult = (args) => {
      if (args.snapshotId === undefined || args.snapshotId === null) return null;
      if (args.ref === undefined || args.pid === undefined) return null;
      const mismatch = manager.refSnapshotMismatch?.(
        Number(args.pid), String(args.ref), args.windowId, args.snapshotId
      );
      if (!mismatch) return null;
      return {
        ok: false,
        error: "stale_snapshot",
        message: mismatch,
        currentSnapshotId: manager.currentSnapshotId?.(Number(args.pid), args.windowId) ?? null,
        actionReplaySafe: false,
        hint: "call cu_snapshot again and use a ref from the new observation",
      };
    };

    // Verify an explicit post-condition through the engine's own `expect`
    // (which polls with a timeout). Returns null when the caller gave none, so
    // the action result keeps its old shape.
    const runExpect = async (spec, args, exec) => {
      if (!spec || typeof spec !== "object") return null;
      const pid = spec.pid ?? args.pid;
      if (pid === undefined) {
        return { matched: false, error: "expect_needs_pid", message: "expect needs a pid" };
      }
      const expectationText =
        spec.query !== undefined
          ? `「${String(spec.query).slice(0, 20)}」`
          : spec.ref !== undefined
          ? String(spec.ref)
          : "目标状态";
      if (Number(spec.timeoutMs ?? 2000) >= 250) {
        // A long poll with a silent overlay looks like a frozen agent.
        manager.writeActivity(`等待 ${expectationText}`);
      }
      const expected = {
        ...(spec.ref !== undefined ? { ref: String(spec.ref) } : {}),
        ...(spec.query !== undefined ? { query: String(spec.query) } : {}),
        ...(spec.enabled !== undefined ? { enabled: Boolean(spec.enabled) } : {}),
        ...(spec.value !== undefined ? { value: String(spec.value) } : {}),
        ...(spec.contains !== undefined ? { contains: String(spec.contains) } : {}),
      };
      try {
        const argv = buildCommandArgv(
          "expect",
          {
            pid,
            windowId: spec.windowId ?? args.windowId,
            ref: spec.ref,
            query: spec.query,
            enabled: spec.enabled,
            value: spec.value,
            contains: spec.contains,
            timeoutMs: spec.timeoutMs ?? 2000,
          },
          manager
        );
        const res = await manager.exec(argv, exec?.signal);
        if (res?.ok) {
          manager.writeActivity(`已确认 ${expectationText}`);
          return {
            matched: true,
            expected,
            matchedRef: res.ref ?? null,
            matchedTitle: res.title ?? null,
            ms: res.ms ?? null,
          };
        }
        manager.writeActivity(`未确认 ${expectationText}`);
        return {
          matched: false,
          expected,
          error: res?.error ?? "expect_failed",
          message: String(res?.message ?? "").slice(0, 200),
          ms: res?.ms ?? null,
        };
      } catch (error) {
        return {
          matched: false,
          expected,
          error: "expect_unavailable",
          message: String(error?.message ?? error).slice(0, 200),
        };
      }
    };

    // After an action: wait for the declared condition first (it is the thing
    // that tells us the app finished), then read the tree, so the delta shows
    // the settled state rather than the pre-settle frame.
    const afterAction = async (args, exec) => {
      const verifyStarted = Date.now();
      const verification = await runExpect(args.expect, args, exec);
      const verifyMs = Date.now() - verifyStarted;
      const post = await runPostAction(args, exec);
      post.timings = { ...(post.timings ?? {}), verifyMs };
      if (!verification) return post;
      return {
        ...post,
        verified: verification.matched,
        verification,
        ...(verification.matched
          ? {}
          : {
              warning:
                "动作已经派发，但界面没有出现预期状态；先重新观察再决定，不要盲目重放",
              actionReplaySafe: false,
            }),
      };
    };

    // 7. cu_expect — the verification primitive the mutating tools embed, also
    // exposed on its own for flows that must confirm a state before acting.
    register({
      name: "cu_expect",
      description:
        "Assert what the app actually did by polling its accessibility tree (no screenshot). Waits until the control matches, the timeout runs out, or the control disappears. Use after an action whose effect matters, instead of trusting ok:true.",
      parameters: {
        pid: {
          type: "integer",
          description: "Target application pid. Omit to use the active session target.",
        },
        windowId: { type: "integer", description: "Optional window scope." },
        ref: {
          type: "string",
          description: "Snapshot ref of the control to check (e.g. 'k0.3.2').",
        },
        query: {
          type: "string",
          description: "Or find the control by its label/value text (case-insensitive substring).",
        },
        enabled: { type: "boolean", description: "Require this enabled state." },
        value: { type: "string", description: "Require this exact value." },
        contains: { type: "string", description: "Require the value or label to contain this text." },
        timeoutMs: {
          type: "integer",
          description: "Poll for this long (default 2000).",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => true,
      async execute(rawArgs, exec) {
        const args = resolveTargetArgs(rawArgs);
        let argv;
        try {
          argv = buildCommandArgv(
            "expect",
            {
              pid: args.pid,
              windowId: args.windowId,
              ref: args.ref,
              query: args.query,
              enabled: args.enabled,
              value: args.value,
              contains: args.contains,
              timeoutMs: args.timeoutMs,
            },
            manager
          );
        } catch (error) {
          return { ok: false, error: "expect_needs_target", message: String(error?.message ?? error) };
        }
        const expectActionId = manager.nextActionId?.("expect") ?? `expect-${Date.now()}`;
        const expectTarget = actionTargetFor(args);
        const expectLabel = args.ref ? `等待 ${args.ref}` : `等待 ${args.query ?? args.contains ?? "条件"}`;
        publishPhase(expectActionId, "expect", "accepted", { target: expectTarget, label: expectLabel });
        if (expectTarget) publishPhase(expectActionId, "expect", "targetReady", { target: expectTarget, label: expectLabel });
        const result = await execWithNativeEvents(argv, exec, expectActionId, "expect");
        publishPhase(expectActionId, "expect", result?.ok ? "verified" : "unverified",
          { target: expectTarget, label: expectLabel,
            ...(result?.ok ? { verification: { matched: true, evidenceRef: "expect" } } : { reason: "not_reached" }) });
        // Keep the failure shape, but state plainly that the target state was
        // not reached rather than leaving the caller to read an error code.
        if (result?.ok) return result;
        return {
          ...result,
          ok: false,
          verified: false,
          error: result?.error ?? "expect_failed",
          message:
            result?.message ??
            "the app did not reach that state within the timeout; the action had no visible effect",
        };
      },
    });

    // 8. cu_click
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
        snapshotId: SNAPSHOT_ID_PARAM,
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
        expect: EXPECT_PARAM,
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
      async execute(rawArgs, exec) {
        const began = Date.now();
        manager.assertCanAct("cu_click", exec?.signal);
        const args = resolveTargetArgs(rawArgs);
        const stale = staleSnapshotResult(args);
        if (stale) {
          manager.showActionFailure?.("点击");
          return stale;
        }
        // Identity path: act on the retained object, but ONLY when the whole
        // identity chain (app, window, worker generation, session generation,
        // observation) still matches the request. A mismatch is an explicit
        // refusal — never a path click against whatever now sits at that ref.
        if (args.ref !== undefined && manager._axWorkerAllowed && typeof manager.axClick === "function") {
          const expectedObservationId = args.snapshotId === undefined || args.snapshotId === null
            ? undefined
            : manager.snapshotObservations?.get(Number(args.snapshotId));
          const bound = manager.resolveBoundToken
            ? manager.resolveBoundToken(args.ref, args, expectedObservationId)
            : (() => { const t = manager.axTokenFor(args.ref); return t ? { ok: true, token: t } : { ok: false }; })();
          if (bound.ok) {
            // R10: AXPress is a single primary-button activation. Silently
            // collapsing right-click / double-click into it changes what the UI
            // does, so refuse explicitly instead of dropping the parameters.
            const button = args.button ?? "left";
            const count = args.count ?? 1;
            if (button !== "left" || Number(count) !== 1) {
              const actionId = manager.nextActionId?.("click") ?? `click-${Date.now()}`;
              const eventTarget = actionTargetFor(args);
              publishPhase(actionId, "click", "accepted", { target: eventTarget });
              publishPhase(actionId, "click", "failed", {
                target: eventTarget, reason: "unsupported_click_semantics",
              });
              manager.showActionFailure?.("不支持的点击参数");
              return {
                ok: false,
                error: "unsupported_click_semantics",
                message: `retained-token click supports only a single left press; got button=${button}, count=${count}. Use explicit x/y coordinates for right/double clicks.`,
                actionReplaySafe: false,
                via: "ax-worker-token",
              };
            }
            const actionId = manager.nextActionId?.("click") ?? `click-${Date.now()}`;
            const eventTarget = actionTargetFor(args);
            const point = aimedClickPoint(args);
            const label = clickLabel(clickTarget(args), point);
            publishPhase(actionId, "click", "accepted", { target: eventTarget, label, ...(point ? { point } : {}) });
            if (eventTarget) publishPhase(actionId, "click", "targetReady", { target: eventTarget, label, ...(point ? { point } : {}) });
            const result = await manager.axClick(bound.token, "AXPress");
            if (result?.ok === true) {
              publishPhase(actionId, "click", "dispatched", { target: eventTarget, label, ...(point ? { point } : {}) });
              if (manager.activeSession) manager.showClickFeedback(point, label);
              // Keep the caller's evidence contract: still observe/preview after a
              // token-dispatched click, exactly like the one-shot path.
              const post = await afterAction({ ...args, observe: args.observe }, exec);
              if (args.expect && post?.verification?.matched === true) {
                publishPhase(actionId, "click", "verified", { target: eventTarget, label,
                  verification: { matched: true, evidenceRef: "expect" } });
              } else {
                publishPhase(actionId, "click", "unverified", { target: eventTarget, label });
              }
              return { ...result, ...post, via: "ax-worker-token" };
            }
            // An uncertain/failed retained dispatch must NOT be replayed by path.
            publishPhase(actionId, "click", "failed", { target: eventTarget, label, reason: String(result?.error ?? "refused") });
            return { ...result, via: "ax-worker-token", actionReplaySafe: false };
          }
          if (manager.axTokenFor?.(args.ref)) {
            manager.showActionFailure?.("目标已变化");
            return {
              ok: false,
              error: bound.error ?? "identity_unproven",
              message: bound.message ?? "the retained token no longer matches this target",
              actionReplaySafe: false,
              hint: "call cu_snapshot again and use a ref from the new observation",
            };
          }
        }
        if (config.autoSession !== false && !manager.activeSession && args.windowId !== undefined) {
          await manager.startVisualSession({
            windowId: args.windowId,
            pid: args.pid,
            halo: false,
            // Auto-click only shrinks DSH; the target window must not move or the
            // element frame we are about to click would be stale.
            dockDsh: config.autoDockDsh !== false,
            splitScreen: false,
          });
        }
        const argv = buildCommandArgv("click", args, manager);
        const label = clickLabel(clickTarget(args), aimedClickPoint(args));
        const actionId = manager.nextActionId?.("click") ?? `click-${Date.now()}`;
        const eventTarget = actionTargetFor(args);
        const aimedEvent = aimedClickPoint(args);
        publishPhase(actionId, "click", "accepted", {
          target: eventTarget,
          label,
          ...(aimedEvent ? { point: aimedEvent } : {}),
        });
        if (eventTarget) {
          publishPhase(actionId, "click", "targetReady", {
            target: eventTarget,
            label,
            ...(aimedEvent ? { point: aimedEvent } : {}),
          });
        }
        // The capsule is a live "what is the agent doing" line, so it names the
        // action while it is being dispatched; a failure overwrites it below.
        manager.writeActivity(label);
        // Locate: glide to where this click is aimed while the engine resolves
        // and dispatches it. This is a hint, not a result — only the ripple and
        // the chip below claim that something happened.
        if (manager.activeSession) {
          const aimed = aimedClickPoint(args);
          if (aimed) {
            try {
              manager.showAgentCursor(aimed.x, aimed.y);
            } catch {
              // ignore visual errors
            }
          }
        }
        const actionStarted = Date.now();
        const result = await execWithNativeEvents(argv, exec, actionId, "click");
        const actionMs = Date.now() - actionStarted;
        if (!result?.ok) {
          // Refused (disabled control, stale ref, user pause, missing window):
          // no ripple, no success chip, and never a `dispatched` event.
          publishPhase(actionId, "click", "failed", {
            target: eventTarget,
            label,
            reason: String(result?.error ?? "refused"),
          });
          if (manager.activeSession) manager.showActionFailure(label);
          return result;
        }
        const landedEvent = landedClickPoint(args, result);
        publishPhase(actionId, "click", "dispatched", {
          target: eventTarget,
          label,
          ...(landedEvent ? { point: landedEvent } : {}),
        });
        // Dispatched and accepted by the engine: now the click is real.
        if (manager.activeSession) {
          manager.showClickFeedback(landedEvent, label);
        }
        const post = await afterAction(args, exec);
        if (args.expect && post?.verification?.matched === true) {
          publishPhase(actionId, "click", "verified", {
            target: eventTarget,
            label,
            verification: { matched: true, evidenceRef: "expect" },
          });
        } else {
          publishPhase(actionId, "click", "unverified", { target: eventTarget, label });
        }
        return {
          ...result,
          ...post,
          timings: { actionMs, ...(post.timings ?? {}), totalMs: Date.now() - began },
        };
      },
    });

    // 9. cu_type
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
        snapshotId: SNAPSHOT_ID_PARAM,
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
        expect: EXPECT_PARAM,
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
      async execute(rawArgs, exec) {
        const began = Date.now();
        manager.assertCanAct("cu_type", exec?.signal);
        const args = resolveTargetArgs(rawArgs);
        const stale = staleSnapshotResult(args);
        if (stale) return stale;
        const mode = args.mode ?? "type";
        const label = mode === "action" ? `执行动作 ${args.actionName}` : `输入文字 (${(args.text ?? "").length}字)`;
        const actionId = manager.nextActionId?.("type") ?? `type-${Date.now()}`;
        const eventTarget = actionTargetFor(args);
        publishPhase(actionId, "type", "accepted", { target: eventTarget, label });
        if (eventTarget) publishPhase(actionId, "type", "targetReady", { target: eventTarget, label });

        // R3: a ref type must act on the retained object in ONE native command
        // that both validates identity and writes. A verify error / worker exit /
        // timeout stops the input; no path-based write to a substitute object.
        if (args.ref !== undefined && manager._axWorkerAllowed && typeof manager.axInput === "function") {
          const bound = manager.resolveBoundToken
            ? manager.resolveBoundToken(args.ref, args)
            : (() => { const t = manager.axTokenFor(args.ref); return t ? { ok: true, token: t } : { ok: false }; })();
          if (bound.ok) {
            try {
              const result = await manager.axInput(bound.token, args.text, mode);
              if (result?.ok === true) {
                publishPhase(actionId, "type", "dispatched", { target: eventTarget, label });
                const post = await afterAction({ ...args, observe: args.observe }, exec);
                publishPhase(actionId, "type",
                  args.expect && post?.verification?.matched === true ? "verified" : "unverified",
                  { target: eventTarget, label,
                    ...(args.expect && post?.verification?.matched === true
                      ? { verification: { matched: true, evidenceRef: "expect" } } : {}) });
                return { ...result, ...post, via: "ax-worker-token",
                         timings: { actionMs: Date.now() - began, ...(post.timings ?? {}), totalMs: Date.now() - began } };
              }
              publishPhase(actionId, "type", "failed", { target: eventTarget, label, reason: String(result?.error ?? "refused") });
              return { ...result, via: "ax-worker-token", actionReplaySafe: false,
                       timings: { actionMs: Date.now() - began, totalMs: Date.now() - began } };
            } catch (error) {
              publishPhase(actionId, "type", "failed", { target: eventTarget, label, reason: "identity_unproven" });
              return { ok: false, error: "identity_unproven", actionReplaySafe: false,
                       message: `the retained target could not be proven; no input was sent (${String(error?.message ?? error).slice(0, 160)})`,
                       hint: "call cu_snapshot again and retry",
                       timings: { actionMs: Date.now() - began, totalMs: Date.now() - began } };
            }
          }
          if (manager.axTokenFor?.(args.ref)) {
            publishPhase(actionId, "type", "failed", { target: eventTarget, label, reason: bound.error ?? "identity_unproven" });
            return { ok: false, error: bound.error ?? "identity_unproven", message: bound.message,
                     actionReplaySafe: false, hint: "call cu_snapshot again and retry" };
          }
        }
        manager.writeActivity(label);
        const cmdParams =
          mode === "action" ? { ...args, name: args.actionName ?? "AXPress" } : args;
        const argv = buildCommandArgv(mode, cmdParams, manager);
        const actionStarted = Date.now();
        const result = await execWithNativeEvents(argv, exec, actionId, "type");
        const actionMs = Date.now() - actionStarted;
        if (!result?.ok) {
          publishPhase(actionId, "type", "failed", { target: eventTarget, label, reason: String(result?.error ?? "failed") });
          return { ...result, timings: { actionMs, totalMs: Date.now() - began } };
        }
        publishPhase(actionId, "type", "dispatched", { target: eventTarget, label });
        const post = await afterAction(args, exec);
        publishPhase(actionId, "type",
          args.expect && post?.verification?.matched === true ? "verified" : "unverified",
          { target: eventTarget, label,
            ...(args.expect && post?.verification?.matched === true
              ? { verification: { matched: true, evidenceRef: "expect" } } : {}) });
        return {
          ...result,
          ...post,
          timings: { actionMs, ...(post.timings ?? {}), totalMs: Date.now() - began },
        };
      },
    });

    // 10. cu_key
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
        expect: EXPECT_PARAM,
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
      async execute(rawArgs, exec) {
        const began = Date.now();
        manager.assertCanAct("cu_key", exec?.signal);
        const args = resolveTargetArgs(rawArgs);
        const label = `按键 ${args.mods ? `${args.mods}+` : ""}${args.name}`;
        const actionId = manager.nextActionId?.("key") ?? `key-${Date.now()}`;
        const eventTarget = actionTargetFor(args);
        publishPhase(actionId, "key", "accepted", { target: eventTarget, label });
        if (eventTarget) publishPhase(actionId, "key", "targetReady", { target: eventTarget, label });
        manager.writeActivity(label);
        const argv = buildCommandArgv("key", args, manager);
        const actionStarted = Date.now();
        const result = await execWithNativeEvents(argv, exec, actionId, "key");
        const actionMs = Date.now() - actionStarted;
        if (!result?.ok) {
          publishPhase(actionId, "key", "failed", { target: eventTarget, label, reason: String(result?.error ?? "failed") });
          return { ...result, timings: { actionMs, totalMs: Date.now() - began } };
        }
        publishPhase(actionId, "key", "dispatched", { target: eventTarget, label });
        const post = await afterAction(args, exec);
        const verifiedKey = args.expect && post?.verification?.matched === true;
        publishPhase(actionId, "key", verifiedKey ? "verified" : "unverified",
          { target: eventTarget, label, ...(verifiedKey ? { verification: { matched: true, evidenceRef: "expect" } } : {}) });
        return {
          ...result,
          ...post,
          timings: { actionMs, ...(post.timings ?? {}), totalMs: Date.now() - began },
        };
      },
    });

    // 11. cu_scroll
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
        expect: EXPECT_PARAM,
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => false,
      async execute(rawArgs, exec) {
        const began = Date.now();
        manager.assertCanAct("cu_scroll", exec?.signal);
        const args = resolveTargetArgs(rawArgs);
        const label = `滚动 dy=${args.dy}`;
        const actionId = manager.nextActionId?.("scroll") ?? `scroll-${Date.now()}`;
        const eventTarget = actionTargetFor(args);
        publishPhase(actionId, "scroll", "accepted", { target: eventTarget, label });
        if (eventTarget) publishPhase(actionId, "scroll", "targetReady", { target: eventTarget, label });
        manager.writeActivity(label);
        const argv = buildCommandArgv("scroll", args, manager);
        const actionStarted = Date.now();
        const result = await execWithNativeEvents(argv, exec, actionId, "scroll");
        const actionMs = Date.now() - actionStarted;
        if (!result?.ok) {
          publishPhase(actionId, "scroll", "failed", { target: eventTarget, label, reason: String(result?.error ?? "failed") });
          return { ...result, timings: { actionMs, totalMs: Date.now() - began } };
        }
        publishPhase(actionId, "scroll", "dispatched", { target: eventTarget, label });
        const post = await afterAction({ ...args, observe: args.observe === true }, exec);
        const verifiedScroll = args.expect && post?.verification?.matched === true;
        publishPhase(actionId, "scroll", verifiedScroll ? "verified" : "unverified",
          { target: eventTarget, label, ...(verifiedScroll ? { verification: { matched: true, evidenceRef: "expect" } } : {}) });
        return {
          ...result,
          ...post,
          timings: { actionMs, ...(post.timings ?? {}), totalMs: Date.now() - began },
        };
      },
    });

    // 12. cu_find
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
      async execute(rawArgs, exec) {
        const args = resolveTargetArgs(rawArgs);
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

    // 13. cu_batch
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
            "Array of action steps: e.g. [{action:'click',ref:'k1.29'},{action:'type',text:'abc'},{action:'key',name:'return'}]. A step may carry snapshotId (the observation its ref came from); the step is refused with stale_snapshot if that observation is no longer current.",
        },
        timeoutMs: {
          type: "integer",
          description: "Max total execution budget in milliseconds (default 20000).",
        },
        settleMs: {
          type: "integer",
          description:
            "Blind pause between steps in milliseconds (default 60). Prefer an {action:'expect'} step over a long settle: it waits for the state the app is actually in instead of a guess.",
        },
        stopOnError: {
          type: "boolean",
          description: "Stop batch on first step error (default true).",
        },
        observe: {
          type: "boolean",
          description: "Capture and return AX delta after batch completes (default true).",
        },
        expect: EXPECT_PARAM,
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
      async execute(rawArgs, exec) {
        const began = Date.now();
        manager.assertCanAct("cu_batch", exec?.signal);
        const args = resolveTargetArgs(rawArgs);
        const batchActionId = manager.nextActionId?.("batch") ?? `batch-${Date.now()}`;
        const batchTarget = actionTargetFor(args);
        const batchLabel = `批处理 ${Array.isArray(args.steps) ? args.steps.length : 0} 步`;
        publishPhase(batchActionId, "batch", "accepted", { target: batchTarget, label: batchLabel });
        if (batchTarget) publishPhase(batchActionId, "batch", "targetReady", { target: batchTarget, label: batchLabel });
        const batchResult = await manager.executeBatch(
          {
            pid: args.pid,
            windowId: args.windowId,
            steps: args.steps,
            timeoutMs: args.timeoutMs,
            settleMs: args.settleMs,
            stopOnError: args.stopOnError,
          },
          exec?.signal
        );
        if (batchResult?.ok === true) {
          publishPhase(batchActionId, "batch", "dispatched", { target: batchTarget, label: batchLabel });
        }
        // A batch terminal phase is unverified until its post-conditions (if any)
        // are checked by afterAction; a failed batch is honestly "failed".
        publishPhase(batchActionId, "batch", batchResult?.ok === true ? "unverified" : "failed",
          { target: batchTarget, label: batchLabel,
            ...(batchResult?.ok === true ? {} : { reason: String(batchResult?.error ?? "batch_failed") }) });

        const targetPid = args.pid ?? batchResult.results?.[0]?.pid;
        const targetWin = args.windowId ?? manager.activeSession?.windowId;
        const shouldPreview = args.preview !== false && targetWin !== undefined;
        const extra = await afterAction(
          {
            pid: targetPid,
            windowId: targetWin,
            observe: args.observe !== false,
            preview: shouldPreview,
            expect: args.expect,
          },
          exec
        );

        return {
          ...batchResult,
          ...extra,
          timings: {
            ...(batchResult.timings ?? {}),
            ...(extra.timings ?? {}),
            totalMs: Date.now() - began,
          },
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

  manager.registrationErrors = registrationErrors;
  if (registrationErrors.length > 0) {
    logBoot(`${registrationErrors.length} tool definition(s) rejected; the rest are registered`);
  }
}

/**
 * Register the embedded `super-computer-use` skill on the context and any active/created agents.
 * One canonical name, matching the plugin title: a `/` query that prefixes the name ranks it
 * first, and longer queries still resolve through the ordered-subsequence name match.
 */
export function registerCuSkill(ctx, manager) {
  const SKILL_NAMES = ["super-computer-use"];
  // Turn-completion hook: "turn/end" means the agent finished this task, so tear
  // down the visual session right away instead of waiting for the idle timer.
  // Registered on the root scope and on every agent scope so it fires no matter
  // where the session event is emitted.
  const onSessionEvent = (_session, event) => {
    if (event?.type === "turn/end" && manager?.activeSession) {
      manager.stopVisualSession().catch(() => {});
    }
  };
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
    const unregs = [registerOnScope(agent.ctx)];
    if (typeof agent.ctx.on === "function") {
      unregs.push(agent.ctx.on("session/event", onSessionEvent));
    }
    agentMap.set(agent, () => unregs.forEach((u) => u?.()));
  };

  if (typeof ctx.on === "function") {
    disposers.push(
      ctx.on("session/event", onSessionEvent),
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

  logBoot("apply() entered");
  let disposeTools;
  try {
    disposeTools = registerCuTools({ ctx, manager, config });
  } catch (error) {
    logBoot(`apply() failed while registering tools: ${error?.stack ?? error}`);
    throw error;
  }
  const disposeSkill = registerCuSkill(ctx, manager);
  logBoot(`apply() done: ${disposeTools ? "tools registered" : "no tools"}`);

  ctx.effect(() => async () => {
    disposeSkill();
    disposeTools();
    await manager.stopVisualSession();
  });
}

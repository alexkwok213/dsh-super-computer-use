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
import { createRuntimeIdentity, installDevSync } from "./dev-sync.mjs";
import { createCuUiRegistry } from "./cu-ui-session.mjs";
import { installHarnessUiBridge } from "./harness-ui-bridge.mjs";
import { createPreviewBridge } from "./preview-stream.mjs";
import { createSettingsStore, deniedAppMatch, shouldRefuseForSettings } from "./native-settings.mjs";
import { detectPlaybook, playbookSummary } from "./app-playbooks.mjs";
import { connectPage, planLayerToStrokes, paintStrokes, sendUndo, readDevToolsActivePort, acquirePage, releasePages, poolSize, launchDebugChrome, ownedChromeRunning, defaultDebugProfileDir, resolveOwnedEndpoint } from "./cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Release marker. `scripts/release.mjs` rewrites this every version bump so a
// version-only Release still changes a Host module: DSH's HMR watches module
// files, and a package.json-only change does not replace the loaded generation.
const RELEASE_VERSION = "0.14.1";
// Capture at module load, not status time: edits on disk do not reload Node modules.
const packageMeta = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
// Identity of the generation this module belongs to. `sourceHash` now covers
// package.json and every lib/*.mjs file (not only index.mjs and core.mjs), so a
// reload can be distinguished from a stale Host module. Client and native
// identities are separate fields because they advance independently.
const pluginRuntime = createRuntimeIdentity({
  repoRoot: join(__dirname, ".."),
  entryPath: fileURLToPath(import.meta.url),
  packageMeta,
});

/**
 * The `process.on("exit")` hook that releases the system sharing indicator.
 * Kept module-level so a plugin reload can replace it instead of stacking one
 * listener (and one blocking child) per generation.
 */
let exitIndicatorHook = null;

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

logBoot(`module evaluated release=${RELEASE_VERSION} ${JSON.stringify(pluginRuntime)}`);

let hostDefineTool = (def) => def;
try {
  const toolsMod = await import("@deepseek-ai/dsh-tools");
  if (typeof toolsMod.defineTool === "function") {
    hostDefineTool = toolsMod.defineTool;
  }
} catch {
  // Fallback identity when imported in standalone Node test runner outside DSH app.asar
}

const schemaStub = () => {
  const self = {
    default: () => self,
    description: () => self,
    volatile: () => self,
  };
  return self;
};
let Schema = {
  object: (shape) => ({ type: "object", shape }),
  array: (item) => ({ type: "array", items: item }),
  string: schemaStub,
  boolean: schemaStub,
  number: schemaStub,
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
    .default(300)
    .description("Auto-end the visual CU session after this many seconds with no cu_* activity. A longer default keeps the DSH Control Deck alive while the user watches or the agent is thinking; 0 disables it."),
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
  viewerMode: Schema.string()
    .default("auto")
    .description(
      "Where the live view renders: 'auto' prefers each target's native preview and only shows the in-chat fallback card when that preview is unavailable; 'embedded' allows the in-chat fallback card (local acceptance); 'native' never uses the in-chat client and keeps the native preview/capsule for external clients.",
    ),
  uiProbe: Schema.boolean()
    .default(false)
    .description("Keep the authenticated /api/scu/probe stream route used to verify the desktop transport (diagnostic only; off in product)"),
  uiRefreshClient: Schema.boolean()
    .default(false)
    .description(
      "One-shot local migration: ask the running client-module registry to re-read this package's manifest so a newly added client half activates without restarting the desktop app. Off for normal installs, where a restart performs the same read.",
    ),
  // Native settings section. These four are .volatile(): changing a preference
  // must not reload a plugin that may be mid-action on the user's desktop.
  enabled: Schema.boolean()
    .default(true)
    .volatile()
    .description("Master switch. When off, every non-read-only cu_* tool is refused (stop/resume stay available)."),
  controlMode: Schema.string()
    .default("background")
    .volatile()
    .description("'background' keeps other apps visible; 'full' defaults hideOtherApps to true on session start."),
  deniedApps: Schema.array(Schema.string())
    .default([])
    .volatile()
    .description("App names the agent may never attach to; matched case-insensitively on cu_session start."),
  unhideOnFinish: Schema.boolean()
    .default(true)
    .volatile()
    .description("Restore apps hidden by a full-control session when it stops."),
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
  const targetId = typeof opts.targetId === "string" && opts.targetId ? opts.targetId : null;
  const target = targetId ? manager?.targetForKey?.(targetId) : null;
  const sessionGenerationAtStart = manager?.sessionGeneration;
  const generation =
    opts.generation !== undefined
      ? opts.generation
      : target
        ? target.generation
        : manager?.sessionGeneration ?? null;
  const isCurrent =
    opts.isCurrent ??
    (generation === null || manager?.sessionGeneration === undefined
      ? undefined
      : () => {
          if (!manager || manager._disposed) return false;
          if (manager.sessionGeneration !== sessionGenerationAtStart) return false;
          if (!targetId) return manager.sessionGeneration === generation;
          const current = manager.targetForKey?.(targetId);
          return Boolean(current) && !current.stopped && !current.closed && current.generation === generation;
        });
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
      shot = await manager.exec(shotArgv, captureSignal, {
        bypassQueue: true,
        ...(targetId ? { targetId } : {}),
      });
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
    targetId,
    windowId: opts.windowId ?? null,
  };
  if (manager && typeof manager === "object") {
    manager.lastImage = lastImage;
    // Record the route the pixels actually took. Without this, `cu_status`
    // reports a vision capability but cannot answer "was vision used?", which
    // is exactly the question a caller debugging a blind click needs answered.
    const provider =
      exec?.agent?.session?.requestHeader?.()?.config?.provider ??
      exec?.agent?.options?.provider ?? null;
    const model =
      exec?.agent?.session?.requestHeader?.()?.config?.model ??
      exec?.agent?.options?.model ?? null;
    manager.lastRoute = {
      at: lastImage.at,
      delivered: lastImage.delivered,
      kind: imageRef ? "image-attachment" : "disk-only",
      provider,
      model,
      via,
      ...(lastImage.reason ? { reason: lastImage.reason } : {}),
    };
  }
  return {
    ok: true,
    targetId,
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
 * @param {{ ctx: any, manager: CuSessionManager, defineTool?: typeof hostDefineTool, config?: any, registry?: any, viewer?: any }} deps
 */
export function registerCuTools(deps) {
  const { ctx, manager, config = {}, registry = null, viewer = null, settings = null } = deps;
  const define = deps.defineTool ?? hostDefineTool;
  const disposers = [];
  // The rim is the only effect that paints over the whole desktop, so it is the
  // one a user can turn off without losing the cursor, halo or capsule.
  if (config.rim === false) manager.rimEnabled = false;
  if (Number.isFinite(Number(config.idleStopSeconds))) {
    manager.idleStopSeconds = Number(config.idleStopSeconds);
  }

  // Tools that only read state. They are allowed while the user pause is
  // latched (and never claim the desk); everything else stays refused.
  const READ_ONLY_TOOLS = new Set(["cu_status", "cu_windows", "cu_snapshot"]);
  // A disabled Computer Use must never become unstoppable. Stop/resume and the
  // read-only probes stay reachable through the master switch (see
  // shouldRefuseForSettings in native-settings.mjs).
  const liveSettings = () => settings?.current?.() ?? null;

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
        const toolName = toolDef.name;
        toolDef = {
          ...toolDef,
          execute: async (...args) => {
            const exec = args[1];
            const hostSessionId =
              typeof exec?.agent?.id === "string" ? exec.agent.id : null;
            // Read-only tools never take the desk. A stop must refuse input and
            // ownership, not make the desktop unreadable: windows and the AX tree
            // stay available so the person (and the model) can still see state.
            // Screenshots/find stay gated because they capture pixels.
            const readOnly = READ_ONLY_TOOLS.has(toolName);
            // cu_status is a read-only health check: a second chat may ask for it
            // without stealing the active owner. Every other mutating tool takes the desk.
            const ownsDesk =
              Boolean(registry) && !readOnly && Boolean(hostSessionId);
            const toolArgs = args[0] && typeof args[0] === "object" ? args[0] : {};
            const currentSettings = liveSettings();
            // Master switch from the native settings section. Read-only probes
            // and stop/resume stay available so a disabled plugin cannot leave a
            // session running with no way to end it.
            const refusal = shouldRefuseForSettings(
              toolName,
              toolArgs,
              currentSettings,
              READ_ONLY_TOOLS,
            );
            if (refusal) {
              const disabled = new Error(
                "Computer Use is turned off in Settings → Computer Use. Turn it on to continue.",
              );
              disabled.code = refusal;
              throw disabled;
            }
            const targetHint = {
              ...(typeof toolArgs.targetId === "string" && toolArgs.targetId
                ? { targetId: toolArgs.targetId }
                : {}),
              ...(toolArgs.pid !== undefined && toolArgs.pid !== null ? { pid: Number(toolArgs.pid) } : {}),
              ...(toolArgs.windowId !== undefined && toolArgs.windowId !== null
                ? { windowId: Number(toolArgs.windowId) }
                : {}),
            };
            const explicitStart =
              toolName === "cu_session" && (toolArgs.action === "start" || toolArgs.action === "resume");
            // A user stop is a latch, not a one-shot status. Do not claim a new
            // owner for an ordinary action while it is set: that would replace
            // the stopped card with failed/running and keep other chats away.
            if (ownsDesk && manager.pauseLatched && !explicitStart) {
              const paused = new Error(
                "Computer Use has been paused/stopped by the user. Call cu_session with action=\"start\" or action=\"resume\" to continue.",
              );
              paused.code = "PAUSED_BY_USER";
              throw paused;
            }
            let ticket = null;
            if (ownsDesk) {
              const claimed = registry.beginAction(hostSessionId, {
                tool: toolName,
                ...(typeof toolArgs.action === "string" ? { operation: toolArgs.action } : {}),
                ...targetHint,
              });
              if (!claimed.ok) {
                const error = new Error(
                  claimed.error === "cu_busy"
                    ? "cu_busy: another chat is controlling the computer. Stop it there before starting a new session."
                    : `cu_unavailable: ${claimed.error}`,
                );
                error.code = claimed.error;
                throw error;
              }
              // Capture the identity of THIS action before awaiting it. A newer
              // action/stop gets a different ticket, so this result can never
              // be applied to the new state.
              ticket = claimed.ticket;
            }
            if (typeof manager.inFlightOps === "number") manager.inFlightOps += 1;
            try {
              const result = await origExecute.apply(toolDef, args);
              if (ownsDesk) {
                registry.endAction(ticket, {
                  // A dispatched-but-unverified effect is not success. Keep it
                  // in the unverified state instead of inventing a failure or a
                  // success from the transport acknowledgement.
                  ok:
                    result?.ok !== false ||
                    result?.error === "effect_not_verified",
                  verified:
                    result?.verified === true ||
                    result?.verification?.matched === true ||
                    result?.verification?.verified === true ||
                    (toolName === "cu_expect" && result?.ok === true),
                  error: result?.ok === false ? (result?.error ?? "action_failed") : undefined,
                });
              }
              return result;
            } catch (error) {
              if (ownsDesk) {
                registry.endAction(ticket, { ok: false, error: error?.message });
              }
              throw error;
            } finally {
              if (typeof manager.inFlightOps === "number") {
                manager.inFlightOps = Math.max(0, manager.inFlightOps - 1);
              }
              // Read-only probes do not count as desktop activity. Mutating
              // tools get a short grace window before a dev reload may replace
              // the generation that just answered.
              if (!READ_ONLY_TOOLS.has(toolName)) manager.lastMutatingToolAt = Date.now();
              // A status read is not desktop activity; only a tool that owns
              // the desk may extend the input idle timer.
              if (ownsDesk && manager.activeSession) manager.armIdleStop();
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

  // Embedded viewing: only when this chat's client half is actually connected.
  // A missing client (other host, CLI) keeps the original native preview, so the
  // existing external-client experience never silently loses its window.
  const viewIsEmbedded = (exec) => {
    if (config.viewerMode === "native") return false;
    const hostSessionId = typeof exec?.agent?.id === "string" ? exec.agent.id : null;
    if (!hostSessionId) return false;
    if (config.viewerMode === "embedded") return true;
    return Boolean(viewer?.clientPresent?.(hostSessionId));
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

  const TARGET_ID_PARAM = {
    type: "string",
    description:
      "A target returned by cu_status/cu_snapshot/cu_session. Use it to address one of several windows in this chat without relying on a session-wide default.",
  };

  // A foreground action is a different capability contract: it changes the
  // user's focus, keyboard destination and possibly the clipboard. `foreground`
  // alone describes WHAT to do; `authorizeForeground` records that the person
  // explicitly allowed the interruption. Both are required, so an ordinary
  // background retry can never silently escalate itself.
  const foregroundRefusal = (args) => {
    if (args.foreground !== true) return null;
    if (args.authorizeForeground === true) return null;
    if (manager?.sessionForegroundAuthorized === true) return null;
    if (manager?.isForegroundAuthorized?.(args.targetId)) return null;
    return {
      ok: false,
      error: "foreground_requires_authorization",
      message:
        "This operation needs the target app in front, which would take focus from the user. " +
        "No input was sent. Ask the user for explicit permission, then retry with foreground:true and authorizeForeground:true.",
      impact: ["user_focus", "real_keyboard_or_mouse", "possibly_clipboard"],
      attemptedForeground: true,
      actionReplaySafe: true,
      capability: "foreground_only",
      stopRetrying: true,
    };
  };

  // Native errors that describe a real capability boundary, not a transient
  // failure. The model must not loop on them or silently promote to foreground.
  const capabilityBoundary = (result) => {
    const code = String(result?.error ?? "");
    if (!code) return null;
    if (["no_frame", "off_stage_window", "target_not_focused", "focused_window_mismatch"].includes(code)) {
      return {
        capability: "background_unavailable",
        requiresForeground: true,
        stopRetrying: true,
      };
    }
    if (["control_disabled", "identity_unproven", "stale_observation", "target_mismatch", "window_gone"].includes(code)) {
      return { capability: "background_refused", stopRetrying: true };
    }
    return null;
  };

  const ensureActionTarget = (args, { explicit = false, makePrimary = true, readOnly = false } = {}) => {
    if (typeof manager.ensureTarget !== "function") return null;
    if (readOnly && manager.pauseLatched) {
      // A read-only observation after a user stop is allowed, but it must not
      // resurrect a target/session in the manager. Use the one-shot identity
      // path unless the target already exists.
      const resolved = resolveTargetArgs(args);
      const known = resolved.targetId ? manager.targetForKey?.(resolved.targetId) : null;
      if (!known) return null;
    }
    const target = manager.ensureTarget(args, {
      explicit,
      makePrimary,
      app: args.appName,
      label: args.label,
    });
    if (target && (target.gateClosed || target.stopped || target.closed)) {
      manager.assertCanAct("target", null, target.id);
    }
    return target;
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
        const session = manager.activeSession;
        return {
          ...status,
          plugin: {
            ...pluginRuntime,
            native: {
              ...(pluginRuntime.native ?? {}),
              // The helper's own status is the only authoritative source for
              // what is actually running; do not infer it from the on-disk hash.
              runningServiceBuildId:
                typeof status?.buildId === "string" ? status.buildId : null,
              runningPid: Number.isInteger(status?.pid) ? status.pid : null,
            },
          },
          pauseLatched: manager.pauseLatched,
          // Lossless JSON: a session can legitimately have no pid/appName, and
          // `undefined` fields are rejected by the host tool-output validator.
          activeSession: session
            ? {
                targetId: session.targetId ?? null,
                windowId: session.windowId ?? null,
                pid: session.pid ?? null,
                app: session.app ?? null,
                label: session.label ?? null,
                startedAt: session.startedAt ?? null,
              }
            : null,
          targets: manager.listTargets(),
          targetCount: manager.listTargets().length,
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
        "Manage a visible macOS Computer Use session. 'start' attaches a target (one chat can hold several), shows a non-activating capsule and halo, and may capture an inline preview. It never activates, moves or stages a window by default; dockDsh/splitScreen/bringOnStage are explicit opt-ins. 'stop' with targetId stops only that target and leaves other targets running; without targetId it stops all. 'resume' clears a user pause. Report stop results literally: restoredTarget:false and cleanupState:unknown are not 'restored' or 'cleaned up'.",
      parameters: {
        targetId: TARGET_ID_PARAM,
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
            "Opt in to shrinking DSH to the right side of the screen (default false; background viewing must not rearrange the user's desktop).",
        },
        splitScreen: {
          type: "boolean",
          description:
            "With dockDsh, also move the target window to the left (default false; explicit opt-in only).",
        },
        bringOnStage: {
          type: "boolean",
          description:
            "Explicitly bring a Stage Manager thumbnail on stage (default false; never implied by observation or background work).",
        },
        capsule: {
          type: "boolean",
          description: "Show the non-activating native status capsule. Default false when the DSH client is present (the Control Deck is the status surface), true otherwise.",
        },
        cursor: {
          type: "boolean",
          description: "Show the virtual cursor/click feedback overlay (default true).",
        },
        hideOtherApps: {
          type: "boolean",
          description:
            "Temporarily hide unrelated desktop apps to keep the main stage unoccluded and restore on stop (default false).",
        },
        nativePreview: {
          type: "boolean",
          description: "Show a draggable native picture preview for this target (default true).",
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
        authorizeForeground: {
          type: "boolean",
          description: "Authorize foreground mouse and keyboard control for this session (required for Metal/Qt apps like 剪映/VideoFusion where background events are ignored).",
        },
        interactive: {
          type: "boolean",
          description: "Interactive session: automatically authorizes foreground control and brings window forward.",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (args.action === "resume") {
          const generation = manager.sessionGeneration;
          const res = await manager.exec(["resume"], exec?.signal, { control: true });
          if (res?.ok !== true) {
            return { ...res, ok: false, error: res?.error ?? "resume_failed", action: "resume", service: res };
          }
          // A stop/new session that raced the reply must retain its gate.
          if (manager.sessionGeneration !== generation || exec?.signal?.aborted || manager._disposed) {
            return { ok: false, error: "cancelled", action: "resume", service: res };
          }
          manager.clearPauseLatch();
          manager.inputGateClosed = false;
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
          const hostSessionId =
            typeof exec?.agent?.id === "string" ? exec.agent.id : null;
          const targetId = typeof args.targetId === "string" && args.targetId ? args.targetId : null;
          // The trusted wrapper reads the current session from the registry it
          // just claimed. The HTTP route still requires an explicit id, so a
          // stale or foreign caller cannot widen the validation.
          const cuSessionId = registry?.cuSessionId?.() ?? null;
          if (registry && hostSessionId && cuSessionId) {
            const stopped = await registry.control({
              hostSessionId,
              cuSessionId,
              command: "stop",
              targetId,
              // A per-target stop must not latch the session-wide user pause:
              // stopping A is not permission to block B. A stop-all is the
              // safety action and latches only when explicitly requested.
              pause: args.pause === true,
            });
            if (stopped.ok) {
              return {
                ok: true,
                session: stopped.targetId ? "target_stopped" : "stopped",
                targetId: stopped.targetId ?? null,
                remainingTargets: stopped.remainingTargets ?? 0,
                paused: args.pause === true,
                inputGateClosed: stopped.inputGateClosed ?? !stopped.targetId,
                targetGateClosed: stopped.targetGateClosed ?? false,
                cleanupState: stopped.cleanupState,
                cancelledActions: stopped.detail?.cancelledActions ?? stopped.cancelledActions ?? 0,
                nativePreviewStopped: stopped.detail?.nativePreviewStopped ?? stopped.nativePreviewStopped ?? false,
                restoredDsh: stopped.detail?.restoredDsh ?? false,
                restoredTarget: stopped.detail?.restoredTarget ?? false,
                via: "ui-registry",
              };
            }
            if (stopped.status === 403) {
              return { ok: false, error: "not_owner", reason: "cu_busy" };
            }
            return { ok: false, error: stopped.error ?? "stop_failed", via: "ui-registry" };
          }
          if (targetId) return await manager.stopTarget(targetId, { pause: args.pause === true });
          return await manager.stopVisualSession({ pause: args.pause === true });
        }
        if (args.action === "preview") {
          const resolved = resolveTargetArgs(args);
          const targetWin = resolved.windowId ?? manager.activeSession?.windowId;
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
            targetId: resolved.targetId ?? null,
            session: manager.activeSession,
            preview,
            ...(preview.image ? { image: preview.image } : {}),
          };
        }
        // action === "start"
        // Explicit start is the only path that may attach/reopen a target and
        // clear the user pause. Layout and activation stay opt-in: observation,
        // previews and ordinary background work never move or stage a window.
        const sessionSettings = liveSettings();
        const denied = deniedAppMatch(args.appName, sessionSettings?.deniedApps ?? []);
        if (denied) {
          const refused = new Error(
            `This app is on the denied list in Settings → Computer Use: ${denied}`,
          );
          refused.code = "APP_DENIED";
          throw refused;
        }
        // Full control hides unrelated apps by default; an explicit argument
        // always wins, so a caller can opt out for one session.
        const hideOtherApps =
          args.hideOtherApps === undefined
            ? sessionSettings?.controlMode === "full"
            : args.hideOtherApps;
        const startArgs = resolveTargetArgs(args);
        const shouldPreview = args.preview !== false && startArgs.windowId !== undefined;
        const embedded = viewIsEmbedded(exec);
        const started = await manager.startVisualSession({
          windowId: startArgs.windowId,
          pid: startArgs.pid,
          appName: args.appName,
          label: args.label,
          halo: args.halo,
          explicit: true,
          authorizeForeground: args.authorizeForeground === true,
          interactive: args.interactive === true,
          dockDsh: args.dockDsh === true,
          splitScreen: args.splitScreen === true,
          bringOnStage: args.bringOnStage === true,
          hideOtherApps,
          force: args.resume === true,
          warmCapture: !shouldPreview,
          nativePreview: args.nativePreview !== false,
          // Native preview is the primary surface. In a connected Harness chat
          // the client fallback card covers capture failures, so do not paint a
          // second native capsule unless the caller explicitly asks for one.
          capsule: args.capsule === true ? true : embedded ? false : args.capsule !== false,
          cursor: args.cursor !== false,
        });
        let preview;
        if (shouldPreview) {
          preview = await capturePreviewObject(ctx, exec, manager, {
            windowId: startArgs.windowId,
            targetId: started.targetId ?? startArgs.targetId,
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
        "List on-screen macOS windows (windowId, pid, app, title, bounds, frontmost) and optionally all running applications. Read-only, so it still works after a stop. ok:false carries the engine's error/message (cancelled, unauthorized, unreachable); ok:true with count:0 means there are genuinely no matching windows.",
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
        // Read-only: allowed after a user stop, because the gate refuses input,
        // not the ability to look at the desktop.
        const winRes = await readExec(["windows"], exec);
        if (winRes?.ok !== true) {
          // "No windows" and "the query failed" are different answers. Dropping
          // the error here used to show an empty list for a cancelled,
          // unauthorized or unreachable query, so the model kept re-planning an
          // action that had never run.
          return {
            ok: false,
            error: winRes?.error ?? "windows_unavailable",
            message: winRes?.message ?? "window enumeration failed",
            frontmost: winRes?.frontmost ?? null,
            count: 0,
            windows: [],
            ...(winRes?.cancelled !== undefined ? { cancelled: winRes.cancelled } : {}),
            ...(winRes?.outcomeUnknown !== undefined ? { outcomeUnknown: winRes.outcomeUnknown } : {}),
            ...(winRes?.actionReplaySafe !== undefined ? { actionReplaySafe: winRes.actionReplaySafe } : {}),
            ...(winRes?.nextSteps !== undefined ? { nextSteps: winRes.nextSteps } : {}),
          };
        }
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
        let appsError;
        if (args.includeApps === true) {
          const appRes = await readExec(["apps"], exec);
          if (appRes?.ok === true) {
            apps = appRes.apps ?? [];
          } else {
            apps = [];
            appsError = {
              error: appRes?.error ?? "apps_unavailable",
              message: appRes?.message ?? "application enumeration failed",
            };
          }
        }
        return {
          ok: true,
          frontmost: winRes.frontmost ?? null,
          count: windows.length,
          windows,
          ...(apps !== undefined ? { apps } : {}),
          ...(appsError ? { appsError } : {}),
        };
      },
    });

    // 4. cu_launch
    register({
      name: "cu_launch",
      description:
        "Launch an application by bundle ID or .app path. Default is a background launch: the app may create its window without taking focus. Set background:false only with explicit user authorization to foreground it, or use bringOnStage with a windowId.",
      parameters: {
        app: {
          type: "string",
          description: "Bundle ID or full .app path to launch.",
        },
        background: {
          type: "boolean",
          description: "Launch without activating the app (default true). background:false requires authorizeForeground:true.",
        },
        authorizeForeground: {
          type: "boolean",
          description: "Explicit user authorization to foreground the launched app or activate a window.",
        },
        windowId: {
          type: "integer",
          description: "Optional windowId; activated only when background:false or bringOnStage:true.",
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
        const background = args.background !== false;
        if (!background) {
          const blocked = foregroundRefusal({ ...args, foreground: true });
          if (blocked) {
            return {
              ...blocked,
              message: "Background launch is the default. Foregrounding the application needs explicit user authorization (foreground:true via authorizeForeground:true was not provided).",
            };
          }
        }
        const results = {};
        if (args.app) {
          manager.writeActivity(`启动应用 ${args.app}${background ? "（后台）" : "（前台）"}`);
          results.launch = await manager.exec(
            ["launch", "--app", String(args.app), ...(background ? ["--background"] : [])],
            exec?.signal,
          );
          if (results.launch?.ok !== true) {
            return { ...results.launch, ok: false, error: results.launch?.error ?? "launch_failed", ...results };
          }
        }
        if (args.windowId !== undefined && (!background || args.bringOnStage === true)) {
          if (background && args.authorizeForeground !== true) {
            return {
              ok: false,
              error: "foreground_requires_authorization",
              message: "bringOnStage changes the visible desktop; pass authorizeForeground:true only after explicit user permission.",
              actionReplaySafe: true,
              stopRetrying: true,
            };
          }
          const cmd = args.bringOnStage ? "stage" : "activate";
          manager.writeActivity(`激活窗口 #${args.windowId}`);
          results.window = await manager.exec([cmd, "--window", String(args.windowId)], exec?.signal);
          if (results.window?.ok !== true) {
            return { ...results.window, ok: false, error: results.window?.error ?? "activate_failed", ...results };
          }
        }
        if (args.windowId !== undefined && background && !args.bringOnStage) {
          results.window = { ok: true, keptInBackground: true, windowId: args.windowId };
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
          background,
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
        "Inspect the Accessibility (AX) element tree of a target application/window. Returns refs and compact deltas. Node @x,y frames are global screen logical points (top-left origin), not window-relative; do not add the window origin. Screenshot pixels instead map to screen = screenshot origin + pixel / scale.",
      parameters: {
        targetId: TARGET_ID_PARAM,
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
        let args = resolveTargetArgs(rawArgs);
        if (args.pid === undefined || args.pid === null) {
          return {
            ok: false,
            error: "target_required",
            message: "cu_snapshot needs a pid or a target returned by cu_session/cu_status",
          };
        }
        const target = ensureActionTarget(args, { makePrimary: false, readOnly: true });
        if (target) args = { ...args, targetId: target.id };
        const owner = ownerOf(exec);
        // Record the target frame with the observation. A coordinate click later
        // compares it with the live frame and refuses after a move or resize.
        const geometry = await currentWindowInfo(args.pid, args.windowId, exec, owner, args.targetId);
        const recordOptions = {
          full: args.full === true,
          owner,
          targetId: args.targetId ?? null,
          bounds: geometry?.bounds ?? null,
        };
        // R2: nodes AND elementTokens must come from ONE retained observation.
        // Running an engine snapshot first and then a worker observation used to
        // splice two traversals together by path; a control that slid into the
        // same path between them could be displayed as A while the token hit B.
        if (manager._axWorkerAllowed && typeof manager.startAXWorker === "function" && args.pid !== undefined) {
          try {
            await manager.startAXWorker(Number(args.pid), args.windowId, args.targetId ?? null);
            const observation = await manager.axObserve(target.id);
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
              const recorded = manager.recordSnapshot(args.pid, args.windowId, raw, recordOptions);
              const observationId =
                manager.axBinding?.(target.id)?.observationId ??
                manager._axBinding?.observationId ??
                null;
              if (observationId) {
                manager.snapshotObservations = manager.snapshotObservations ?? new Map();
                manager.snapshotObservations.set(recorded.snapshotId, observationId);
                // Bound history: this is a session-local provenance cache, not
                // an unbounded audit log of every observation ever taken.
                if (manager.snapshotObservations.size > 64) {
                  manager.snapshotObservations.delete(manager.snapshotObservations.keys().next().value);
                }
              }
              const tokenMap = manager.axTokensFor?.(target.id) ?? manager.axTokens;
              const elementTokens = tokenMap ? Object.fromEntries(tokenMap) : undefined;
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
            manager.clearAXBinding?.(target.id);
            if (!manager.clearAXBinding) {
              manager._axBinding = null;
              manager.axTokens?.clear?.();
            }
          }
        }
        const argv = buildCommandArgv("snapshot", args, manager);
        const raw = await readExec(argv, exec, { targetId: args.targetId ?? null });
        if (!raw?.ok) {
          if (["window_gone", "target_mismatch"].includes(String(raw?.error ?? "")) && args.targetId) {
            manager.invalidateTarget(args.targetId, raw.error);
          }
          return raw;
        }
        const recorded = manager.recordSnapshot(args.pid, args.windowId, raw, recordOptions);
        if (target) target.updatedAt = Date.now();
        return { ok: true, ...recorded, targetId: args.targetId ?? null };
      },
    });

    // 6. cu_screenshot
    register({
      name: "cu_screenshot",
      description:
        "Capture a screenshot of a specific window (even in background) or the full screen, returning an inline preview image and coordinate scaling metadata.",
      parameters: {
        targetId: TARGET_ID_PARAM,
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
          targetId: args.targetId ?? null,
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
        const node = manager.resolveRefProvenance(args.pid, args.ref, args.windowId, args.targetId ?? null);
        if (node && Number.isFinite(node.cx) && Number.isFinite(node.cy)) {
          return { x: node.cx, y: node.cy };
        }
      }
      return null;
    };

    // Snapshot provenance for a ref: role/title for the overlay label.
    const clickTarget = (args) => {
      if (!args.ref || args.pid === undefined) return {};
      return manager.resolveRefProvenance(args.pid, args.ref, args.windowId, args.targetId ?? null) ?? {};
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
            "snapshot",
            { pid: args.pid, windowId: args.windowId, noActions: true, targetId: args.targetId },
            manager,
          );
          const baseline =
            typeof manager.cachedFingerprint === "function"
              ? manager.cachedFingerprint(args.pid, args.windowId, ownerOf(exec), args.targetId ?? null)
              : null;
          let snapRaw = await manager.exec(snapArgv, exec?.signal, {
            ...(args.targetId ? { targetId: args.targetId } : {}),
          });
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
            const next = await manager.exec(snapArgv, exec?.signal, {
              ...(args.targetId ? { targetId: args.targetId } : {}),
            });
            if (!next?.ok) break;
            reads += 1;
            snapRaw = next;
            changed = snapshotFingerprint(snapRaw) !== baseline;
          }
          const observation = manager.recordSnapshot(args.pid, args.windowId, snapRaw, {
            full: false,
            owner: ownerOf(exec),
            targetId: args.targetId ?? null,
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
            targetId: args.targetId ?? null,
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

    // A live target names the window being driven. The manager resolves the
    // pid+window pair atomically and returns a targetId so every snapshot,
    // queue and stop gate is scoped to the same window incarnation.
    const resolveTargetArgs = (args) => {
      if (typeof manager.resolveTargetArgs === "function") return manager.resolveTargetArgs(args);
      // Compatibility with a lightweight test/client manager that only exposes
      // the legacy activeSession view.
      const session = manager.activeSession;
      if (!session) return args;
      const hasPid = args.pid !== undefined && args.pid !== null;
      const hasWindow = args.windowId !== undefined && args.windowId !== null;
      if (!hasPid && !hasWindow && session.pid !== undefined) {
        return { ...args, pid: session.pid, windowId: session.windowId ?? undefined };
      }
      if (hasPid && !hasWindow && Number(args.pid) === Number(session.pid)) {
        return { ...args, windowId: session.windowId ?? undefined };
      }
      return args;
    };

    // The chat that asked for a tool call. Observation baselines and cursor
    // provenance are per chat; two chats on the same window must not share one.
    const ownerOf = (exec) =>
      typeof exec?.agent?.id === "string" ? exec.agent.id : null;

    // Read-only commands (windows/snapshot/expect/shot) keep working after a
    // stop: the input gate must refuse typing and clicking, not make the app
    // unreadable. `control` bypasses the gate and generation check only.
    const readExec = (argv, exec, options = {}) =>
      manager.exec(argv, exec?.signal, {
        control: true,
        ...(typeof options.targetId === "string" ? { targetId: options.targetId } : {}),
      });

    // The window's frame right now. Used to refuse a coordinate that is outside
    // the target window, and to notice that the window moved after the
    // observation a coordinate was read from. Returns null when the listing
    // cannot prove anything, in which case the engine's own preflight decides.
    const currentWindowInfo = async (pid, windowId, exec, owner, targetId = null) => {
      let listing;
      try {
        listing = await readExec(["windows"], exec, { targetId });
      } catch {
        return null;
      }
      if (listing?.ok !== true || !Array.isArray(listing.windows)) return null;
      const wantWindow = windowId !== undefined && windowId !== null ? Number(windowId) : null;
      const wantPid = pid !== undefined && pid !== null ? Number(pid) : null;
      const win =
        listing.windows.find((w) => (wantWindow !== null ? Number(w.windowId) === wantWindow : false)) ??
        (wantWindow === null && wantPid !== null
          ? listing.windows.find((w) => Number(w.pid) === wantPid)
          : undefined);
      if (!win?.bounds) return null;
      const bounds = {
        x: Number(win.bounds.x),
        y: Number(win.bounds.y),
        width: Number(win.bounds.width),
        height: Number(win.bounds.height),
      };
      if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
      const observed = manager.snapshotGeometry?.(Number(win.pid), Number(win.windowId), owner, targetId);
      return {
        windowId: Number(win.windowId),
        pid: Number(win.pid),
        app: String(win.app ?? ""),
        title: String(win.title ?? ""),
        bounds,
        observedBounds: observed?.bounds ?? null,
        observedAt: observed?.takenAt ?? null,
      };
    };

    // A coordinate click carries no identity of its own. Refuse one that is not
    // inside the target window's current frame, and one whose frame changed
    // since the observation it was read from: "clicked the same numbers again"
    // is not evidence that the same control is still there.
    const guardExplicitPoint = async (args, exec) => {
      const windowId = args.windowId ?? manager.activeSession?.windowId;
      const pid = args.pid ?? manager.activeSession?.pid;
      if (windowId === undefined && pid === undefined) return null;
      const info = await currentWindowInfo(pid, windowId, exec, ownerOf(exec), args.targetId ?? null);
      if (!info) return null;
      const { bounds } = info;

      if (Number.isFinite(Number(args.windowX)) && Number.isFinite(Number(args.windowY))) {
        args.x = bounds.x + Number(args.windowX);
        args.y = bounds.y + Number(args.windowY);
      }

      if (!Number.isFinite(Number(args.x)) || !Number.isFinite(Number(args.y))) return null;
      let point = { x: Number(args.x), y: Number(args.y) };
      let inside =
        point.x >= bounds.x &&
        point.x < bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y < bounds.y + bounds.height;
      if (!inside && point.x >= 0 && point.x < bounds.width && point.y >= 0 && point.y < bounds.height) {
        const candidateX = bounds.x + point.x;
        const candidateY = bounds.y + point.y;
        if (candidateX >= bounds.x && candidateX < bounds.x + bounds.width && candidateY >= bounds.y && candidateY < bounds.y + bounds.height) {
          args.x = candidateX;
          args.y = candidateY;
          point = { x: candidateX, y: candidateY };
          inside = true;
        }
      }
      if (!inside) {
        manager.showActionFailure?.("坐标越界");
        return {
          ok: false,
          error: "point_outside_target_window",
          message:
            `(${point.x}, ${point.y}) is outside ${info.app} window ${info.windowId} ` +
            `(${bounds.x}, ${bounds.y}, ${bounds.width}x${bounds.height}); refusing to click another app`,
          point,
          target: info,
          actionReplaySafe: true,
          hint: "re-observe the window (cu_windows / cu_snapshot) and aim inside its current frame",
        };
      }
      const before = info.observedBounds;
      const changed =
        before &&
        (Math.abs(before.x - bounds.x) > 1 ||
          Math.abs(before.y - bounds.y) > 1 ||
          Math.abs(before.width - bounds.width) > 1 ||
          Math.abs(before.height - bounds.height) > 1);
      if (changed) {
        manager.showActionFailure?.("窗口已移动");
        return {
          ok: false,
          error: "window_geometry_changed",
          message:
            `${info.app} window ${info.windowId} moved or resized after the last observation; ` +
            "the old coordinates no longer name the control they were read from",
          point,
          target: info,
          previousBounds: before,
          actionReplaySafe: true,
          hint: "call cu_snapshot again and derive coordinates from the new observation",
        };
      }
      return null;
    };

    // Publish adapter phases into the unified action-event log. The tools still
    // own their immediate overlay commands; the log is the auditable state that
    // native rendering (and the final verifier) consume.
    const actionTargetFor = (args) => {
      const pid = args.pid ?? manager.activeSession?.pid;
      if (pid === undefined) return null;
      const target = manager.targetForKey?.(args.targetId ?? manager.currentTargetKey);
      return {
        ...(args.targetId ? { targetId: args.targetId } : {}),
        pid: Number(pid),
        windowId: args.windowId ?? manager.activeSession?.windowId ?? null,
        targetGeneration: Number(target?.generation ?? manager.sessionGeneration ?? 0),
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
    const execWithNativeEvents = (argv, exec, actionId, kind, options = {}) =>
      manager.exec(argv, exec?.signal, {
        eventsVersion: 1,
        ...(options.control === true ? { control: true } : {}),
        ...(options.targetId ? { targetId: options.targetId } : {}),
        eventContext: {
          sessionId: manager.sessionId ?? "no-session",
          actionId,
          targetGeneration: Number(
            manager.targetForKey?.(options.targetId ?? null)?.generation ?? manager.sessionGeneration ?? 0,
          ),
          ...(options.targetId ? { targetId: options.targetId } : {}),
        },
        onEvent: (event) => {
          try { manager.publishActionEvent?.(event); } catch { /* never break the action */ }
        },
      });

    // Refuse a ref that provably belongs to an observation the caller has moved
    // past. The engine already rejects a path whose role/title changed; this
    // catches the case where a *same-named* control slid into that path, which
    // path+role+title cannot tell apart.
    const staleSnapshotResult = (args, exec) => {
      if (args.snapshotId === undefined || args.snapshotId === null) return null;
      if (args.ref === undefined || args.pid === undefined) return null;
      const mismatch = manager.refSnapshotMismatch?.(
        Number(args.pid), String(args.ref), args.windowId, args.snapshotId,
        ownerOf(exec), args.targetId ?? null,
      );
      if (!mismatch) return null;
      return {
        ok: false,
        error: "stale_snapshot",
        message: mismatch,
        currentSnapshotId: manager.currentSnapshotId?.(Number(args.pid), args.windowId, args.targetId ?? null) ?? null,
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
        const res = await manager.exec(argv, exec?.signal, {
          control: true,
          ...(args.targetId ? { targetId: args.targetId } : {}),
        });
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
      const shouldPreview = args.preview === true || (args.preview !== false && manager?.sessionAutoPreview && args.windowId !== undefined);
      const post = await runPostAction({ ...args, preview: shouldPreview }, exec);
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

    /**
     * Turn an engine acknowledgement into an honest action outcome.
     *
     * `ok` from the engine means it accepted/dispatched an event. It does not
     * mean the target changed. A pid-targeted event that produced no observable
     * change is reported as `effect_not_verified` (not success) and is marked
     * replay-unsafe; the caller must re-observe or ask the user for foreground
     * permission rather than retrying the same background dispatch.
     */
    const decorateEvidence = (args, result, post = {}) => {
      const out = { ...result, ...post };
      const boundary = capabilityBoundary(result);
      if (boundary && !out.capability) Object.assign(out, boundary);
      if (result?.ok === false) return out;
      const foreground = args.foreground === true || Boolean(manager?.isForegroundAuthorized?.(args.targetId)) || result?.activated === true;
      const explicitVerified =
        post?.verification?.matched === true ||
        result?.verified === true ||
        result?.landed === true;
      if (foreground) {
        return {
          ...out,
          dispatchMode: "foreground",
          foregroundAuthorized: true,
          verified: explicitVerified,
          outcome: explicitVerified ? "verified" : "dispatched_unverified",
          affectedUserFocus: true,
        };
      }
      const via = String(result?.via ?? "");
      const pidDispatch = via.includes("pid-events");
      const changed = post?.observation?.changed;
      if (explicitVerified) {
        return { ...out, verified: true, dispatchMode: "background", effectEvidence: "explicit_postcondition", outcome: "verified" };
      }
      if (pidDispatch) {
        // A raw PID event is never success on its own. Even if an unrelated
        // observation changed, only an explicit post-condition names the effect
        // the caller meant. This is the rule that stops "events sent" from
        // becoming "action succeeded" in the model's view.
        const noChange = changed === false;
        return {
          ...out,
          ok: false,
          verified: false,
          dispatchMode: "background",
          dispatchOnly: true,
          dispatched: true,
          error: "effect_not_verified",
          message:
            (noChange
              ? "The background event was dispatched, but the target's accessibility state did not change. "
              : "The background event was dispatched, but no explicit post-condition verified its effect. ") +
            "This is not a successful action; do not replay it blindly. Re-observe, add an explicit expect, " +
            "or ask the user before using a foreground action. " +
            "后台事件只能算派发；未通过显式后置条件验证前，不要当作成功，也不要盲目重放。",
          actionReplaySafe: false,
          stopRetrying: true,
          capability: "background_effect_unverified",
          outcome: changed === true ? "dispatched_observed_unverified" : "dispatched_no_effect",
        };
      }
      if (changed === true) {
        return {
          ...out,
          verified: false,
          dispatchMode: "background",
          effectEvidence: "ax_observation_changed",
          outcome: "dispatched_observed",
          warning:
            "目标界面发生了变化，但没有明确后置条件证明这是业务结果；不要直接把“树动了”当成成功。",
        };
      }
      if (post?.verification && post.verification.matched !== true) {
        return {
          ...out,
          verified: false,
          dispatchMode: "background",
          outcome: "dispatched_unverified",
          actionReplaySafe: false,
          warning:
            post.warning ||
            "The action was dispatched but its explicit post-condition was not met; re-observe instead of replaying it.",
        };
      }
      return {
        ...out,
        verified: false,
        dispatchMode: "background",
        dispatchOnly: pidDispatch,
        outcome: "dispatched_unverified",
        actionReplaySafe: false,
        warning:
          "The event was dispatched but no post-condition verified its effect. Do not retry the same dispatch; " +
          "re-observe, use an explicit expect, or report that the effect is unverified.",
      };
    };

    // 7. cu_expect — the verification primitive the mutating tools embed, also
    // exposed on its own for flows that must confirm a state before acting.
    register({
      name: "cu_expect",
      description:
        "Assert what the app actually did by polling its accessibility tree (no screenshot). Waits until the control matches, the timeout runs out, or the control disappears. Use after an action whose effect matters, instead of trusting ok:true.",
      parameters: {
        targetId: TARGET_ID_PARAM,
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
        let args = resolveTargetArgs(rawArgs);
        const target = ensureActionTarget(args);
        if (target) args = { ...args, targetId: target.id };
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
        const result = await execWithNativeEvents(argv, exec, expectActionId, "expect", {
          control: true,
          ...(args.targetId ? { targetId: args.targetId } : {}),
        });
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
        "Click a control in a macOS app by snapshot ref (e.g. 'e12') or coordinates (x, y). Runs in background by default without moving the user's mouse or stealing focus, and returns an automatic AX delta observation. Prefer a ref/AXPress when the control has a reliable ref. Explicit coordinates are checked against the target window's current frame: point_outside_target_window and window_geometry_changed are refusals, not retries — re-observe before aiming again. ok:true with observation.changed:false means the event was dispatched but nothing moved; do not repeat the same click blindly.",
      parameters: {
        targetId: TARGET_ID_PARAM,
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
        windowX: {
          type: "number",
          description: "Target window-relative X coordinate in logical points (auto-converts to screen X).",
        },
        windowY: {
          type: "number",
          description: "Target window-relative Y coordinate in logical points (auto-converts to screen Y).",
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
          description: "Bring window to front and use a foreground click (default false = background). Requires authorizeForeground:true.",
        },
        authorizeForeground: {
          type: "boolean",
          description:
            "Explicit user authorization for an action that takes focus/real input. Without both this and foreground:true the tool refuses before sending input.",
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
        let args = resolveTargetArgs(rawArgs);
        const target = ensureActionTarget(args);
        if (target) args = { ...args, targetId: target.id };
        manager.assertCanAct("cu_click", exec?.signal, args.targetId ?? null);
        const foregroundBlocked = foregroundRefusal(args);
        if (foregroundBlocked) return foregroundBlocked;
        const stale = staleSnapshotResult(args, exec);
        if (stale) {
          manager.showActionFailure?.("点击");
          return stale;
        }
        const outside = await guardExplicitPoint(args, exec);
        if (outside) return outside;
        // Identity path: act on the retained object, but ONLY when the whole
        // identity chain (app, window, worker generation, session generation,
        // observation) still matches the request. A mismatch is an explicit
        // refusal — never a path click against whatever now sits at that ref.
        if (
          args.ref !== undefined &&
          manager._axWorkerAllowed &&
          typeof manager.axClick === "function" &&
          manager.axTokenUsableFor?.(args) !== false
        ) {
          const expectedObservationId = args.snapshotId === undefined || args.snapshotId === null
            ? undefined
            : manager.snapshotObservations?.get(Number(args.snapshotId));
          const bound = manager.resolveBoundToken
            ? manager.resolveBoundToken(args.ref, args, expectedObservationId)
            : (() => { const t = manager.axTokenFor(args.ref, args.targetId, args); return t ? { ok: true, token: t } : { ok: false }; })();
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
            const fg = args.foreground === true || manager.isForegroundAuthorized(args.targetId);
            const result = await manager.axClick(bound.token, "AXPress", args.targetId ?? null, {
              button,
              count,
              foreground: fg,
            });
            if (result?.ok === true) {
              publishPhase(actionId, "click", "dispatched", { target: eventTarget, label, ...(point ? { point } : {}) });
              if (manager._visualFeedbackActive?.()) manager.showClickFeedback(point, label);
              // Keep the caller's evidence contract: still observe/preview after a
              // token-dispatched click, exactly like the one-shot path.
              const post = await afterAction({ ...args, observe: args.observe }, exec);
              if (args.expect && post?.verification?.matched === true) {
                publishPhase(actionId, "click", "verified", { target: eventTarget, label,
                  verification: { matched: true, evidenceRef: "expect" } });
              } else {
                publishPhase(actionId, "click", "unverified", { target: eventTarget, label });
              }
              return decorateEvidence(
                args,
                { ...result, via: "ax-worker-token" },
                { ...post, via: "ax-worker-token" },
              );
            }
            // An uncertain/failed retained dispatch must NOT be replayed by path.
            publishPhase(actionId, "click", "failed", { target: eventTarget, label, reason: String(result?.error ?? "refused") });
            return { ...result, via: "ax-worker-token", actionReplaySafe: false };
          }
          if (manager.axTokenUsableFor?.(args) !== false && manager.axTokenFor?.(args.ref, args.targetId ?? null, args)) {
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
        if (args.ref !== undefined) {
          const foreignToken = manager.foreignAXTokenFor?.(args.ref, args);
          if (foreignToken) {
            manager.showActionFailure?.("目标已变化");
            return {
              ok: false,
              error: "identity_unproven",
              message: `ref ${args.ref} belongs to retained target ${foreignToken}, not the requested target; call cu_snapshot for this target`,
              targetId: args.targetId ?? null,
              actionReplaySafe: false,
              hint: "call cu_snapshot again for this target and use a ref from that observation",
            };
          }
        }
        if (
          config.autoSession !== false &&
          manager._visualStarted !== true &&
          args.windowId !== undefined &&
          !(target?.stopped || target?.gateClosed) &&
          viewIsEmbedded(exec)
        ) {
          // Auto-session: when an action targets a window and the agent has not
          // opened a session yet, raise the same target-scoped native preview
          // Codex shows. It is the viewer; no in-page duplicate card is needed.
          await manager.startVisualSession({
            windowId: args.windowId,
            pid: args.pid,
            halo: false,
            dockDsh: false,
            splitScreen: false,
            nativePreview: true,
            capsule: false,
            cursor: true,
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
        if (manager._visualFeedbackActive?.()) {
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
        const result = await execWithNativeEvents(argv, exec, actionId, "click", {
          ...(args.targetId ? { targetId: args.targetId } : {}),
        });
        const actionMs = Date.now() - actionStarted;
        if (!result?.ok) {
          // Refused (disabled control, stale ref, user pause, missing window):
          // no ripple, no success chip, and never a `dispatched` event.
          publishPhase(actionId, "click", "failed", {
            target: eventTarget,
            label,
            reason: String(result?.error ?? "refused"),
          });
          if (manager._visualFeedbackActive?.()) manager.showActionFailure(label);
          return result;
        }
        const landedEvent = landedClickPoint(args, result);
        publishPhase(actionId, "click", "dispatched", {
          target: eventTarget,
          label,
          ...(landedEvent ? { point: landedEvent } : {}),
        });
        // Dispatched and accepted by the engine: now the click is real.
        if (manager._visualFeedbackActive?.()) {
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
        const decorated = decorateEvidence(args, result, post);
        return {
          ...decorated,
          timings: { actionMs, ...(post.timings ?? {}), totalMs: Date.now() - began },
        };
      },
    });

    // Drag is an explicit gesture: background dispatch is not proof that a
    // canvas accepted it, and foreground input is never an implicit fallback.
    const DRAG_POINT = {
      type: "object", additionalProperties: false,
      properties: { x: { type: "number" }, y: { type: "number" } },
    };
    register({
      name: "cu_drag",
      description: "Drag from one observed point to another within the same target window, in logical screen coordinates. Background by default; foreground requires explicit authorization. Dispatch alone does not verify the result: inspect the new frame or provide an expect condition. Never blindly repeat an unverified drag.",
      parameters: {
        targetId: TARGET_ID_PARAM,
        pid: { type: "integer", description: "Target application pid." },
        windowId: { type: "integer", description: "Target window ID." },
        from: { ...DRAG_POINT, description: "Start point in logical screen coordinates." },
        to: { ...DRAG_POINT, description: "End point in logical screen coordinates." },
        foreground: { type: "boolean", description: "Use real mouse and activate target; requires authorizeForeground." },
        authorizeForeground: { type: "boolean", description: "User explicitly authorized interruption and real mouse input." },
        observe: { type: "boolean", description: "Observe the target after dispatch (default true)." },
        expect: EXPECT_PARAM,
        preview: { type: "boolean", description: "Attach a target window preview after dispatch." },
      },
      output: { schema: { type: "json" }, render: renderWithOptionalImage() },
      isConcurrencySafe: () => false,
      async execute(rawArgs, exec) {
        const began = Date.now();
        let args = resolveTargetArgs(rawArgs);
        const target = ensureActionTarget(args);
        if (target) args = { ...args, targetId: target.id };
        manager.assertCanAct("cu_drag", exec?.signal, args.targetId ?? null);
        const blocked = foregroundRefusal(args);
        if (blocked) return blocked;
        const points = [args.from?.x, args.from?.y, args.to?.x, args.to?.y];
        if (!points.every((value) => typeof value === "number" && Number.isFinite(value)) || !args.pid || !args.windowId) {
          return { ok: false, error: "invalid_drag_target", message: "drag requires a target pid, windowId and finite from/to coordinates", actionReplaySafe: true };
        }
        const info = await currentWindowInfo(args.pid, args.windowId, exec, ownerOf(exec), args.targetId ?? null);
        if (!info) return { ok: false, error: "target_geometry_unavailable", message: "Cannot verify the target window bounds; no drag was sent.", actionReplaySafe: true };
        if (info.pid !== Number(args.pid)) return { ok: false, error: "target_mismatch", message: "The window belongs to a different process; no drag was sent.", actionReplaySafe: true };
        for (const point of [args.from, args.to]) {
          const refusal = await guardExplicitPoint({ ...args, ...point }, exec);
          if (refusal) return refusal;
        }
        const actionId = manager.nextActionId?.("drag") ?? `drag-${Date.now()}`;
        const eventTarget = actionTargetFor(args);
        const label = "拖拽";
        publishPhase(actionId, "drag", "accepted", { target: eventTarget, label });
        manager.writeActivity(label);
        const actionStarted = Date.now();
        const result = await execWithNativeEvents(buildCommandArgv("drag", args, manager), exec, actionId, "drag", { targetId: args.targetId ?? null });
        const actionMs = Date.now() - actionStarted;
        if (!result?.ok) {
          publishPhase(actionId, "drag", "failed", { target: eventTarget, label, reason: String(result?.error ?? "refused") });
          return result;
        }
        publishPhase(actionId, "drag", "dispatched", { target: eventTarget, label });
        const post = await afterAction(args, exec);
        publishPhase(actionId, "drag", post?.verification?.matched === true ? "verified" : "unverified", { target: eventTarget, label });
        return { ...decorateEvidence(args, result, post), actionReplaySafe: false, timings: { actionMs, ...(post.timings ?? {}), totalMs: Date.now() - began } };
      },
    });

    // 8b. cu_paint_plan — compile an image into a layered stroke plan.
    register({
      name: "cu_paint_plan",
      description:
        "Compile a reference image into a layered posterized stroke plan (palette + horizontal brush runs) plus a preview PNG. Read-only: nothing is drawn. The plan is the input for cu_paint, which executes one layer at a time after the app's brush colour is set.",
      parameters: {
        imagePath: { type: "string", description: "Absolute path to a PNG/JPEG reference image." },
        x: { type: "number", description: "Left edge of the drawing area in logical screen coordinates." },
        y: { type: "number", description: "Top edge of the drawing area." },
        width: { type: "number", description: "Drawing area width in points (>= 40)." },
        height: { type: "number", description: "Drawing area height in points (>= 40)." },
        grid: { type: "integer", description: "Sampling grid (24-400, default 150)." },
        colors: { type: "integer", description: "Palette size (2-24, default 10)." },
        planPath: { type: "string", description: "Where to write the plan JSON (default: next to the image)." },
        previewPath: { type: "string", description: "Optional path for the posterized preview PNG." },
        pid: { type: "integer", description: "Optional target pid: the rect must lie inside its window." },
        windowId: { type: "integer", description: "Optional target window: the rect must lie inside it." },
      },
      output: { schema: { type: "json" }, render: renderWithOptionalImage() },
      isConcurrencySafe: () => true,
      async execute(rawArgs, exec) {
        const began = Date.now();
        const args = rawArgs ?? {};
        const imagePath = String(args.imagePath ?? "");
        if (!imagePath.startsWith("/")) {
          return { ok: false, error: "image_path_must_be_absolute", message: "pass an absolute imagePath", actionReplaySafe: true };
        }
        if (!existsSync(imagePath)) {
          return { ok: false, error: "image_missing", message: `no file at ${imagePath}`, actionReplaySafe: true };
        }
        const rect = [args.x, args.y, args.width, args.height].map(Number);
        if (!rect.every((value) => Number.isFinite(value)) || rect[2] < 40 || rect[3] < 40) {
          return { ok: false, error: "invalid_rect", message: "x, y, width and height are required (width/height >= 40)", actionReplaySafe: true };
        }
        const grid = Math.max(24, Math.min(400, Number(args.grid ?? 150)));
        const colors = Math.max(2, Math.min(24, Number(args.colors ?? 10)));
        if (args.pid !== undefined && args.windowId !== undefined) {
          const info = await currentWindowInfo(Number(args.pid), Number(args.windowId), exec, ownerOf(exec), null);
          if (!info) {
            return { ok: false, error: "target_geometry_unavailable", message: "cannot read the target window bounds", actionReplaySafe: true };
          }
          const inside =
            rect[0] >= info.bounds.x &&
            rect[1] >= info.bounds.y &&
            rect[0] + rect[2] <= info.bounds.x + info.bounds.width &&
            rect[1] + rect[3] <= info.bounds.y + info.bounds.height;
          if (!inside) {
            return { ok: false, error: "rect_outside_window", message: "the drawing rect must lie inside the target window", actionReplaySafe: true };
          }
        }
        const argv = [
          "drawplan",
          "--image", imagePath,
          "--rect", rect.join(","),
          "--grid", String(grid),
          "--colors", String(colors),
        ];
        if (args.planPath) argv.push("--out", String(args.planPath));
        if (args.previewPath) argv.push("--preview", String(args.previewPath));
        const result = await execWithNativeEvents(argv, exec, manager.nextActionId?.("paint-plan") ?? `paint-plan-${Date.now()}`, "expect", {});
        if (result?.ok !== true) return result;
        let imageRef = null;
        if (result.preview) {
          try {
            const bytes = readFileSync(result.preview);
            const saved = await trySaveImageAttachment(ctx, exec, new Uint8Array(bytes), "paint-plan-preview.png");
            imageRef = saved.image ?? null;
          } catch {
            imageRef = null;
          }
        }
        return {
          ...result,
          ...(imageRef ? { image: imageRef } : {}),
          actionReplaySafe: true,
          timings: { totalMs: Date.now() - began },
        };
      },
    });

    // 8c. cu_paint — stream one plan layer (or a raw stroke file) as paced mouse strokes.
    register({
      name: "cu_paint",
      description:
        "Paint one layer of a cu_paint_plan file, or a raw stroke JSON file, as a single paced stroke stream in one native call (no per-stroke LLM round trip). Set the app's brush colour to the layer hex first. Dispatch is not verification: inspect the frame afterwards. Uses the real pointer by default because browser canvases ignore PID-targeted drags; pass authorizeForeground after the user agrees. Use background only for apps known to accept background drags.",
      parameters: {
        targetId: TARGET_ID_PARAM,
        pid: { type: "integer", description: "Target application pid." },
        windowId: { type: "integer", description: "Target window ID; every stroke point must lie inside it." },
        planPath: { type: "string", description: "Plan JSON written by cu_paint_plan." },
        layerIndex: { type: "integer", description: "Which plan layer to draw (its index field, not array position)." },
        strokesFile: { type: "string", description: "Raw strokes JSON: {\"strokes\":[[[x,y],…],…]} with absolute coordinates." },
        paceMs: { type: "integer", description: "Delay between pointer events in ms (default 13; below ~10 canvas apps drop strokes)." },
        inset: { type: "number", description: "Plan mode only: horizontal inset as a fraction of a cell (default 0.13)." },
        foreground: { type: "boolean", description: "Use the real pointer and focus the target (default true)." },
        authorizeForeground: { type: "boolean", description: "User explicitly authorized interruption and real pointer input." },
        background: { type: "boolean", description: "Opt into PID-targeted drags instead of the real pointer. Browser canvases usually ignore these." },
        dryRun: { type: "boolean", description: "Validate the layer geometry without sending any events." },
      },
      output: { schema: { type: "json" }, render: renderWithOptionalImage() },
      isConcurrencySafe: () => false,
      async execute(rawArgs, exec) {
        const began = Date.now();
        let args = resolveTargetArgs(rawArgs);
        const target = ensureActionTarget(args);
        if (target) args = { ...args, targetId: target.id };
        manager.assertCanAct("cu_paint", exec?.signal, args.targetId ?? null);
        args = { ...args, foreground: args.background === true ? false : args.foreground !== false };
        if (!args.pid || !args.windowId) {
          return { ok: false, error: "invalid_target", message: "cu_paint needs pid and windowId", actionReplaySafe: true };
        }
        if (!args.planPath && !args.strokesFile) {
          return { ok: false, error: "missing_source", message: "pass planPath + layerIndex, or strokesFile", actionReplaySafe: true };
        }
        if (args.planPath && args.layerIndex === undefined) {
          return { ok: false, error: "missing_layer", message: "planPath needs layerIndex", actionReplaySafe: true };
        }
        if (!args.dryRun) {
          const blocked = foregroundRefusal(args);
          if (blocked) return blocked;
        }
        const info = await currentWindowInfo(args.pid, args.windowId, exec, ownerOf(exec), args.targetId ?? null);
        if (!info) return { ok: false, error: "target_geometry_unavailable", message: "cannot read the target window bounds", actionReplaySafe: true };
        if (info.pid !== Number(args.pid)) {
          return { ok: false, error: "target_mismatch", message: "the window belongs to a different process", actionReplaySafe: true };
        }
        const pace = Math.max(2, Math.min(200, Number(args.paceMs ?? 13)));
        const argv = ["strokes", "--pid", String(args.pid), "--window", String(args.windowId), "--pace", String(pace)];
        if (args.planPath) argv.push("--plan", String(args.planPath), "--layer", String(args.layerIndex));
        else argv.push("--file", String(args.strokesFile));
        if (args.inset !== undefined) argv.push("--inset", String(args.inset));
        if (args.background === true) argv.push("--background");
        if (args.dryRun) argv.push("--dry-run");
        const actionId = manager.nextActionId?.("paint") ?? `paint-${Date.now()}`;
        const eventTarget = actionTargetFor(args);
        const label = `绘制图层 ${args.layerIndex ?? ""}`.trim();
        publishPhase(actionId, "drag", "accepted", { target: eventTarget, label });
        manager.writeActivity(label);
        const result = await execWithNativeEvents(argv, exec, actionId, "drag", { targetId: args.targetId ?? null });
        if (result?.ok !== true) {
          publishPhase(actionId, "drag", "failed", { target: eventTarget, label, reason: String(result?.error ?? "refused") });
          return result;
        }
        publishPhase(actionId, "drag", "dispatched", { target: eventTarget, label });
        return {
          ...result,
          actionReplaySafe: false,
          dispatchOnly: true,
          hint: "strokes were dispatched; take a screenshot to confirm the layer landed",
          timings: { totalMs: Date.now() - began },
        };
      },
    });

    // 8d. cu_cdp_paint — inject strokes into a browser canvas over the Chrome
    // DevTools Protocol. This is the ONLY reliable way to draw on a Web canvas
    // (Canva / Figma / tldraw): the render loop filters CGEvent pointer input,
    // so cu_paint's native strokes do not paint there. Requires Chrome started
    // with --remote-debugging-port (the same profile keeps the user's logins).
    register({
      name: "cu_cdp_paint",
      description:
        "Draw into a web page canvas (Canva/Figma/tldraw/…) over the Chrome DevTools Protocol — the reliable path for browser canvases where native pointer events (cu_paint) are dropped by the page's render loop. Connect needs Chrome running with --remote-debugging-port (auto-discovered from DevToolsActivePort on macOS). Two modes: (a) planPath + layerIndex draws one cu_paint_plan layer (set the app brush colour to that layer's hex first); (b) strokesFile draws raw {\"strokes\":[[[x,y],…],…]} in CSS-pixel viewport coords. Dispatch is not verification: screenshot the page afterwards. Read-only discovery via action='status'.",
      parameters: {
        action: { type: "string", description: "'paint' (default), 'status' (list attachable pages), or 'disconnect' (drop pooled CDP session)." },
        planPath: { type: "string", description: "Plan JSON from cu_paint_plan (paint one layer)." },
        layerIndex: { type: "integer", description: "Which plan layer to draw (its index field)." },
        strokesFile: { type: "string", description: "Raw strokes JSON: {\"strokes\":[[[x,y],…],…]} in page CSS pixels." },
        paceMs: { type: "integer", description: "Delay between mouse events in ms (default 14; browser canvases drop strokes when too fast)." },
        inset: { type: "number", description: "Plan mode only: horizontal inset as a fraction of a cell (default 0.13)." },
        urlMatch: { type: "string", description: "Attach to the page whose URL contains this substring (e.g. 'canva.com')." },
        targetId: { type: "string", description: "Attach to a specific CDP target id (from action='status')." },
        wsUrl: { type: "string", description: "Explicit browser websocket URL (overrides DevToolsActivePort discovery)." },
        undo: { type: "boolean", description: "Instead of painting, send one Cmd+Z / Ctrl+Z to the attached page." },
        dryRun: { type: "boolean", description: "Resolve layer geometry + attach, but send no mouse input." },
        reuse: { type: "boolean", description: "Reuse a cached CDP session to avoid re-prompting 'Allow remote debugging?' (default true). Set false to force a fresh connection." },
        disconnect: { type: "boolean", description: "Drop the pooled CDP session for the matching page instead of painting." },
        launch: { type: "boolean", description: "Launch an owned debug Chrome with a dedicated profile instead of attaching to the daily browser. Avoids the Chrome 144+ per-request 'Allow remote debugging?' prompt. Log in to the site once in this profile and it persists." },
        profileDir: { type: "string", description: "Dedicated --user-data-dir for launch mode (default ~/.cu/cdp-profile)." },
        debugPort: { type: "integer", description: "Remote debugging port for launch mode (default 9333; avoid 9222 which the daily Chrome may hold)." },
        startUrl: { type: "string", description: "Page to open when launching the owned debug Chrome (e.g. 'https://www.canva.com/')." },
        syncLogin: { type: "boolean", description: "On launch, copy the daily Chrome's login state (cookies/logins/local storage) into the owned profile so it starts signed in (default true)." },
        syncLoginFrom: { type: "string", description: "Daily Chrome user-data-dir to copy logins from (default: auto-detect Google Chrome/Edge/Chromium/Brave)." },
      },
      output: { schema: { type: "json" }, render: renderWithOptionalImage() },
      isConcurrencySafe: () => false,
      async execute(rawArgs, exec) {
        const began = Date.now();
        const args = rawArgs ?? {};
        manager.assertCanAct("cu_cdp_paint", exec?.signal, null);
        const mode = String(args.action ?? "paint");
        // Validate source arguments before touching the network so deterministic
        // mistakes fail fast and offline.
        let plan = null;
        let strokes = null;
        let hex = "";
        if (mode !== "status" && args.undo !== true && args.dryRun !== true) {
          if (args.planPath) {
            if (args.layerIndex === undefined) {
              return { ok: false, error: "missing_layer", message: "planPath needs layerIndex", actionReplaySafe: true };
            }
          } else if (!args.strokesFile) {
            return { ok: false, error: "missing_source", message: "pass planPath + layerIndex, or strokesFile", actionReplaySafe: true };
          }
        }
        if (args.disconnect === true || mode === "disconnect") {
          const closed = releasePages({ urlMatch: args.urlMatch ? String(args.urlMatch) : undefined, targetId: args.targetId ? String(args.targetId) : undefined });
          return { ok: true, action: "disconnect", closed, actionReplaySafe: true, timings: { totalMs: Date.now() - began } };
        }
        // Optional: launch an owned debug Chrome (dedicated profile) so we never
        // touch the user's daily browser and never re-prompt "Allow remote
        // debugging?" — the browser-use / Playwright pattern.
        let launchedEndpoint = null;
        let lastLoginSync = null;
        if (args.launch === true) {
          try {
            const info = await launchDebugChrome({
              profileDir: args.profileDir ? String(args.profileDir) : defaultDebugProfileDir(),
              port: args.debugPort !== undefined ? Number(args.debugPort) : 9333,
              startUrl: args.startUrl ? String(args.startUrl) : undefined,
              syncLogin: args.syncLogin !== false,
              syncLoginFrom: args.syncLoginFrom ? String(args.syncLoginFrom) : undefined,
            });
            launchedEndpoint = info.browserUrl;
            if (info.loginSync) lastLoginSync = info.loginSync;
          } catch (err) {
            return { ok: false, error: "cdp_launch_failed", message: String(err?.message ?? err), actionReplaySafe: true };
          }
        } else if (!args.wsUrl) {
          // No explicit endpoint and not launching: reuse a running owned Chrome
          // (persisted port) before falling back to the daily browser attach.
          try {
            const owned = await resolveOwnedEndpoint(args.profileDir ? String(args.profileDir) : undefined);
            if (owned) launchedEndpoint = owned.browserUrl;
          } catch { /* fall through to discovery/attach */ }
        }
        const connectOpts = {
          wsUrl: args.wsUrl ? String(args.wsUrl) : (launchedEndpoint || undefined),
          urlMatch: args.urlMatch ? String(args.urlMatch) : undefined,
          targetId: args.targetId ? String(args.targetId) : undefined,
          reuse: args.reuse !== false,
        };
        let conn;
        try {
          conn = await acquirePage(connectOpts);
        } catch (err) {
          return { ok: false, error: "cdp_connect_failed", message: String(err?.message ?? err), actionReplaySafe: true };
        }
        const { client, page, pages } = conn;
        try {
          if (mode === "status") {
            return {
              ok: true,
              action: "status",
              endpoint: conn.endpoint,
              pages: pages.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url })),
              ...(lastLoginSync ? { loginSync: lastLoginSync } : {}),
              actionReplaySafe: true,
              timings: { totalMs: Date.now() - began },
            };
          }
          await client.send("Page.bringToFront", {});
          if (args.undo === true) {
            await sendUndo(client);
            return { ok: true, action: "undo", target: { title: page.title, url: page.url }, actionReplaySafe: false, dispatchOnly: true, timings: { totalMs: Date.now() - began } };
          }
          let strokes;
          let hex = "";
          if (args.planPath) {
            if (args.layerIndex === undefined) {
              return { ok: false, error: "missing_layer", message: "planPath needs layerIndex", actionReplaySafe: true };
            }
            const planRaw = readFileSync(String(args.planPath), "utf8");
            const planObj = JSON.parse(planRaw);
            const inset = args.inset !== undefined ? Number(args.inset) : 0.13;
            const layer = planLayerToStrokes(planObj, Number(args.layerIndex), inset);
            strokes = layer.strokes;
            hex = layer.hex;
          } else if (args.strokesFile) {
            const raw = JSON.parse(readFileSync(String(args.strokesFile), "utf8"));
            strokes = Array.isArray(raw) ? raw : raw.strokes;
            hex = raw?.hex ?? "";
          } else {
            return { ok: false, error: "missing_source", message: "pass planPath + layerIndex, or strokesFile", actionReplaySafe: true };
          }
          if (!Array.isArray(strokes) || strokes.length === 0) {
            return { ok: false, error: "empty_strokes", message: "no strokes to draw", actionReplaySafe: true };
          }
          const totalPoints = strokes.reduce((n, s) => n + (Array.isArray(s) ? s.length : 0), 0);
          if (args.dryRun === true) {
            return { ok: true, action: "dryRun", target: { title: page.title, url: page.url }, strokes: strokes.length, points: totalPoints, hex, actionReplaySafe: true, timings: { totalMs: Date.now() - began } };
          }
          const pace = Math.max(2, Math.min(200, Number(args.paceMs ?? 14)));
          const label = `CDP 绘制图层 ${args.layerIndex ?? ""}`.trim();
          manager.writeActivity(label);
          const result = await paintStrokes(client, strokes, { paceMs: pace });
          return {
            ok: true,
            action: "paint",
            target: { title: page.title, url: page.url },
            hex,
            strokes: result.strokes,
            points: result.points,
            paceMs: pace,
            actionReplaySafe: false,
            dispatchOnly: true,
            hint: "strokes were injected over CDP; screenshot the page to confirm the layer landed",
            timings: { totalMs: Date.now() - began },
          };
        } catch (err) {
          return { ok: false, error: "cdp_paint_failed", message: String(err?.message ?? err), actionReplaySafe: false };
        } finally {
          // Keep the pooled session alive so the next call does not reconnect
          // and re-prompt "Allow remote debugging?". Callers can drop it with
          // action:'disconnect' or reuse:false.
          if (!conn || conn.dead) { try { client.close(); } catch { /* ignore */ } }
        }
      },
    });


    // 8e. cu_discover — enumerate what the target application can do BEFORE
    // operating it. The recurring failure in computer use is not "cannot click"
    // but "does not know the app has a thickness slider at all". This returns a
    // verified capability playbook plus the live controls found on the page.
    register({
      name: "cu_discover",
      description:
        "Discover an application's capabilities before operating it. For a web page (Canva/Figma/etc.) it enumerates every aria-labelled control, input (with type/min/max/value), tab and canvas surface, and matches the page against a verified playbook that explains how to use those controls. Call this FIRST when asked to do something unfamiliar in an app — knowing the app has a 'thickness slider inside a settings popover' is what makes drawing possible at all.",
      parameters: {
        urlMatch: { type: "string", description: "Attach to the CDP page whose URL contains this substring (e.g. 'canva.com')." },
        wsUrl: { type: "string", description: "Explicit browser websocket URL (overrides DevToolsActivePort discovery)." },
        launch: { type: "boolean", description: "Launch/reuse the owned debug Chrome before enumerating." },
        startUrl: { type: "string", description: "Page to open when launching the owned debug Chrome." },
        port: { type: "integer", description: "Owned debug Chrome port (default 9333)." },
        includeHidden: { type: "boolean", description: "Include controls with zero size / hidden (default false)." },
      },
      output: { schema: { type: "json" } },
      isConcurrencySafe: () => true,
      async execute(rawArgs, exec) {
        const began = Date.now();
        const args = rawArgs ?? {};
        let endpoint = args.wsUrl ? String(args.wsUrl) : undefined;
        if (!endpoint && args.launch === true) {
          try {
            const info = await launchDebugChrome({
              port: args.port !== undefined ? Number(args.port) : 9333,
              startUrl: args.startUrl ? String(args.startUrl) : undefined,
            });
            endpoint = info.browserUrl;
          } catch (err) {
            return { ok: false, error: "cdp_launch_failed", message: String(err?.message ?? err), actionReplaySafe: true };
          }
        }
        let conn;
        try {
          conn = await acquirePage({ wsUrl: endpoint, urlMatch: args.urlMatch ? String(args.urlMatch) : undefined });
        } catch (err) {
          return { ok: false, error: "cdp_connect_failed", message: String(err?.message ?? err), actionReplaySafe: true };
        }
        const { client, page } = conn;
        try {
          const hidden = args.includeHidden === true;
          const expression = `(() => {
            const vis = (e) => {
              if (${hidden}) return true;
              const r = e.getBoundingClientRect();
              return r.width > 2 && r.height > 2;
            };
            const rect = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
            const label = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || (e.tagName === 'INPUT' ? (e.placeholder || '') : '') || '').trim();
            const buttons = [];
            const inputs = [];
            const tabs = [];
            let canvasLike = 0;
            for (const e of document.querySelectorAll('button,[role=button],[role=tab],[role=menuitem],a[aria-label]')) {
              if (!vis(e)) continue;
              const item = { label: label(e), role: e.getAttribute('role') || e.tagName.toLowerCase(), rect: rect(e) };
              if (!item.label) continue;
              if (item.role === 'tab') tabs.push(item); else buttons.push(item);
            }
            for (const e of document.querySelectorAll('input,select,textarea,[contenteditable=true]')) {
              if (!vis(e)) continue;
              inputs.push({
                label: label(e) || (e.name || ''),
                type: e.type || e.tagName.toLowerCase(),
                value: e.type === 'range' || e.type === 'text' ? e.value : undefined,
                min: e.min || undefined,
                max: e.max || undefined,
                rect: rect(e),
              });
            }
            for (const e of document.querySelectorAll('canvas,svg')) {
              if (!vis(e)) continue;
              const r = e.getBoundingClientRect();
              if (r.width >= 200 && r.height >= 150) canvasLike += 1;
            }
            const dedupe = (list) => { const seen = new Set(); return list.filter((x) => { const k = x.label + '|' + x.rect.join(','); if (seen.has(k)) return false; seen.add(k); return true; }); };
            return JSON.stringify({
              title: document.title,
              url: location.href,
              viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
              counts: { buttons: buttons.length, tabs: tabs.length, inputs: inputs.length, largeCanvasSurfaces: canvasLike },
              buttons: dedupe(buttons).slice(0, 120),
              tabs: dedupe(tabs).slice(0, 40),
              inputs: dedupe(inputs).slice(0, 40),
            });
          })()`;
          const r = await client.send("Runtime.evaluate", { expression, returnByValue: true });
          let caps = null;
          try { caps = JSON.parse(r.result.value); } catch { caps = null; }
          if (!caps) return { ok: false, error: "discover_failed", message: "page did not return a capability map", actionReplaySafe: true };
          const pb = detectPlaybook(caps.url, caps.title);
          return {
            ok: true,
            page: { title: caps.title, url: caps.url },
            viewport: caps.viewport,
            counts: caps.counts,
            controls: { buttons: caps.buttons, tabs: caps.tabs, inputs: caps.inputs },
            playbook: playbookSummary(pb),
            next: pb?.flows ? Object.keys(pb.flows) : [],
            actionReplaySafe: true,
            timings: { totalMs: Date.now() - began },
          };
        } catch (err) {
          return { ok: false, error: "discover_failed", message: String(err?.message ?? err), actionReplaySafe: true };
        } finally {
          if (!conn || conn.dead) { try { client.close(); } catch { /* ignore */ } }
        }
      },
    });

    // 9. cu_type
    register({
      name: "cu_type",
      description:
        "Enter text into a macOS application control in the background (Unicode & Chinese safe). Supports 'type' (PID key/AX events), 'setvalue' (direct AXValue write with read-back), or 'action' (perform named AX action like AXPress/AXShowMenu).",
      parameters: {
        targetId: TARGET_ID_PARAM,
        mode: {
          type: "string",
          enum: ["type", "setvalue", "action"],
          description: "Input mechanism (default 'type'; use 'setvalue' for direct field replacement).",
        },
        pid: {
          type: "integer",
          description: "Target application pid. Omit when targetId already identifies it.",
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
          description: "Use foreground paste/typing (default false = background). Requires authorizeForeground:true.",
        },
        authorizeForeground: {
          type: "boolean",
          description:
            "Explicit user authorization for an action that takes focus and may use the real clipboard. Without both flags the tool refuses.",
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
        let args = resolveTargetArgs(rawArgs);
        const target = ensureActionTarget(args);
        if (target) args = { ...args, targetId: target.id };
        manager.assertCanAct("cu_type", exec?.signal, args.targetId ?? null);
        const foregroundBlocked = foregroundRefusal(args);
        if (foregroundBlocked) return foregroundBlocked;
        const stale = staleSnapshotResult(args, exec);
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
        if (
          args.ref !== undefined &&
          manager._axWorkerAllowed &&
          typeof manager.axInput === "function" &&
          manager.axTokenUsableFor?.(args) !== false
        ) {
          const bound = manager.resolveBoundToken
            ? manager.resolveBoundToken(args.ref, args)
            : (() => { const t = manager.axTokenFor(args.ref, args.targetId, args); return t ? { ok: true, token: t } : { ok: false }; })();
          if (bound.ok) {
            try {
              const fg = args.foreground === true || manager.isForegroundAuthorized(args.targetId);
              const result = await manager.axInput(bound.token, args.text, mode, args.targetId ?? null, { foreground: fg });
              if (result?.ok === true) {
                publishPhase(actionId, "type", "dispatched", { target: eventTarget, label });
                const post = await afterAction({ ...args, observe: args.observe }, exec);
                publishPhase(actionId, "type",
                  args.expect && post?.verification?.matched === true ? "verified" : "unverified",
                  { target: eventTarget, label,
                    ...(args.expect && post?.verification?.matched === true
                      ? { verification: { matched: true, evidenceRef: "expect" } } : {}) });
                return decorateEvidence(
                  args,
                  { ...result, via: "ax-worker-token" },
                  { ...post, timings: { actionMs: Date.now() - began, ...(post.timings ?? {}), totalMs: Date.now() - began } },
                );
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
          if (manager.axTokenUsableFor?.(args) !== false && manager.axTokenFor?.(args.ref, args.targetId ?? null, args)) {
            publishPhase(actionId, "type", "failed", { target: eventTarget, label, reason: bound.error ?? "identity_unproven" });
            return { ok: false, error: bound.error ?? "identity_unproven", message: bound.message,
                     actionReplaySafe: false, hint: "call cu_snapshot again and retry" };
          }
        }
        if (args.ref !== undefined) {
          const foreignToken = manager.foreignAXTokenFor?.(args.ref, args);
          if (foreignToken) {
            return {
              ok: false,
              error: "identity_unproven",
              message: `ref ${args.ref} belongs to retained target ${foreignToken}, not the requested target; call cu_snapshot for this target`,
              targetId: args.targetId ?? null,
              actionReplaySafe: false,
              hint: "call cu_snapshot again for this target and use a ref from that observation",
            };
          }
        }
        manager.writeActivity(label);
        const cmdParams =
          mode === "action" ? { ...args, name: args.actionName ?? "AXPress" } : args;
        const argv = buildCommandArgv(mode, cmdParams, manager);
        const actionStarted = Date.now();
        const result = await execWithNativeEvents(argv, exec, actionId, "type", {
          ...(args.targetId ? { targetId: args.targetId } : {}),
        });
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
          ...decorateEvidence(args, result, post),
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
        targetId: TARGET_ID_PARAM,
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
          description: "Send key in foreground (default false = background PID event). Requires authorizeForeground:true.",
        },
        authorizeForeground: {
          type: "boolean",
          description:
            "Explicit user authorization for an action that takes focus and sends real keyboard input. Without both flags the tool refuses.",
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
        let args = resolveTargetArgs(rawArgs);
        const target = ensureActionTarget(args);
        if (target) args = { ...args, targetId: target.id };
        manager.assertCanAct("cu_key", exec?.signal, args.targetId ?? null);
        const foregroundBlocked = foregroundRefusal(args);
        if (foregroundBlocked) return foregroundBlocked;
        const label = `按键 ${args.mods ? `${args.mods}+` : ""}${args.name}`;
        const actionId = manager.nextActionId?.("key") ?? `key-${Date.now()}`;
        const eventTarget = actionTargetFor(args);
        publishPhase(actionId, "key", "accepted", { target: eventTarget, label });
        if (eventTarget) publishPhase(actionId, "key", "targetReady", { target: eventTarget, label });
        manager.writeActivity(label);
        const argv = buildCommandArgv("key", args, manager);
        const actionStarted = Date.now();
        const result = await execWithNativeEvents(argv, exec, actionId, "key", {
          ...(args.targetId ? { targetId: args.targetId } : {}),
        });
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
          ...decorateEvidence(args, result, post),
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
        targetId: TARGET_ID_PARAM,
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
          description: "Scroll in foreground at cursor coordinates (default false = background PID scroll). Requires authorizeForeground:true.",
        },
        authorizeForeground: {
          type: "boolean",
          description:
            "Explicit user authorization for an action that takes focus/real input. Without both flags the tool refuses.",
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
        let args = resolveTargetArgs(rawArgs);
        const target = ensureActionTarget(args);
        if (target) args = { ...args, targetId: target.id };
        manager.assertCanAct("cu_scroll", exec?.signal, args.targetId ?? null);
        const foregroundBlocked = foregroundRefusal(args);
        if (foregroundBlocked) return foregroundBlocked;
        const label = `滚动 dy=${args.dy}`;
        const actionId = manager.nextActionId?.("scroll") ?? `scroll-${Date.now()}`;
        const eventTarget = actionTargetFor(args);
        publishPhase(actionId, "scroll", "accepted", { target: eventTarget, label });
        if (eventTarget) publishPhase(actionId, "scroll", "targetReady", { target: eventTarget, label });
        manager.writeActivity(label);
        const argv = buildCommandArgv("scroll", args, manager);
        const actionStarted = Date.now();
        const result = await execWithNativeEvents(argv, exec, actionId, "scroll", {
          ...(args.targetId ? { targetId: args.targetId } : {}),
        });
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
          ...decorateEvidence(args, result, post),
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
        targetId: TARGET_ID_PARAM,
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
        let args = resolveTargetArgs(rawArgs);
        const target = ensureActionTarget(args, { makePrimary: false, readOnly: true });
        if (target) args = { ...args, targetId: target.id };
        const mode = args.mode ?? "auto";
        let axResult = null;
        if ((mode === "auto" || mode === "ax") && args.pid !== undefined) {
          const axArgv = ["ax", "--pid", String(args.pid), "--find", String(args.query)];
          if (args.windowId !== undefined) axArgv.push("--window", String(args.windowId));
          axResult = await readExec(axArgv, exec, { targetId: args.targetId ?? null });
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
          const ocrResult = await readExec(ocrArgv, exec, { targetId: args.targetId ?? null });
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

    // 12b. cu_click_text
    // Dynamic trees (Electron/WKWebView apps that re-render on focus) shift
    // their AX paths between a snapshot and a click, so a path ref goes stale
    // even though the control is right there. This tool names the control by
    // its visible label and lets the engine press it in one walk.
    register({
      name: "cu_click_text",
      description:
        "Press a control by its visible text. Checks Accessibility (AX) first for instant AXPress, and automatically falls back to Apple Vision OCR with coordinate clicking for custom canvas apps (like 剪映, Blender, games) that do not expose AX text nodes.",
      parameters: {
        targetId: TARGET_ID_PARAM,
        text: {
          type: "string",
          required: true,
          description: "Visible title/label (or value) substring of the control to press.",
        },
        pid: {
          type: "integer",
          description: "Target application pid.",
        },
        windowId: {
          type: "integer",
          description: "Target windowId (required: the engine scopes the walk to one window).",
        },
        exact: {
          type: "boolean",
          description: "Match the label exactly instead of by substring.",
        },
        index: {
          type: "integer",
          description: "Which match to press when several match (default 0, pressable matches first).",
        },
        foreground: {
          type: "boolean",
          description: "Click in foreground (activates window). Defaults to true when authorized or targeting creative canvas apps like 剪映.",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderWithOptionalImage(),
      },
      async execute(rawArgs, exec) {
        let args = resolveTargetArgs(rawArgs);
        const target = ensureActionTarget(args);
        if (target) args = { ...args, targetId: target.id };
        if (args.pid === undefined || args.pid === null) {
          return {
            ok: false,
            error: "target_required",
            message: "cu_click_text needs a pid or a target returned by cu_session/cu_status",
          };
        }
        if (args.windowId === undefined || args.windowId === null) {
          return {
            ok: false,
            error: "window_required",
            message: "cu_click_text needs a windowId; the engine scopes the AX walk to one window",
          };
        }
        manager.assertCanAct("cu_click_text", exec?.signal, args.targetId ?? null);
        const argv = [
          "clicktext",
          "--pid",
          String(args.pid),
          "--window",
          String(args.windowId),
          "--text",
          String(args.text),
        ];
        if (args.exact === true) argv.push("--exact");
        if (args.index !== undefined && args.index !== null) {
          argv.push("--index", String(Number(args.index)));
        }
        const foreground =
          args.foreground === true ||
          manager.sessionForegroundAuthorized ||
          manager.isForegroundAuthorized(args.targetId);
        if (foreground) {
          argv.push("--foreground");
        }
        const actionId = manager.nextActionId?.("click_text") ?? `click-text-${Date.now()}`;
        const eventTarget = actionTargetFor(args);
        const label = `点击「${String(args.text).slice(0, 20)}」`;
        publishPhase(actionId, "click_text", "accepted", { target: eventTarget, label });
        if (eventTarget) {
          publishPhase(actionId, "click_text", "targetReady", { target: eventTarget, label });
        }
        const result = await execWithNativeEvents(argv, exec, actionId, "click_text", {
          targetId: args.targetId ?? null,
        });
        publishPhase(actionId, "click_text", result?.ok ? "dispatched" : "failed", {
          target: eventTarget,
          label,
          ...(result?.ok ? {} : { reason: String(result?.error ?? "failed") }),
        });
        if (!result?.ok) {
          manager.showActionFailure?.("点击");
          return { ...result, ok: false, actionReplaySafe: false };
        }
        return { ...result, ok: true, action: "click_text", verified: true };
      },
    });

    // 13. cu_batch
    register({
      name: "cu_batch",
      description:
        "Execute a fast local sequence of macOS actions (click, type, setvalue, key, scroll, wait, action) without LLM roundtrip lag. Returns composite step results, post-batch AX delta, and optional inline window preview.",
      parameters: {
        foreground: {
          type: "boolean",
          description: "Default input mode for all steps. True requires authorizeForeground:true; an individual step may override it. Default false (background).",
        },
        authorizeForeground: {
          type: "boolean",
          description:
            "Explicit user authorization for any foreground step in this batch. Without it, a foreground step refuses the whole batch before input.",
        },
        targetId: TARGET_ID_PARAM,
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
        let args = resolveTargetArgs(rawArgs);
        const target = ensureActionTarget(args);
        if (target) args = { ...args, targetId: target.id };
        manager.assertCanAct("cu_batch", exec?.signal, args.targetId ?? null);
        // A batch cannot contain foreground steps unless the caller explicitly
        // authorized them; otherwise one step could silently take focus.
        const batchFgAuth = args.authorizeForeground === true || manager?.sessionForegroundAuthorized === true || Boolean(manager?.isForegroundAuthorized?.(args.targetId));
        if ((args.foreground === true || (Array.isArray(args.steps) && args.steps.some((step) => step?.foreground === true))) && !batchFgAuth) {
          return {
            ok: false,
            error: "foreground_requires_authorization",
            message: "a batch step asks for foreground input; pass authorizeForeground:true only after explicit user permission",
            actionReplaySafe: true,
            stopRetrying: true,
          };
        }
        if (Array.isArray(args.steps)) {
          // A coordinate step carries no identity. Check it against the live
          // window frame before the batch dispatches anything, so an early
          // step cannot land and then a later stale point hit another app.
          for (let index = 0; index < args.steps.length; index += 1) {
            const step = args.steps[index];
            if (step?.action !== "click" || step.x === undefined || step.y === undefined) continue;
            const refusal = await guardExplicitPoint({ ...args, ...step }, exec);
            if (refusal) return { ...refusal, stepIndex: index };
          }
        }
        const batchActionId = manager.nextActionId?.("batch") ?? `batch-${Date.now()}`;
        const batchTarget = actionTargetFor(args);
        const batchLabel = `批处理 ${Array.isArray(args.steps) ? args.steps.length : 0} 步`;
        publishPhase(batchActionId, "batch", "accepted", { target: batchTarget, label: batchLabel });
        if (batchTarget) publishPhase(batchActionId, "batch", "targetReady", { target: batchTarget, label: batchLabel });
        const batchResult = await manager.executeBatch(
          {
            pid: args.pid,
            windowId: args.windowId,
            targetId: args.targetId,
            foreground: args.foreground === true,
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

        const inputActions = new Set(["click", "double_click", "key", "type", "scroll"]);
        const executedInputs = args.steps.slice(0, batchResult.results?.length ?? 0)
          .filter((step) => inputActions.has(step.action));
        const modes = new Set(executedInputs.map((step) => step.foreground ?? (args.foreground === true)));
        const evidence = decorateEvidence({ ...args, foreground: modes.has(true) }, batchResult, extra);
        if (modes.size > 1 && batchResult.ok !== false) evidence.dispatchMode = "mixed";
        return {
          ...evidence,
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
export function registerCuSkill(ctx, manager, registry = null) {
  const SKILL_NAMES = ["dsh-super-computer-use"];
  // Turn-completion hook: "turn/end" means the agent finished this task, so tear
  // down the visual session right away instead of waiting for the idle timer.
  // Registered on the root scope and on every agent scope so it fires no matter
  // where the session event is emitted. The UI owned by the same chat is marked
  // stopped with the manager's honest cleanup state; it is never transferred.
  const stopFromLifecycle = async (hostSessionId) => {
    if (!manager?.activeSession) return;
    // Only the chat that owns the desktop may end it. A background or newly
    // opened chat finishing its turn must not stop another chat's CU session.
    const owner = registry?.ownerSessionId?.() ?? null;
    if (owner !== null && owner !== hostSessionId) return;
    if (owner === null && hostSessionId !== null && registry) return;
    // Capture the UI identity BEFORE cleanup: a late markStopped must not hit a
    // session this chat starts after the turn-end.
    const uiSessionId = registry?.cuSessionId?.() ?? null;
    const verifiedPreviews = new Map();
    try {
      for (const t of registry?.snapshot?.(hostSessionId)?.targets ?? []) {
        if (t.active && t.state === "verified" && t.action?.verified === true &&
            t.nativePreview?.visible && t.nativePreview.status === "live")
          verifiedPreviews.set(t.targetId, t.targetGeneration);
      }
    } catch { /* Optional visuals must never prevent teardown. */ }
    const result = await manager.stopVisualSession({ reason: "turn_end", verifiedPreviews }).catch(() => null);
    registry?.markStopped?.(hostSessionId ?? null, {
      cleanupState: result?.cleanupState ?? "unknown",
      cuSessionId: uiSessionId ?? undefined,
    });
  };
  const onSessionEvent = (_session, event) => {
    if (event?.type !== "turn/end") return;
    const hostSessionId = typeof _session?.id === "string" ? _session.id : null;
    stopFromLifecycle(hostSessionId).catch(() => {});
  };
  const registerOnScope = (scopeCtx) => {
    const skills = scopeCtx?.get?.("skills");
    if (!skills || typeof skills.register !== "function") return () => {};
    const unregs = SKILL_NAMES.map((sName) =>
      skills.register({
        name: sName,
        description:
          "macOS Computer Use / 桌面操控与自动化（剪映、微信、Finder、备忘录等后台操作与内嵌观看预览）。Control macOS desktop applications using background AX actions, status capsule/halo, and inline window previews.",
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
        // Owner disappearance stops the desktop instead of handing it to the
        // next chat; the registry performs the same gated stop the UI uses.
        if (registry && typeof agent?.id === "string") {
          registry.sessionEnded(agent.id).catch(() => {});
        }
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

export async function apply(ctx, config = {}) {
  const manager = new CuSessionManager({
    serviceUrl: config?.serviceUrl,
  });
  // One registry per plugin instance: it is the single place that maps a
  // Harness chat to the one CU session allowed to control this desktop.
  const registry = createCuUiRegistry({ manager, log: logBoot });
  // Native settings: one writable copy of the .volatile() preferences. The
  // Loader commits a change into the running fiber rather than reloading the
  // plugin, so toggling a switch cannot interrupt an action already in flight.
  const settingsStore = createSettingsStore({ ctx, config, log: logBoot });
  // The settings page writes through the Host's settings service. Record once
  // whether this Harness build actually exposes it: a missing service shows up
  // as an explicit 502 in the page, not as a silently lost preference.
  const hostSettings = ctx?.get?.("settings");
  logBoot(
    `native settings: service=${Boolean(hostSettings)} writable=${typeof hostSettings?.update === "function"}`,
  );
  const applySettingsToManager = () => {
    manager.unhideOnFinish = settingsStore.current().unhideOnFinish !== false;
  };
  applySettingsToManager();
  if (typeof ctx.effect === "function" && typeof ctx.on === "function") {
    ctx.effect(() => {
      const dispose = ctx.on("loader/volatile-update", () => {
        settingsStore.refresh(config);
        applySettingsToManager();
      });
      return () => {
        try { dispose?.(); } catch { /* teardown continues */ }
      };
    }, "scu: volatile settings");
  }
  // Native buttons share the same UI stop transaction and cleanup reporting.
  manager.nativeTargetStopHandler = (targetId, reason) => {
    registry.sync();
    const hostSessionId = registry.ownerSessionId();
    if (!hostSessionId) return manager.stopTarget(targetId, { reason });
    return registry.control({ hostSessionId, cuSessionId: registry.cuSessionId(),
      command: "stop", targetId, pause: false, reason });
  };

  // A leaked indicator is invisible to a fresh host: the ScreenCaptureKit
  // stream lives in the launchd `cu` service, not in DSH, so macOS keeps its
  // "Currently Sharing" panel across restarts and quitting DSH cannot clear it.
  // No session can exist before this host binds one, and the desktop host is
  // single-instance, so releasing the indicator once at boot is safe — and it
  // is the only thing that heals an instance that was force-quit mid-session.
  manager.stopScreenIndicator({ attempts: 2 }).then(() => {
    if (manager.screenIndicatorListenerMissing) {
      // The engine now reports whether the menu-bar app applied the request; the
      // old build answered "ok" while nothing was listening.
      logBoot("screen-indicator: no menu-bar listener (Super Computer Use app is not running)");
    } else if (manager.screenIndicatorWasOn) {
      logBoot("released a leaked screen-sharing indicator at boot");
    }
  }).catch(() => {});

  // Force quit, crash or a host that exits without running its dispose effects
  // never reaches the async cleanup above. Node still runs `exit` listeners, so
  // release synchronously from there; a plugin reload replaces the hook instead
  // of stacking one listener per generation.
  const releaseIndicatorOnExit = () => {
    try {
      manager.stopScreenIndicatorSync();
    } catch {
      // never block exit
    }
  };
  const hasProcess = typeof process !== "undefined" && typeof process.once === "function";
  if (hasProcess) {
    if (exitIndicatorHook) process.removeListener("exit", exitIndicatorHook);
    exitIndicatorHook = releaseIndicatorOnExit;
    process.once("exit", releaseIndicatorOnExit);
  }

  logBoot("apply() entered");
  // A reload must not interrupt a running CU session or a tool that is still
  // finishing. The command writes a request file; the decision and the
  // reconcile both happen here, inside the running Host.
  const activity = () => {
    const session = manager.activeSession;
    if (session) {
      return {
        busy: true,
        reason: "active_cu_session",
        detail: {
          windowId: session.windowId ?? null,
          pid: session.pid ?? null,
          app: session.app ?? null,
        },
      };
    }
    const inFlight = Number(manager.inFlightOps) || 0;
    if (inFlight > 0) {
      return { busy: true, reason: "tool_in_flight", detail: { count: inFlight } };
    }
    const sinceLast = Date.now() - (Number(manager.lastMutatingToolAt) || 0);
    if (manager.lastMutatingToolAt && sinceLast < 1500) {
      return { busy: true, reason: "recent_tool_activity", detail: { sinceLastMs: sinceLast } };
    }
    return { busy: false };
  };
  let devSync = null;
  try {
    devSync = await installDevSync(ctx, {
      runtime: pluginRuntime,
      manager,
      stateDir: manager.stateDir,
      activity,
      log: logBoot,
    });
  } catch (error) {
    // A broken development control must not take the Computer Use tools down.
    logBoot(`dev-sync install failed: ${error?.stack ?? error}`);
  }
  const previewBridge = createPreviewBridge({ manager, log: logBoot });
  const bridge = installHarnessUiBridge(ctx, {
    registry,
    manager,
    config,
    settings: settingsStore,
    stateDir: manager.stateDir,
    preview: previewBridge,
    log: logBoot,
    onClientHello: (hello) => devSync?.noteClientHello?.(hello),
  });
  logBoot(
    bridge.available
      ? "Harness UI bridge installed"
      : `Harness UI bridge unavailable: ${bridge.reason ?? "unknown"}`,
  );
  // Boot diagnostics for the client half: the module graph is composed by the
  // Host, and a missing entry here means no card can ever mount, independent of
  // anything the client code does.
  try {
    const modules = ctx.get?.("clientModules");
    if (modules?.graph) {
      const graph = modules.graph();
      const entry = graph.entries?.find((row) => row.id === "dsh-super-computer-use");
      logBoot(
        `client graph entries=${graph.entries?.length ?? 0} scu=${entry ? `${entry.url} rev=${entry.rev}` : "absent"}`,
      );
      // A newly added `dsh.client` declaration is normally read on the next app
      // start. This one-shot local migration clears the per-specifier manifest
      // cache and re-runs the incremental reconcile for this entry, so an
      // already-running desktop can pick the bundle up without a restart. It is
      // opt-in, never enabled by the shipped bundle patch.
      if (!entry && config.uiRefreshClient === true && modules.pkgMeta && modules.dirty && modules.flush) {
        try {
          modules.pkgMeta.clear();
          modules.dirty.add("dsh-super-computer-use");
          modules.flush((error) => logBoot(`client graph reconcile error: ${error?.message ?? error}`));
          const after = modules
            .graph()
            .entries?.find((row) => row.id === "dsh-super-computer-use");
          logBoot(`client graph refreshed scu=${after ? after.url : "absent"}`);
        } catch (error) {
          logBoot(`client graph refresh failed: ${error?.message ?? error}`);
        }
      }
    } else {
      logBoot("client graph unavailable at apply time");
    }
  } catch (error) {
    logBoot(`client graph probe failed: ${error?.message ?? error}`);
  }
  let disposeTools;
  try {
    disposeTools = registerCuTools({ ctx, manager, config, registry, viewer: bridge, settings: settingsStore });
  } catch (error) {
    logBoot(`apply() failed while registering tools: ${error?.stack ?? error}`);
    throw error;
  }
  const disposeSkill = registerCuSkill(ctx, manager, registry);
  logBoot(`apply() done: ${disposeTools ? "tools registered" : "no tools"}`);

  // Auto-launch bundled engine in background if needed (no external launchd required)
  manager.ensureServiceRunning().catch((err) => {
    logBoot(`ensureServiceRunning note: ${err?.message ?? err}`);
  });

  ctx.effect(() => async () => {
    disposeSkill();
    disposeTools();
    bridge.dispose();
    previewBridge.dispose();
    registry.dispose();
    await manager.stopVisualSession({ reason: "plugin_dispose" });
    manager.stopManagedService();
    manager.dispose();
  });
}


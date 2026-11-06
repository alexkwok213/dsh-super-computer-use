// Native Computer Use settings: the persistent preferences behind the Harness
// settings section, plus one authenticated route on the existing UI bridge.
//
// These fields are declared .volatile() in the plugin Config: the Loader commits
// new values into the running fiber instead of reloading the plugin. Reloading a
// computer-use plugin mid-action is exactly what AGENTS.md forbids, so the
// running copy is refreshed from `loader/volatile-update` and never re-applied.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SETTINGS_NS = "super-computer-use";
export const SETTINGS_PATH = "/api/scu/settings";
export const MAX_SETTINGS_BODY = 4096;

export const SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  controlMode: "background",
  deniedApps: [],
  unhideOnFinish: true,
});

/** Volatile Config fields arrive as `{ get() }` references, not plain values. */
export function readConfigValue(config, key, fallback) {
  const raw = config?.[key];
  if (raw && typeof raw === "object" && typeof raw.get === "function") {
    try {
      const value = raw.get();
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }
  return raw === undefined || raw === null ? fallback : raw;
}

export function normalizeDeniedApps(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim().slice(0, 120);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= 50) break;
  }
  return out;
}

/** Project the live Config into a plain, validated settings object. */
export function resolveSettings(config) {
  return {
    enabled: readConfigValue(config, "enabled", true) !== false,
    controlMode:
      readConfigValue(config, "controlMode", "background") === "full" ? "full" : "background",
    deniedApps: normalizeDeniedApps(readConfigValue(config, "deniedApps", [])),
    unhideOnFinish: readConfigValue(config, "unhideOnFinish", true) !== false,
  };
}

/** Only declared keys, only declared shapes. Unknown keys are refused, not stored. */
export function validateSettingsPatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "invalid_patch" };
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return { ok: false, error: "empty_patch" };
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key)) {
      return { ok: false, error: "unknown_setting" };
    }
  }
  const patch = {};
  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") return { ok: false, error: "invalid_enabled" };
    patch.enabled = value.enabled;
  }
  if ("controlMode" in value) {
    if (value.controlMode !== "background" && value.controlMode !== "full") {
      return { ok: false, error: "invalid_control_mode" };
    }
    patch.controlMode = value.controlMode;
  }
  if ("deniedApps" in value) {
    if (!Array.isArray(value.deniedApps) || value.deniedApps.length > 50) {
      return { ok: false, error: "invalid_denied_apps" };
    }
    if (value.deniedApps.some((item) => typeof item !== "string")) {
      return { ok: false, error: "invalid_denied_apps" };
    }
    patch.deniedApps = normalizeDeniedApps(value.deniedApps);
  }
  if ("unhideOnFinish" in value) {
    if (typeof value.unhideOnFinish !== "boolean") {
      return { ok: false, error: "invalid_unhide_on_finish" };
    }
    patch.unhideOnFinish = value.unhideOnFinish;
  }
  return { ok: true, patch };
}

/** Case-insensitive match against a target app name; returns the matched rule. */
export function deniedAppMatch(appName, deniedApps) {
  if (typeof appName !== "string" || !appName.trim() || !Array.isArray(deniedApps)) return null;
  const needle = appName.trim().toLowerCase();
  for (const rule of deniedApps) {
    if (typeof rule !== "string" || !rule.trim()) continue;
    const name = rule.trim().toLowerCase();
    if (needle === name || needle.includes(name) || name.includes(needle)) return rule;
  }
  return null;
}

/**
 * The master-switch gate, as a pure function so it can be tested without
 * dispatching a real desktop action. Read-only probes and stop/resume stay
 * reachable while Computer Use is off; everything else is refused.
 */
export function shouldRefuseForSettings(toolName, toolArgs, settings, readOnlyTools) {
  if (settings?.enabled !== false) return null;
  if (readOnlyTools?.has?.(toolName)) return null;
  if (toolName === "cu_session" && (toolArgs?.action === "stop" || toolArgs?.action === "resume")) {
    return null;
  }
  return "COMPUTER_USE_DISABLED";
}

/**
 * The one writable copy of the settings. Persistence goes through the Host's
 * `settings` service (profile Cordis patch), so the values live where every
 * other system setting lives; there is no second private config file.
 */
export function createSettingsStore({ ctx, config, log = () => {} } = {}) {
  let current = resolveSettings(config);
  let lastError = null;

  const refresh = (nextConfig) => {
    current = resolveSettings(nextConfig ?? config);
    return current;
  };

  const update = async (patch) => {
    const settings = ctx?.get?.("settings");
    if (!settings || typeof settings.update !== "function") {
      return {
        ok: false,
        error: "settings_service_unavailable",
        message: "This Harness build exposes no settings service; preferences were not changed.",
      };
    }
    try {
      await settings.update(SETTINGS_NS, patch);
      current = { ...current, ...patch };
      lastError = null;
      return { ok: true, settings: current };
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 200);
      log(`settings write failed: ${lastError}`);
      return { ok: false, error: "settings_write_failed", message: lastError };
    }
  };

  return {
    current: () => current,
    refresh,
    update,
    lastError: () => lastError,
  };
}

/** Read the same native permission bits `cu_status` reports; never guess them. */
async function readPermissions(manager, signal) {
  try {
    const status = await manager?.getStatus?.(signal);
    if (!status || status.ok === false) {
      return { available: false, accessibility: false, screenRecording: false };
    }
    return {
      available: true,
      accessibility: status.accessibility === true,
      screenRecording: status.screenRecording === true,
    };
  } catch {
    return { available: false, accessibility: false, screenRecording: false };
  }
}

/** Approximate footprint of the plugin's own state directory (top level only). */
function readStorageBytes(stateDir) {
  if (!stateDir) return null;
  try {
    let total = 0;
    for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        total += statSync(join(stateDir, entry.name)).size || 0;
      } catch {
        // A file disappearing mid-scan is not a reason to fail the whole read.
      }
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * Build the single settings route. It is registered on `connection.fetch`, the
 * same authenticated carrier as /api/scu/state — no new port, no new token, and
 * the request body is never treated as authorization.
 */
export function createSettingsRoute({
  ctx,
  config,
  manager,
  registry,
  stateDir,
  log,
  json,
  readJson,
  store: injectedStore,
} = {}) {
  const store = injectedStore ?? createSettingsStore({ ctx, config, log });
  const snapshot = async () => {
    const targets = manager?.listTargets?.() ?? [];
    return {
      ok: true,
      serverNow: Date.now(),
      settings: store.current(),
      permissions: await readPermissions(manager),
      storageBytes: readStorageBytes(stateDir),
      persistence: "profile",
      // Root-scoped surfaces (the sidebar panel) have no hostSessionId of their
      // own. This is the one session that currently owns the desktop, so the
      // panel can offer a truthful "stop all" instead of guessing a chat.
      ownerSessionId: registry?.ownerSessionId?.() ?? null,
      activity: {
        active: Boolean(manager?.activeSession),
        app: manager?.activeSession?.app ?? null,
        targetCount: targets.length,
        pauseLatched: Boolean(manager?.pauseLatched),
      },
    };
  };

  return {
    path: SETTINGS_PATH,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const parsed = await readJson(request, MAX_SETTINGS_BODY);
      if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);
      const action = parsed.value.action;
      if (action === "get") return json(await snapshot(), 200);
      if (action !== "set") return json({ ok: false, error: "invalid_action" }, 400);
      const validated = validateSettingsPatch(parsed.value.patch);
      if (!validated.ok) return json({ ok: false, error: validated.error }, 400);
      const written = await store.update(validated.patch);
      if (!written.ok) {
        return json(
          { ok: false, error: written.error, message: written.message ?? null },
          502,
        );
      }
      return json(await snapshot(), 200);
    },
  };
}

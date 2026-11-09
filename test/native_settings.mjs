// Native settings section: pure logic, the authenticated route, the tool gate
// and the Client's slot registrations. Everything here runs with a throwaway
// CU_STATE_DIR supplied by scripts/test-isolated.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  SETTINGS_DEFAULTS,
  SETTINGS_PATH,
  createSettingsRoute,
  createSettingsStore,
  deniedAppMatch,
  normalizeDeniedApps,
  readConfigValue,
  resolveSettings,
  shouldRefuseForSettings,
  validateSettingsPatch,
} from "../lib/native-settings.mjs";
import { registerCuTools } from "../lib/index.mjs";
import { CuSessionManager } from "../lib/core.mjs";

const volatile = (value) => ({ get: () => value });

test("resolveSettings reads plain values, volatile references and defaults", () => {
  assert.deepEqual(resolveSettings({}), SETTINGS_DEFAULTS);
  assert.deepEqual(
    resolveSettings({
      enabled: volatile(false),
      controlMode: volatile("full"),
      deniedApps: volatile(["  微信 ", "微信", "", "Finder"]),
      unhideOnFinish: volatile(false),
    }),
    {
      enabled: false,
      controlMode: "full",
      deniedApps: ["微信", "Finder"],
      unhideOnFinish: false,
    },
  );
  // A broken volatile reference must degrade to the default, not crash apply().
  assert.equal(
    resolveSettings({ enabled: { get: () => { throw new Error("bad"); } } }).enabled,
    true,
  );
  assert.equal(readConfigValue({ x: 7 }, "x", 9), 7);
  assert.equal(readConfigValue({}, "x", 9), 9);
  assert.deepEqual(normalizeDeniedApps("not-an-array"), []);
});

test("validateSettingsPatch refuses unknown keys and bad shapes", () => {
  assert.equal(validateSettingsPatch({ enabled: true }).ok, true);
  assert.deepEqual(validateSettingsPatch({ deniedApps: [" A ", "A", "B"] }).patch.deniedApps, [
    "A",
    "B",
  ]);
  assert.equal(validateSettingsPatch({ evil: 1 }).error, "unknown_setting");
  assert.equal(validateSettingsPatch({}).error, "empty_patch");
  assert.equal(validateSettingsPatch({ controlMode: "root" }).error, "invalid_control_mode");
  assert.equal(validateSettingsPatch({ enabled: "yes" }).error, "invalid_enabled");
  assert.equal(validateSettingsPatch({ deniedApps: [1] }).error, "invalid_denied_apps");
  assert.equal(validateSettingsPatch(null).error, "invalid_patch");
});

test("deniedAppMatch is case-insensitive and never blocks an unnamed target", () => {
  const rules = ["微信", "Finder"];
  assert.equal(deniedAppMatch("微信", rules), "微信");
  assert.equal(deniedAppMatch("  微信  ", rules), "微信");
  assert.equal(deniedAppMatch("FINDER", rules), "Finder");
  assert.equal(deniedAppMatch("Safari", rules), null);
  assert.equal(deniedAppMatch(undefined, rules), null);
  assert.equal(deniedAppMatch("Safari", null), null);
});

test("master switch refuses actions but keeps read-only probes and stop/resume", () => {
  const readOnly = new Set(["cu_status", "cu_windows", "cu_snapshot"]);
  const off = { enabled: false };
  assert.equal(shouldRefuseForSettings("cu_click", {}, off, readOnly), "COMPUTER_USE_DISABLED");
  assert.equal(shouldRefuseForSettings("cu_click", {}, { enabled: true }, readOnly), null);
  assert.equal(shouldRefuseForSettings("cu_status", {}, off, readOnly), null);
  assert.equal(shouldRefuseForSettings("cu_session", { action: "stop" }, off, readOnly), null);
  assert.equal(shouldRefuseForSettings("cu_session", { action: "resume" }, off, readOnly), null);
  assert.equal(
    shouldRefuseForSettings("cu_session", { action: "start" }, off, readOnly),
    "COMPUTER_USE_DISABLED",
  );
});

test("settings store persists through the Host settings service", async () => {
  const writes = [];
  const ctx = {
    get: (name) =>
      name === "settings"
        ? { update: async (ns, patch) => writes.push({ ns, patch }) }
        : undefined,
  };
  const store = createSettingsStore({ ctx, config: {} });
  assert.equal(store.current().enabled, true);
  const result = await store.update({ enabled: false });
  assert.equal(result.ok, true);
  assert.deepEqual(writes, [{ ns: "super-computer-use", patch: { enabled: false } }]);
  assert.equal(store.current().enabled, false);
  store.refresh({ enabled: volatile(true), controlMode: volatile("full") });
  assert.equal(store.current().enabled, true);
  assert.equal(store.current().controlMode, "full");
});

test("settings store refuses to change state when persistence fails", async () => {
  const noService = createSettingsStore({ ctx: { get: () => undefined }, config: {} });
  const unavailable = await noService.update({ enabled: false });
  assert.equal(unavailable.error, "settings_service_unavailable");
  assert.equal(noService.current().enabled, true);

  const throwing = createSettingsStore({
    ctx: { get: () => ({ update: async () => { throw new Error("read-only profile"); } }) },
    config: {},
  });
  const failed = await throwing.update({ enabled: false });
  assert.equal(failed.error, "settings_write_failed");
  assert.equal(throwing.current().enabled, true);
});

const fakeManager = () => ({
  getStatus: async () => ({ ok: true, accessibility: true, screenRecording: false }),
  listTargets: () => [],
  activeSession: null,
  pauseLatched: false,
});

test("settings route authenticates nothing of its own and only accepts get/set", async () => {
  const json = (body, status = 200) => ({ body, status });
  const readJson = async (request) => ({ ok: true, value: request.body });
  const updates = [];
  const store = {
    current: () => ({ ...SETTINGS_DEFAULTS, enabled: false }),
    update: async (patch) => {
      updates.push(patch);
      return { ok: true };
    },
  };
  const route = createSettingsRoute({
    manager: fakeManager(),
    registry: { ownerSessionId: () => "session-1" },
    json,
    readJson,
    store,
  });
  assert.equal(route.path, SETTINGS_PATH);
  assert.deepEqual(route.methods, ["POST"]);

  const got = await route.fetch({ body: { action: "get" } });
  assert.equal(got.status, 200);
  assert.equal(got.body.ok, true);
  assert.equal(got.body.settings.enabled, false);
  assert.equal(got.body.permissions.accessibility, true);
  assert.equal(got.body.permissions.screenRecording, false);
  assert.equal(got.body.ownerSessionId, "session-1");
  assert.equal(got.body.activity.active, false);

  const set = await route.fetch({ body: { action: "set", patch: { enabled: true } } });
  assert.equal(set.status, 200);
  assert.deepEqual(updates, [{ enabled: true }]);

  assert.equal((await route.fetch({ body: { action: "delete" } })).body.error, "invalid_action");
  assert.equal(
    (await route.fetch({ body: { action: "set", patch: { evil: 1 } } })).body.error,
    "unknown_setting",
  );

  const failing = createSettingsRoute({
    manager: fakeManager(),
    json,
    readJson,
    store: { current: () => SETTINGS_DEFAULTS, update: async () => ({ ok: false, error: "settings_write_failed" }) },
  });
  const refused = await failing.fetch({ body: { action: "set", patch: { enabled: false } } });
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error, "settings_write_failed");
});

test("disabled master switch really refuses a registered cu_* action", async () => {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get: () => undefined,
  };
  const manager = new CuSessionManager();
  const settings = { current: () => ({ ...SETTINGS_DEFAULTS, enabled: false }) };
  registerCuTools({ ctx, manager, config: {}, settings });
  const click = tools.get("cu_click");
  assert.ok(click, "cu_click must still be registered while disabled");
  await assert.rejects(
    () => click.execute({}, {}),
    (error) => error.code === "COMPUTER_USE_DISABLED",
  );
  manager.dispose();
});

test("client registers only the settings section, not a plugin-bar entry or central panel", () => {
  const code = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  let captured = null;
  const style = { dataset: {}, textContent: "", remove() {} };
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (spec) => { captured = spec; } },
    },
    document: {
      currentScript: null,
      head: { appendChild() {} },
      createElement: () => style,
      querySelectorAll: () => [],
    },
    navigator: { language: "en" },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.runInNewContext(code, sandbox);
  assert.ok(captured, "client.js must register a module factory");
  // The classic bundle must survive a second execution in the same lexical
  // environment (Client HMR); top-level const would throw here.
  assert.doesNotThrow(() => vm.runInNewContext(code, sandbox));

  const React = {
    createElement: (...args) => args,
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
    useSyncExternalStore: (_subscribe, get) => get(),
  };
  const mod = captured.factory((name) => (name === "react" ? React : {}));
  const registrations = [];
  const ctx = {
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => {
      const dispose = fn();
      return () => dispose?.();
    },
  };
  mod.apply(ctx);

  const sidebar = registrations.find((r) => r.options.name === "sidebar.panellist");
  const main = registrations.find((r) => r.options.name === "main");
  const section = registrations.find((r) => r.options.name === "settings.section");
  // Computer Use lives in Settings now. A sidebar.panellist row would put it
  // back in the plugin bar, and a main panel would be unreachable without it.
  assert.equal(sidebar, undefined, "no plugin-bar (sidebar.panellist) entry may be registered");
  assert.equal(main, undefined, "no orphaned central panel (main) may be registered");
  assert.ok(section, "settings.section registration missing");
  assert.equal(section.options.id, "computer-use");
  assert.equal(typeof section.options.label, "function");
  assert.equal(section.options.label(), "Computer Use");
  sandbox.navigator.language = "zh-CN";
  assert.equal(section.options.label(), "电脑控制", "Chinese shell must label the settings section in Chinese");
  sandbox.navigator.language = "en";
  assert.equal(typeof section.component, "function");
  // Removing the plugin-bar entry must not take the ambient card or overlay with it.
  assert.ok(registrations.some((r) => r.options.name === "conversation.input.dock"));
  assert.ok(registrations.some((r) => r.options.name === "shell.overlay"));
});

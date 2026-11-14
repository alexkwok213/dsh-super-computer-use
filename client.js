/* DSH Super Computer Use — Harness client half.
 *
 * Registers one ambient card under the current conversation's composer and one
 * frame-wide overlay for the enlarged view. Everything here is plain JS on the
 * host's module table: React comes from the page, there is no second React and
 * no app-root replacement.
 */
// Captured while this classic bundle is executing. The Host serves bundles at a
// revisioned URL; the browser half reports that revision back so a development
// update can prove which artifact is actually running. The whole bundle is
// wrapped in an IIFE because Client HMR executes this classic script again in the
// same global lexical environment; top-level `const` would fail with
// "Identifier has already been declared" on the second execution.
(() => {
const SCRIPT_URL = (() => {
  try {
    if (typeof document === "undefined" || !document.currentScript) return "";
    return String(document.currentScript.src || "");
  } catch {
    return "";
  }
})();
const SCRIPT_REV = (() => {
  const match = /[?&]rev=([^&#]+)/.exec(SCRIPT_URL);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
})();

window.__ModuleLoader__.load({
  id: "dsh-super-computer-use",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

    const NS = "dsh-super-computer-use";
    const CLIENT_VERSION = "0.29.0";
    const STATE_PATH = "/api/scu/state";
    const CONTROL_PATH = "/api/scu/control";
    const PREVIEW_PATH = "/api/scu/preview";
    const PROBE_PATH = "/api/scu/probe";
    const CLIENT_HELLO_PATH = "/api/scu/client-hello";
    const CLIENT_HELLO_INTERVAL_MS = 5000;
    const CLIENT_CAPABILITIES = ["dev-sync-hello"];
    let helloInFlight = false;
    function announceClient() {
      if (helloInFlight || !SCRIPT_REV) return;
      if (typeof fetch !== "function") return;
      helloInFlight = true;
      try {
        Promise.resolve(
          fetch(CLIENT_HELLO_PATH, {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              clientRev: SCRIPT_REV,
              clientVersion: CLIENT_VERSION,
              scriptUrl: SCRIPT_URL,
              capabilities: CLIENT_CAPABILITIES,
            }),
          }),
        )
          .catch(() => {})
          .finally(() => {
            helloInFlight = false;
          });
      } catch {
        helloInFlight = false;
      }
    }

    const ACTIVE_STATES = new Set(["claimed", "running", "waiting", "verified", "unverified", "failed", "stopping"]);
    const FINAL_STATES = new Set(["stopped", "cleanup_unknown"]);

    const STRINGS = {
      en: {
        "card.expand": "Expand",
        "card.collapse": "Collapse",
        "card.watch": "Watch",
        "card.hidePreview": "Hide preview",
        "card.details": "Details",
        "card.stop": "Stop",
        "card.stopping": "Stopping…",
        "card.stopAll": "Stop all",
        "card.stoppingAll": "Stopping all…",
        "card.targets": "{count} targets",
        "card.targetCount": "{count} active",
        "deck.title": "DSH is controlling",
        "deck.background": "Background · focus unchanged",
        "deck.expand": "Expand",
        "deck.collapse": "Collapse",
        "deck.close": "Hide deck",
        "deck.show": "Deck",
        "card.target": "Target",
        "card.noTarget": "Choosing a window",
        "card.frameAge": "Frame {seconds}s ago",
        "card.fresh": "Live",
        "card.stale": "Last frame",
        "card.noPreview": "No preview",
        "card.waitingForFrame": "Waiting for the first frame…",
        "state.claimed": "Preparing",
        "state.running": "Working",
        "state.waiting": "Waiting",
        "state.unverified": "Done, not verified",
        "state.verified": "Verified",
        "state.failed": "Failed",
        "state.stopping": "Stopping",
        "state.stopped": "Stopped",
        "state.cleanup_unknown": "Stopped · cleanup unknown",
        "state.busy_elsewhere": "Another chat is using the computer",
        "action.session": "Starting session",
        "action.windows": "Reading windows",
        "action.launch": "Launching app",
        "action.observe": "Reading interface",
        "action.screenshot": "Capturing screen",
        "action.find": "Finding control",
        "action.verify": "Verifying",
        "action.click": "Clicking",
        "action.type": "Typing",
        "action.key": "Pressing a key",
        "action.scroll": "Scrolling",
        "action.batch": "Running a sequence",
        "action.action": "Acting",
        "overlay.title": "Computer Use",
        "overlay.live": "Live preview",
        "overlay.close": "Close preview",
        "overlay.stopHint": "Stop closes the input gate immediately; queued actions will not run.",
        "overlay.diagnostics": "Diagnostics",
        "overlay.dismiss": "Dismiss",
        "err.reconnecting": "Reconnecting…",
        "err.unauthorized": "Not authorized",
        "err.control": "Stop failed: {error}",
        "err.busy": "Another chat already controls the computer.",
        "diag.carrier": "Carrier",
        "diag.probe": "Stream probe",
        "diag.generation": "Target generation",
        "diag.frames": "Frames",
        "meta.fps": "{fps} fps",
        "meta.none": "—",
        "perm.openSettings": "Open System Settings",
        "native.nav": "Computer Use",
        "native.subtitle": "Desktop control, permissions and preferences",
        "native.refresh": "Refresh",
        "native.loading": "Loading…",
        "native.error": "Could not reach the Computer Use service: {error}",
        "native.section.enable": "Enable computer use",
        "native.section.enableHint": "When off, every action is refused except status, stop and resume.",
        "native.section.mode": "How the agent uses the apps you allow",
        "native.section.modeHint": "Background keeps other apps visible. Full control hides unrelated apps by default.",
        "native.mode.background": "Background",
        "native.mode.full": "Full control",
        "native.section.denied": "Denied apps",
        "native.section.deniedHint": "One app name per line. Matching ignores case.",
        "native.section.deniedEmpty": "No apps denied. Add an app to refuse every request for it.",
        "native.section.unhide": "Unhide apps when it finishes",
        "native.section.unhideHint": "Restore apps hidden by a full-control session when it stops.",
        "native.permissions": "Permissions",
        "native.accessibility": "Accessibility",
        "native.screenRecording": "Screen recording",
        "native.granted": "Granted",
        "native.notGranted": "Not granted",
        "native.unknown": "Unconfirmed",
        "native.storage": "Storage",
        "native.storageHint": "Space used by Computer Use on this Mac (top-level files).",
        "native.save": "Save",
        "native.saving": "Saving…",
        "native.saved": "Saved",
        "native.close": "Close",
        "native.kb": "{kb} KB",
        "native.openSettings": "Open System Settings",
        "native.permissionHint": "Manage Accessibility and Screen Recording in System Settings",
        "native.saveTitle": "Save preferences",
        "native.saveBody": "Changes take effect after you save.",
        "native.authorize": "Authorize Super Computer Use",
        "native.authorizeHint": "Manage Accessibility and Screen Recording in System Settings, then set preferences below.",
        "native.preferences": "Preferences",
        "native.helperName": "Super Computer Use",
        "native.permissionsUse": "In System Settings, allow {application} to read the interface, click and type.",
        "native.screenRecordingUse": "In System Settings, allow {application} to capture application windows.",
        "native.requestPermission": "Request permission",
        "native.retry": "Retry",
        "native.staleNotice": "Could not refresh. Showing the last observation.",
        "native.queryFailed": "Could not read settings: {error}",
        "native.savedToast": "Preferences saved",
        "native.settingsOpenedToast": "Opened System Settings",
        "native.loadingHint": "Reading current settings…",
        "native.setupTitle": "Set up Super Computer Use first",
        "native.setupBody": "The plugin is enabled. Grant Accessibility and Screen Recording before using it, then review the preferences on the plugin page.",
        "native.setupQueryFailed": "System permissions could not be checked. Open the plugin details to see the reason and retry.",
        "native.later": "Later",
        "native.openSetup": "Open setup",
        "native.configured": "Saved",
      },
      zh: {
        "card.expand": "展开",
        "card.collapse": "收起",
        "card.watch": "观看",
        "card.hidePreview": "收起预览",
        "card.details": "详情",
        "card.stop": "停止",
        "card.stopping": "正在停止…",
        "card.stopAll": "全部停止",
        "card.stoppingAll": "正在全部停止…",
        "card.targets": "{count} 个目标",
        "card.targetCount": "{count} 个运行中",
        "deck.title": "DSH 正在操控",
        "deck.background": "后台执行 · 焦点未改变",
        "deck.expand": "展开",
        "deck.collapse": "收起",
        "deck.close": "隐藏控制台",
        "deck.show": "控制台",
        "card.target": "目标",
        "card.noTarget": "正在选择窗口",
        "card.frameAge": "画面 {seconds}s 前",
        "card.fresh": "实时",
        "card.stale": "最近画面",
        "card.noPreview": "无预览",
        "card.waitingForFrame": "等待首帧…",
        "state.claimed": "准备中",
        "state.running": "执行中",
        "state.waiting": "等待中",
        "state.unverified": "已执行未验证",
        "state.verified": "已验证",
        "state.failed": "失败",
        "state.stopping": "停止中",
        "state.stopped": "已停止",
        "state.cleanup_unknown": "已停止 · 清理状态未知",
        "state.busy_elsewhere": "另一个聊天正在使用电脑",
        "action.session": "启动会话",
        "action.windows": "读取窗口",
        "action.launch": "启动应用",
        "action.observe": "读取界面",
        "action.screenshot": "截取屏幕",
        "action.find": "查找控件",
        "action.verify": "验证结果",
        "action.click": "点击",
        "action.type": "输入",
        "action.key": "按键",
        "action.scroll": "滚动",
        "action.batch": "执行组合操作",
        "action.action": "操作中",
        "overlay.title": "Computer Use",
        "overlay.live": "实时预览",
        "overlay.close": "关闭预览",
        "overlay.stopHint": "停止会立即关闭输入闸门，排队动作不会再执行。",
        "overlay.diagnostics": "诊断",
        "overlay.dismiss": "关闭",
        "err.reconnecting": "重新连接中…",
        "err.unauthorized": "未授权",
        "err.control": "停止失败：{error}",
        "err.busy": "另一个聊天已经在控制电脑。",
        "diag.carrier": "通道",
        "diag.probe": "流式探测",
        "diag.generation": "目标代次",
        "diag.frames": "帧数",
        "meta.fps": "{fps} fps",
        "meta.none": "—",
        "perm.openSettings": "打开系统设置授权",
        "native.nav": "电脑控制",
        "native.subtitle": "桌面操控、权限与偏好",
        "native.refresh": "刷新",
        "native.loading": "加载中…",
        "native.error": "无法连接 Computer Use 服务：{error}",
        "native.section.enable": "启用电脑控制",
        "native.section.enableHint": "关闭后，除状态、停止与恢复外，所有动作都会被拒绝。",
        "native.section.mode": "Agent 如何使用允许的应用",
        "native.section.modeHint": "后台保留其他应用可见；完全控制默认隐藏无关应用。",
        "native.mode.background": "后台",
        "native.mode.full": "完全控制",
        "native.section.denied": "拒绝的应用",
        "native.section.deniedHint": "每行一个应用名，匹配不区分大小写。",
        "native.section.deniedEmpty": "没有拒绝的应用。添加应用后会自动拒绝对它的请求。",
        "native.section.unhide": "结束时恢复隐藏的应用",
        "native.section.unhideHint": "完全控制会话结束时，恢复被它隐藏的应用。",
        "native.permissions": "权限",
        "native.accessibility": "辅助功能",
        "native.screenRecording": "屏幕录制",
        "native.granted": "已允许",
        "native.notGranted": "未授权",
        "native.unknown": "未确认",
        "native.storage": "存储",
        "native.storageHint": "Computer Use 在这台 Mac 上占用的空间（仅顶层文件）。",
        "native.save": "保存",
        "native.saving": "保存中…",
        "native.saved": "已保存",
        "native.close": "关闭",
        "native.kb": "{kb} KB",
        "native.openSettings": "打开系统设置",
        "native.permissionHint": "在系统设置中管理辅助功能和屏幕录制权限",
        "native.saveTitle": "保存偏好",
        "native.saveBody": "修改后需保存才会生效。",
        "native.authorize": "给 Super Computer Use 授权",
        "native.authorizeHint": "在系统设置中管理辅助功能和屏幕录制权限，并在下方设置偏好。",
        "native.preferences": "偏好",
        "native.helperName": "Super Computer Use",
        "native.permissionsUse": "在系统设置中允许 {application} 读取界面、点击和输入。",
        "native.screenRecordingUse": "在系统设置中允许 {application} 截取应用窗口。",
        "native.requestPermission": "申请权限",
        "native.retry": "重试",
        "native.staleNotice": "刷新失败，当前显示上一次的观测结果。",
        "native.queryFailed": "无法读取设置：{error}",
        "native.savedToast": "偏好已保存",
        "native.settingsOpenedToast": "已打开系统设置",
        "native.loadingHint": "正在读取当前设置…",
        "native.setupTitle": "使用 Super Computer Use 前需要设置",
        "native.setupBody": "插件已开启。使用前请授予辅助功能和屏幕录制权限，并在插件详情页检查偏好设置。",
        "native.setupQueryFailed": "暂时无法检测系统权限。请打开插件详情页查看原因并重试。",
        "native.later": "稍后",
        "native.openSetup": "前往设置",
        "native.configured": "已保存",
      },
    };

    // Additional locales cover the settings surface. Every dictionary is
    // completed from English so the host locale registry sees identical key
    // sets; chat-card copy falls back to English until it is translated.
    const EXTRA_LOCALES = {
      ja: {
        "native.authorize": "Super Computer Use に権限を付与",
        "native.authorizeHint": "システム設定でアクセシビリティと画面収録を管理し、下で設定を変更します。",
        "native.preferences": "設定",
        "native.helperName": "Super Computer Use",
        "native.permissionsUse": "システム設定で {application} による画面の読み取り、クリック、入力を許可します。",
        "native.screenRecordingUse": "システム設定で {application} によるウィンドウのキャプチャを許可します。",
        "native.requestPermission": "権限を申請",
        "native.retry": "再試行",
        "native.staleNotice": "更新できませんでした。前回の観測結果を表示しています。",
        "native.queryFailed": "設定を読み込めませんでした：{error}",
        "native.savedToast": "設定を保存しました",
        "native.settingsOpenedToast": "システム設定を開きました",
        "native.loadingHint": "現在の設定を読み込み中…",
        "native.setupTitle": "使用前に設定が必要です",
        "native.setupBody": "プラグインは有効です。使用前にアクセシビリティと画面収録を許可し、プラグインの詳細ページで設定を確認してください。",
        "native.setupQueryFailed": "システム権限を確認できませんでした。詳細ページで理由を確認して再試行してください。",
        "native.later": "後で",
        "native.openSetup": "設定を開く",
        "native.configured": "未保存の変更はありません",
      },
      es: {
        "native.authorize": "Autorizar Super Computer Use",
        "native.authorizeHint": "Gestiona Accesibilidad y Grabación de pantalla en Ajustes del sistema y configura las preferencias abajo.",
        "native.preferences": "Preferencias",
        "native.helperName": "Super Computer Use",
        "native.permissionsUse": "En Ajustes del sistema, permite que {application} lea la interfaz, haga clic y escriba.",
        "native.screenRecordingUse": "En Ajustes del sistema, permite que {application} capture ventanas de la aplicación.",
        "native.requestPermission": "Solicitar permiso",
        "native.retry": "Reintentar",
        "native.staleNotice": "No se pudo actualizar. Se muestra la última observación.",
        "native.queryFailed": "No se pudo leer la configuración: {error}",
        "native.savedToast": "Preferencias guardadas",
        "native.settingsOpenedToast": "Ajustes del sistema abiertos",
        "native.loadingHint": "Leyendo la configuración actual…",
        "native.setupTitle": "Configura Super Computer Use antes de usarlo",
        "native.setupBody": "El complemento está activado. Concede Accesibilidad y Grabación de pantalla antes de usarlo y revisa las preferencias en la página del complemento.",
        "native.setupQueryFailed": "No se pudieron comprobar los permisos del sistema. Abre los detalles del complemento para ver el motivo y reintentar.",
        "native.later": "Más tarde",
        "native.openSetup": "Abrir configuración",
        "native.configured": "Sin cambios pendientes",
      },
      fr: {
        "native.authorize": "Autoriser Super Computer Use",
        "native.authorizeHint": "Gérez Accessibilité et Enregistrement de l'écran dans les Réglages Système, puis définissez les préférences ci-dessous.",
        "native.preferences": "Préférences",
        "native.helperName": "Super Computer Use",
        "native.permissionsUse": "Dans les Réglages Système, autorisez {application} à lire l'interface, cliquer et saisir du texte.",
        "native.screenRecordingUse": "Dans les Réglages Système, autorisez {application} à capturer les fenêtres.",
        "native.requestPermission": "Demander l'autorisation",
        "native.retry": "Réessayer",
        "native.staleNotice": "Actualisation impossible. Dernière observation affichée.",
        "native.queryFailed": "Impossible de lire les paramètres : {error}",
        "native.savedToast": "Préférences enregistrées",
        "native.settingsOpenedToast": "Réglages Système ouverts",
        "native.loadingHint": "Lecture des paramètres…",
        "native.setupTitle": "Configurer Super Computer Use avant utilisation",
        "native.setupBody": "Le module est activé. Accordez Accessibilité et Enregistrement de l'écran avant de l'utiliser, puis vérifiez les préférences sur la page du module.",
        "native.setupQueryFailed": "Impossible de vérifier les autorisations système. Ouvrez les détails du module pour voir la raison et réessayer.",
        "native.later": "Plus tard",
        "native.openSetup": "Ouvrir la configuration",
        "native.configured": "Aucune modification en attente",
      },
      de: {
        "native.authorize": "Super Computer Use autorisieren",
        "native.authorizeHint": "Verwalte Bedienungshilfen und Bildschirmaufnahme in den Systemeinstellungen und lege unten die Einstellungen fest.",
        "native.preferences": "Einstellungen",
        "native.helperName": "Super Computer Use",
        "native.permissionsUse": "Erlaube {application} in den Systemeinstellungen, die Oberfläche zu lesen, zu klicken und einzugeben.",
        "native.screenRecordingUse": "Erlaube {application} in den Systemeinstellungen, Anwendungsfenster aufzunehmen.",
        "native.requestPermission": "Berechtigung anfordern",
        "native.retry": "Erneut versuchen",
        "native.staleNotice": "Aktualisierung fehlgeschlagen. Letzte Beobachtung wird angezeigt.",
        "native.queryFailed": "Einstellungen konnten nicht gelesen werden: {error}",
        "native.savedToast": "Einstellungen gespeichert",
        "native.settingsOpenedToast": "Systemeinstellungen geöffnet",
        "native.loadingHint": "Aktuelle Einstellungen werden gelesen…",
        "native.setupTitle": "Super Computer Use zuerst einrichten",
        "native.setupBody": "Das Plugin ist aktiviert. Erteile Bedienungshilfen und Bildschirmaufnahme vor der Nutzung und prüfe die Einstellungen auf der Plugin-Seite.",
        "native.setupQueryFailed": "Systemberechtigungen konnten nicht geprüft werden. Öffne die Plugin-Details für die Ursache und versuche es erneut.",
        "native.later": "Später",
        "native.openSetup": "Einrichtung öffnen",
        "native.configured": "Keine ausstehenden Änderungen",
      },
      ru: {
        "native.authorize": "Разрешить Super Computer Use",
        "native.authorizeHint": "Управляйте «Универсальным доступом» и «Записью экрана» в Системных настройках, а затем задайте параметры ниже.",
        "native.preferences": "Параметры",
        "native.helperName": "Super Computer Use",
        "native.permissionsUse": "В Системных настройках разрешите {application} читать интерфейс, нажимать и вводить текст.",
        "native.screenRecordingUse": "В Системных настройках разрешите {application} захватывать окна приложений.",
        "native.requestPermission": "Запросить разрешение",
        "native.retry": "Повторить",
        "native.staleNotice": "Не удалось обновить. Показано последнее наблюдение.",
        "native.queryFailed": "Не удалось прочитать настройки: {error}",
        "native.savedToast": "Настройки сохранены",
        "native.settingsOpenedToast": "Системные настройки открыты",
        "native.loadingHint": "Чтение текущих настроек…",
        "native.setupTitle": "Сначала настройте Super Computer Use",
        "native.setupBody": "Плагин включён. Перед использованием предоставьте «Универсальный доступ» и «Запись экрана», затем проверьте параметры на странице плагина.",
        "native.setupQueryFailed": "Не удалось проверить системные разрешения. Откройте подробности плагина, чтобы узнать причину, и повторите попытку.",
        "native.later": "Позже",
        "native.openSetup": "Открыть настройку",
        "native.configured": "Нет несохранённых изменений",
      },
      pt: {
        "native.authorize": "Autorizar o Super Computer Use",
        "native.authorizeHint": "Gerencie Acessibilidade e Gravação de Tela nos Ajustes do Sistema e defina as preferências abaixo.",
        "native.preferences": "Preferências",
        "native.helperName": "Super Computer Use",
        "native.permissionsUse": "Nos Ajustes do Sistema, permita que {application} leia a interface, clique e digite.",
        "native.screenRecordingUse": "Nos Ajustes do Sistema, permita que {application} capture janelas.",
        "native.requestPermission": "Solicitar permissão",
        "native.retry": "Tentar novamente",
        "native.staleNotice": "Não foi possível atualizar. Exibindo a última observação.",
        "native.queryFailed": "Não foi possível ler as configurações: {error}",
        "native.savedToast": "Preferências salvas",
        "native.settingsOpenedToast": "Ajustes do Sistema abertos",
        "native.loadingHint": "Lendo as configurações atuais…",
        "native.setupTitle": "Configure o Super Computer Use antes de usar",
        "native.setupBody": "O plugin está ativado. Conceda Acessibilidade e Gravação de Tela antes de usar e revise as preferências na página do plugin.",
        "native.setupQueryFailed": "Não foi possível verificar as permissões do sistema. Abra os detalhes do plugin para ver o motivo e tente novamente.",
        "native.later": "Depois",
        "native.openSetup": "Abrir configuração",
        "native.configured": "Sem alterações pendentes",
      },
    };

    const LOCALES = (() => {
      const out = { en: STRINGS.en, zh: { ...STRINGS.en, ...STRINGS.zh } };
      for (const [id, extra] of Object.entries(EXTRA_LOCALES)) out[id] = { ...STRINGS.en, ...extra };
      return out;
    })();

    function tFor(localeId, key, params) {
      const id = typeof localeId === "string" ? localeId.toLowerCase() : "";
      const dict = LOCALES[id] || (id.startsWith("zh") ? LOCALES.zh : LOCALES.en);
      let text = dict[key] ?? LOCALES.en[key] ?? key;
      if (params) text = text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
      return text;
    }

    // ---------------------------------------------------------------- transport

    async function readJsonResponse(response) {
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { ok: false, error: "bad_response" };
      }
      return data;
    }

    async function postJson(path, body, signal) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await readJsonResponse(response);
      if (!response.ok || data?.ok === false) {
        const error = new Error(data?.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.code = data?.error;
        error.data = data;
        throw error;
      }
      return data;
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // ---------------------------------------------------------------- preview

    class FrameParser {
      constructor(onFrame, limits = { meta: 16 * 1024, jpeg: 2 * 1024 * 1024 }) {
        this.onFrame = onFrame;
        this.limits = limits;
        this.buffer = new Uint8Array(0);
        this.invalid = null;
      }

      push(chunk) {
        if (this.invalid) return;
        const next = new Uint8Array(this.buffer.length + chunk.length);
        next.set(this.buffer, 0);
        next.set(chunk, this.buffer.length);
        this.buffer = next;
        this.drain();
      }

      drain() {
        for (;;) {
          if (this.buffer.length < 8) return;
          const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, 8);
          const metaLength = view.getUint32(0, false);
          const jpegLength = view.getUint32(4, false);
          if (metaLength === 0 || metaLength > this.limits.meta) {
            this.invalid = "invalid_meta_length";
            return;
          }
          if (jpegLength === 0 || jpegLength > this.limits.jpeg) {
            this.invalid = "invalid_frame_length";
            return;
          }
          const total = 8 + metaLength + jpegLength;
          if (this.buffer.length < total) return;
          const metaBytes = this.buffer.subarray(8, 8 + metaLength);
          const jpegBytes = this.buffer.subarray(8 + metaLength, total);
          let meta;
          try {
            meta = JSON.parse(new TextDecoder().decode(metaBytes));
          } catch {
            this.invalid = "invalid_meta_json";
            return;
          }
          this.buffer = this.buffer.subarray(total);
          try {
            this.onFrame(meta, jpegBytes);
          } catch {
            // A presentation callback must not kill the stream parser.
          }
        }
      }
    }

    class PreviewController {
      constructor(store, targetId = null) {
        this.store = store;
        this.targetId = targetId;
        this.abort = null;
        this.reader = null;
        // The card and the expanded panel can be mounted at the same time.
        // One controller may own several canvases; closing one must not detach
        // the other.
        this.canvases = new Set();
        this.running = false;
        this.firstFrameTimer = null;
        this.staleTimer = null;
        this.decoding = false;
        this.dropped = 0;
        this.frames = 0;
        this.startedAt = 0;
        this.lastFrameAt = 0;
        this.fps = 0;
        this.fpsWindow = [];
        this.invalid = null;
        this.lastAttemptAt = 0;
        this.opening = false;
        this.token = 0;
        this.stream = null;
        // A stream that produced no frame is not retried in a tight loop for
        // the same session/target; a new identity (or an explicit close) clears
        // this.
        this.blockedIdentity = null;
      }

      attach(canvas) {
        if (!canvas) return;
        this.canvases.add(canvas);
        this.store.notify();
      }

      detach(canvas) {
        if (canvas) this.canvases.delete(canvas);
      }

      static sameIdentity(a, b) {
        return Boolean(
          a &&
            b &&
            a.cuSessionId === b.cuSessionId &&
            a.targetGeneration === b.targetGeneration &&
            (a.targetId ?? null) === (b.targetId ?? null),
        );
      }

      /** The host state this stream must match before a frame may paint. */
      identitySnapshot() {
        const snapshot = this.store.getSnapshot();
        if (!snapshot) return null;
        if (!this.targetId) {
          return {
            cuSessionId: snapshot.cuSessionId,
            targetGeneration: snapshot.targetGeneration,
            targetId: snapshot.target?.targetId ?? null,
            state: snapshot.state,
            active: ACTIVE_STATES.has(snapshot.state),
          };
        }
        const target = (snapshot.targets ?? []).find((item) => item.targetId === this.targetId);
        if (!target) return null;
        return {
          cuSessionId: snapshot.cuSessionId,
          targetGeneration: target.targetGeneration,
          targetId: target.targetId,
          state: target.state,
          active: target.active === true && ACTIVE_STATES.has(target.state),
          windowId: target.windowId,
        };
      }

      setStatus(info) {
        if (this.targetId) this.store.setPreview(info, this.targetId);
        else this.store.setPreview(info);
      }

      clearCanvas() {
        for (const canvas of this.canvases) {
          try {
            const ctx2d = canvas.getContext("2d", { alpha: false });
            if (ctx2d?.clearRect) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
          } catch {
            // A detached canvas is not a reason to fail the stream.
          }
        }
      }

      resetStream() {
        this.frames = 0;
        this.dropped = 0;
        this.fps = 0;
        this.fpsWindow = [];
        this.lastFrameAt = 0;
        this.invalid = null;
        this.decoding = false;
      }

      async open() {
        const snapshot = this.store.getSnapshot();
        if (!this.store.active) return;
        if (!snapshot?.cuSessionId || this.running || this.opening) return;
        const live = this.identitySnapshot();
        if (!live?.active) return;
        if (
          this.store.expanded === false &&
          this.store.previewWanted === false &&
          this.store.deckVisible === false
        ) return;
        const identity = {
          cuSessionId: snapshot.cuSessionId,
          targetGeneration: live.targetGeneration,
          targetId: live.targetId,
        };
        if (PreviewController.sameIdentity(this.blockedIdentity, identity)) return;
        // A failed attempt (409 before a target exists, child crash) must not
        // spawn one process per state poll. Retry at most once per second.
        const now = performance.now();
        if (now - this.lastAttemptAt < 1000) return;
        this.lastAttemptAt = now;

        const token = ++this.token;
        const streamIdentity = { token, ...identity };
        this.stream = streamIdentity;
        this.blockedIdentity = null;
        this.resetStream();
        // A new stream must not show the previous target while its first frame
        // is still being captured.
        this.clearCanvas();
        this.running = true;
        this.opening = true;
        this.abort = new AbortController();
        this.startedAt = now;
        this.setStatus({ status: "connecting", fps: 0, frameAgeMs: null, reason: null });
        this.firstFrameTimer = setTimeout(() => {
          if (token !== this.token || !this.running || this.frames > 0) return;
          this.degradeNoFirstFrame(token, identity);
        }, 1500);

        const url =
          `${PREVIEW_PATH}?hostSessionId=${encodeURIComponent(this.store.hostSessionId)}` +
          `&cuSessionId=${encodeURIComponent(identity.cuSessionId)}` +
          `&generation=${encodeURIComponent(identity.targetGeneration)}` +
          (identity.targetId ? `&targetId=${encodeURIComponent(identity.targetId)}` : "");

        try {
          const response = await fetch(url, {
            signal: this.abort.signal,
            credentials: "same-origin",
            cache: "no-store",
          });
          if (!response.ok || !response.body) {
            if (token === this.token && this.running) {
              this.setStatus({ status: "unavailable", reason: `http_${response.status}` });
            }
            return;
          }
          if (token !== this.token || !this.running) {
            // A newer target/session superseded this attempt while it was
            // connecting; drop it instead of running two capture clients.
            response.body?.cancel?.().catch?.(() => {});
            return;
          }
          const parser = new FrameParser((meta, jpeg) => this.present(meta, jpeg, streamIdentity));
          this.reader = response.body.getReader();
          for (;;) {
            const { done, value } = await this.reader.read();
            if (done) break;
            if (value) parser.push(value);
            if (parser.invalid) {
              this.invalid = parser.invalid;
              break;
            }
          }
          if (token === this.token && this.running && !this.abort.signal.aborted) {
            this.setStatus({ status: "stale", reason: this.invalid ?? "stream_ended" });
          }
        } catch (error) {
          if (token === this.token && error?.name !== "AbortError" && this.running) {
            this.setStatus({ status: "stale", reason: "stream_error" });
          }
        } finally {
          // A superseded stream must not reset the live one's flags or reader:
          // its finally runs after the replacement has already started.
          if (token === this.token) {
            this.running = false;
            this.opening = false;
            clearTimeout(this.firstFrameTimer);
            this.firstFrameTimer = null;
            try {
              this.reader?.releaseLock?.();
            } catch {
              // Already released by abort.
            }
            this.reader = null;
          }
        }
      }

      /**
       * No frame in 1500 ms is a failed stream, not an invitation to wait
       * forever behind a "stale" label. Abort it, name the reason, and block
       * this same identity from respawning until the target/session changes.
       */
      degradeNoFirstFrame(token, identity) {
        if (token !== this.token) return;
        this.running = false;
        this.opening = false;
        this.token += 1;
        this.blockedIdentity = { ...identity };
        this.stream = null;
        clearTimeout(this.firstFrameTimer);
        this.firstFrameTimer = null;
        clearTimeout(this.staleTimer);
        this.staleTimer = null;
        try {
          this.abort?.abort();
        } catch {
          // ignore
        }
        this.abort = null;
        try {
          this.reader?.cancel?.();
        } catch {
          // ignore
        }
        this.reader = null;
        this.decoding = false;
        this.setStatus({
          status: "stale",
          reason: "first_frame_timeout",
          fps: 0,
          frameAgeMs: null,
        });
      }

      present(meta, jpeg, identity) {
        // Every pending operation carries the stream it belongs to. A frame
        // from a closed/replaced stream is discarded before it allocates a
        // bitmap or touches decode state.
        if (!identity || identity.token !== this.token) return;
        if (!this.running || !this.abort || this.abort.signal.aborted) return;
        if (!meta || meta.version !== 1) return;
        if (meta.targetGeneration !== identity.targetGeneration) {
          this.dropped += 1;
          return;
        }
        if (meta.cuSessionId && meta.cuSessionId !== identity.cuSessionId) {
          this.dropped += 1;
          return;
        }
        const current = this.identitySnapshot();
        if (
          !current ||
          !current.active ||
          current.cuSessionId !== identity.cuSessionId ||
          current.targetGeneration !== identity.targetGeneration ||
          (current.targetId ?? null) !== (identity.targetId ?? null)
        ) {
          this.dropped += 1;
          return;
        }
        if (this.decoding) {
          this.dropped += 1;
          return; // at most one frame waiting to present
        }
        this.decoding = true;
        const token = identity.token;
        const startedDecode = performance.now();
        createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
          .then((bitmap) => {
            // A decode that resolves after the stream was replaced must not
            // clear the NEW stream's decoding lock or publish its frame.
            if (token !== this.token) {
              bitmap.close?.();
              return;
            }
            this.decoding = false;
            if (!this.running || this.abort?.signal.aborted || this.stream?.token !== token) {
              bitmap.close?.();
              return;
            }
            const latest = this.identitySnapshot();
            if (
              !latest ||
              !latest.active ||
              latest.cuSessionId !== identity.cuSessionId ||
              latest.targetGeneration !== identity.targetGeneration ||
              (latest.targetId ?? null) !== (identity.targetId ?? null)
            ) {
              bitmap.close?.();
              this.dropped += 1;
              return;
            }
            for (const canvas of this.canvases) {
              try {
                const ctx2d = canvas.getContext("2d", { alpha: false });
                if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
                if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
                ctx2d.drawImage(bitmap, 0, 0);
              } catch {
                // One detached canvas must not stop the other from painting.
              }
            }
            bitmap.close?.();
            this.frames += 1;
            const now = performance.now();
            this.lastFrameAt = now;
            this.fpsWindow.push(now);
            while (this.fpsWindow.length > 0 && now - this.fpsWindow[0] > 1000) this.fpsWindow.shift();
            this.fps = this.fpsWindow.length;
            this.setStatus({
              status: "live",
              fps: this.fps,
              frameAgeMs: 0,
              width: bitmap.width,
              height: bitmap.height,
              frameId: meta.frameId ?? null,
              decodeMs: Math.round((now - startedDecode) * 10) / 10,
              dropped: this.dropped,
              reason: null,
            });
            clearTimeout(this.firstFrameTimer);
            this.firstFrameTimer = null;
            clearTimeout(this.staleTimer);
            this.staleTimer = setTimeout(() => {
              if (
                token === this.token &&
                this.running &&
                this.lastFrameAt &&
                performance.now() - this.lastFrameAt > 2000
              ) {
                this.setStatus({ status: "stale", reason: "no_frames" });
              }
            }, 2000);
          })
          .catch(() => {
            if (token === this.token) {
              this.decoding = false;
              this.dropped += 1;
            }
          });
      }

      close() {
        this.running = false;
        this.opening = false;
        this.token += 1;
        clearTimeout(this.firstFrameTimer);
        this.firstFrameTimer = null;
        clearTimeout(this.staleTimer);
        this.staleTimer = null;
        try {
          this.abort?.abort();
        } catch {
          // ignore
        }
        this.abort = null;
        try {
          this.reader?.cancel?.();
        } catch {
          // ignore
        }
        this.reader = null;
        this.decoding = false;
        this.stream = null;
        // An explicit close (stop, unmount, target switch) is allowed to try
        // the next identity immediately; the 1 s rate limit only governs
        // automatic retries after a failure.
        this.lastAttemptAt = 0;
        this.blockedIdentity = null;
        if (this.frames > 0) {
          this.setStatus({ status: "unavailable", fps: 0, frameAgeMs: null, reason: "closed" });
        }
      }
    }

    // ---------------------------------------------------------------- store

    class SessionStore {
      constructor(hostSessionId) {
        this.hostSessionId = hostSessionId;
        this.listeners = new Set();
        this.mounts = 0;
        this.snapshot = {
          version: 1,
          revision: -1,
          hostSessionId,
          cuSessionId: null,
          state: "connecting",
          label: "",
          target: null,
          targetGeneration: 0,
          previewStatus: "unavailable",
          cleanupState: "clean",
        };
        this.connection = "connecting";
        this.lastError = null;
        this.dismissed = false;
        this.expanded = false;
        // The user explicitly asked to watch this session's preview. The card
        // stays a ~40 px strip until this is true.
        this.watching = false;
        this.previewWanted = false;
        this.deckVisible = false;
        this.deckCollapsed = false;
        this.deckHiddenSignature = null;
        this.hiddenTargets = new Set();
        this.expandedTargets = new Set();
        this.previews = new Map();
        this.previewInfos = new Map();
        this.preview = this.previewFor(null);
        this.previewInfo = { status: "unavailable", fps: 0, frameAgeMs: null };
        this.selectedTargetId = null;
        this.probe = null;
        this.timer = null;
        this.abort = null;
        this.inflight = false;
        // Lifecycle identity: every start begins a new epoch and every pending
        // operation (poll, control, preview) carries the epoch/token it began
        // under. A settle after stop/remount belongs to history.
        this.active = false;
        this.lifecycleEpoch = 0;
        this.inflightEpoch = 0;
        this.stopping = false;
        this.stoppingAll = false;
        this.stoppingTargets = new Set();
        this.stoppedAt = null;
        this.pollInterval = 1000;
        this.visibilityHandler = null;
        this.view = null;
        this.rebuildView();
      }

      /**
       * One composite snapshot for React. notify() alone used to leave
       * getSnapshot() returning the identical object, so previewInfo,
       * connection and stopping changes were invisible until the next poll.
       */
      previewFor(targetId = null) {
        const key = targetId ?? "__primary__";
        let controller = this.previews.get(key);
        if (!controller) {
          controller = new PreviewController(this, targetId ?? null);
          this.previews.set(key, controller);
        }
        return controller;
      }

      targets() {
        return Array.isArray(this.snapshot?.targets) ? this.snapshot.targets : [];
      }

      primaryTarget() {
        const targets = this.targets();
        return (
          targets.find((target) => target.targetId === this.snapshot?.target?.targetId) ??
          targets.find((target) => target.active) ??
          targets[0] ??
          null
        );
      }

      selectTarget(targetId) {
        this.selectedTargetId = targetId ?? null;
        this.notify();
      }

      deckSignature() {
        return `${this.snapshot?.cuSessionId ?? ""}:${this.targets()
          .map((target) => target.targetId)
          .join(",")}`;
      }

      dismissDeck() {
        for (const target of this.targets()) this.hiddenTargets.add(target.targetId);
        this.deckVisible = false;
        this.deckHiddenSignature = this.deckSignature();
        // Closing the deck must release its preview children, unless the user
        // separately chose Watch or has the enlarged overlay open.
        if (!this.watching && !this.expanded) this.closePreviews();
        this.notify();
      }

      dismissTargetPanel(targetId) {
        if (!targetId) return;
        this.hiddenTargets.add(targetId);
        this.expandedTargets.delete(targetId);
        const active = this.targets().filter(
          (target) => target.active === true && ACTIVE_STATES.has(target.state),
        );
        if (active.length > 0 && active.every((target) => this.hiddenTargets.has(target.targetId))) {
          this.deckVisible = false;
          this.deckHiddenSignature = this.deckSignature();
        }
        this.notify();
      }

      showDeck() {
        this.deckVisible = true;
        this.deckHiddenSignature = null;
        this.hiddenTargets.clear();
        this.notify();
        this.openPreviews();
      }

      toggleTargetCollapsed(targetId) {
        if (!targetId) return;
        if (this.expandedTargets.has(targetId)) {
          this.expandedTargets.delete(targetId);
          // Collapsing drops the capture with it: no hidden stream keeps the
          // screen-record indicator on.
          this.previewFor(targetId).close();
        } else {
          this.expandedTargets.add(targetId);
          this.openPreviews();
        }
        this.notify();
      }

      toggleDeckCollapsed() {
        this.deckCollapsed = !this.deckCollapsed;
        this.notify();
      }

      openPreviews() {
        if (!this.active) return;
        // Control-only deck: a visible deck is not a reason to capture. Frames
        // start only for a card the user expanded, for Watch, or for the big
        // panel. Otherwise every automatic deck show would open a ScreenCaptureKit
        // stream on the targets and re-trigger the system capture consent.
        const wantsAll = this.expanded === true || this.previewWanted === true;
        if (!wantsAll && this.expandedTargets.size === 0) return;
        const targets = this.targets();
        if (targets.length === 0) {
          this.preview.open();
          return;
        }
        for (const target of targets) {
          if (target.active !== true || !ACTIVE_STATES.has(target.state)) continue;
          if (!wantsAll && !this.expandedTargets.has(target.targetId)) continue;
          this.previewFor(target.targetId).open();
        }
        // A target can finish between the two polls; keep the legacy primary
        // path alive only when the host has not published target rows at all.
      }

      closePreviews() {
        for (const controller of this.previews.values()) controller.close();
      }

      rebuildView() {
        this.view = {
          ...this.snapshot,
          previewInfo: this.previewInfo,
          targetPreviews: Object.fromEntries(this.previewInfos),
          selectedTargetId: this.selectedTargetId,
          connection: this.connection,
          lastError: this.lastError,
          stopping: this.stopping === true,
          stoppingAll: this.stoppingAll === true,
          stoppingTargets: [...this.stoppingTargets],
          expanded: this.expanded,
          watching: this.watching,
          previewWanted: this.previewWanted,
          deckVisible: this.deckVisible,
          deckCollapsed: this.deckCollapsed,
          hiddenTargetIds: [...this.hiddenTargets],
          expandedTargetIds: [...this.expandedTargets],
          stoppedAt: this.stoppedAt,
          probe: this.probe,
        };
        return this.view;
      }

      getSnapshot = () => this.view ?? this.rebuildView();

      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      };

      notify() {
        this.rebuildView();
        for (const listener of [...this.listeners]) {
          try {
            listener();
          } catch {
            // A view must never break polling.
          }
        }
      }

      mount() {
        this.mounts += 1;
        if (this.mounts === 1) {
          this.dismissed = false;
          this.start();
          // The carrier probe is a diagnosis route, not product traffic. It is
          // only exercised by tests; a normal client never sends it.
        }
        return () => {
          this.mounts = Math.max(0, this.mounts - 1);
          if (this.mounts === 0) this.stop();
        };
      }

      setConnection(connection) {
        if (this.connection === connection) return;
        this.connection = connection;
        this.notify();
      }

      start() {
        if (this.active) return;
        this.active = true;
        this.lifecycleEpoch += 1;
        this.inflight = false;
        this.inflightEpoch = 0;
        this.abort = null;
        this.stopping = false;
        if (typeof document !== "undefined") {
          this.visibilityHandler = () => {
            if (document.visibilityState === "hidden") {
              this.closePreviews();
            } else {
              this.pollNow(true);
              if (this.expanded || this.previewWanted) this.openPreviews();
            }
          };
          document.addEventListener("visibilitychange", this.visibilityHandler);
        }
        this.pollNow(true, this.lifecycleEpoch);
      }

      stop() {
        this.active = false;
        this.lifecycleEpoch += 1;
        clearTimeout(this.timer);
        this.timer = null;
        const controller = this.abort;
        this.abort = null;
        this.inflight = false;
        this.inflightEpoch = 0;
        try {
          controller?.abort();
        } catch {
          // ignore
        }
        this.closePreviews();
        this.deckVisible = false;
        if (typeof document !== "undefined" && this.visibilityHandler) {
          document.removeEventListener("visibilitychange", this.visibilityHandler);
          this.visibilityHandler = null;
        }
      }

      schedule(delay, epoch = this.lifecycleEpoch) {
        if (!this.active || epoch !== this.lifecycleEpoch) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.active || epoch !== this.lifecycleEpoch) return;
          this.pollNow(false, epoch);
        }, delay);
      }

      async pollNow(immediate, epoch = this.lifecycleEpoch) {
        if (!this.active || epoch !== this.lifecycleEpoch) return;
        if (this.inflight && this.inflightEpoch === epoch) return;
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          this.schedule(800, epoch);
          return;
        }
        this.inflight = true;
        this.inflightEpoch = epoch;
        const controller = new AbortController();
        this.abort = controller;
        try {
          const data = await postJson(
            STATE_PATH,
            { hostSessionId: this.hostSessionId },
            controller.signal,
          );
          if (!this.active || epoch !== this.lifecycleEpoch) return;
          this.applySnapshot(data.snapshot);
          this.setConnection("live");
          this.lastError = null;
        } catch (error) {
          if (error?.name === "AbortError") return;
          if (!this.active || epoch !== this.lifecycleEpoch) return;
          const unauthorized = error?.status === 401 || error?.status === 403;
          this.setConnection(unauthorized ? "unauthorized" : "reconnecting");
          this.lastError = error?.message ?? String(error);
        } finally {
          if (this.inflightEpoch === epoch) {
            this.inflight = false;
            this.inflightEpoch = 0;
          }
          if (this.abort === controller) this.abort = null;
          if (this.active && epoch === this.lifecycleEpoch) {
            const interval = ACTIVE_STATES.has(this.snapshot.state) ? 250 : this.pollInterval;
            this.schedule(immediate ? 60 : interval, epoch);
          }
        }
      }

      applySnapshot(next) {
        if (!this.active) return;
        if (!next || typeof next !== "object") return;
        if (!Number.isInteger(next.revision)) return;
        if (this.snapshot.revision > next.revision) return; // never regress
        const previous = this.snapshot;
        const previousTargets = new Map(
          (Array.isArray(previous.targets) ? previous.targets : []).map((target) => [
            target.targetId,
            target,
          ]),
        );
        const wasActive = ACTIVE_STATES.has(previous.state);
        const becameActive = ACTIVE_STATES.has(next.state);
        const wasFinal = FINAL_STATES.has(previous.state);
        this.snapshot = next;
        const targets = Array.isArray(next.targets) ? next.targets : [];
        if (previous.cuSessionId !== next.cuSessionId) this.closePreviews();
        if (targets.length > 0) {
          // The legacy single-target controller is not used once the host has
          // published target rows; close it so no orphan stream survives the
          // transition.
          this.preview.close();
          // A target's stream is retired when its window incarnation changes,
          // when it is stopped, or when the whole target disappears. A sibling
          // target's stream is untouched.
          for (const [targetId, old] of previousTargets) {
            const current = targets.find((target) => target.targetId === targetId);
            if (
              !current ||
              current.active !== true ||
              Number(current.targetGeneration) !== Number(old.targetGeneration) ||
              !ACTIVE_STATES.has(current.state)
            ) {
              this.previewFor(targetId).close();
            }
            if (current && Number(current.targetGeneration) !== Number(old.targetGeneration)) {
              this.hiddenTargets.delete(targetId);
              this.expandedTargets.delete(targetId);
            }
          }
          for (const key of [...this.previews.keys()]) {
            if (key === "__primary__") continue;
            if (!targets.some((target) => target.targetId === key)) {
              this.previewFor(key).close();
              this.previews.delete(key);
              this.previewInfos.delete(key);
            }
          }
          const selected = targets.find((target) => target.targetId === this.selectedTargetId);
          if (!selected || selected.active !== true || !ACTIVE_STATES.has(selected.state)) {
            this.selectedTargetId =
              targets.find((target) => target.active === true && ACTIVE_STATES.has(target.state))?.targetId ??
              next.target?.targetId ??
              targets[0]?.targetId ??
              null;
          }
        } else {
          // Legacy single-target snapshots keep their original identity logic.
          if (
            previous.targetGeneration !== next.targetGeneration ||
            previous.cuSessionId !== next.cuSessionId
          ) {
            this.preview.close();
          }
        }
        const hasActiveTarget = targets.some(
          (target) => target.active === true && ACTIVE_STATES.has(target.state),
        );
        const sessionFinal =
          FINAL_STATES.has(next.state) && (targets.length === 0 || !hasActiveTarget);
        const knownTargets = new Set(targets.map((target) => target.targetId));
        for (const targetId of [...this.hiddenTargets]) {
          if (!knownTargets.has(targetId)) this.hiddenTargets.delete(targetId);
        }
        for (const targetId of [...this.expandedTargets]) {
          if (!knownTargets.has(targetId)) this.expandedTargets.delete(targetId);
        }
        const signature = `${next.cuSessionId ?? ""}:${targets.map((target) => target.targetId).join(",")}`;
        if (hasActiveTarget && this.deckHiddenSignature !== signature) {
          this.deckVisible = true;
          this.deckCollapsed = false;
        }
        if (!hasActiveTarget) {
          this.deckVisible = false;
          this.deckHiddenSignature = null;
          this.hiddenTargets.clear();
          this.expandedTargets.clear();
        }
        if (sessionFinal) {
          this.stoppedAt = this.stoppedAt ?? Date.now();
          // A finished session keeps no live view; the last frame is already
          // on screen and the card says it is stopped.
          this.watching = false;
          this.previewWanted = false;
          this.closePreviews();
        }
        this.notify();
        if (becameActive && !wasActive) {
          this.dismissed = false;
          this.stoppedAt = null;
          this.watching = false;
          this.previewWanted = false;
        }
        if (wasFinal && ACTIVE_STATES.has(next.state)) {
          this.watching = false;
          this.previewWanted = false;
        }
        const wantsFrames = this.expanded || this.previewWanted || this.expandedTargets.size > 0;
        if (wantsFrames && hasActiveTarget) {
          this.openPreviews();
        } else if (wantsFrames && targets.length === 0) {
          this.preview.open();
        }
      }

      setPreview(info, targetId = null) {
        if (targetId) {
          this.previewInfos.set(targetId, {
            ...(this.previewInfos.get(targetId) ?? {}),
            ...info,
          });
        } else {
          this.previewInfo = { ...this.previewInfo, ...info };
        }
        this.notify();
      }

      toggleWatch() {
        if (FINAL_STATES.has(this.snapshot.state) && this.targets().every((target) => !target.active)) return;
        if (this.watching) {
          this.watching = false;
          this.previewWanted = false;
          this.closePreviews();
        } else {
          this.watching = true;
          this.previewWanted = true;
          this.pollNow(true);
          this.openPreviews();
        }
        this.notify();
      }

      toggleExpanded() {
        this.expanded = !this.expanded;
        if (this.expanded) {
          this.previewWanted = true;
          expansion.set(this.hostSessionId);
          this.pollNow(true);
          this.openPreviews();
        } else {
          expansion.set(null);
          // Collapsing the big panel returns to the card the user was already
          // watching; it never starts a preview they did not ask for.
          this.previewWanted = this.watching === true;
          if (!this.previewWanted) this.closePreviews();
        }
        this.notify();
      }

      closeExpanded() {
        if (!this.expanded) return;
        this.expanded = false;
        expansion.set(null);
        this.previewWanted = this.watching === true;
        if (!this.previewWanted) this.closePreviews();
        this.notify();
      }

      dismiss() {
        this.dismissed = true;
        this.closeExpanded();
        this.notify();
      }

      async stopControl(command = "stop", targetId = null) {
        if (targetId) {
          if (this.stoppingTargets.has(targetId)) return;
          if (this.stoppingAll) return;
        } else if (this.stopping || this.stoppingAll) {
          return;
        }
        const epoch = this.lifecycleEpoch;
        if (targetId) this.stoppingTargets.add(targetId);
        else {
          this.stopping = true;
          this.stoppingAll = true;
        }
        this.notify();
        try {
          // STOP is identity-based: the server ignores ordinary state revisions
          // so a click between two polls still stops. Sending expectedRevision
          // here would reintroduce exactly the 409 this fixes. A target stop
          // does not request a session-wide pause; only stop-all does.
          const data = await postJson(CONTROL_PATH, {
            hostSessionId: this.hostSessionId,
            cuSessionId: this.snapshot.cuSessionId,
            command,
            ...(targetId ? { targetId } : {}),
            pause: targetId ? false : true,
          });
          if (!this.active || epoch !== this.lifecycleEpoch) return;
          // Prefer the host's authoritative snapshot. Never fabricate
          // revision+1: that poisons the monotonic revision gate and hides the
          // real state until the next poll.
          if (data?.snapshot) {
            this.applySnapshot(data.snapshot);
          } else if (data?.state) {
            this.snapshot = {
              ...this.snapshot,
              state: data.state,
              cleanupState: data.cleanupState ?? this.snapshot.cleanupState,
            };
            this.notify();
          }
          this.lastError = null;
          if (targetId) {
            this.previewFor(targetId).close();
          } else {
            this.stoppedAt = Date.now();
            this.closePreviews();
          }
          this.pollNow(true, epoch);
        } catch (error) {
          if (!this.active || epoch !== this.lifecycleEpoch) return;
          this.lastError = error?.message ?? String(error);
          this.notify();
          // A stale_session means a newer session already exists; this stop was
          // for the old one. Never replay the stop against the new session.
          this.pollNow(true, epoch);
        } finally {
          if (epoch === this.lifecycleEpoch) {
            if (targetId) this.stoppingTargets.delete(targetId);
            else {
              this.stopping = false;
              this.stoppingAll = false;
            }
            this.notify();
          }
        }
      }

      async runProbe() {
        // Carrier proof: first chunk must arrive before EOF, and abort must end
        // the read. Kept in memory for the diagnostics row and the acceptance
        // harness; nothing here is sent to the model.
        if (this.probe) return this.probe;
        const startedAt = performance.now();
        const controller = new AbortController();
        let firstChunkMs = null;
        let chunks = 0;
        try {
          const response = await fetch(PROBE_PATH, {
            signal: controller.signal,
            credentials: "same-origin",
            cache: "no-store",
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let text = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && firstChunkMs === null) firstChunkMs = Math.round(performance.now() - startedAt);
            chunks += 1;
            text += decoder.decode(value, { stream: true });
            if (firstChunkMs !== null && chunks === 1) {
              // Read again to prove the body was not one buffered response.
              const next = await reader.read();
              if (!next.done) {
                chunks += 1;
                text += decoder.decode(next.value, { stream: true });
              }
              controller.abort();
              break;
            }
          }
          const lines = text.trim().split("\n").filter(Boolean).map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          });
          this.probe = {
            ok: true,
            firstChunkMs,
            totalMs: Math.round(performance.now() - startedAt),
            chunks,
            events: lines.filter(Boolean),
            aborted: controller.signal.aborted,
            carrier: `fetch ${location.protocol}//${location.host}`,
          };
        } catch (error) {
          this.probe = {
            ok: false,
            error: error?.message ?? String(error),
            firstChunkMs,
            chunks,
            carrier: `fetch ${location.protocol}//${location.host}`,
          };
        }
        this.notify();
        return this.probe;
      }
    }

    // One shared expansion slot: at most one enlarged panel across the page.
    const expansion = {
      value: null,
      listeners: new Set(),
      subscribe(fn) {
        expansion.listeners.add(fn);
        return () => expansion.listeners.delete(fn);
      },
      get() {
        return expansion.value;
      },
      set(value) {
        if (expansion.value === value) return;
        expansion.value = value;
        for (const fn of [...expansion.listeners]) fn();
      },
    };

    // The floating Control Deck is a root overlay with no owner props. Track
    // the conversation whose composer card is currently mounted; that is the
    // chat whose targets the deck must show.
    const activeDeckSession = {
      value: null,
      listeners: new Set(),
      subscribe(fn) {
        activeDeckSession.listeners.add(fn);
        return () => activeDeckSession.listeners.delete(fn);
      },
      get() {
        return activeDeckSession.value;
      },
      set(value) {
        if (activeDeckSession.value === value) return;
        activeDeckSession.value = value;
        for (const fn of [...activeDeckSession.listeners]) fn();
      },
    };

    const stores = new Map();
    function storeFor(hostSessionId) {
      let store = stores.get(hostSessionId);
      if (!store) {
        store = new SessionStore(hostSessionId);
        stores.set(hostSessionId, store);
      }
      return store;
    }

    // ---------------------------------------------------------------- styles

    const CSS = `
.scu-root { pointer-events: auto; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased; --scu-radius: 16px; --scu-fg: var(--dsw-alias-label-primary); --scu-fg2: var(--dsw-alias-label-secondary);
  --scu-line: var(--dsw-alias-border-l1); --scu-line2: var(--dsw-alias-border-l2);
  --scu-surface: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 78%, transparent);
  --scu-accent: var(--dsw-alias-brand-primary); --scu-ok: var(--dsw-alias-state-success-primary);
  --scu-warn: var(--dsw-alias-state-warn-primary); --scu-err: var(--dsw-alias-state-error-primary);
  color: var(--scu-fg); font-size: 12px; line-height: 1.35; }
.scu-float-stack { position: fixed; right: 20px; bottom: 96px; z-index: 80; pointer-events: none;
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  max-height: calc(100vh - 128px); overflow-y: auto; overflow-x: visible; padding: 4px 2px 4px 10px; }
.scu-float-stack::-webkit-scrollbar { width: 0; height: 0; }
.scu-float { pointer-events: auto; position: relative; box-sizing: border-box;
  width: min(284px, calc(100vw - 40px));
  border-radius: 16px; overflow: hidden; color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  background: rgba(22, 22, 24, .74);
  -webkit-backdrop-filter: blur(34px) saturate(180%); backdrop-filter: blur(34px) saturate(180%);
  border: .5px solid rgba(255, 255, 255, .14);
  box-shadow: 0 18px 44px rgba(0, 0, 0, .34), 0 2px 6px rgba(0, 0, 0, .18), 0 0 0 .5px rgba(0, 0, 0, .22),
    inset 0 .5px 0 rgba(255, 255, 255, .10);
  transition: transform 240ms cubic-bezier(.22, 1, .36, 1), box-shadow 240ms ease;
  animation: scu-float-in 380ms cubic-bezier(.22, 1, .36, 1) both;
  animation-delay: calc(var(--scu-float-index, 0) * 45ms); }
.scu-float.is-expanded { width: min(332px, calc(100vw - 40px)); }
.scu-float:hover { transform: translateY(-1px);
  box-shadow: 0 22px 52px rgba(0, 0, 0, .36), 0 2px 8px rgba(0, 0, 0, .18), 0 0 0 .5px rgba(0, 0, 0, .20); }
.scu-float-head { display: flex; align-items: center; gap: 9px; padding: 9px 8px 9px 12px; min-height: 38px; }
.scu-float-orb { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: #0a84ff;
  box-shadow: 0 0 0 3px rgba(10, 132, 255, .16);
  transition: background 180ms ease, box-shadow 180ms ease; }
.scu-float-orb[data-state="verified"], .scu-float-state-dot[data-state="verified"] { background: #30d158; }
.scu-float-orb[data-state="unverified"], .scu-float-state-dot[data-state="unverified"] { background: #ffd60a; }
.scu-float-orb[data-state="failed"], .scu-float-state-dot[data-state="failed"] { background: #ff453a; }
.scu-float-orb[data-state="waiting"], .scu-float-state-dot[data-state="waiting"] { animation: scu-pulse 1.6s ease-in-out infinite; }
.scu-float-titles { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.scu-float-app { font-size: 12.5px; font-weight: 590; letter-spacing: -.01em; color: #fff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scu-float-sub { font-size: 10.5px; color: rgba(255, 255, 255, .56);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scu-float-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.scu-float-icon { appearance: none; border: 0; width: 22px; height: 22px; padding: 0; border-radius: 50%;
  display: grid; place-items: center; background: transparent; color: rgba(255, 255, 255, .52); cursor: pointer;
  font-size: 13px; line-height: 1; transition: background 140ms ease, color 140ms ease, transform 140ms ease, opacity 160ms ease; }
.scu-float-icon:hover { background: rgba(255, 255, 255, .13); color: #fff; }
.scu-float-icon:active { transform: scale(.92); }
.scu-float-close:hover { color: #ff6b60; background: rgba(255, 69, 58, .18); }
.scu-float-glyph { transform: translateY(-.5px); }
.scu-float-reveal { opacity: 0; }
.scu-float:hover .scu-float-reveal, .scu-float:focus-within .scu-float-reveal { opacity: 1; }
.scu-float-preview { position: relative; margin: 0 8px 8px; border-radius: 12px; overflow: hidden;
  background: #000; aspect-ratio: 16 / 10;
  box-shadow: inset 0 0 0 .5px rgba(255, 255, 255, .10); }
.scu-float-canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
.scu-float-vignette { position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(180deg, rgba(0, 0, 0, .14), transparent 22% 66%, rgba(0, 0, 0, .42)); }
.scu-float-live { position: absolute; left: 7px; top: 7px; z-index: 2; display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 7px; border-radius: 999px; font-size: 9px; font-weight: 620; letter-spacing: .07em;
  color: rgba(255, 255, 255, .92); background: rgba(20, 20, 22, .50);
  border: .5px solid rgba(255, 255, 255, .14);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
.scu-float-live::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #30d158;
  box-shadow: 0 0 8px rgba(48, 209, 88, .75); }
.scu-float-live[data-status="stale"]::before { background: #ffd60a; box-shadow: 0 0 8px rgba(255, 214, 10, .65); }
.scu-float-window { position: absolute; right: 7px; top: 7px; z-index: 2; padding: 2px 7px; border-radius: 999px;
  font-size: 9px; color: rgba(255, 255, 255, .62); background: rgba(20, 20, 22, .46);
  border: .5px solid rgba(255, 255, 255, .10);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
.scu-float-wait { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center;
  color: rgba(255, 255, 255, .48); font-size: 10.5px; letter-spacing: .01em; }
.scu-float .scu-stop { appearance: none; border: 0; border-radius: 999px; padding: 3px 9px;
  font-size: 10.5px; font-weight: 590; cursor: pointer; flex: 0 0 auto;
  color: #ff6b60; background: rgba(255, 69, 58, .16);
  transition: background 150ms ease, transform 150ms ease; }
.scu-float .scu-stop:hover { background: rgba(255, 69, 58, .28); }
.scu-float .scu-stop:active { transform: scale(.96); }
.scu-float .scu-stop:disabled { opacity: .5; cursor: default; }
@media (max-width: 720px) {
  .scu-float-stack { right: 8px; bottom: 76px; max-height: calc(100vh - 96px); }
  .scu-float, .scu-float.is-expanded { width: calc(100vw - 16px); }
}
@media (prefers-reduced-motion: reduce) {
  .scu-float { animation: none !important; transition: none !important; }
  .scu-float:hover { transform: none; }
}
@keyframes scu-float-in {
  from { opacity: 0; transform: translateY(14px) scale(.965); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.scu-card { box-sizing: border-box; width: min(320px, 100%); margin: 7px auto 3px; border-radius: var(--scu-radius);
  border: 1px solid color-mix(in srgb, #fff 10%, var(--scu-line));
  background: linear-gradient(180deg, color-mix(in srgb, #fff 7%, transparent), transparent 32%),
    color-mix(in srgb, var(--scu-surface) 90%, transparent);
  -webkit-backdrop-filter: blur(28px) saturate(1.55); backdrop-filter: blur(28px) saturate(1.55);
  box-shadow: 0 12px 32px rgba(0,0,0,.18), 0 1px 0 rgba(255,255,255,.12) inset;
  padding: 9px 11px 10px; overflow: hidden; animation: scu-in 240ms cubic-bezier(.22,1,.36,1) both; }
.scu-strip { display: flex; align-items: center; gap: 9px; min-height: 44px; padding: 6px 9px; }
.scu-strip .scu-head { flex: 1 1 auto; min-height: 0; }
.scu-strip .scu-app { font-size: 11.5px; }
.scu-strip .scu-sub { font-size: 10.5px; }
.scu-watch { appearance: none; border: 1px solid color-mix(in srgb, var(--scu-accent) 38%, var(--scu-line));
  background: color-mix(in srgb, var(--scu-accent) 9%, transparent); color: var(--scu-accent);
  border-radius: 999px; padding: 4px 10px; font-size: 10.5px; font-weight: 600; cursor: pointer; flex: 0 0 auto;
  transition: background 150ms ease, transform 150ms ease; }
.scu-watch:active { transform: scale(.96); }
.scu-watch:hover { background: color-mix(in srgb, var(--scu-accent) 18%, transparent); }
.scu-watch:focus-visible { outline: 2px solid var(--scu-accent); outline-offset: 1px; }
.scu-head { display: flex; align-items: center; gap: 8px; min-height: 26px; }
.scu-dot { width: 8px; height: 8px; border-radius: 99px; flex: 0 0 auto; background: var(--scu-fg2);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--scu-fg2) 16%, transparent); transition: background 180ms ease, box-shadow 180ms ease; }
.scu-dot[data-state="running"], .scu-dot[data-state="claimed"] { background: var(--scu-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--scu-accent) 22%, transparent); animation: scu-pulse 1.4s ease-in-out infinite; }
.scu-dot[data-state="verified"] { background: var(--scu-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--scu-ok) 20%, transparent); }
.scu-dot[data-state="failed"] { background: var(--scu-err); box-shadow: 0 0 0 3px color-mix(in srgb, var(--scu-err) 20%, transparent); }
.scu-dot[data-state="waiting"], .scu-dot[data-state="stopping"], .scu-dot[data-state="cleanup_unknown"] { background: var(--scu-warn); }
.scu-titles { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.scu-app { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: .01em; }
.scu-sub { color: var(--scu-fg2); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scu-icon { appearance: none; border: 1px solid transparent; background: transparent; color: var(--scu-fg2);
  width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; cursor: pointer; flex: 0 0 auto; padding: 0; }
.scu-icon:hover { background: color-mix(in srgb, var(--scu-fg) 8%, transparent); color: var(--scu-fg); }
.scu-icon:focus-visible { outline: 2px solid var(--scu-accent); outline-offset: 1px; }
.scu-body { position: relative; margin-top: 7px; border-radius: 9px; overflow: hidden; background: #07090c;
  aspect-ratio: 16 / 10; border: 1px solid color-mix(in srgb, var(--scu-line) 70%, transparent); }
.scu-body[data-compact="1"] { aspect-ratio: 16 / 9; max-height: 150px; }
.scu-canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
.scu-empty { position: absolute; inset: 0; display: grid; place-items: center; color: #9aa4b2; font-size: 11px; text-align: center; padding: 8px; }
.scu-badge { position: absolute; top: 6px; left: 6px; border-radius: 99px; padding: 2px 7px; font-size: 10px; font-weight: 600;
  color: #fff; background: rgba(0,0,0,.5); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); letter-spacing: .02em; }
.scu-badge[data-status="live"] { background: color-mix(in srgb, var(--scu-ok) 78%, transparent); }
.scu-badge[data-status="stale"] { background: color-mix(in srgb, var(--scu-warn) 82%, transparent); color: #1b1300; }
.scu-foot { display: flex; align-items: center; gap: 8px; margin-top: 7px; min-height: 24px; }
.scu-meta { color: var(--scu-fg2); font-size: 10.5px; flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.scu-stop { appearance: none; border: 1px solid color-mix(in srgb, var(--scu-err) 36%, var(--scu-line));
  background: color-mix(in srgb, var(--scu-err) 9%, transparent); color: var(--scu-err);
  border-radius: 999px; padding: 4px 11px; font-size: 10.5px; font-weight: 600; cursor: pointer; flex: 0 0 auto;
  transition: background 150ms ease, transform 150ms ease; }
.scu-stop:active { transform: scale(.96); }
.scu-stop:hover { background: color-mix(in srgb, var(--scu-err) 20%, transparent); }
.scu-stop:disabled { opacity: .55; cursor: default; }
.scu-stop:focus-visible { outline: 2px solid var(--scu-err); outline-offset: 1px; }
.scu-error { margin-top: 6px; color: var(--scu-err); font-size: 10.5px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.scu-perm-btn { appearance: none; border: 1px solid var(--scu-line2); background: color-mix(in srgb, var(--dsw-alias-primary, #4b70e2) 18%, transparent); color: var(--scu-fg); border-radius: 6px; padding: 2px 8px; font-size: 10.5px; font-weight: 550; cursor: pointer; }
.scu-perm-btn:hover { background: color-mix(in srgb, var(--dsw-alias-primary, #4b70e2) 32%, transparent); }
.scu-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(6,8,12,.34);
  -webkit-backdrop-filter: blur(18px) saturate(1.1); backdrop-filter: blur(18px) saturate(1.1);
  display: grid; place-items: center; padding: 24px; animation: scu-fade 220ms ease-out both; }
.scu-panel { width: min(880px, 94vw); max-height: min(78vh, 760px); border-radius: 24px; overflow: hidden;
  background: linear-gradient(180deg, color-mix(in srgb, #fff 7%, transparent), transparent 30%),
    color-mix(in srgb, var(--dsw-alias-bg-overlay) 88%, transparent);
  border: 1px solid color-mix(in srgb, #fff 13%, var(--scu-line2));
  box-shadow: 0 38px 100px rgba(0,0,0,.48), 0 2px 0 rgba(255,255,255,.1) inset;
  -webkit-backdrop-filter: blur(34px) saturate(1.6); backdrop-filter: blur(34px) saturate(1.6);
  display: flex; flex-direction: column; animation: scu-rise 280ms cubic-bezier(.22,1,.36,1) both; }
.scu-panel-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--scu-line); }
.scu-panel-title { font-weight: 650; font-size: 13.5px; letter-spacing: -.01em; }
.scu-panel-sub { color: var(--scu-fg2); font-size: 11px; flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scu-panel-body { position: relative; flex: 1 1 auto; min-height: 240px; margin: 8px; border-radius: 16px; overflow: hidden;
  background: #05070a; display: grid; place-items: center; border: 1px solid color-mix(in srgb, #fff 8%, transparent); }
.scu-panel-canvas { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; display: block; }
.scu-multi { width: min(640px, 100%); }
.scu-targets { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 7px; margin-top: 7px; }
.scu-target { min-width: 0; border: 1px solid var(--scu-line); border-radius: 9px; padding: 6px; background: color-mix(in srgb, var(--scu-fg) 3%, transparent); }
.scu-target[data-state="stopped"], .scu-target[data-state="cleanup_unknown"] { opacity: .68; }
.scu-target-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.scu-target-head .scu-stop { padding: 2px 6px; font-size: 10px; }
.scu-target-body { position: relative; margin-top: 5px; border-radius: 6px; overflow: hidden; background: #07090c; aspect-ratio: 16 / 10; }
.scu-target-canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
.scu-target-foot { display: flex; margin-top: 4px; min-height: 14px; }
.scu-target-foot .scu-meta { font-size: 10px; }
.scu-tabs { display: flex; gap: 4px; padding: 7px 12px 0; overflow-x: auto; border-bottom: 1px solid var(--scu-line); }
.scu-tab { appearance: none; border: 1px solid var(--scu-line); border-bottom: none; border-radius: 7px 7px 0 0;
  background: transparent; color: var(--scu-fg2); padding: 4px 9px; font-size: 11px; cursor: pointer; white-space: nowrap; }
.scu-tab[aria-selected="true"] { background: color-mix(in srgb, var(--scu-accent) 13%, transparent); color: var(--scu-fg); border-color: var(--scu-accent); }
.scu-tab[data-state="failed"] { color: var(--scu-err); }
.scu-stop-all { border-color: color-mix(in srgb, var(--scu-err) 65%, var(--scu-line)); }
.scu-panel-foot { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-top: 1px solid var(--scu-line); flex-wrap: wrap; }
.scu-diag { border-top: 1px dashed var(--scu-line); color: var(--scu-fg2); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.scu-diag > summary { cursor: pointer; padding: 6px 12px; list-style: none; user-select: none; }
.scu-diag > summary::-webkit-details-marker { display: none; }
.scu-diag > summary::before { content: "▸ "; color: var(--scu-fg2); }
.scu-diag[open] > summary::before { content: "▾ "; }
.scu-diag-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 4px 14px; padding: 0 12px 10px; }
.scu-diag b { color: var(--scu-fg); font-weight: 600; }
.scu-hint { color: var(--scu-fg2); font-size: 10.5px; flex: 1 1 220px; }
@keyframes scu-in { from { opacity: 0; transform: translateY(4px) scale(.995); } to { opacity: 1; transform: none; } }
@keyframes scu-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes scu-rise { from { opacity: 0; transform: translateY(8px) scale(.99); } to { opacity: 1; transform: none; } }
@keyframes scu-pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
/* Native settings section. Inherit the host theme: this surface lives outside
   the chat card, so it uses the shell's tokens. */
.scu-native { color: var(--scu-fg, inherit); font-size: 13px; line-height: 1.55; }
.scu-native-wrap { max-width: 760px; margin: 0 auto; padding: 28px 26px 48px; }
.scu-native-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 22px; }
.scu-native-head h2 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.01em; }
.scu-native-head p { margin: 3px 0 0; color: var(--scu-fg2, #888); font-size: 12px; }
.scu-native-head .scu-native-actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.scu-native-card { border: 1px solid var(--scu-line, rgba(127,127,127,.25)); border-radius: 14px; padding: 16px 18px; margin-bottom: 14px; background: rgba(127,127,127,.045); }
.scu-native-card > h3 { margin: 0 0 12px; font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; color: var(--scu-fg2, #888); }
.scu-native-row { display: flex; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--scu-line, rgba(127,127,127,.18)); }
.scu-native-row:last-child { border-bottom: 0; }
.scu-native-row-main { flex: 1 1 auto; min-width: 0; }
.scu-native-row-main b { display: block; font-weight: 600; font-size: 13px; }
.scu-native-row-main small { display: block; color: var(--scu-fg2, #888); font-size: 11.5px; margin-top: 2px; }
.scu-native-switch { flex: 0 0 auto; width: 40px; height: 23px; border-radius: 99px; border: 1px solid var(--scu-line, rgba(127,127,127,.35)); background: rgba(127,127,127,.18); cursor: pointer; position: relative; padding: 0; }
.scu-native-switch[aria-pressed="true"] { background: #2f7cf6; border-color: #2f7cf6; }
.scu-native-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%; background: #fff; transition: transform .16s ease; }
.scu-native-switch[aria-pressed="true"]::after { transform: translateX(17px); }
.scu-native-seg { display: inline-flex; border: 1px solid var(--scu-line, rgba(127,127,127,.35)); border-radius: 9px; overflow: hidden; flex: 0 0 auto; }
.scu-native-seg button { border: 0; background: transparent; color: inherit; padding: 6px 12px; font-size: 12px; cursor: pointer; }
.scu-native-seg button[aria-pressed="true"] { background: #2f7cf6; color: #fff; }
.scu-native-btn { border: 1px solid var(--scu-line, rgba(127,127,127,.35)); background: transparent; color: inherit; border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
.scu-native-btn:hover { background: rgba(127,127,127,.1); }
.scu-native-btn:disabled { opacity: .5; cursor: default; }
.scu-native-textarea { width: 100%; min-height: 74px; box-sizing: border-box; resize: vertical; border-radius: 9px; border: 1px solid var(--scu-line, rgba(127,127,127,.35)); background: transparent; color: inherit; padding: 9px 11px; font: inherit; font-size: 12px; }
.scu-native-badge { flex: 0 0 auto; font-size: 11px; padding: 3px 9px; border-radius: 99px; border: 1px solid var(--scu-line, rgba(127,127,127,.35)); }
.scu-native-badge[data-ok="true"] { color: #17803d; border-color: rgba(23,128,61,.45); background: rgba(23,128,61,.09); }
.scu-native-badge[data-ok="false"] { color: #b3472e; border-color: rgba(179,71,46,.45); background: rgba(179,71,46,.09); }
.scu-native-note { color: var(--scu-fg2, #888); font-size: 11.5px; margin-top: 10px; }
.scu-native-error { color: #b3472e; font-size: 12px; margin-bottom: 12px; }
@media (prefers-reduced-motion: reduce) {
  .scu-card, .scu-backdrop, .scu-panel, .scu-dot { animation: none !important; transition: none !important; }
  .scu-native-switch::after { transition: none !important; }
}
/* Host-native settings surface. These rules override the hand-rolled
   scu-native-* styles above with the same design tokens the built-in
   Computer Use permission panel uses, so the page reads as part of DSH. */
.scu-native-wrap { max-width: 760px; margin: 0 auto; padding: 8px 0 32px; }
.scu-native-panels { display: grid; gap: 32px; }
.scu-native-panel { display: grid; gap: 12px; min-width: 0; }
.scu-native-panel > h3 { margin: 0; font-size: 14px; font-weight: 500; }
.scu-native-panel > p { margin: 0; color: var(--dsw-alias-label-secondary, var(--scu-fg2)); font-size: 13px; line-height: 1.6; }
.scu-native-card { min-width: 0; padding: 0; margin: 0; background: transparent;
  border: .5px solid var(--dsw-alias-border-l3, var(--scu-line)); border-radius: var(--dsw-radius-md, 12px); }
.scu-native-card > * + * { border-top: .5px solid var(--dsw-alias-border-l3, var(--scu-line)); }
.scu-native-card > h3 { margin: 0; padding: 16px 16px 0; font-size: 13px; font-weight: 500;
  color: var(--dsw-alias-label-secondary, var(--scu-fg2)); text-transform: none; letter-spacing: 0; }
.scu-native-row { min-height: 80px; box-sizing: border-box; align-items: center; gap: 12px; padding: 16px;
  border-bottom: 0; flex-wrap: wrap; }
.scu-native-row-main { flex: 1 1 auto; min-width: 140px; }
.scu-native-row-main b { font-size: 13px; font-weight: 500; }
.scu-native-row-main small { font-size: 13px; color: var(--dsw-alias-label-secondary, var(--scu-fg2)); }
.scu-native-head { align-items: center; gap: 12px; margin-bottom: 0; flex-wrap: wrap; }
.scu-native-head h2 { font-size: 14px; font-weight: 500; }
.scu-native-head p { font-size: 13px; color: var(--dsw-alias-label-secondary, var(--scu-fg2)); }
.scu-native-actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.scu-native-actions .scu-native-btn { width: auto; }
.scu-native-btn, .scu-native-permAction { width: 168px; flex: 0 0 auto; box-sizing: border-box; appearance: none;
  border: .5px solid var(--dsw-alias-border-l2, var(--scu-line)); border-radius: var(--dsw-radius-sm, 8px);
  background: transparent; color: var(--dsw-alias-label-primary, var(--scu-fg));
  padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer; }
.scu-native-btn:hover { background: var(--dsw-alias-bg-hover, rgba(127,127,127,.08)); }
.scu-native-btn:disabled { opacity: .5; cursor: default; }
.scu-native-btn[data-configured]:disabled { opacity: 1; color: var(--dsw-alias-label-primary, var(--scu-fg)); cursor: default; }
.scu-native-badge { font-size: 12px; padding: 3px 9px; border-radius: var(--dsw-radius-sm, 6px);
  border: .5px solid var(--dsw-alias-border-l2, var(--scu-line)); color: var(--dsw-alias-label-secondary, var(--scu-fg2)); background: transparent; }
.scu-native-badge[data-ok="true"] { color: var(--dsw-alias-state-success-primary, #17803d); border-color: var(--dsw-alias-state-success-primary, #17803d); }
.scu-native-badge[data-ok="false"] { color: var(--dsw-alias-state-error-primary, #b3472e); border-color: var(--dsw-alias-state-error-primary, #b3472e); }
.scu-native-switch { width: 40px; height: 23px; border-radius: 99px;
  border: .5px solid var(--dsw-alias-border-l2, var(--scu-line)); background: var(--dsw-alias-bg-skeleton, rgba(127,127,127,.18)); }
.scu-native-switch[aria-pressed="true"] { background: var(--dsw-alias-brand-primary, #4b70e2); border-color: transparent; }
.scu-native-seg { border: .5px solid var(--dsw-alias-border-l2, var(--scu-line)); border-radius: var(--dsw-radius-sm, 8px); }
.scu-native-seg button[aria-pressed="true"] { background: var(--dsw-alias-brand-primary, #4b70e2); color: #fff; }
.scu-native-textarea { border: .5px solid var(--dsw-alias-border-l2, var(--scu-line));
  border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: inherit; }
.scu-native-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 16px; font-size: 13px; }
.scu-native-notice .scu-native-btn { width: auto; }
.scu-native-error { color: var(--dsw-alias-state-error-primary, #b3472e); margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.scu-native-skeleton { display: inline-block; border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-bg-skeleton, rgba(127,127,127,.16)); height: 13px; }
.scu-native-skeleton[data-w="wide"] { width: 168px; height: 28px; }
.scu-native-skeleton[data-w="text"] { width: 60%; }
.scu-native-hint { font-size: 13px; color: var(--dsw-alias-label-secondary, var(--scu-fg2)); }
/* Exact built-in PermissionPanel geometry for the rewritten panel. */
.scu-native-permission, .scu-native-card > .scu-native-notice {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  padding: 16px; min-height: 80px; box-sizing: border-box;
}
.scu-native-permission-main { flex: 1 1 auto; min-width: 140px; }
.scu-native-permission-main strong { display: block; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, var(--scu-fg)); }
.scu-native-permission-main p { margin: 0; color: var(--dsw-alias-label-secondary, var(--scu-fg2)); font-size: 13px; line-height: 1.6; }
.scu-native-panel strong { font-weight: 500; }
.scu-native-panel > p { margin: 0; color: var(--dsw-alias-label-secondary, var(--scu-fg2)); line-height: 1.6; }
.scu-native-app-badge { display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 2px 6px; border: .5px solid var(--dsw-alias-border-l1, var(--scu-line));
  border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-primary, var(--scu-fg)); vertical-align: middle; }
.scu-native-app-badge > span { min-width: 0; overflow-wrap: anywhere; }
.scu-native-gear { flex: 0 0 auto; opacity: .7; }
.scu-native-value { font-size: 13px; color: var(--dsw-alias-label-primary, var(--scu-fg)); font-variant-numeric: tabular-nums; }
.scu-native-btn[data-variant="outline"] { background: transparent; border-color: var(--dsw-alias-border-l2, var(--scu-line)); color: var(--dsw-alias-label-primary, var(--scu-fg)); }
.scu-native-btn[data-variant="primary"] { background: var(--dsw-alias-brand-primary, #4b70e2); border-color: transparent; color: #fff; }
.scu-native-btn[data-variant="primary"]:disabled { opacity: .5; }
.scu-native-btn[data-configured]:disabled { opacity: 1; color: var(--dsw-alias-label-primary, var(--scu-fg)); background: transparent; cursor: default; }
.scu-native-btn-sm { width: auto; padding: 5px 10px; }
.scu-native-toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 4px; }
.scu-modal-backdrop { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 24px;
  background: rgba(8,10,16,.42); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
.scu-modal { width: min(420px, 100%); box-sizing: border-box; padding: 24px; border-radius: var(--dsw-radius-lg, 16px);
  border: .5px solid var(--dsw-alias-border-l3, var(--scu-line)); background: var(--dsw-alias-bg-overlay, #fff);
  color: var(--dsw-alias-label-primary, var(--scu-fg)); box-shadow: 0 24px 64px rgba(0,0,0,.28); }
.scu-modal strong { display: block; font-size: 15px; font-weight: 600; margin-bottom: 10px; }
.scu-modal p { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary, var(--scu-fg2)); margin: 0 0 20px; }
.scu-modal-foot { display: flex; justify-content: flex-end; gap: 8px; }
.scu-modal-foot .scu-native-btn { width: auto; }
.scu-toast { position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); z-index: 130;
  display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 999px;
  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, var(--scu-fg));
  border: .5px solid var(--dsw-alias-border-l3, var(--scu-line)); box-shadow: 0 8px 28px rgba(0,0,0,.22); font-size: 12.5px; }
.scu-toast-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #30b070); }
.scu-toast-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #d0453a); }
`;

    // ---------------------------------------------------------------- components

    // Stable identities for the "no store yet" snapshot. Returning a fresh
    // object from getSnapshot makes React retry forever and the slot error
    // boundary retires the entry, so the empty value is a frozen constant.
    const EMPTY_SNAPSHOT = Object.freeze({
      version: 1,
      revision: -1,
      state: "idle",
      target: null,
      previewStatus: "unavailable",
    });
    const NOOP_SUBSCRIBE = () => () => {};
    const EMPTY_SNAPSHOT_GET = () => EMPTY_SNAPSHOT;

    // Cordis resolves services under the current fiber's isolate key, so a
    // plain ctx.get("locale") can miss a root-provided service (the same trap
    // as the Host HMR probe). Try every scope, then fall back to the shell's
    // own language so a Chinese DSH never renders English copy.
    function resolveLocaleService(ctx) {
      const attempts = [
        () => ctx?.get?.("locale"),
        () => ctx?.root?.get?.("locale"),
        () => ctx?.reflect?.get?.("locale", false),
        () => ctx?.locale,
      ];
      for (const attempt of attempts) {
        try {
          const value = attempt();
          if (value && typeof value.getLocale === "function") return value;
        } catch {
          // A proxy read without inject throws; that is a probe result.
        }
      }
      return null;
    }

    function shellLocaleId() {
      const nav = typeof navigator !== "undefined" ? String(navigator.language || "") : "";
      const doc = typeof document !== "undefined" ? String(document.documentElement?.lang || "") : "";
      return [nav, doc].some((value) => value.toLowerCase().startsWith("zh")) ? "zh-CN" : "en";
    }

    function useLocale(ctx) {
      const locale = resolveLocaleService(ctx);
      const subscribe = useCallback(
        (fn) => (locale?.subscribe ? locale.subscribe(fn) : () => {}),
        [locale],
      );
      const get = useCallback(() => {
        if (locale?.getLocale) {
          const id = locale.getLocale().id;
          if (id) return id;
        }
        return shellLocaleId();
      }, [locale]);
      const id = useSyncExternalStore(subscribe, get, get);
      return { id, t: (key, params) => tFor(id, key, params) };
    }

    function stateText(t, snapshot) {
      if (snapshot.state === "running" || snapshot.state === "claimed") {
        const action = snapshot.action?.kind;
        const actionText = action ? t(`action.${action}`) : snapshot.label ? snapshot.label : "";
        return actionText || t(`state.${snapshot.state}`);
      }
      return t(`state.${snapshot.state}`);
    }

    function targetName(snapshot, t) {
      const target = snapshot?.target;
      if (!target) return t("card.noTarget");
      const app = target.appName || (target.pid ? `pid ${target.pid}` : "");
      return app || `window ${target.windowId ?? "?"}`;
    }

    function targetLabel(target, t) {
      if (!target) return t("card.noTarget");
      const app = target.appName || (target.pid ? `pid ${target.pid}` : "");
      return app || `window ${target.windowId ?? "?"}`;
    }

    function targetStateText(t, target) {
      if (target.nativePreview?.status === "unavailable") return t("card.noPreview");
      if (target.state === "running" || target.state === "claimed") {
        const action = target.action?.kind;
        return action ? t(`action.${action}`) : t(`state.${target.state}`);
      }
      return t(`state.${target.state}`);
    }

    function ageText(ms, t) {
      if (ms === null || ms === undefined) return t("meta.none");
      return t("card.frameAge", { seconds: (ms / 1000).toFixed(1) });
    }

    function StopButton({ store, snapshot, t, targetId = null, all = false }) {
      const stopping = all
        ? snapshot.stoppingAll === true || snapshot.stopping === true
        : targetId
          ? (snapshot.stoppingTargets ?? []).includes(targetId)
          : snapshot.state === "stopping" || snapshot.stopping === true;
      const label = stopping
        ? all
          ? t("card.stoppingAll")
          : t("card.stopping")
        : all
          ? t("card.stopAll")
          : t("card.stop");
      return h(
        "button",
        {
          type: "button",
          className: all ? "scu-stop scu-stop-all" : "scu-stop",
          disabled: stopping,
          // One activation path: click (also produced by keyboard and AXPress).
          // A pointerdown+click pair relied on the stopping flag/time to hide a
          // double trigger instead of having only one semantic trigger.
          onClick: () => store.stopControl("stop", targetId),
          title: label,
        },
        label,
      );
    }

    function PreviewCanvas({ store, preview = null, className, compact }) {
      const canvasRef = useRef(null);
      const controller = preview ?? store.preview;
      useEffect(() => {
        controller.attach(canvasRef.current);
        const wants = store.expanded || store.previewWanted || store.deckVisible;
        if (wants) controller.open();
        const attached = canvasRef.current;
        return () => controller.detach(attached);
      }, [controller, store]);
      return h("canvas", {
        ref: canvasRef,
        className,
        "aria-hidden": true,
        "data-compact": compact ? "1" : "0",
      });
    }

    function TargetTile({ store, target, snapshot, t }) {
      const preview = store.previewFor(target.targetId);
      const info = snapshot.targetPreviews?.[target.targetId] ?? {
        status: target.previewStatus ?? "unavailable",
        fps: 0,
        frameAgeMs: null,
      };
      const hasFrame = preview.frames > 0;
      return h(
        "div",
        { className: "scu-target", "data-state": target.state, "data-target-id": target.targetId },
        h(
          "div",
          { className: "scu-target-head" },
          h("span", { className: "scu-dot", "data-state": target.state, "aria-hidden": true }),
          h(
            "div",
            { className: "scu-titles" },
            h("span", { className: "scu-app", title: targetLabel(target, t) }, targetLabel(target, t)),
            h("span", { className: "scu-sub" }, targetStateText(t, target)),
          ),
          target.active ? h(StopButton, { store, snapshot, t, targetId: target.targetId }) : null,
        ),
        h(
          "div",
          { className: "scu-target-body" },
          h(PreviewCanvas, { store, preview, className: "scu-target-canvas", compact: true }),
          !hasFrame
            ? h(
                "div",
                { className: "scu-empty" },
                info.status === "unavailable" ? t("card.noPreview") : t("card.waitingForFrame"),
              )
            : null,
          info.status === "live" || info.status === "stale"
            ? h("span", { className: "scu-badge", "data-status": info.status },
                info.status === "live" ? t("card.fresh") : t("card.stale"))
            : null,
        ),
        h(
          "div",
          { className: "scu-target-foot" },
          h("span", { className: "scu-meta" },
            info.status === "live"
              ? t("meta.fps", { fps: info.fps || 0 })
              : `${target.windowId ? `#${target.windowId}` : ""} ${ageText(info.frameAgeMs, t)}`.trim()),
        ),
      );
    }

    function TargetFloat({ store, target, snapshot, t, index }) {
      const preview = store.previewFor(target.targetId);
      const info = snapshot.targetPreviews?.[target.targetId] ?? {
        status: target.previewStatus ?? "unavailable",
        fps: 0,
        frameAgeMs: null,
      };
      // Control-only by default: the resting state is one slim row of chrome.
      // The live thumbnail is opt-in, so an ambient target never parks a large
      // opaque card over the page it is driving.
      const expandedCard = (snapshot.expandedTargetIds ?? []).includes(target.targetId);
      const hasFrame = preview.frames > 0;
      const live = info.status === "live";
      const stateText = targetStateText(t, target);
      const action = target.action?.kind ? t(`action.${target.action.kind}`) : "";
      return h(
        "article",
        {
          className: `scu-float${expandedCard ? " is-expanded" : ""}`,
          "data-state": target.state,
          "data-target-id": target.targetId,
          style: { "--scu-float-index": String(index) },
        },
        h(
          "header",
          { className: "scu-float-head" },
          h("span", { className: "scu-float-orb", "data-state": target.state, "aria-hidden": true }),
          h(
            "div",
            { className: "scu-float-titles" },
            h("span", { className: "scu-float-app", title: targetLabel(target, t) },
              targetLabel(target, t)),
            h("span", { className: "scu-float-sub" }, action || stateText),
          ),
          h(
            "div",
            { className: "scu-float-actions" },
            h(StopButton, { store, snapshot, t, targetId: target.targetId }),
            h(
              "button",
              {
                type: "button", className: "scu-float-icon",
                "aria-label": expandedCard ? t("deck.collapse") : t("deck.expand"),
                title: expandedCard ? t("deck.collapse") : t("deck.expand"),
                "aria-expanded": expandedCard,
                onClick: () => store.toggleTargetCollapsed(target.targetId),
              },
              h("span", { className: "scu-float-glyph" }, expandedCard ? "\u2303" : "\u2304"),
            ),
            h(
              "button",
              {
                type: "button", className: "scu-float-icon scu-float-reveal",
                "aria-label": t("deck.expand"), title: t("deck.expand"),
                onClick: () => {
                  store.selectTarget(target.targetId);
                  store.toggleExpanded();
                },
              },
              h("span", { className: "scu-float-glyph" }, "\u2197"),
            ),
            h(
              "button",
              {
                type: "button", className: "scu-float-icon scu-float-close scu-float-reveal",
                "aria-label": t("deck.close"), title: t("deck.close"),
                onClick: () => store.dismissTargetPanel(target.targetId),
              },
              h("span", { className: "scu-float-glyph" }, "\u00d7"),
            ),
          ),
        ),
        expandedCard
          ? h(
              "div",
              { className: "scu-float-preview" },
              h(PreviewCanvas, { store, preview, className: "scu-float-canvas", compact: true }),
              h("div", { className: "scu-float-vignette", "aria-hidden": true }),
              hasFrame
                ? h("span", { className: "scu-float-live", "data-status": info.status },
                    live ? "LIVE" : t("card.stale"))
                : h("span", { className: "scu-float-wait" }, t("card.waitingForFrame")),
              h("span", { className: "scu-float-window" },
                target.windowId ? `#${target.windowId}` : "app"),
            )
          : null,
      );
    }

    function ControlDeck() {
      const ctx = ControlDeck.ctx;
      const { t } = useLocale(ctx);
      const sessionId = useSyncExternalStore(
        activeDeckSession.subscribe,
        activeDeckSession.get,
        activeDeckSession.get,
      );
      const store = useMemo(() => (sessionId ? storeFor(sessionId) : null), [sessionId]);
      const fallback = useMemo(
        () => ({ version: 1, revision: -1, state: "idle", target: null, targets: [], deckVisible: false }),
        [],
      );
      const fallbackGet = useMemo(() => () => fallback, [fallback]);
      const snapshot = useSyncExternalStore(
        store ? store.subscribe : NOOP_SUBSCRIBE,
        store ? store.getSnapshot : fallbackGet,
        store ? store.getSnapshot : fallbackGet,
      );

      useEffect(() => {
        if (!store) return undefined;
        return store.mount();
      }, [store]);

      useEffect(() => {
        if (!store || snapshot.deckVisible !== true) return undefined;
        // The deck itself is control-only; it opens frames only for cards the
        // user expanded (or for Watch / the big panel).
        store.openPreviews();
        return undefined;
      }, [
        store, sessionId, snapshot.deckVisible, snapshot.state,
        snapshot.targets?.length, (snapshot.expandedTargetIds ?? []).join(","),
      ]);

      if (!store || snapshot.deckVisible !== true || snapshot.expanded === true) return null;
      const targets = Array.isArray(snapshot.targets) ? snapshot.targets : [];
      const hidden = new Set(snapshot.hiddenTargetIds ?? []);
      const visible = targets.filter(
        (target) =>
          target.active === true &&
          ACTIVE_STATES.has(target.state) &&
          !hidden.has(target.targetId),
      );
      // Codex-style: a target that already owns a native preview window needs
      // no duplicate page float. Keep a float only as a fallback for targets
      // whose native preview is missing or was closed.
      const uncovered = visible.filter((target) => target.nativePreview?.visible !== true);
      if (uncovered.length === 0) return null;
      return h(
        "div",
        { className: "scu-root scu-float-stack", "data-scu-deck": sessionId },
        uncovered.map((target, index) =>
          h(TargetFloat, {
            key: target.targetId, store, target, snapshot, t, index,
          })),
      );
    }

    function CuCard({ sessionId }) {
      const ctx = CuCard.ctx;
      const { t } = useLocale(ctx);
      const hostSessionId = typeof sessionId === "string" ? sessionId : null;
      const store = useMemo(() => (hostSessionId ? storeFor(hostSessionId) : null), [hostSessionId]);
      const fallback = useMemo(
        () => ({ version: 1, revision: -1, state: "connecting", target: null, previewStatus: "unavailable" }),
        [],
      );
      const fallbackGet = useMemo(() => () => fallback, [fallback]);
      const snapshot = useSyncExternalStore(
        store ? store.subscribe : NOOP_SUBSCRIBE,
        store ? store.getSnapshot : fallbackGet,
        store ? store.getSnapshot : fallbackGet,
      );

      useEffect(() => {
        if (!store) return undefined;
        return store.mount();
      }, [store]);

      useEffect(() => {
        if (!hostSessionId) return undefined;
        activeDeckSession.set(hostSessionId);
        return () => {
          if (activeDeckSession.get() === hostSessionId) activeDeckSession.set(null);
        };
      }, [hostSessionId]);

      useEffect(() => {
        if (!store) return undefined;
        if (FINAL_STATES.has(snapshot.state)) {
          const timer = setTimeout(() => store.dismiss(), 7000);
          return () => clearTimeout(timer);
        }
        return undefined;
      }, [store, snapshot.state]);

      useEffect(() => {
        if (!store) return undefined;
        if (store.expanded) {
          store.pollNow(true);
          store.openPreviews();
        }
        return undefined;
      }, [store, snapshot.state, snapshot.targetGeneration]);

      if (!store || !hostSessionId) return null;
      if (store.dismissed) return null;
      if (!ACTIVE_STATES.has(snapshot.state) && !FINAL_STATES.has(snapshot.state)) return null;

      const running = snapshot.state === "running" || snapshot.state === "claimed";
      const info = snapshot.previewInfo ?? store.previewInfo;
      const hasFrame = store.preview.frames > 0;
      const age = info.frameAgeMs;
      const watching = snapshot.watching === true || snapshot.expanded === true;
      const badge =
        info.status === "live" ? t("card.fresh") : info.status === "stale" ? t("card.stale") : null;
      const targets = Array.isArray(snapshot.targets) ? snapshot.targets : [];
      const multi = targets.length > 0;
      const activeTargets = targets.filter(
        (target) => target.active === true && ACTIVE_STATES.has(target.state),
      );
      // Codex-style: a visible native preview window IS the viewer for that
      // target. The in-chat card is duplicate chrome in that state and only
      // remains as the fallback surface when a preview is unavailable or the
      // user closed it.
      const nativePreviewCoversTargets =
        activeTargets.length > 0 &&
        activeTargets.every((target) => target.nativePreview?.visible === true);
      if (nativePreviewCoversTargets && !watching) return null;
      const activeCount = activeTargets.length;
      const hiddenPanels = activeTargets.filter((target) =>
        (snapshot.hiddenTargetIds ?? []).includes(target.targetId)).length;
      const primaryName = targetName(snapshot, t);
      const titleText = multi
        ? `${primaryName} · ${t("card.targets", { count: targets.length })}`
        : primaryName;

      const stop = h(StopButton, { store, snapshot, t, all: multi });
      const isPermError =
        snapshot.lastError &&
        /permission|authorized|accessibility|screencapture|privacy/i.test(snapshot.lastError);
      const error = snapshot.lastError
        ? h(
            "div",
            { className: "scu-error", role: "status" },
            h("span", null, snapshot.lastError),
            isPermError
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "scu-perm-btn",
                    onClick: () =>
                      postJson(CONTROL_PATH, { command: "open_settings", target: "accessibility" }),
                  },
                  t("perm.openSettings"),
                )
              : null,
          )
        : null;

      if (!watching) {
        // Default: a 40 px status strip. No empty black frame, no waiting for a
        // click on a video that was never requested.
        return h(
          "div",
          { className: "scu-root", "data-scu-card": hostSessionId },
          h(
            "div",
            { className: "scu-card scu-strip", "data-state": snapshot.state },
            h("span", { className: "scu-dot", "data-state": snapshot.state, "aria-hidden": true }),
            h(
              "div",
              { className: "scu-titles" },
              h("span", { className: "scu-app", title: titleText }, titleText),
              h("span", { className: "scu-sub" },
                multi
                  ? `${stateText(t, snapshot)} · ${t("card.targetCount", { count: activeCount })}`
                  : stateText(t, snapshot)),
            ),
            activeCount > 0 && (!snapshot.deckVisible || hiddenPanels > 0)
              ? h(
                  "button",
                  { type: "button", className: "scu-watch", onClick: () => store.showDeck() },
                  t("deck.show"),
                )
              : null,
            h(
              "button",
              { type: "button", className: "scu-watch", onClick: () => store.toggleWatch() },
              t("card.watch"),
            ),
            stop,
            error,
          ),
        );
      }

      if (multi) {
        return h(
          "div",
          { className: "scu-root", "data-scu-card": hostSessionId },
          h(
            "div",
            { className: "scu-card scu-multi", "data-state": snapshot.state },
            h(
              "div",
              { className: "scu-head" },
              h("span", { className: "scu-dot", "data-state": snapshot.state, "aria-hidden": true }),
              h(
                "div",
                { className: "scu-titles" },
                h("span", { className: "scu-app", title: titleText }, titleText),
                h("span", { className: "scu-sub" },
                  `${stateText(t, snapshot)} · ${t("card.targetCount", { count: activeCount })}`),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "scu-icon",
                  "aria-expanded": snapshot.expanded ? "true" : "false",
                  "aria-label": snapshot.expanded ? t("card.collapse") : t("card.expand"),
                  title: snapshot.expanded ? t("card.collapse") : t("card.expand"),
                  onClick: () => store.toggleExpanded(),
                },
                h(
                  "svg",
                  { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
                  h("path", {
                    d: snapshot.expanded ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4",
                    stroke: "currentColor",
                    "stroke-width": 1.6,
                    "stroke-linecap": "round",
                    "stroke-linejoin": "round",
                  }),
                ),
              ),
            ),
            h(
              "div",
              { className: "scu-targets" },
              targets.map((target) =>
                h(TargetTile, { key: target.targetId, store, target, snapshot, t })),
            ),
            h(
              "div",
              { className: "scu-foot" },
              h("span", { className: "scu-meta" },
                t("card.targets", { count: targets.length })),
              h(
                "button",
                { type: "button", className: "scu-watch", onClick: () => store.toggleWatch() },
                t("card.hidePreview"),
              ),
              stop,
            ),
            error,
          ),
        );
      }

      return h(
        "div",
        { className: "scu-root", "data-scu-card": hostSessionId },
        h(
          "div",
          { className: "scu-card", "data-state": snapshot.state },
          h(
            "div",
            { className: "scu-head" },
            h("span", { className: "scu-dot", "data-state": snapshot.state, "aria-hidden": true }),
            h(
              "div",
              { className: "scu-titles" },
              h("span", { className: "scu-app", title: targetName(snapshot, t) }, targetName(snapshot, t)),
              h("span", { className: "scu-sub" }, stateText(t, snapshot)),
            ),
            h(
              "button",
              {
                type: "button",
                className: "scu-icon",
                "aria-expanded": snapshot.expanded ? "true" : "false",
                "aria-label": snapshot.expanded ? t("card.collapse") : t("card.expand"),
                title: snapshot.expanded ? t("card.collapse") : t("card.expand"),
                onClick: () => store.toggleExpanded(),
              },
              h(
                "svg",
                { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
                h("path", {
                  d: snapshot.expanded ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4",
                  stroke: "currentColor",
                  "stroke-width": 1.6,
                  "stroke-linecap": "round",
                  "stroke-linejoin": "round",
                }),
              ),
            ),
          ),
          h(
            "div",
            { className: "scu-body", "data-compact": "1" },
            h(PreviewCanvas, { store, className: "scu-canvas", compact: true }),
            !hasFrame
              ? h(
                  "div",
                  { className: "scu-empty" },
                  info.status === "unavailable" ? t("card.noPreview") : t("card.waitingForFrame"),
                )
              : null,
            badge ? h("span", { className: "scu-badge", "data-status": info.status }, badge) : null,
          ),
          h(
            "div",
            { className: "scu-foot" },
            h(
              "span",
              { className: "scu-meta" },
              running
                ? stateText(t, snapshot)
                : `${snapshot.target?.windowId ? `#${snapshot.target.windowId}` : ""} ${ageText(age, t)}`.trim(),
            ),
            h(
              "button",
              { type: "button", className: "scu-watch", onClick: () => store.toggleWatch() },
              t("card.hidePreview"),
            ),
            stop,
          ),
          error,
        ),
      );
    }

    function Overlay() {
      const ctx = Overlay.ctx;
      const { t } = useLocale(ctx);
      const expandedSession = useSyncExternalStore(expansion.subscribe, expansion.get, expansion.get);
      const store = useMemo(() => (expandedSession ? storeFor(expandedSession) : null), [expandedSession]);
      const snapshot = useSyncExternalStore(
        store ? store.subscribe : NOOP_SUBSCRIBE,
        store ? store.getSnapshot : EMPTY_SNAPSHOT_GET,
        store ? store.getSnapshot : EMPTY_SNAPSHOT_GET,
      );
      const closeRef = useRef(null);
      const panelRef = useRef(null);
      const previousFocus = useRef(null);

      useEffect(() => {
        if (!expandedSession) return undefined;
        previousFocus.current = document.activeElement;
        const onKey = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            store?.closeExpanded();
            return;
          }
          if (event.key !== "Tab") return;
          const panel = panelRef.current;
          if (!panel) return;
          const focusables = [...panel.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          )].filter((node) => !node.disabled && node.getClientRects().length > 0);
          if (focusables.length === 0) {
            event.preventDefault();
            closeRef.current?.focus?.();
            return;
          }
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
            event.preventDefault();
            first.focus();
          }
        };
        document.addEventListener("keydown", onKey, true);
        const timer = setTimeout(() => closeRef.current?.focus?.(), 30);
        return () => {
          clearTimeout(timer);
          document.removeEventListener("keydown", onKey, true);
          const previous = previousFocus.current;
          if (previous && typeof previous.focus === "function") previous.focus();
        };
      }, [expandedSession, store]);

      useEffect(() => {
        if (!store) return undefined;
        // The overlay may be the only mounted view for this store (the card can
        // be unmounted when the chat changes). Mount it so polling/stop have a
        // live lifecycle; when the card is also mounted this is a ref count.
        return store.mount();
      }, [store]);

      useEffect(() => {
        if (!expandedSession || !store) return undefined;
        // The overlay is the expanded view: keep the store's own flags aligned
        // with it, otherwise a panel reopened after a stop never retries video.
        store.expanded = true;
        store.previewWanted = true;
        store.pollNow(true);
        store.openPreviews();
        return undefined;
      }, [expandedSession, store]);

      if (!expandedSession || !store) return null;
      if (FINAL_STATES.has(snapshot.state) && store.stoppedAt && Date.now() - store.stoppedAt > 60000) return null;

      const targets = Array.isArray(snapshot.targets) ? snapshot.targets : [];
      const selected =
        targets.find((item) => item.targetId === snapshot.selectedTargetId) ??
        targets.find((item) => item.active === true) ??
        targets[0] ??
        null;
      const selectedPreview = selected ? store.previewFor(selected.targetId) : store.preview;
      const info = selected
        ? snapshot.targetPreviews?.[selected.targetId] ?? {
            status: selected.previewStatus ?? "unavailable",
            fps: 0,
            frameAgeMs: null,
          }
        : snapshot.previewInfo ?? store.previewInfo;
      const target = selected ? targetLabel(selected, t) : targetName(snapshot, t);
      const stateForHeader = selected ? targetStateText(t, selected) : stateText(t, snapshot);
      return h(
        "div",
        { className: "scu-root" },
        h(
          "div",
          {
            className: "scu-backdrop",
            onClick: (event) => {
              if (event.target === event.currentTarget) store.closeExpanded();
            },
          },
          h(
            "div",
            {
              ref: panelRef,
              className: "scu-panel",
              role: "dialog",
              "aria-modal": "true",
              "aria-label": `${t("overlay.title")} — ${target}`,
            },
            h(
              "div",
              { className: "scu-panel-head" },
              h("span", { className: "scu-dot", "data-state": snapshot.state, "aria-hidden": true }),
              h("span", { className: "scu-panel-title" }, t("overlay.title")),
              h(
                "span",
                { className: "scu-panel-sub" },
                `${target} · ${stateText(t, snapshot)}`,
              ),
              h(
                "button",
                {
                  ref: closeRef,
                  type: "button",
                  className: "scu-icon",
                  "aria-label": t("overlay.close"),
                  title: t("overlay.close"),
                  onClick: () => store.closeExpanded(),
                },
                h(
                  "svg",
                  { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
                  h("path", {
                    d: "M4 4l8 8M12 4l-8 8",
                    stroke: "currentColor",
                    "stroke-width": 1.6,
                    "stroke-linecap": "round",
                  }),
                ),
              ),
            ),
            targets.length > 1
              ? h(
                  "div",
                  { className: "scu-tabs", role: "tablist", "aria-label": t("card.targets", { count: targets.length }) },
                  targets.map((item) =>
                    h(
                      "button",
                      {
                        key: item.targetId,
                        type: "button",
                        role: "tab",
                        className: "scu-tab",
                        "aria-selected": item.targetId === selected?.targetId ? "true" : "false",
                        "data-state": item.state,
                        onClick: () => store.selectTarget(item.targetId),
                      },
                      targetLabel(item, t),
                    ),
                  ),
                )
              : null,
            h(
              "div",
              { className: "scu-panel-body" },
              h(PreviewCanvas, { store, preview: selectedPreview, className: "scu-panel-canvas", compact: false }),
              selectedPreview.frames === 0
                ? h(
                    "div",
                    { className: "scu-empty" },
                    info.status === "unavailable" ? t("card.noPreview") : t("card.waitingForFrame"),
                  )
                : null,
            ),
            h(
              "div",
              { className: "scu-panel-foot" },
              h(
                "span",
                { className: "scu-hint" },
                info.status === "stale" ? `${t("card.stale")} · ${ageText(info.frameAgeMs, t)}` : t("overlay.stopHint"),
              ),
              h(
                "span",
                { className: "scu-meta", style: { flex: "0 0 auto" } },
                info.status === "live" ? t("meta.fps", { fps: info.fps || 0 }) : t("meta.none"),
              ),
              h(StopButton, { store, snapshot, t, targetId: selected?.targetId ?? null }),
              selected ? h(StopButton, { store, snapshot, t, all: true }) : null,
            ),
            h(
              "details",
              { className: "scu-diag" },
              h("summary", null, t("card.details")),
              h(
                "div",
                { className: "scu-diag-grid" },
                h("span", null, h("b", null, t("diag.generation")),
                  ` ${selected?.targetGeneration ?? snapshot.targetGeneration ?? "—"}`),
                h(
                  "span",
                  null,
                  h("b", null, t("diag.frames")),
                  ` ${selectedPreview.frames}${selectedPreview.dropped ? ` / dropped ${selectedPreview.dropped}` : ""}${info.decodeMs ? ` / ${info.decodeMs}ms` : ""}`,
                ),
              ),
            ),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------- native UI
    //
    // One surface only: the real settings page (settings.section). The plugin
    // bar deliberately has no "Computer Use" entry — every control lives in
    // Settings, so the sidebar stays uncluttered. The page reads the single
    // authenticated route, so it can never disagree with the tool gate.

    const NativeUI = { ctx: null };
    const SETTINGS_PATH = "/api/scu/settings";
    const NATIVE_POLL_MS = 5000;

    function nativeIsChinese(localeId) {
      const nav =
        typeof navigator !== "undefined" ? String(navigator.language || "") : "";
      const doc =
        typeof document !== "undefined"
          ? String(document.documentElement?.lang || "")
          : "";
      // The host's own UI may be Chinese even when the locale service exposes
      // no getLocale() (or reports a neutral id). Any Chinese signal wins, so
      // the native surfaces never silently fall back to English in a zh shell.
      return [localeId, nav, doc].some((value) =>
        String(value || "").toLowerCase().startsWith("zh"),
      );
    }

    function useNativeT() {
      const ctx = NativeUI.ctx ?? { get: () => null };
      const { t } = useLocale(ctx); // keeps the subscription for live switches
      return t;
    }

    function useNativeSnapshot() {
      const [state, setState] = useState({ loading: true, data: null, error: null });
      const load = useCallback(async () => {
        try {
          const data = await postJson(SETTINGS_PATH, { action: "get" });
          setState({ loading: false, data, error: null });
        } catch (error) {
          setState((prev) => ({
            loading: false,
            data: prev.data,
            error: String(error?.message ?? error),
          }));
        }
      }, []);
      useEffect(() => {
        load();
        const timer = setInterval(load, NATIVE_POLL_MS);
        return () => clearInterval(timer);
      }, [load]);
      return { ...state, reload: load };
    }

    async function openPermissionSettings(target, t) {
      try {
        await postJson(CONTROL_PATH, { command: "open_settings", target });
        if (t) showToast(t("native.settingsOpenedToast"));
      } catch {
        // A shortcut to System Settings is not a state machine. The next poll
        // reports the real permission bits; never show a fake "Granted".
      }
    }

    function nativeNavLabel() {
      return nativeIsChinese("") ? "电脑控制" : "Computer Use";
    }

    // ------------------------------------------------- host-native settings UI
    // Mirrors the built-in Computer Use permission panel without requiring host
    // UI primitives: host design tokens, bordered panels 32px apart, skeleton
    // rows while the single authenticated query is in flight, a per-notice
    // retry, a configured-state save button and a global toast.

    const toastState = { current: null, listeners: new Set() };
    const toastSubscribe = (fn) => {
      toastState.listeners.add(fn);
      return () => toastState.listeners.delete(fn);
    };
    const toastGet = () => toastState.current;
    const toastGetServer = () => null;
    function showToast(text, tone) {
      toastState.current = { id: Date.now(), text, tone: tone || "success" };
      for (const fn of Array.from(toastState.listeners)) fn();
    }
    function ScuToast() {
      const item = useSyncExternalStore(toastSubscribe, toastGet, toastGetServer);
      useEffect(() => {
        if (!item) return undefined;
        const timer = setTimeout(() => {
          toastState.current = null;
          for (const fn of Array.from(toastState.listeners)) fn();
        }, 3200);
        return () => clearTimeout(timer);
      }, [item]);
      if (!item) return null;
      return h("div", { className: "scu-toast", role: "status", key: item.id },
        h("span", { className: "scu-toast-dot", "data-tone": item.tone }),
        h("span", null, item.text));
    }

    // Mirrors the built-in PermissionPanel: skeleton rows keep the 168px
    // action seat occupied while the single settings query is in flight.
    function SkeletonRow() {
      return h("div", { className: "scu-native-permission", "aria-hidden": "true" },
        h("div", { className: "scu-native-permission-main" },
          h("div", { className: "scu-native-skeleton", "data-w": "text" }),
          h("div", { className: "scu-native-skeleton", "data-w": "text", style: { marginTop: "8px", width: "45%" } })),
        h("div", { className: "scu-native-skeleton", "data-w": "wide" }));
    }

    // Mirrors PermissionDescription: the responsible application is an l1
    // bordered badge inside the sentence, not a separate status chip.
    function PermissionDescription({ template, helper }) {
      const parts = String(template).split("{application}");
      return h("p", null,
        parts[0],
        h("span", { className: "scu-native-app-badge" }, helper),
        parts.length > 1 ? parts[1] : null);
    }

    function GearIcon() {
      return h("svg", { className: "scu-native-gear", width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("circle", { cx: 8, cy: 8, r: 2.3, stroke: "currentColor", "stroke-width": 1.2 }),
        h("path", { d: "M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2", stroke: "currentColor", "stroke-width": 1.2, "stroke-linecap": "round" }));
    }

    // Mirrors PermissionAction: a denied permission gets a primary "request"
    // button; a granted/unknown one gets an outline status button with a gear.
    function HostPermissionRow({ t, label, description, value, available, target, helper }) {
      const known = available === true;
      const granted = known && value === true;
      const text = known ? (granted ? t("native.granted") : t("native.requestPermission")) : t("native.unknown");
      return h("div", { className: "scu-native-permission", role: "group", "aria-label": label },
        h("div", { className: "scu-native-permission-main" },
          h("strong", null, label),
          h(PermissionDescription, { template: description, helper })),
        h("button", {
          className: "scu-native-btn scu-native-permAction",
          "data-variant": known && !granted ? "primary" : "outline",
          type: "button",
          title: t("native.openSettings"),
          onClick: () => openPermissionSettings(target, t),
        }, h("span", null, text), known && granted ? h(GearIcon) : null));
    }

    // One card row in the built-in layout: strong title, secondary description,
    // and a right-hand control that keeps the 168px action seat.
    function PanelRow({ title, description, children }) {
      return h("div", { className: "scu-native-permission", role: "group", "aria-label": title },
        h("div", { className: "scu-native-permission-main" },
          h("strong", null, title),
          h("p", null, description)),
        children);
    }

    function SettingsPanel(props) {
      const t = useNativeT();
      const snap = useNativeSnapshot();
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const current = snap.data?.settings ?? null;
      const effective = draft ?? current;
      const patch = (key, value) => setDraft({ ...(effective ?? {}), [key]: value });
      const deniedText = (effective?.deniedApps ?? []).join("\n");
      const dirty = draft !== null;
      const loading = !snap.data && snap.loading;

      useEffect(() => {
        const onFocus = () => snap.reload();
        if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("focus", onFocus);
        const off = NativeUI.ctx?.on?.("connection/reset", onFocus);
        return () => {
          if (typeof window !== "undefined" && window.removeEventListener) window.removeEventListener("focus", onFocus);
          try { off?.(); } catch { /* teardown continues */ }
        };
      }, [snap.reload]);

      const save = async () => {
        if (!draft || !effective) return;
        setSaving(true);
        try {
          await postJson(SETTINGS_PATH, {
            action: "set",
            patch: {
              enabled: effective.enabled !== false,
              controlMode: effective.controlMode === "full" ? "full" : "background",
              deniedApps: Array.isArray(effective.deniedApps) ? effective.deniedApps : [],
              unhideOnFinish: effective.unhideOnFinish !== false,
            },
          });
          setDraft(null);
          showToast(t("native.savedToast"));
          await snap.reload();
        } catch (error) {
          showToast(String(error?.message ?? error), "error");
        } finally {
          setSaving(false);
        }
      };

      if (props?.view === "summary") return h("span", null, t("native.subtitle"));

      const perms = snap.data?.permissions;
      const helper = t("native.helperName");

      // The description keeps {application} as a literal so PermissionDescription
      // can render the responsible app as an l1 badge, exactly like the built-in
      // cua permission panel. Error notices live inside the card, as Builtin does.
      const permissionCard = h("div", { className: "scu-native-card" },
        loading ? h(SkeletonRow) : h(HostPermissionRow, {
          t, label: t("native.accessibility"),
          description: t("native.permissionsUse"),
          value: perms?.accessibility, available: perms?.available, target: "accessibility", helper,
        }),
        loading ? h(SkeletonRow) : h(HostPermissionRow, {
          t, label: t("native.screenRecording"),
          description: t("native.screenRecordingUse"),
          value: perms?.screenRecording, available: perms?.available, target: "screenRecording", helper,
        }),
        snap.error
          ? h("div", { className: "scu-native-notice", role: "alert" },
              h("span", { className: "scu-native-error" }, snap.data ? t("native.staleNotice") : t("native.queryFailed", { error: snap.error })),
              h("button", { className: "scu-native-btn scu-native-btn-sm", type: "button", onClick: snap.reload }, t("native.retry")))
          : null);

      const preferencesCard = h("div", { className: "scu-native-card" },
        effective
          ? h(PanelRow, { title: t("native.section.enable"), description: t("native.section.enableHint") },
              h("button", {
                className: "scu-native-switch",
                type: "button",
                "aria-pressed": String(effective.enabled !== false),
                "aria-label": t("native.section.enable"),
                onClick: () => patch("enabled", effective.enabled === false),
              }))
          : h(SkeletonRow),
        effective
          ? h(PanelRow, { title: t("native.section.mode"), description: t("native.section.modeHint") },
              h("div", { className: "scu-native-seg" },
                h("button", { type: "button", "aria-pressed": String(effective.controlMode !== "full"), onClick: () => patch("controlMode", "background") }, t("native.mode.background")),
                h("button", { type: "button", "aria-pressed": String(effective.controlMode === "full"), onClick: () => patch("controlMode", "full") }, t("native.mode.full"))))
          : h(SkeletonRow),
        effective
          ? h("div", { className: "scu-native-permission", role: "group", "aria-label": t("native.section.denied") },
              h("div", { className: "scu-native-permission-main" },
                h("strong", null, t("native.section.denied")),
                h("p", null, t("native.section.deniedHint")),
                h("textarea", {
                  className: "scu-native-textarea",
                  value: deniedText,
                  "aria-label": t("native.section.denied"),
                  onChange: (event) => patch("deniedApps", String(event?.target?.value ?? "").split("\n").map((line) => line.trim()).filter(Boolean)),
                }),
                deniedText ? null : h("p", null, t("native.section.deniedEmpty"))))
          : h(SkeletonRow),
        effective
          ? h(PanelRow, { title: t("native.section.unhide"), description: t("native.section.unhideHint") },
              h("button", {
                className: "scu-native-switch",
                type: "button",
                "aria-pressed": String(effective.unhideOnFinish !== false),
                "aria-label": t("native.section.unhide"),
                onClick: () => patch("unhideOnFinish", effective.unhideOnFinish === false),
              }))
          : h(SkeletonRow),
        // Builtin ConfigurationSetting semantics: a completed state is an
        // outline button, never a filled primary one. The old version applied
        // both classes and produced unreadable black-on-black text.
        h("div", { className: "scu-native-permission", role: "group", "aria-label": t("native.saveTitle") },
          h("div", { className: "scu-native-permission-main" },
            h("strong", null, t("native.saveTitle")),
            h("p", null, t("native.saveBody"))),
          h("button", {
            className: "scu-native-btn scu-native-permAction",
            "data-variant": dirty ? "primary" : "outline",
            "data-configured": dirty ? undefined : "",
            disabled: !dirty || saving || !effective,
            type: "button",
            onClick: save,
          }, saving ? t("native.saving") : (dirty ? t("native.save") : t("native.configured")))));

      const storageCard = snap.data
        ? h("div", { className: "scu-native-card" },
            h(PanelRow, { title: t("native.storage"), description: t("native.storageHint") },
              h("span", { className: "scu-native-value" },
                snap.data.storageBytes == null ? t("native.unknown") : t("native.kb", { kb: Math.round(snap.data.storageBytes / 1024) }))))
        : null;

      // Builtin PermissionPanel shape: panels 32px apart, each with an h3,
      // one bordered card and a single hint line. No duplicated subtitle and
      // no oversized action bar competing with the card. The only toolbar
      // affordance is the shell-owned Close, present on settings.section only.
      return h("div", { className: "scu-native", "data-cua-settings": "", "aria-busy": String(loading || saving) },
        h("div", { className: "scu-native-wrap" },
          typeof props?.close === "function"
            ? h("div", { className: "scu-native-toolbar" },
                h("button", { className: "scu-native-btn scu-native-btn-sm", type: "button", onClick: snap.reload, disabled: saving }, t("native.refresh")),
                h("button", { className: "scu-native-btn scu-native-btn-sm", type: "button", onClick: props.close }, t("native.close")))
            : null,
          h("div", { className: "scu-native-panels" },
            h("section", { className: "scu-native-panel", "aria-label": t("native.authorize") },
              h("h3", null, t("native.authorize")),
              permissionCard,
              h("p", { className: "scu-native-hint" }, t("native.permissionHint"))),
            h("section", { className: "scu-native-panel", "aria-label": t("native.preferences") },
              h("h3", null, t("native.preferences")),
              preferencesCard),
            storageCard
              ? h("section", { className: "scu-native-panel", "aria-label": t("native.storage") },
                  h("h3", null, t("native.storage")), storageCard)
              : null)));
    }

    function BundleActivation(props) {
      const t = useNativeT();
      const snap = useNativeSnapshot();
      const ready = snap.data?.permissions?.available === true
        && snap.data.permissions.accessibility === true
        && snap.data.permissions.screenRecording === true;
      useEffect(() => {
        if (ready && typeof props?.onDismiss === "function") props.onDismiss();
      }, [ready, props?.onDismiss]);
      if (!props || props.packageName !== "dsh-super-computer-use") return null;
      if (ready) return null;
      if (!snap.data && snap.loading) return null;
      return h("div", { className: "scu-modal-backdrop" },
        h("div", { className: "scu-modal", role: "dialog", "aria-modal": "true" },
          h("strong", null, t("native.setupTitle")),
          h("p", null, snap.error ? t("native.setupQueryFailed") : t("native.setupBody")),
          h("div", { className: "scu-modal-foot" },
            h("button", { className: "scu-native-btn", type: "button", onClick: props.onDismiss }, t("native.later")),
            h("button", { className: "scu-native-btn", "data-variant": "primary", type: "button", onClick: props.onOpenDetails }, t("native.openSetup")))));
    }

    function SettingsIcon({ size }) {
      const s = Number(size) || 16;
      return h("svg", { width: s, height: s, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("rect", { x: 1.25, y: 2, width: 13.5, height: 10.5, rx: 2, stroke: "currentColor", "stroke-width": 1.2 }),
        h("path", { d: "M5 5.5 L5 11.5 L7.1 9.6 L8.6 12.5 L9.8 11.9 L8.4 9.2 L11 9 Z", fill: "currentColor" }));
    }

    // ---------------------------------------------------------------- plugin

    return {
      inject: ["slots", "locale"],
      // The Harness module table only needs inject/apply. The test runner loads
      // this same factory and drives the real classes; keeping the hook here is
      // cheaper and more honest than a second copy of the lifecycle logic.
      __test: {
        SessionStore, PreviewController, CuCard, Overlay, ControlDeck,
        SettingsPanel, BundleActivation, SettingsIcon, ScuToast,
        storeFor, expansion, activeDeckSession,
      },
      apply(ctx) {
        CuCard.ctx = ctx;
        Overlay.ctx = ctx;
        ControlDeck.ctx = ctx;
        NativeUI.ctx = ctx;

        const locale = ctx.get("locale");
        if (locale && typeof locale.register === "function") {
          try {
            ctx.effect(
              () => locale.register(NS, LOCALES),
              "scu: locale dictionaries",
            );
          } catch {
            // English fallback still renders if another instance registered first.
          }
        }

        if (typeof document !== "undefined") {
          ctx.effect(() => {
            const style = document.createElement("style");
            style.dataset.scu = CLIENT_VERSION;
            style.textContent = CSS;
            document.head.appendChild(style);
            return () => style.remove();
          }, "scu: styles");
        }

        ctx.effect(
          () => () => {
            // Module unload / HMR replacement: close every poller and preview
            // so the Host's response is cancelled and its helper exits.
            for (const store of stores.values()) store.stop();
            stores.clear();
          },
          "scu: session stores",
        );

        ctx.slots.inject("conversation.input.dock", () =>
          ctx.slots.register(
            { name: "conversation.input.dock", id: "super-computer-use", order: 30 },
            CuCard,
          ),
        );
        ctx.slots.inject("shell.overlay", () => {
          const disposeDeck = ctx.slots.register(
            { name: "shell.overlay", id: "super-computer-use-deck", order: 39 },
            ControlDeck,
          );
          const disposeOverlay = ctx.slots.register(
            { name: "shell.overlay", id: "super-computer-use", order: 40 },
            Overlay,
          );
          const disposeToast = ctx.slots.register(
            { name: "shell.overlay", id: "super-computer-use-toast", order: 41 },
            ScuToast,
          );
          return () => {
            try { disposeDeck?.(); } catch { /* teardown continues */ }
            try { disposeOverlay?.(); } catch { /* teardown continues */ }
            try { disposeToast?.(); } catch { /* teardown continues */ }
          };
        });

        // Settings entry plus its navigation icon. The host owns the settings
        // navigation; the plugin bar stays clean.
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "computer-use",
              order: 35,
              label: nativeNavLabel,
            },
            SettingsPanel,
          ),
        );
        ctx.slots.inject("settings.section.icon", () =>
          ctx.slots.register(
            { name: "settings.section.icon", id: "computer-use" },
            SettingsIcon,
          ),
        );

        // The bundle detail page is the same surface the built-in Computer Use
        // permission panel uses. Both slots are keyed by the package name, so
        // our configuration appears between the description and the component
        // rows, and enabling the bundle offers first-run setup guidance.
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register(
            {
              name: "plugins.bundle.config",
              key: "dsh-super-computer-use",
              locale: NS,
            },
            SettingsPanel,
          ),
        );
        ctx.slots.inject("plugins.bundle.activation", () =>
          ctx.slots.register(
            {
              name: "plugins.bundle.activation",
              key: "dsh-super-computer-use",
              locale: NS,
            },
            BundleActivation,
          ),
        );

        if (typeof window !== "undefined") {
          window.__SCU_CLIENT__ = {
            version: CLIENT_VERSION,
            rev: SCRIPT_REV,
            capabilities: CLIENT_CAPABILITIES,
            storeFor,
            expansion,
          };
          // Announce once immediately and then slowly, so a Host reload that
          // disposes the route cannot hide a client whose bundle is current.
          // The interval is torn down with this plugin fiber on HMR replacement.
          announceClient();
          if (typeof setInterval === "function") {
            ctx.effect(() => {
              const timer = setInterval(announceClient, CLIENT_HELLO_INTERVAL_MS);
              return () => clearInterval(timer);
            }, "scu: client identity heartbeat");
          }
        }
      },
    };
  },
});
})();

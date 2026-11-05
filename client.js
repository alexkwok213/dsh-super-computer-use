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
    const CLIENT_VERSION = "0.3.0";
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
      },
      zh: {
        "card.expand": "展开",
        "card.collapse": "收起",
        "card.watch": "观看",
        "card.hidePreview": "收起预览",
        "card.details": "详情",
        "card.stop": "停止",
        "card.stopping": "正在停止…",
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
      },
    };

    function tFor(localeId, key, params) {
      // Harness ships `zh`, but a shell may report a regional/script tag such
      // as `zh-CN` or `zh-Hans`; every Chinese variant reads the same copy.
      const isChinese = typeof localeId === "string" && localeId.toLowerCase().startsWith("zh");
      const dict = isChinese ? STRINGS.zh : STRINGS.en;
      let text = dict[key] ?? STRINGS.en[key] ?? key;
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
      constructor(store) {
        this.store = store;
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
            a.targetGeneration === b.targetGeneration,
        );
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
        if (!ACTIVE_STATES.has(snapshot.state)) return;
        if (this.store.expanded === false && this.store.previewWanted === false) return;
        const identity = {
          cuSessionId: snapshot.cuSessionId,
          targetGeneration: snapshot.targetGeneration,
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
        this.store.setPreview({ status: "connecting", fps: 0, frameAgeMs: null, reason: null });
        this.firstFrameTimer = setTimeout(() => {
          if (token !== this.token || !this.running || this.frames > 0) return;
          this.degradeNoFirstFrame(token, identity);
        }, 1500);

        const url =
          `${PREVIEW_PATH}?hostSessionId=${encodeURIComponent(this.store.hostSessionId)}` +
          `&cuSessionId=${encodeURIComponent(identity.cuSessionId)}` +
          `&generation=${encodeURIComponent(identity.targetGeneration)}`;

        try {
          const response = await fetch(url, {
            signal: this.abort.signal,
            credentials: "same-origin",
            cache: "no-store",
          });
          if (!response.ok || !response.body) {
            if (token === this.token && this.running) {
              this.store.setPreview({ status: "unavailable", reason: `http_${response.status}` });
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
            this.store.setPreview({ status: "stale", reason: this.invalid ?? "stream_ended" });
          }
        } catch (error) {
          if (token === this.token && error?.name !== "AbortError" && this.running) {
            this.store.setPreview({ status: "stale", reason: "stream_error" });
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
        this.store.setPreview({
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
        const current = this.store.getSnapshot();
        if (
          !current ||
          current.cuSessionId !== identity.cuSessionId ||
          current.targetGeneration !== identity.targetGeneration
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
            const latest = this.store.getSnapshot();
            if (
              !latest ||
              latest.cuSessionId !== identity.cuSessionId ||
              latest.targetGeneration !== identity.targetGeneration
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
            this.store.setPreview({
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
                this.store.setPreview({ status: "stale", reason: "no_frames" });
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
          this.store.setPreview({ status: "unavailable", fps: 0, frameAgeMs: null, reason: "closed" });
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
        this.preview = new PreviewController(this);
        this.previewInfo = { status: "unavailable", fps: 0, frameAgeMs: null };
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
      rebuildView() {
        this.view = {
          ...this.snapshot,
          previewInfo: this.previewInfo,
          connection: this.connection,
          lastError: this.lastError,
          stopping: this.stopping === true,
          expanded: this.expanded,
          watching: this.watching,
          previewWanted: this.previewWanted,
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
              this.preview.close();
            } else {
              this.pollNow(true);
              if (this.expanded || this.previewWanted) this.preview.open();
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
        this.preview.close();
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
        const wasActive = ACTIVE_STATES.has(this.snapshot.state);
        const becameActive = ACTIVE_STATES.has(next.state);
        const wasFinal = FINAL_STATES.has(this.snapshot.state);
        const previousGeneration = this.snapshot.targetGeneration;
        const previousCuSessionId = this.snapshot.cuSessionId;
        this.snapshot = next;
        if (
          previousGeneration !== next.targetGeneration ||
          previousCuSessionId !== next.cuSessionId
        ) {
          // A target switch or a new CU session retires the old stream before a
          // new first frame; otherwise the old canvas keeps painting a window
          // that is no longer owned.
          this.preview.close();
        }
        if (FINAL_STATES.has(next.state)) {
          this.stoppedAt = this.stoppedAt ?? Date.now();
          // A finished session keeps no live view; the last frame is already
          // on screen and the card says it is stopped.
          this.watching = false;
          this.previewWanted = false;
          this.preview.close();
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
        if (ACTIVE_STATES.has(next.state) && (this.expanded || this.previewWanted)) {
          this.preview.open();
        }
      }

      setPreview(info) {
        this.previewInfo = { ...this.previewInfo, ...info };
        this.notify();
      }

      toggleWatch() {
        if (FINAL_STATES.has(this.snapshot.state)) return;
        if (this.watching) {
          this.watching = false;
          this.previewWanted = false;
          this.preview.close();
        } else {
          this.watching = true;
          this.previewWanted = true;
          this.pollNow(true);
          this.preview.open();
        }
        this.notify();
      }

      toggleExpanded() {
        this.expanded = !this.expanded;
        if (this.expanded) {
          this.previewWanted = true;
          expansion.set(this.hostSessionId);
          this.pollNow(true);
          this.preview.open();
        } else {
          expansion.set(null);
          // Collapsing the big panel returns to the card the user was already
          // watching; it never starts a preview they did not ask for.
          this.previewWanted = this.watching === true;
          if (!this.previewWanted) this.preview.close();
        }
        this.notify();
      }

      closeExpanded() {
        if (!this.expanded) return;
        this.expanded = false;
        expansion.set(null);
        this.previewWanted = this.watching === true;
        if (!this.previewWanted) this.preview.close();
        this.notify();
      }

      dismiss() {
        this.dismissed = true;
        this.closeExpanded();
        this.notify();
      }

      async stopControl(command = "stop") {
        if (this.stopping) return;
        const epoch = this.lifecycleEpoch;
        this.stopping = true;
        this.notify();
        try {
          // STOP is identity-based: the server ignores ordinary state revisions
          // so a click between two polls still stops. Sending expectedRevision
          // here would reintroduce exactly the 409 this fixes.
          const data = await postJson(CONTROL_PATH, {
            hostSessionId: this.hostSessionId,
            cuSessionId: this.snapshot.cuSessionId,
            command,
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
          this.stoppedAt = Date.now();
          this.preview.close();
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
            this.stopping = false;
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
.scu-root { pointer-events: auto; --scu-radius: 12px; --scu-fg: var(--dsw-alias-label-primary); --scu-fg2: var(--dsw-alias-label-secondary);
  --scu-line: var(--dsw-alias-border-l1); --scu-line2: var(--dsw-alias-border-l2);
  --scu-surface: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 78%, transparent);
  --scu-accent: var(--dsw-alias-brand-primary); --scu-ok: var(--dsw-alias-state-success-primary);
  --scu-warn: var(--dsw-alias-state-warn-primary); --scu-err: var(--dsw-alias-state-error-primary);
  color: var(--scu-fg); font-size: 12px; line-height: 1.35; }
.scu-card { box-sizing: border-box; width: min(320px, 100%); margin: 6px auto 2px; border-radius: var(--scu-radius);
  border: 1px solid var(--scu-line); background: var(--scu-surface);
  -webkit-backdrop-filter: blur(18px) saturate(1.35); backdrop-filter: blur(18px) saturate(1.35);
  box-shadow: 0 8px 28px rgba(0,0,0,.16), 0 1px 0 rgba(255,255,255,.06) inset;
  padding: 8px 9px 9px; overflow: hidden; animation: scu-in 120ms ease-out both; }
.scu-strip { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 5px 9px; }
.scu-strip .scu-head { flex: 1 1 auto; min-height: 0; }
.scu-strip .scu-app { font-size: 11.5px; }
.scu-strip .scu-sub { font-size: 10.5px; }
.scu-watch { appearance: none; border: 1px solid color-mix(in srgb, var(--scu-accent) 45%, var(--scu-line));
  background: color-mix(in srgb, var(--scu-accent) 10%, transparent); color: var(--scu-accent);
  border-radius: 8px; padding: 4px 9px; font-size: 11px; font-weight: 600; cursor: pointer; flex: 0 0 auto; }
.scu-watch:hover { background: color-mix(in srgb, var(--scu-accent) 18%, transparent); }
.scu-watch:focus-visible { outline: 2px solid var(--scu-accent); outline-offset: 1px; }
.scu-head { display: flex; align-items: center; gap: 8px; min-height: 26px; }
.scu-dot { width: 8px; height: 8px; border-radius: 99px; flex: 0 0 auto; background: var(--scu-fg2);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--scu-fg2) 18%, transparent); }
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
.scu-stop { appearance: none; border: 1px solid color-mix(in srgb, var(--scu-err) 45%, var(--scu-line));
  background: color-mix(in srgb, var(--scu-err) 12%, transparent); color: var(--scu-err);
  border-radius: 8px; padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer; flex: 0 0 auto; }
.scu-stop:hover { background: color-mix(in srgb, var(--scu-err) 20%, transparent); }
.scu-stop:disabled { opacity: .55; cursor: default; }
.scu-stop:focus-visible { outline: 2px solid var(--scu-err); outline-offset: 1px; }
.scu-error { margin-top: 6px; color: var(--scu-err); font-size: 10.5px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.scu-perm-btn { appearance: none; border: 1px solid var(--scu-line2); background: color-mix(in srgb, var(--dsw-alias-primary, #4b70e2) 18%, transparent); color: var(--scu-fg); border-radius: 6px; padding: 2px 8px; font-size: 10.5px; font-weight: 550; cursor: pointer; }
.scu-perm-btn:hover { background: color-mix(in srgb, var(--dsw-alias-primary, #4b70e2) 32%, transparent); }
.scu-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(8,10,14,.42);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); display: grid; place-items: center; padding: 24px;
  animation: scu-fade 180ms ease-out both; }
.scu-panel { width: min(860px, 94vw); max-height: min(78vh, 760px); border-radius: 16px; overflow: hidden;
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 92%, transparent);
  border: 1px solid var(--scu-line2); box-shadow: 0 28px 80px rgba(0,0,0,.42);
  display: flex; flex-direction: column; animation: scu-rise 180ms cubic-bezier(.2,.7,.3,1) both; }
.scu-panel-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--scu-line); }
.scu-panel-title { font-weight: 650; font-size: 13px; }
.scu-panel-sub { color: var(--scu-fg2); font-size: 11px; flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scu-panel-body { position: relative; flex: 1 1 auto; min-height: 240px; background: #05070a; display: grid; place-items: center; }
.scu-panel-canvas { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; display: block; }
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
@media (prefers-reduced-motion: reduce) {
  .scu-card, .scu-backdrop, .scu-panel, .scu-dot { animation: none !important; transition: none !important; }
}
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

    function useLocale(ctx) {
      const locale = ctx.get("locale");
      const subscribe = useCallback(
        (fn) => (locale?.subscribe ? locale.subscribe(fn) : () => {}),
        [locale],
      );
      const get = useCallback(() => (locale?.getLocale ? locale.getLocale().id : "en"), [locale]);
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

    function ageText(ms, t) {
      if (ms === null || ms === undefined) return t("meta.none");
      return t("card.frameAge", { seconds: (ms / 1000).toFixed(1) });
    }

    function StopButton({ store, snapshot, t }) {
      const stopping = snapshot.state === "stopping" || snapshot.stopping === true;
      return h(
        "button",
        {
          type: "button",
          className: "scu-stop",
          disabled: stopping,
          // One activation path: click (also produced by keyboard and AXPress).
          // A pointerdown+click pair relied on the stopping flag/time to hide a
          // double trigger instead of having only one semantic trigger.
          onClick: () => store.stopControl("stop"),
          title: t("card.stop"),
        },
        stopping ? t("card.stopping") : t("card.stop"),
      );
    }

    function PreviewCanvas({ store, className, compact }) {
      const canvasRef = useRef(null);
      useEffect(() => {
        store.preview.attach(canvasRef.current);
        const wants = store.expanded || store.previewWanted;
        if (wants) store.preview.open();
        const attached = canvasRef.current;
        return () => store.preview.detach(attached);
      }, [store]);
      return h("canvas", {
        ref: canvasRef,
        className,
        "aria-hidden": true,
        "data-compact": compact ? "1" : "0",
      });
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
          store.preview.open();
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

      const stop = h(StopButton, { store, snapshot, t });
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
              h("span", { className: "scu-app", title: targetName(snapshot, t) }, targetName(snapshot, t)),
              h("span", { className: "scu-sub" }, stateText(t, snapshot)),
            ),
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
        store.preview.open();
        return undefined;
      }, [expandedSession, store]);

      if (!expandedSession || !store) return null;
      if (FINAL_STATES.has(snapshot.state) && store.stoppedAt && Date.now() - store.stoppedAt > 60000) return null;

      const info = snapshot.previewInfo ?? store.previewInfo;
      const target = targetName(snapshot, t);
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
            h(
              "div",
              { className: "scu-panel-body" },
              h(PreviewCanvas, { store, className: "scu-panel-canvas", compact: false }),
              store.preview.frames === 0
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
              h(StopButton, { store, snapshot, t }),
            ),
            h(
              "details",
              { className: "scu-diag" },
              h("summary", null, t("card.details")),
              h(
                "div",
                { className: "scu-diag-grid" },
                h("span", null, h("b", null, t("diag.generation")), ` ${snapshot.targetGeneration ?? "—"}`),
                h(
                  "span",
                  null,
                  h("b", null, t("diag.frames")),
                  ` ${store.preview.frames}${store.preview.dropped ? ` / dropped ${store.preview.dropped}` : ""}${info.decodeMs ? ` / ${info.decodeMs}ms` : ""}`,
                ),
              ),
            ),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------- plugin

    return {
      inject: ["slots", "locale"],
      // The Harness module table only needs inject/apply. The test runner loads
      // this same factory and drives the real classes; keeping the hook here is
      // cheaper and more honest than a second copy of the lifecycle logic.
      __test: { SessionStore, PreviewController, CuCard, Overlay, storeFor, expansion },
      apply(ctx) {
        CuCard.ctx = ctx;
        Overlay.ctx = ctx;

        const locale = ctx.get("locale");
        if (locale && typeof locale.register === "function") {
          try {
            ctx.effect(
              () => locale.register(NS, { en: STRINGS.en, zh: STRINGS.zh }),
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
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register({ name: "shell.overlay", id: "super-computer-use", order: 40 }, Overlay),
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

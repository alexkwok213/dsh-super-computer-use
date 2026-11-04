// Unified action-event protocol v1 (Spec §5.2) and the NDJSON stream reader that
// carries native phases. One normalized event shape is what the overlay, the
// capsule and the tool result all read, so "what the user sees" can never drift
// from "what the engine actually did".
//
// This module is pure: it validates/normalizes/dedupes and parses. It never
// touches the desktop.

export const ACTION_EVENT_VERSION = 1;
export const PHASES = [
  "accepted",
  "targetReady",
  "dispatched",
  "waiting",
  "verified",
  "unverified",
  "failed",
  "cancelled",
  "unknown",
];
export const KINDS = ["click", "type", "key", "scroll", "drag", "observe", "expect"];
export const SOURCES = ["adapter", "native"];

// A phase that describes a resolved target MUST carry a valid target.
const TARGET_REQUIRED = new Set(["targetReady", "dispatched", "waiting", "verified", "unverified"]);
// Terminal end states.
export const TERMINAL_PHASES = new Set(["verified", "unverified", "failed", "cancelled", "unknown"]);

const isFiniteNumber = (n) => typeof n === "number" && Number.isFinite(n);
const isNonEmptyString = (s) => typeof s === "string" && s.length > 0;

function bad(field, message) {
  return { ok: false, error: "invalid_action_event", field, message };
}

function validateTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return bad("target", "target must be an object");
  }
  if (!Number.isInteger(target.pid) || target.pid < 0) {
    return bad("target.pid", "target.pid must be a non-negative integer");
  }
  if (!(target.windowId === null || Number.isInteger(target.windowId))) {
    return bad("target.windowId", "target.windowId must be an integer or null");
  }
  if (!isFiniteNumber(target.targetGeneration)) {
    return bad("target.targetGeneration", "target.targetGeneration must be a finite number");
  }
  if (!isFiniteNumber(target.geometryVersion)) {
    return bad("target.geometryVersion", "target.geometryVersion must be a finite number");
  }
  return { ok: true };
}

function validatePoint(point) {
  if (!point || typeof point !== "object") return bad("point", "point must be an object");
  // (0, 0) is a legal point: only missing/non-finite values are invalid.
  if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
    return bad("point", "point.x/point.y must be finite numbers");
  }
  return { ok: true };
}

function validateRect(rect) {
  if (!rect || typeof rect !== "object") return bad("rect", "rect must be an object");
  for (const key of ["x", "y", "width", "height"]) {
    if (!isFiniteNumber(rect[key])) return bad(`rect.${key}`, `rect.${key} must be finite`);
  }
  if (rect.width < 0 || rect.height < 0) return bad("rect", "rect width/height must be >= 0");
  return { ok: true };
}

/**
 * Validate and normalize one raw event. Returns `{ok:true, event}` or a
 * structured error `{ok:false, error, field, message}`. Never throws for bad
 * data (a malformed visual message must not break a real action).
 *
 * @param {Record<string, any>} raw
 * @param {{currentSessionId?: string}} [opts]
 */
export function normalizeActionEvent(raw, opts = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return bad("event", "event must be an object");
  }
  if (raw.version !== ACTION_EVENT_VERSION) {
    return bad("version", `version must be ${ACTION_EVENT_VERSION}`);
  }
  for (const key of ["sessionId", "actionId", "eventId"]) {
    if (!isNonEmptyString(raw[key])) return bad(key, `${key} must be a non-empty string`);
  }
  if (opts.currentSessionId && raw.sessionId !== opts.currentSessionId) {
    return { ok: false, error: "stale_session", message: `event for a superseded session` };
  }
  if (!SOURCES.includes(raw.source)) return bad("source", `source must be one of ${SOURCES.join(", ")}`);
  if (!PHASES.includes(raw.phase)) return bad("phase", `phase must be one of ${PHASES.join(", ")}`);
  if (!KINDS.includes(raw.kind)) return bad("kind", `kind must be one of ${KINDS.join(", ")}`);
  if (!isNonEmptyString(raw.clockDomain)) return bad("clockDomain", "clockDomain must be a non-empty string");
  if (!(typeof raw.emittedNs === "string" && /^\d+$/.test(raw.emittedNs))) {
    return bad("emittedNs", "emittedNs must be a string of digits (big-int safe)");
  }
  if (raw.stepIndex !== undefined && !Number.isInteger(raw.stepIndex)) {
    return bad("stepIndex", "stepIndex must be an integer");
  }
  if (raw.label !== undefined && typeof raw.label !== "string") {
    return bad("label", "label must be a string");
  }
  if (raw.reason !== undefined && typeof raw.reason !== "string") {
    return bad("reason", "reason must be a string");
  }

  const target = raw.target ?? null;
  if (target === null) {
    if (TARGET_REQUIRED.has(raw.phase)) {
      return bad("target", `${raw.phase} requires a resolved target`);
    }
  } else {
    const t = validateTarget(target);
    if (!t.ok) return t;
  }

  if (raw.point !== undefined) {
    const p = validatePoint(raw.point);
    if (!p.ok) return p;
  }
  if (raw.rect !== undefined) {
    const r = validateRect(raw.rect);
    if (!r.ok) return r;
  }

  if (raw.phase === "verified") {
    if (!raw.verification || raw.verification.matched !== true || !isNonEmptyString(raw.verification.evidenceRef)) {
      return bad("verification", "verified requires verification.matched=true and an evidenceRef");
    }
  }

  return {
    ok: true,
    event: {
      version: ACTION_EVENT_VERSION,
      sessionId: raw.sessionId,
      actionId: raw.actionId,
      eventId: raw.eventId,
      source: raw.source,
      phase: raw.phase,
      kind: raw.kind,
      target,
      clockDomain: raw.clockDomain,
      emittedNs: raw.emittedNs,
      ...(raw.stepIndex !== undefined ? { stepIndex: raw.stepIndex } : {}),
      ...(raw.point !== undefined ? { point: { x: raw.point.x, y: raw.point.y } } : {}),
      ...(raw.rect !== undefined
        ? { rect: { x: raw.rect.x, y: raw.rect.y, width: raw.rect.width, height: raw.rect.height } }
        : {}),
      ...(raw.label !== undefined ? { label: raw.label } : {}),
      ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
      ...(raw.verification !== undefined ? { verification: { ...raw.verification } } : {}),
    },
  };
}

/**
 * A per-session event log: dedupe by eventId FIRST, then assign a monotonically
 * increasing seq. A retried event keeps its identity and is dropped, so a
 * replayed native event can never re-light the overlay or reorder the stream.
 */
export function createActionEventLog({ currentSessionId, limit = 512 } = {}) {
  let seq = 0;
  let sessionId = currentSessionId;
  const seen = new Set();
  const events = [];

  return {
    get seq() {
      return seq;
    },
    get events() {
      return events;
    },
    setSession(id) {
      // A new session invalidates nothing in the log but changes which events we
      // accept going forward; older events are already recorded.
      sessionId = id;
    },
    publish(eventWithoutSeq) {
      const normalized = normalizeActionEvent(eventWithoutSeq, { currentSessionId: sessionId });
      if (!normalized.ok) return normalized;
      const event = normalized.event;
      if (seen.has(event.eventId)) {
        return { ok: false, error: "duplicate_event", duplicate: true, message: `eventId ${event.eventId} already published` };
      }
      seen.add(event.eventId);
      seq += 1;
      event.seq = seq;
      events.push(event);
      if (events.length > limit) events.splice(0, events.length - limit);
      return { ok: true, event };
    },
  };
}

/**
 * Parse the NDJSON exec stream:
 *   {"kind":"event","event":{...}}   one or more native phase events
 *   {"kind":"result","result":{...}} the final engine result (exactly once)
 *
 * Tolerates JSON split across chunks, several lines per chunk, a disconnect
 * after events (→ `stream_incomplete`, never success), a missing final result,
 * and an old engine that returned a single bare JSON result object.
 *
 * @param {{onEvent?: (event: object) => void}} [opts]
 */
export function createEventStreamParser({ onEvent } = {}) {
  let buffer = "";
  let result;
  let sawResult = false;
  let malformed = false;
  const events = [];

  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      malformed = true;
      return;
    }
    if (obj && obj.kind === "event") {
      const normalized = normalizeActionEvent(obj.event);
      if (!normalized.ok) {
        malformed = true;
        return;
      }
      events.push(normalized.event);
      try {
        onEvent?.(normalized.event);
      } catch {
        // a consumer error must never corrupt the stream
      }
      return;
    }
    if (obj && obj.kind === "result") {
      result = obj.result;
      sawResult = true;
      return;
    }
    // Old engine: one bare JSON result, no `kind` envelope.
    result = obj;
    sawResult = true;
  };

  return {
    push(chunk) {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        consumeLine(line);
      }
    },
    end() {
      if (buffer.trim()) consumeLine(buffer);
      buffer = "";
      if (!sawResult) {
        return {
          ok: false,
          error: "stream_incomplete",
          message: "the event stream ended without a final result",
          events,
          sawEvents: events.length > 0,
          ...(malformed ? { malformed: true } : {}),
        };
      }
      return {
        ok: true,
        result,
        events,
        sawEvents: events.length > 0,
        ...(malformed ? { malformed: true } : {}),
      };
    },
  };
}

/**
 * A small factory the adapter uses to publish its own (source:"adapter") phases
 * without hand-writing ids each time.
 */
export function createAdapterPublisher({ sessionId, clockDomain = "adapter" } = {}) {
  let actionCounter = 0;
  let eventCounter = 0;
  return {
    beginAction(kind) {
      actionCounter += 1;
      return `a${actionCounter}-${kind}`;
    },
    make({ actionId, kind, phase, target = null, ...rest }) {
      eventCounter += 1;
      return {
        version: ACTION_EVENT_VERSION,
        sessionId,
        actionId,
        eventId: `${actionId}#${eventCounter}`,
        source: "adapter",
        phase,
        kind,
        target,
        clockDomain,
        emittedNs: String(BigInt(Date.now()) * 1_000_000n),
        ...rest,
      };
    },
  };
}

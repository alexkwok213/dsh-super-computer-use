// One deadline / generation / cancellation context shared by the WHOLE preview
// chain: queue → capture → fallback shot → attachment save → publish.
//
// A preview is optional evidence attached to someone else's result. Once this
// deadline is spent (budget, external cancel, or a superseded session
// generation) nothing later in the chain may enqueue more work, fall back to an
// engine shot that would block the action queue, or overwrite the picture state
// of a newer session (F3, Spec §6.3 / §7.2).

export const PREVIEW_BUDGET_EXCEEDED = "PREVIEW_BUDGET_EXCEEDED";
export const PREVIEW_CANCELLED = "PREVIEW_CANCELLED";
export const PREVIEW_STALE_GENERATION = "PREVIEW_STALE_GENERATION";

export class PreviewDeadlineError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "PreviewDeadlineError";
    this.code = code;
    this.previewDeadline = true;
    Object.assign(this, meta);
  }
}

/**
 * @param {object} opts
 * @param {number} [opts.budgetMs] 0 (default) = no budget at this layer, but
 *   external cancellation and the underlying capture timeout still apply.
 * @param {AbortSignal} [opts.signal]
 * @param {any} [opts.generation] opaque generation token recorded on errors
 * @param {() => boolean} [opts.isCurrent] predicate; false ⇒ the preview belongs
 *   to a superseded session/generation and must not act.
 * @returns {{ signal: AbortSignal|undefined, remainingMs: () => number,
 *   check: () => void, dispose: () => void, expired: Promise<never>,
 *   budgetMs: number, generation: any }}
 */
export function createPreviewDeadline({ budgetMs = 0, signal, generation = null, isCurrent, now = Date.now } = {}) {
  const budget = Math.max(0, Number(budgetMs) || 0);
  const startedAt = now();
  let disposed = false;
  let timer = null;
  let abortListener = null;
  let rejectExpired = () => {};
  const expired = new Promise((_, reject) => {
    rejectExpired = reject;
  });
  // A pending/deadline promise must never surface as an unhandled rejection when
  // the caller instead polls check().
  expired.catch(() => {});

  const abortError = () =>
    new PreviewDeadlineError(PREVIEW_CANCELLED, "preview was cancelled", { generation });
  const expiredError = () =>
    new PreviewDeadlineError(PREVIEW_BUDGET_EXCEEDED, `preview exceeded its ${budget} ms budget`, {
      budgetMs: budget,
      generation,
      elapsedMs: now() - startedAt,
    });
  const staleError = () =>
    new PreviewDeadlineError(PREVIEW_STALE_GENERATION, "preview belongs to a superseded session/generation", {
      generation,
    });

  if (budget > 0) {
    timer = setTimeout(() => rejectExpired(expiredError()), budget);
    if (typeof timer.unref === "function") timer.unref();
  }
  if (signal) {
    abortListener = () => rejectExpired(abortError());
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  }

  const remainingMs = () => (budget > 0 ? Math.max(0, budget - (now() - startedAt)) : Infinity);

  function check() {
    if (disposed) return;
    if (signal?.aborted) throw abortError();
    if (typeof isCurrent === "function" && !isCurrent()) throw staleError();
    if (budget > 0 && now() - startedAt >= budget) throw expiredError();
  }

  return {
    signal,
    generation,
    budgetMs: budget,
    startedAt,
    remainingMs,
    check,
    expired,
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    },
  };
}

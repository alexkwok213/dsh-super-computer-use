// Each entry owns one pipe-bound native window. Captured entry identity prevents
// output from a retired process from controlling a replacement target.
export class NativePreviews {
  constructor({ launch, onEvent, keepAlive = false }) {
    this.launch = launch;
    this.onEvent = onEvent;
    this.keepAlive = keepAlive === true;
    this.entries = new Map();
    this.receipts = new Map();
  }

  open(identity) {
    const old = this.entries.get(identity.targetId);
    if (old && old.identity.generation === identity.generation &&
        old.identity.windowId === identity.windowId && old.child.exitCode === null) return true;
    this.close(identity.targetId);
    for (const receipt of this.receipts.values()) {
      if (receipt.identity.slot === identity.slot) receipt.child.kill('SIGTERM');
    }
    let child;
    try { child = this.launch(identity); } catch { return false; }
    const entry = { identity: { ...identity }, child, pending: '' };
    this.entries.set(identity.targetId, entry);
    const current = () => this.entries.get(identity.targetId) === entry;
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      if (!current()) return;
      entry.pending += chunk.toString();
      if (entry.pending.length > 65536) { this.close(identity.targetId); return; }
      let boundary;
      while ((boundary = entry.pending.indexOf('\n')) >= 0) {
        const line = entry.pending.slice(0, boundary);
        entry.pending = entry.pending.slice(boundary + 1);
        try { this.onEvent(entry.identity, JSON.parse(line)); } catch { /* optional visuals */ }
        if (!current()) return;
      }
    });
    const retire = () => {
      if (!current()) return;
      try { this.onEvent(entry.identity, { ok: false, error: "preview_process_ended" }); } catch { /* optional visuals */ }
      if (current()) this.entries.delete(identity.targetId);
    };
    child.on('error', retire);
    child.on('close', retire);
    // A preview must not keep its host alive. Parent exit closes stdin; the
    // native owned-preview EOF path tears down capture and the window. Tests
    // opt in to keepAlive so they can await a child's exit instead of letting
    // the test runner's event loop drain first.
    if (!this.keepAlive) {
      child.unref?.();
      child.stdin.unref?.();
      child.stdout.unref?.();
    }
    return true;
  }

  send(targetId, command) {
    const child = this.entries.get(targetId)?.child;
    if (!child?.stdin?.writable || child.stdin.destroyed) return false;
    try { child.stdin.write(`${JSON.stringify(command)}\n`); return true; }
    catch { return false; }
  }

  close(targetId, verifiedPreviews) {
    if (!verifiedPreviews) {
      for (const receipt of this.receipts.values()) {
        if (targetId === undefined || receipt.identity.targetId === targetId) receipt.child.kill('SIGTERM');
      }
    }
    if (targetId === undefined) {
      let had = false;
      for (const key of [...this.entries.keys()]) had = this.close(key, verifiedPreviews) || had;
      return had;
    }
    const entry = this.entries.get(targetId);
    if (!entry) return false;
    this.entries.delete(targetId);
    const verified = verifiedPreviews?.get(targetId) === entry.identity.generation &&
      Number.isInteger(entry.identity.generation);
    if (verified) {
      this.receipts.set(entry.child, entry);
      entry.child.once('close', () => this.receipts.delete(entry.child));
    }
    entry.child.stdin.end(verified ? '{"cmd":"last-action-verified"}\n' : undefined);
    // EOF starts the native exit transition. Bound the grace period in case a
    // child cannot drain; never delay target input-gate closure for animation.
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      const deadline = setTimeout(() => {
        if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGTERM');
      }, verified ? 5800 : 500);
      // Keep this bounded cleanup alive even when the host event loop drains.
      entry.child.once('close', () => clearTimeout(deadline));
    }
    return true;
  }
}

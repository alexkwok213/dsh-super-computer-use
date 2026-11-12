import Foundation
import Darwin
import Dispatch

/// Turn service termination into a cooperative stop, so a held mouse button
/// can be released by the drawing loop before the helper exits.
final class PaintCancellation {
    private let lock = NSLock()
    private var cancelled = false
    private let source: DispatchSourceSignal

    init() {
        signal(SIGTERM, SIG_IGN)
        source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: DispatchQueue.global(qos: .userInitiated))
        source.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.cancelled = true; self.lock.unlock()
        }
        source.resume()
    }

    var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }
}

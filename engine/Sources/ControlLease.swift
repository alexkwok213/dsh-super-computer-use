import Foundation
import Dispatch
import Security

/// A process-local lease state machine. All methods hold its lock only while
/// inspecting or changing state; callers perform work outside the lock.
///
/// This does not coordinate across processes or service restarts. If this
/// process exits while a child continues working, a new instance cannot know
/// about that work. External coordination/fencing is required for that case.
/// An end result only reports eligibility at the instant of `end`; it cannot
/// atomically protect an external commit or revoke side effects already made.
public final class ControlLease: @unchecked Sendable {
    /// Secret bearer credential; protect it in transit and do not log it.
    public struct Token: Equatable, Sendable {
        fileprivate let bytes: [UInt8]
        fileprivate init(bytes: [UInt8]) { self.bytes = bytes }
        public init?(hex: String) {
            guard let bytes = ControlLease.decodeHex(hex) else { return nil }
            self.bytes = bytes
        }
        public var hex: String { ControlLease.encodeHex(bytes) }
    }

    public struct Operation: Equatable, Sendable {
        fileprivate let bytes: [UInt8]
        fileprivate init(bytes: [UInt8]) { self.bytes = bytes }
        public init?(hex: String) {
            guard let bytes = ControlLease.decodeHex(hex) else { return nil }
            self.bytes = bytes
        }
        public var hex: String { ControlLease.encodeHex(bytes) }
    }

    private static func encodeHex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    private static func decodeHex(_ hex: String) -> [UInt8]? {
        let input = Array(hex.utf8)
        guard input.count == 64 else { return nil }
        func nibble(_ char: UInt8) -> UInt8? {
            switch char {
            case 48...57: return char - 48
            case 65...70: return char - 65 + 10
            case 97...102: return char - 97 + 10
            default: return nil
            }
        }
        var result: [UInt8] = []
        result.reserveCapacity(32)
        for index in stride(from: 0, to: input.count, by: 2) {
            guard let high = nibble(input[index]), let low = nibble(input[index + 1]) else { return nil }
            result.append(high << 4 | low)
        }
        return result
    }

    public enum DrainReason: Equatable, Sendable {
        case expired, cancelled, released
    }

    public enum LeaseError: Error, Equatable, Sendable {
        case invalidTask, invalidTTL, clockOverflow, randomnessUnavailable
        case busy, noLease, unauthorized, draining, operationInFlight, invalidOperation
    }

    public enum EndResult: Equatable, Sendable {
        case eligibleToCommit
        case discard(DrainReason)
    }

    public enum Status: Equatable, Sendable {
        case available
        case active(task: String, remainingNanoseconds: UInt64, inFlight: Bool)
        case draining(task: String, reason: DrainReason)
    }

    private struct Lease {
        let task: String
        let token: Token
        var deadline: UInt64
        var operation: Operation?
        var reason: DrainReason?
    }

    private let lock = NSLock()
    private var lease: Lease?
    private let now: () -> UInt64

    /// Uses a monotonic uptime clock. TTL values are in nanoseconds.
    public convenience init() {
        self.init(clock: { DispatchTime.now().uptimeNanoseconds })
    }

    // Internal injection permits deterministic tests; the clock must be
    // monotonic and safe to call from any thread.
    init(clock: @escaping () -> UInt64) {
        self.now = clock
    }

    private static func randomBytes() throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw LeaseError.randomnessUnavailable
        }
        return bytes
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    // Called under the lock. An expired in-flight operation retains ownership
    // until its matching end; otherwise an expired lease is immediately free.
    private func expire(at time: UInt64) {
        guard var current = lease, current.reason == nil, time >= current.deadline else { return }
        if current.operation == nil {
            lease = nil
        } else {
            current.reason = .expired
            lease = current
        }
    }

    private func deadline(at time: UInt64, ttl: UInt64) throws -> UInt64 {
        guard ttl > 0 else { throw LeaseError.invalidTTL }
        let (value, overflow) = time.addingReportingOverflow(ttl)
        guard !overflow else { throw LeaseError.clockOverflow }
        return value
    }

    private func authenticated(task: String, token: Token) throws -> Lease {
        guard let current = lease else { throw LeaseError.noLease }
        guard current.task == task && current.token == token else { throw LeaseError.unauthorized }
        return current
    }

    public func acquire(task: String, ttlNanoseconds: UInt64) throws -> Token {
        guard !task.isEmpty else { throw LeaseError.invalidTask }
        guard ttlNanoseconds > 0 else { throw LeaseError.invalidTTL }
        let token = Token(bytes: try Self.randomBytes())
        return try locked {
            let time = now()
            expire(at: time)
            guard lease == nil else { throw LeaseError.busy }
            let expiry = try deadline(at: time, ttl: ttlNanoseconds)
            lease = Lease(task: task, token: token, deadline: expiry, operation: nil, reason: nil)
            return token
        }
    }

    public func renew(task: String, token: Token, ttlNanoseconds: UInt64) throws {
        try locked {
            let time = now()
            expire(at: time)
            var current = try authenticated(task: task, token: token)
            guard current.reason == nil else { throw LeaseError.draining }
            current.deadline = try deadline(at: time, ttl: ttlNanoseconds)
            lease = current
        }
    }

    /// Stops new work. If work is in flight, ownership remains until `end`.
    public func cancel(task: String, token: Token) throws {
        try stop(task: task, token: token, reason: .cancelled)
    }

    /// Relinquishes ownership, draining any work already in flight.
    public func release(task: String, token: Token) throws {
        try stop(task: task, token: token, reason: .released)
    }

    private func stop(task: String, token: Token, reason: DrainReason) throws {
        try locked {
            expire(at: now())
            var current = try authenticated(task: task, token: token)
            guard current.reason == nil else { throw LeaseError.draining }
            if current.operation == nil {
                lease = nil
            } else {
                current.reason = reason
                lease = current
            }
        }
    }

    /// Exactly one operation may be in flight for the entire instance.
    public func begin(task: String, token: Token) throws -> Operation {
        let operation = Operation(bytes: try Self.randomBytes())
        return try locked {
            expire(at: now())
            var current = try authenticated(task: task, token: token)
            guard current.reason == nil else { throw LeaseError.draining }
            guard current.operation == nil else { throw LeaseError.operationInFlight }
            current.operation = operation
            lease = current
            return operation
        }
    }

    /// Revalidate an in-flight operation before starting another step. This is
    /// not an atomic transaction with an external GUI event; callers must still
    /// verify the target and handle cancellation racing with event delivery.
    public func checkActive(task: String, token: Token, operation: Operation) throws {
        try locked {
            expire(at: now())
            let current = try authenticated(task: task, token: token)
            guard current.reason == nil else { throw LeaseError.draining }
            guard current.operation == operation else { throw LeaseError.invalidOperation }
        }
    }

    /// Completes the exact operation. Do not perform further controlled work
    /// after this call: it may immediately permit a different task to acquire.
    public func end(task: String, token: Token, operation: Operation) throws -> EndResult {
        try locked {
            expire(at: now())
            var current = try authenticated(task: task, token: token)
            guard current.operation == operation else { throw LeaseError.invalidOperation }
            if let reason = current.reason {
                lease = nil
                return .discard(reason)
            }
            current.operation = nil
            lease = current
            return .eligibleToCommit
        }
    }

    public func status() -> Status {
        locked {
            let time = now()
            expire(at: time)
            guard let current = lease else { return .available }
            if let reason = current.reason {
                return .draining(task: current.task, reason: reason)
            }
            return .active(task: current.task, remainingNanoseconds: current.deadline - time,
                           inFlight: current.operation != nil)
        }
    }
}

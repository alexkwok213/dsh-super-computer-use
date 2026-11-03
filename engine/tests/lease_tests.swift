import Foundation
import Dispatch

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt64 = 100
    func now() -> UInt64 { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ newValue: UInt64) { lock.lock(); value = newValue; lock.unlock() }
}

private final class Results<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [T] = []
    func append(_ value: T) { lock.lock(); values.append(value); lock.unlock() }
    func snapshot() -> [T] { lock.lock(); defer { lock.unlock() }; return values }
}

private func check(_ condition: Bool, _ message: String) {
    guard condition else { fatalError(message) }
}

private func expect(_ expected: ControlLease.LeaseError, _ action: () throws -> Void) {
    do { try action(); fatalError("Expected \(expected)") }
    catch let error as ControlLease.LeaseError { check(error == expected, "Expected \(expected), got \(error)") }
    catch { fatalError("Unexpected error: \(error)") }
}

@main
private struct LeaseTests {
    static func main() throws {
        try contention()
        try expiredInFlight()
        try cancelledAndReleased()
        try authenticationAndOperations()
        try renewalAndValidation()
        try lostCompletionStaysBlocked()
        print("PASS: concurrency, expiry, cancellation/release, authentication, renewal and validation")
    }

    static func contention() throws {
        let lease = ControlLease()
        let results = Results<(String, ControlLease.Token)>()
        DispatchQueue.concurrentPerform(iterations: 128) { index in
            let task = "task-\(index)"
            if let token = try? lease.acquire(task: task, ttlNanoseconds: 60_000_000_000) {
                results.append((task, token))
            }
        }
        let winners = results.snapshot()
        check(winners.count == 1, "Only one concurrent acquisition may succeed")
        let (task, token) = winners[0]
        let operations = Results<ControlLease.Operation>()
        DispatchQueue.concurrentPerform(iterations: 128) { _ in
            if let operation = try? lease.begin(task: task, token: token) { operations.append(operation) }
        }
        let started = operations.snapshot()
        check(started.count == 1, "Only one concurrent begin may succeed")
        check(try lease.end(task: task, token: token, operation: started[0]) == .eligibleToCommit, "Valid operation should be eligible")
        try lease.release(task: task, token: token)
        check(lease.status() == .available, "Release should free an idle lease")
    }

    static func expiredInFlight() throws {
        let clock = TestClock()
        let lease = ControlLease(clock: clock.now)
        let token = try lease.acquire(task: "old", ttlNanoseconds: 10)
        let operation = try lease.begin(task: "old", token: token)
        try lease.checkActive(task: "old", token: token, operation: operation)
        clock.set(110)
        expect(.draining) { try lease.checkActive(task: "old", token: token, operation: operation) }
        check(lease.status() == .draining(task: "old", reason: .expired), "Expiry must drain")
        expect(.busy) { _ = try lease.acquire(task: "new", ttlNanoseconds: 10) }
        expect(.draining) { try lease.renew(task: "old", token: token, ttlNanoseconds: 10) }
        expect(.draining) { _ = try lease.begin(task: "old", token: token) }
        check(try lease.end(task: "old", token: token, operation: operation) == .discard(.expired), "Expired work must be discarded")
        let next = try lease.acquire(task: "new", ttlNanoseconds: 10)
        try lease.release(task: "new", token: next)
        let idle = try lease.acquire(task: "idle", ttlNanoseconds: 10)
        clock.set(120)
        check(lease.status() == .available, "Expired idle lease must become available")
        expect(.noLease) { try lease.renew(task: "idle", token: idle, ttlNanoseconds: 10) }
    }

    static func cancelledAndReleased() throws {
        for isCancel in [true, false] {
            let clock = TestClock()
            let lease = ControlLease(clock: clock.now)
            let token = try lease.acquire(task: "old", ttlNanoseconds: 50)
            let operation = try lease.begin(task: "old", token: token)
            if isCancel { try lease.cancel(task: "old", token: token) }
            else { try lease.release(task: "old", token: token) }
            let reason: ControlLease.DrainReason = isCancel ? .cancelled : .released
            check(lease.status() == .draining(task: "old", reason: reason), "Stop must drain in-flight work")
            expect(.draining) { try lease.checkActive(task: "old", token: token, operation: operation) }
            expect(.busy) { _ = try lease.acquire(task: "new", ttlNanoseconds: 10) }
            expect(.draining) { _ = try lease.begin(task: "old", token: token) }
            clock.set(200)
            check(try lease.end(task: "old", token: token, operation: operation) == .discard(reason), "Stop reason must survive expiry")
            let next = try lease.acquire(task: "new", ttlNanoseconds: 10)
            try lease.cancel(task: "new", token: next)
            check(lease.status() == .available, "Idle cancellation should free lease")
        }
    }

    static func authenticationAndOperations() throws {
        let lease = ControlLease()
        let old = try lease.acquire(task: "same", ttlNanoseconds: 60_000_000_000)
        let oldOperation = try lease.begin(task: "same", token: old)
        _ = try lease.end(task: "same", token: old, operation: oldOperation)
        try lease.release(task: "same", token: old)
        let token = try lease.acquire(task: "same", ttlNanoseconds: 60_000_000_000)
        check(ControlLease.Token(hex: token.hex) == token, "Token must survive serialization")
        check(ControlLease.Token(hex: String(repeating: "z", count: 64)) == nil, "Invalid token must be rejected")
        check(ControlLease.Token(hex: "00") == nil, "Short token must be rejected")
        check(old != token, "Tokens must differ across acquisitions")
        expect(.unauthorized) { _ = try lease.begin(task: "same", token: old) }
        expect(.unauthorized) { try lease.cancel(task: "wrong", token: token) }
        expect(.unauthorized) { try lease.renew(task: "same", token: old, ttlNanoseconds: 10) }
        expect(.unauthorized) { try lease.release(task: "same", token: old) }
        let op = try lease.begin(task: "same", token: token)
        check(ControlLease.Operation(hex: op.hex) == op, "Operation must survive serialization")
        check(ControlLease.Operation(hex: "invalid") == nil, "Invalid operation must be rejected")
        expect(.unauthorized) { _ = try lease.end(task: "same", token: old, operation: op) }
        expect(.unauthorized) { try lease.checkActive(task: "same", token: old, operation: op) }
        expect(.invalidOperation) { try lease.checkActive(task: "same", token: token, operation: oldOperation) }
        expect(.invalidOperation) { _ = try lease.end(task: "same", token: token, operation: oldOperation) }
        expect(.operationInFlight) { _ = try lease.begin(task: "same", token: token) }
        check(try lease.end(task: "same", token: token, operation: op) == .eligibleToCommit, "Correct operation ends")
        expect(.invalidOperation) { _ = try lease.end(task: "same", token: token, operation: op) }
        try lease.release(task: "same", token: token)
    }

    static func lostCompletionStaysBlocked() throws {
        let clock = TestClock()
        let lease = ControlLease(clock: clock.now)
        let token = try lease.acquire(task: "old", ttlNanoseconds: 10)
        let operation = try lease.begin(task: "old", token: token)
        clock.set(10_000)
        for _ in 0..<10 {
            check(lease.status() == .draining(task: "old", reason: .expired), "Unconfirmed work must stay blocked")
            expect(.busy) { _ = try lease.acquire(task: "new", ttlNanoseconds: 10) }
        }
        check(try lease.end(task: "old", token: token, operation: operation) == .discard(.expired), "Only matching completion releases draining")
    }

    static func renewalAndValidation() throws {
        let clock = TestClock()
        let lease = ControlLease(clock: clock.now)
        expect(.invalidTask) { _ = try lease.acquire(task: "", ttlNanoseconds: 10) }
        expect(.invalidTTL) { _ = try lease.acquire(task: "x", ttlNanoseconds: 0) }
        expect(.clockOverflow) { _ = try lease.acquire(task: "x", ttlNanoseconds: UInt64.max) }
        let token = try lease.acquire(task: "x", ttlNanoseconds: 10)
        expect(.invalidTTL) { try lease.renew(task: "x", token: token, ttlNanoseconds: 0) }
        expect(.clockOverflow) { try lease.renew(task: "x", token: token, ttlNanoseconds: UInt64.max) }
        clock.set(105)
        try lease.renew(task: "x", token: token, ttlNanoseconds: 20)
        clock.set(110)
        check(lease.status() == .active(task: "x", remainingNanoseconds: 15, inFlight: false), "Renewal should reset TTL from now")
        try lease.release(task: "x", token: token)
    }
}

import Foundation
import Dispatch
import Darwin

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}

private final class DeferredDelivery: @unchecked Sendable {
    private let lock = NSLock()
    private var callback: (@Sendable () -> Void)?
    func store(_ value: @escaping @Sendable () -> Void) {
        lock.lock(); callback = value; lock.unlock()
    }
    func deliver() {
        lock.lock(); let value = callback; callback = nil; lock.unlock()
        value?()
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.lock(); count += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}

@main
struct ProcessSupervisorTests {
    static func main() throws {
        let arguments = CommandLine.arguments
        if arguments.count > 1 {
            switch arguments[1] {
            case "normal":
                FileHandle.standardOutput.write(Data("hello".utf8))
                FileHandle.standardError.write(Data("error".utf8))
                exit(7)
            case "wait":
                sleep(30)
                exit(0)
            case "ignore":
                signal(SIGTERM, SIG_IGN)
                sleep(30)
                exit(0)
            case "flood":
                let chunk = Data(repeating: 65, count: 16_384)
                for _ in 0..<256 {
                    FileHandle.standardOutput.write(chunk)
                    FileHandle.standardError.write(chunk)
                }
                exit(0)
            default: exit(2)
            }
        }

        let executable = URL(fileURLWithPath: arguments[0]).standardizedFileURL
        let supervisor = ProcessSupervisor()
        let normalConfig = ProcessSupervisor.Configuration(timeout: 5, termGrace: 0.5, killGrace: 1)
        let quickConfig = ProcessSupervisor.Configuration(timeout: 0.5, termGrace: 0.3, killGrace: 2)
        let normal = try supervisor.run(executable: executable, arguments: ["normal"], configuration: normalConfig)
        if case .exited(let result) = normal.outcome {
            check(result.status == 7 && result.reason == .exit, "normal status")
        } else { check(false, "normal exit confirmed") }
        check(!normal.timedOut && normal.signals.isEmpty, "normal did not time out")
        check(String(data: normal.handle.output.stdout, encoding: .utf8) == "hello", "stdout captured")
        check(String(data: normal.handle.output.stderr, encoding: .utf8) == "error", "stderr captured")

        let term = try supervisor.run(executable: executable, arguments: ["wait"], configuration: quickConfig)
        if case .exited(let result) = term.outcome {
            check(result.reason == .uncaughtSignal && result.status == SIGTERM, "TERM exit confirmed")
        } else { check(false, "TERM exit confirmation") }
        check(term.timedOut && term.signals.map(\.signal) == [SIGTERM], "TERM escalation")
        check(term.signals.allSatisfy { $0.error == 0 }, "TERM accepted")

        let ignored = try supervisor.run(executable: executable, arguments: ["ignore"], configuration: quickConfig)
        if case .exited(let result) = ignored.outcome {
            check(result.reason == .uncaughtSignal && result.status == SIGKILL, "KILL exit confirmed")
        } else { check(false, "KILL exit confirmation") }
        check(ignored.signals.map(\.signal) == [SIGTERM, SIGKILL], "ignored TERM escalates to KILL")
        check(ignored.signals.allSatisfy { $0.error == 0 }, "signals accepted")

        var floodConfig = normalConfig
        floodConfig.outputLimit = 1024
        let flood = try supervisor.run(executable: executable, arguments: ["flood"], configuration: floodConfig)
        if case .exited(let result) = flood.outcome {
            check(result.status == 0 && !flood.timedOut, "both pipes drained without deadlock")
        } else { check(false, "flood exit confirmed") }
        let captured = flood.handle.output
        check(captured.stdout.count == 1024 && captured.stderr.count == 1024, "output bounded")
        check(captured.stdoutTruncated && captured.stderrTruncated, "truncation reported")

        let deferred = DeferredDelivery()
        let injected = ProcessSupervisor(terminationDelivery: { deferred.store($0) })
        let unconfirmed = try injected.run(executable: executable, arguments: ["normal"],
            configuration: .init(timeout: 0.3, termGrace: 0.1, killGrace: 0.1))
        if case .uncertain = unconfirmed.outcome {} else { check(false, "unconfirmed returns uncertain") }
        check(unconfirmed.handle.waitForConfirmation(timeout: 0) == nil, "no fabricated confirmation")
        check(unconfirmed.handle.processIdentifier > 0, "process retained for tracking")
        let elapsedStart = DispatchTime.now().uptimeNanoseconds
        check(unconfirmed.handle.waitForConfirmation(timeout: 0.05) == nil, "unconfirmed wait expires")
        let elapsed = DispatchTime.now().uptimeNanoseconds - elapsedStart
        check(elapsed >= 30_000_000, "unconfirmed wait does not return early")
        deferred.deliver()
        check(unconfirmed.handle.waitForConfirmation(timeout: 1)?.status == 7, "late confirmation tracked")
        check(unconfirmed.handle.waitForConfirmation(timeout: 0)?.status == 7, "confirmation remains observable")

        let counter = Counter()
        DispatchQueue.concurrentPerform(iterations: 12) { _ in
            if let result = try? supervisor.run(executable: executable, arguments: ["normal"], configuration: normalConfig),
               case .exited(let value) = result.outcome, value.status == 7,
               String(data: result.handle.output.stdout, encoding: .utf8) == "hello" {
                counter.increment()
            }
        }
        check(counter.value == 12, "concurrent independent processes")

        do {
            _ = try supervisor.run(executable: executable, configuration: .init(timeout: .nan, termGrace: 0, killGrace: 0))
            check(false, "invalid configuration rejected")
        } catch ProcessSupervisor.ConfigurationError.invalidConfiguration {}
        print("process supervisor tests passed")
    }
}

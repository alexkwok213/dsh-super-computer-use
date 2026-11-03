import Foundation
import Dispatch
import Darwin

/// Supervises only the directly launched process. It cannot prove that descendants
/// have exited or that any external input state has been restored.
final class ProcessSupervisor: Sendable {
    struct Configuration {
        var timeout: TimeInterval
        var termGrace: TimeInterval
        var killGrace: TimeInterval
        var outputLimit: Int = 1_048_576
    }

    struct SignalAttempt {
        let signal: Int32
        /// Zero means the signal was accepted; otherwise this is an errno value.
        let error: Int32
    }

    enum Outcome {
        case exited(Exit)
        case uncertain
    }

    struct Exit {
        let status: Int32
        let reason: Process.TerminationReason
    }

    struct Output {
        let stdout: Data
        let stderr: Data
        let stdoutTruncated: Bool
        let stderrTruncated: Bool
    }

    struct Result {
        let outcome: Outcome
        let timedOut: Bool
        let signals: [SignalAttempt]
        /// Keep this handle to inspect an uncertain process and wait again later.
        let handle: Handle
    }

    enum ConfigurationError: Error {
        case invalidConfiguration
    }

    // Injection delays or suppresses delivery of the real termination handler;
    // it cannot manufacture an exit without that handler first running.
    typealias TerminationDelivery = @Sendable (@escaping @Sendable () -> Void) -> Void
    typealias SignalSender = @Sendable (pid_t, Int32) -> Int32
    private let delivery: TerminationDelivery
    private let sendSignal: SignalSender

    init(terminationDelivery: @escaping TerminationDelivery = { $0() },
         signalSender: @escaping SignalSender = { pid, signal in
             if Darwin.kill(pid, signal) == 0 { return 0 }
             return errno
         }) {
        self.delivery = terminationDelivery
        self.sendSignal = signalSender
    }

    /// Each call owns a separate Process and can run concurrently with other calls.
    /// A launch failure is thrown; a launched process always has a tracking handle.
    func run(executable: URL, arguments: [String] = [],
             environment: [String: String]? = nil,
             configuration: Configuration) throws -> Result {
        let durations = [configuration.timeout, configuration.termGrace, configuration.killGrace]
        guard durations.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 86_400 }),
              configuration.outputLimit >= 0 else { throw ConfigurationError.invalidConfiguration }

        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        if let environment = environment { process.environment = environment }
        process.standardInput = FileHandle.nullDevice
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        let handle = Handle(process: process, stdout: outPipe, stderr: errPipe,
                            limit: configuration.outputLimit)
        let delivery = self.delivery
        process.terminationHandler = { process in
            let exit = Exit(status: process.terminationStatus, reason: process.terminationReason)
            // Capture the exit before delivery is injected. Drain buffered bytes even
            // if a descendant still holds a write end; never wait for pipe EOF.
            handle.finishOutput()
            process.terminationHandler = nil
            delivery { handle.confirm(exit) }
        }
        do {
            try process.run()
        } catch {
            process.terminationHandler = nil
            handle.finishOutput()
            throw error
        }
        // Process.run() duplicates the write ends for the child. The parent must
        // close its copies so they cannot keep the pipes open.
        try? outPipe.fileHandleForWriting.close()
        try? errPipe.fileHandleForWriting.close()
        handle.startOutput()

        if let exit = handle.waitForConfirmation(timeout: configuration.timeout) {
            return Result(outcome: .exited(exit), timedOut: false, signals: [], handle: handle)
        }
        var attempts: [SignalAttempt] = []
        if let attempt = handle.signalIfUnconfirmed(SIGTERM, sender: sendSignal) { attempts.append(attempt) }
        if let exit = handle.waitForConfirmation(timeout: configuration.termGrace) {
            return Result(outcome: .exited(exit), timedOut: true, signals: attempts, handle: handle)
        }
        if let attempt = handle.signalIfUnconfirmed(SIGKILL, sender: sendSignal) { attempts.append(attempt) }
        if let exit = handle.waitForConfirmation(timeout: configuration.killGrace) {
            return Result(outcome: .exited(exit), timedOut: true, signals: attempts, handle: handle)
        }
        return Result(outcome: .uncertain, timedOut: true, signals: attempts, handle: handle)
    }

    final class Handle: @unchecked Sendable {
        private let process: Process
        private let lock = NSLock()
        private let confirmation = DispatchGroup()
        private var exit: Exit?
        private let stdout: PipeDrain
        private let stderr: PipeDrain

        fileprivate init(process: Process, stdout: Pipe, stderr: Pipe, limit: Int) {
            self.process = process
            self.confirmation.enter()
            self.stdout = PipeDrain(stdout.fileHandleForReading, limit: limit)
            self.stderr = PipeDrain(stderr.fileHandleForReading, limit: limit)
        }

        var processIdentifier: pid_t { process.processIdentifier }

        /// Returns nil unless the Foundation termination handler has confirmed exit.
        func waitForConfirmation(timeout: TimeInterval) -> Exit? {
            guard timeout.isFinite && timeout >= 0 && timeout <= 86_400 else { return nil }
            guard confirmation.wait(timeout: .now() + timeout) == .success else { return nil }
            lock.lock()
            defer { lock.unlock() }
            return exit
        }

        /// A snapshot; output may continue to arrive while the process is running.
        var output: Output {
            let out = stdout.snapshot()
            let err = stderr.snapshot()
            return Output(stdout: out.0, stderr: err.0,
                          stdoutTruncated: out.1, stderrTruncated: err.1)
        }

        fileprivate func startOutput() { stdout.start(); stderr.start() }
        fileprivate func finishOutput() { stdout.finish(); stderr.finish() }
        fileprivate func confirm(_ value: Exit) {
            lock.lock()
            if exit == nil {
                exit = value
                confirmation.leave()
            }
            lock.unlock()
        }

        fileprivate func signalIfUnconfirmed(_ signal: Int32, sender: SignalSender) -> SignalAttempt? {
            lock.lock()
            defer { lock.unlock() }
            guard exit == nil, process.isRunning else { return nil }
            return SignalAttempt(signal: signal, error: sender(process.processIdentifier, signal))
        }
    }
}

/// Nonblocking, bounded capture. Once the direct child terminates, drain what is
/// immediately available and close without waiting for inherited writer handles.
private final class PipeDrain {
    private let lock = NSLock()
    private let handle: FileHandle
    private let limit: Int
    private var data = Data()
    private var truncated = false
    private var finished = false
    private var source: DispatchSourceRead?

    init(_ handle: FileHandle, limit: Int) {
        self.handle = handle
        self.limit = limit
        let fd = handle.fileDescriptor
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    }

    func start() {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return }
        let source = DispatchSource.makeReadSource(fileDescriptor: handle.fileDescriptor,
                                                    queue: DispatchQueue.global(qos: .utility))
        self.source = source
        source.setEventHandler { [weak self] in self?.readAvailable() }
        source.resume()
    }

    func finish() {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return }
        drainLocked()
        finished = true
        source?.cancel()
        source = nil
        try? handle.close()
    }

    func snapshot() -> (Data, Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (data, truncated)
    }

    private func readAvailable() {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return }
        if drainLocked() {
            finished = true
            source?.cancel()
            source = nil
            try? handle.close()
        }
    }

    // Limit each pass so another process holding a writer cannot monopolize it.
    @discardableResult
    private func drainLocked() -> Bool {
        var buffer = [UInt8](repeating: 0, count: 16_384)
        for _ in 0..<256 {
            let n = Darwin.read(handle.fileDescriptor, &buffer, buffer.count)
            if n > 0 {
                let count = Int(n)
                let keep = min(count, max(0, limit - data.count))
                if keep > 0 { data.append(contentsOf: buffer[0..<keep]) }
                if keep < count { truncated = true }
            } else if n < 0 && errno == EINTR {
                continue
            } else {
                return n == 0
            }
        }
        return false
    }
}

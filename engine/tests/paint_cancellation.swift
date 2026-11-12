import Foundation
import Darwin
@main struct PaintCancellationTest {
    static func main() {
        let cancellation = PaintCancellation()
        precondition(!cancellation.isCancelled)
        kill(getpid(), SIGTERM)
        let until = Date().addingTimeInterval(2)
        while !cancellation.isCancelled && Date() < until { usleep(1000) }
        precondition(cancellation.isCancelled, "SIGTERM must request a graceful paint stop")
        print("paint cancellation tests passed")
    }
}

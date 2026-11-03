// Read-only query benchmark; no windows are created or activated.
import Foundation
import CoreGraphics
let allOptions: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = CGWindowListCopyWindowInfo(allOptions, kCGNullWindowID) as? [[String: Any]] ?? []
guard let row = windows.first(where: { ($0[kCGWindowLayer as String] as? Int) == 0 }),
      let id = row[kCGWindowNumber as String] as? UInt32 else {
    fputs("No visible target window for benchmark\n", stderr)
    exit(1)
}
func measure(_ name: String, _ query: () -> Void) {
    var samples: [Double] = []
    for _ in 0..<10 { query() }
    for _ in 0..<200 {
        let start = DispatchTime.now().uptimeNanoseconds
        query()
        samples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
    }
    samples.sort()
    print(String(format: "%@: median %.3f ms; p95 %.3f ms; 200 samples", name, samples[100], samples[190]))
}
measure("full window query") { _ = CGWindowListCopyWindowInfo(allOptions, kCGNullWindowID) }
measure("single window query") { _ = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) }

"""Render the actual overlay class offscreen; no desktop windows are opened."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
source = (root / 'engine/Sources/VisualFeedback.swift').read_text()
view = source[source.index('final class CursorLayerView: NSView {'):]
check = r'''
let view = CursorLayerView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
view.layout()
let rim = view.layer!.sublayers!.first!
view.setAura(false)
let disabledOpacity = rim.opacity
// runCursorOverlay calls pulseAura on cursor/click/label, unconditionally.
view.pulseAura()
let afterActionOpacity = rim.opacity
print("{\"rimDisabledOpacity\":\(disabledOpacity),\"rimAfterActionOpacity\":\(afterActionOpacity)}")
'''
with tempfile.TemporaryDirectory(prefix='scu-view-review-') as directory:
    work = Path(directory)
    main = work / 'main.swift'
    binary = work / 'view-probe'
    main.write_text('import AppKit\nimport QuartzCore\n' + view + check)
    subprocess.run(['swiftc', '-swift-version', '5', '-module-cache-path', str(work / 'cache'),
                    '-framework', 'AppKit', '-framework', 'QuartzCore',
                    str(main), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)

#!/usr/bin/env python3
"""Render a cu_paint_plan plan JSON to a pixel-accurate PNG.

This is the reliable "draw the reference image" path: instead of driving a
thick, self-drawn web brush through fragile UI, compile the image with
`cu drawplan`, then rasterize the plan's horizontal runs here and place the PNG
into the target app (upload / drop). Deterministic and pixel-exact.

Usage:
  python3 scripts/plan-to-png.py plan.json out.png [--scale 1] [--bg "#ffffff"]
         [--local] [--transparent]

Flags:
  --local        ignore the plan's absolute x0/y0 (screen coords) and render
                 from (0,0), so the preview has no useless top/left margin.
  --transparent  RGBA with an alpha-0 background instead of opaque white, so
                 the preview can be compared against the reference cleanly.

IMPORTANT: this PNG is an OFF-SCREEN COMPOSITION/COLOUR PREVIEW ONLY. It must
NEVER be uploaded, pasted or dropped into the target app as a deliverable:
computer use requires real strokes injected into the app itself (user ruling
2026-11-08, see docs/process-authenticity-oracle.md). `draw-image.mjs` now
only produces this preview; its placement capability was removed.

Plan format (from `cu drawplan`):
  { x0, y0, sx, sy, layers:[{index, hex, runs:[[i0,j,i1], ...]}, ...] }
  Each run is a same-colour horizontal span on grid row j from column i0..i1.
"""
import json
import sys
from PIL import Image, ImageDraw


def render(plan, scale=1, bg=(255, 255, 255), local=False, transparent=False):
    layers = plan["layers"]
    sx, sy = plan["sx"], plan["sy"]
    # x0/y0 are absolute screen coords of the drawing rect. They are correct for
    # stroke painting but must be dropped when rasterising a standalone image.
    x0 = 0 if local else plan["x0"]
    y0 = 0 if local else plan["y0"]
    maxx = x0
    maxy = y0
    for l in layers:
        for r in l["runs"]:
            maxx = max(maxx, x0 + (r[2] + 1) * sx)
            maxy = max(maxy, y0 + (r[1] + 1) * sy)
    w = int(maxx + 20)
    h = int(maxy + 20)
    size = (max(1, int(w * scale)), max(1, int(h * scale)))
    mode = "RGBA" if transparent else "RGB"
    fill_bg = (0, 0, 0, 0) if transparent else bg
    img = Image.new(mode, size, fill_bg)
    d = ImageDraw.Draw(img)
    # light -> dark so darker detail lands on top
    def lum(hexc):
        r = int(hexc[1:3], 16); g = int(hexc[3:5], 16); b = int(hexc[5:7], 16)
        return 0.299 * r + 0.587 * g + 0.114 * b
    for l in sorted(layers, key=lambda L: -lum(L["hex"])):
        col = l["hex"]
        for run in l["runs"]:
            i0, j, i1 = run[0], run[1], run[2]
            X = (x0 + i0 * sx) * scale
            Y = (y0 + j * sy) * scale
            W = (i1 - i0 + 1) * sx * scale
            H = sy * scale
            d.rectangle([X, Y, X + W, Y + H], fill=col)
    return img


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 1
    plan_path, out_path = argv[1], argv[2]
    scale = 1.0
    bg = (255, 255, 255)
    local = False
    transparent = False
    i = 3
    while i < len(argv):
        if argv[i] == "--scale":
            scale = float(argv[i + 1]); i += 2
        elif argv[i] == "--bg":
            h = argv[i + 1].lstrip("#")
            bg = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)); i += 2
        elif argv[i] == "--local":
            local = True; i += 1
        elif argv[i] == "--transparent":
            transparent = True; i += 1
        else:
            i += 1
    with open(plan_path) as f:
        plan = json.load(f)
    img = render(plan, scale=scale, bg=bg, local=local, transparent=transparent)
    img.save(out_path)
    print(json.dumps({"ok": True, "out": out_path, "width": img.width,
                      "height": img.height, "mode": img.mode,
                      "local": local, "transparent": transparent}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

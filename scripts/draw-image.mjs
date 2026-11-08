#!/usr/bin/env node
// draw-image.mjs — OFF-SCREEN COMPOSITION PREVIEW ONLY.
//
// This script compiles a reference image into a layered stroke plan and
// rasterises that plan into a PNG so a human/agent can CHECK the posterised
// composition and palette BEFORE painting. It deliberately CANNOT place the
// image into an application.
//
// WHY THE PLACEMENT CAPABILITY WAS REMOVED (2026-11-08 user ruling):
// Computer use means operating the target app. Rendering a picture off-screen
// and uploading / pasting / dropping it into the canvas is process fraud — the
// pixels match but no computer use happened. Earlier versions of this script
// did exactly that (a CDP file-input upload for Canva, a clipboard paste for
// Freeform). Both paths were deleted. See docs/process-authenticity-oracle.md.
//
// The ONLY legitimate way to get the drawing into an app is to inject real
// strokes: `cu_paint` for native apps, `cu_cdp_paint` for web canvases. Start
// with `cu_route` and read its `prohibited` + `acceptance` fields.
//
// Usage:
//   node scripts/draw-image.mjs --image ./ref.png [--out ./out/preview.png]
//        [--x 150 --y 120 --width 850 --height 780] [--colors 9] [--grid 130]
//
// Output: a plan JSON + a transparent, locally-positioned preview PNG.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CU = process.env.CU_BIN || join(ROOT, "bin", "cu");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return def;
}

function findPython() {
  const cands = [process.env.CU_PYTHON, process.env.PYTHON,
    "/Users/johnkwok/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3", "python3"].filter(Boolean);
  for (const c of cands) {
    if (spawnSync(c, ["-c", "import PIL"], { stdio: "ignore" }).status === 0) return c;
  }
  throw new Error("no Pillow-capable python found; install Pillow or set CU_PYTHON");
}

// Hard guardrail: the old placement flags must fail loudly instead of silently
// producing a preview that someone might then treat as a deliverable.
const REMOVED_FLAGS = ["--place", "--url", "--port", "--target"];
for (const flag of REMOVED_FLAGS) {
  if (process.argv.includes(flag)) {
    console.error(`[draw-image] ${flag} was REMOVED: this script can no longer place images into an app.`);
    console.error("[draw-image] To actually draw, use cu_route → cu_paint (native) / cu_cdp_paint (web) inside the target app.");
    console.error("[draw-image] See docs/process-authenticity-oracle.md.");
    process.exit(2);
  }
}

async function main() {
  const image = arg("image");
  if (!image || !existsSync(image)) {
    console.error("usage: node scripts/draw-image.mjs --image <path> [--out <preview.png>]");
    process.exit(2);
  }
  const rect = [arg("x", "150"), arg("y", "120"), arg("width", "850"), arg("height", "780")];
  const colors = arg("colors", "9");
  const grid = arg("grid", "130");
  const out = arg("out", join(ROOT, "out", "draw-preview.png"));
  mkdirSync(dirname(out), { recursive: true });

  const planPath = out.replace(/\.[^.]+$/, "") + ".plan.json";
  const planRes = JSON.parse(execFileSync(CU, ["drawplan", "--image", image,
    "--rect", rect.join(","), "--grid", String(grid), "--colors", String(colors),
    "--out", planPath], { encoding: "utf8" }).trim().split("\n").pop());
  if (planRes.ok !== true) throw new Error("drawplan failed: " + JSON.stringify(planRes));

  const py = findPython();
  const pngRes = JSON.parse(execFileSync(py, [join(ROOT, "scripts", "plan-to-png.py"),
    planPath, out, "--scale", arg("scale", "1"), "--local", "--transparent"],
    { encoding: "utf8" }).trim().split("\n").pop());
  if (pngRes.ok !== true) throw new Error("plan-to-png failed");

  console.log("[draw-image] plan:", planPath, "layers", planRes.layers?.length, "runs", planRes.totalRuns);
  console.log("[draw-image] PREVIEW PNG (composition/colour check only):", out,
              pngRes.width + "x" + pngRes.height);
  console.log("[draw-image] WARNING: this PNG is NOT a deliverable. Uploading/pasting it into the target app is process fraud (user ruling 2026-11-08).");
  console.log("[draw-image] To draw for real: cu_route → cu_paint (native) / cu_cdp_paint (web) inside the target app.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("[draw-image] FAILED:", e.message); process.exit(1); });

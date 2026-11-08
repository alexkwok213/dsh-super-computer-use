#!/usr/bin/env node
// draw-image.mjs — reproduce a reference image into a web canvas (Canva etc.)
// end-to-end, reliably, in one command.
//
// Why this exists: driving a web app's freehand brush through self-drawn UI is
// unreliable (thick default brush blobs, hidden colour/size widgets, zoom-
// dependent coordinates, undo that key events don't reach). The deterministic
// way is: compile the image to a layered plan with `cu drawplan`, rasterise the
// plan to a pixel-exact PNG with `scripts/plan-to-png.py`, then place that PNG
// into the app over CDP (upload the file into a file input and click it onto
// the canvas, or open it in a tab). This script does all three.
//
// Usage:
//   node scripts/draw-image.mjs --image ./ref.png --url https://www.canva.com/design/XXX/edit
//        [--x 150 --y 120 --width 850 --height 780] [--colors 9] [--grid 130]
//        [--out ./out/fish.png] [--port 9333] [--no-place]
//
// It launches (or reuses) an owned debug Chrome with the user's copied logins,
// renders the PNG, uploads it into the design, and clicks the upload thumbnail
// so a real image element lands on the canvas. Screenshot afterwards to verify.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchDebugChrome, acquirePage, releasePages } from "../lib/cdp.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CU = process.env.CU_BIN || join(ROOT, "bin", "cu");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return def;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

function findPython() {
  const cands = [process.env.CU_PYTHON, process.env.PYTHON,
    "/Users/johnkwok/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3", "python3"].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ["-c", "import PIL"], { stdio: "ignore" });
    if (r.status === 0) return c;
  }
  throw new Error("no Pillow-capable python found; install Pillow or set CU_PYTHON");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const image = arg("image");
  const url = arg("url");
  const port = Number(arg("port", "9333"));
  if (!image || !existsSync(image)) { console.error("usage: --image <path> --url <web-canvas-url>"); process.exit(2); }
  const rect = [arg("x", "150"), arg("y", "120"), arg("width", "850"), arg("height", "780")];
  const colors = arg("colors", "9");
  const grid = arg("grid", "130");
  const out = arg("out", join(ROOT, "out", "draw-image.png"));
  mkdirSync(dirname(out), { recursive: true });

  // 1. compile plan
  const planPath = out.replace(/\.[^.]+$/, "") + ".plan.json";
  const planRes = JSON.parse(execFileSync(CU, ["drawplan", "--image", image, "--rect", rect.join(","), "--grid", String(grid), "--colors", String(colors), "--out", planPath], { encoding: "utf8" }).trim().split("\n").pop());
  if (planRes.ok !== true) throw new Error("drawplan failed: " + JSON.stringify(planRes));
  console.log("[draw-image] plan:", planPath, "layers", planRes.layers?.length, "runs", planRes.totalRuns);

  // 2. rasterise to a pixel-exact PNG
  const py = findPython();
  const pngRes = JSON.parse(execFileSync(py, [join(ROOT, "scripts", "plan-to-png.py"), planPath, out, "--scale", arg("scale", "1")], { encoding: "utf8" }).trim().split("\n").pop());
  if (pngRes.ok !== true) throw new Error("plan-to-png failed");
  console.log("[draw-image] png:", out, pngRes.width + "x" + pngRes.height);

  if (hasFlag("no-place")) { console.log("[draw-image] --no-place: skipping placement"); return; }
  if (!url) { console.log("[draw-image] no --url: PNG only"); return; }

  // 3. place into the web canvas over CDP
  const info = await launchDebugChrome({ port, startUrl: url, timeoutMs: 25000 });
  const designMatch = (() => {
    const m = /\/(?:design|d)\/([A-Za-z0-9_-]+)/.exec(url);
    return m ? m[1] : new URL(url).hostname.split(".").slice(-2).join(".");
  })();
  let conn;
  try {
    conn = await acquirePage({ wsUrl: info.browserUrl, urlMatch: designMatch });
  } catch {
    // No tab has the design open yet: open one, then attach.
    const boot = await acquirePage({ wsUrl: info.browserUrl, urlMatch: "." });
    const created = await boot.client.send("Target.createTarget", { url });
    releasePages({});
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try { conn = await acquirePage({ wsUrl: info.browserUrl, urlMatch: designMatch }); break; } catch { /* wait */ }
    }
    if (!conn) throw new Error("could not open the target design tab");
  }
  const c = conn.client;
  await c.send("Page.bringToFront", {}).catch(() => {});
  await sleep(4000);
  const click = async (x, y) => {
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  };
  // open the app's upload panel if it has one; find a file input
  await c.send("DOM.enable", {}); await c.send("Runtime.enable", {});
  let inputNode = 0;
  const findInput = async () => {
    const q = await c.send("Runtime.evaluate", { expression: `(()=>{const e=document.querySelector('input[type=file]');if(e){e.setAttribute('data-draw-up','1');return 'yes'}return 'no'})()`, returnByValue: true });
    if (q.result.value !== "yes") return 0;
    const doc = await c.send("DOM.getDocument", { depth: 1 });
    const qs = await c.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "input[data-draw-up='1']" });
    return qs.nodeId || 0;
  };
  const openUploadTab = async () => {
    const upTab = await c.send("Runtime.evaluate", { expression: `(()=>{const e=[...document.querySelectorAll('[aria-label],[role=tab]')].find(x=>/^(上传|Upload)$/i.test((x.getAttribute('aria-label')||x.innerText||'').trim())&&x.getBoundingClientRect().width>10);if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`, returnByValue: true });
    if (upTab.result.value) { const p = JSON.parse(upTab.result.value); await click(p.x, p.y); await sleep(1200); return true; }
    return false;
  };
  for (let attempt = 0; attempt < 8 && !inputNode; attempt++) {
    inputNode = await findInput();
    if (!inputNode) { await openUploadTab(); await sleep(500); }
  }
  if (!inputNode) {
    console.log("[draw-image] no file input found; PNG rendered at", out, "— place it manually or open it in a tab");
    releasePages({}); return;
  }
  await c.send("DOM.setFileInputFiles", { nodeId: inputNode, files: [out] });
  console.log("[draw-image] uploaded", out, "into the design");
  await sleep(4500);
  // click the newest uploaded thumbnail to drop it on the canvas
  const thumb = await c.send("Runtime.evaluate", { expression: `(()=>{const imgs=[...document.querySelectorAll('img')].map(e=>e.getBoundingClientRect()).filter(r=>r.width>40&&r.width<200&&r.x<620);if(!imgs.length)return null;const r=imgs[imgs.length-1];return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`, returnByValue: true });
  if (thumb.result.value) {
    const p = JSON.parse(thumb.result.value);
    await click(p.x, p.y);
    await sleep(1500);
    console.log("[draw-image] clicked upload thumbnail to place it");
  }
  console.log("[draw-image] DONE — screenshot the window to verify. PNG:", out);
  releasePages({});
}

main().then(() => process.exit(0)).catch((e) => { console.error("[draw-image] FAILED:", e.message); process.exit(1); });

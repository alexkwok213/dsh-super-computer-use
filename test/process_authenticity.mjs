// Source-level guardrail: the shortcut must be PHYSICALLY absent, not merely
// discouraged in prose. A future edit that reintroduces a placement path, an
// "exactCopy" route, or a PNG-first instruction fails here before release.
// See docs/process-authenticity-oracle.md (zero-trust / Byzantine assumption).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROHIBITED_DELIVERY_PATHS, routeFor, TOOL_CHANNELS } from '../lib/app-playbooks.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('draw-image.mjs has no placement capability left', () => {
  const src = read('scripts/draw-image.mjs');
  for (const banned of ['placeIntoFreeform', 'DOM.setFileInputFiles', 'launchDebugChrome', 'acquirePage', 'Cmd+V', 'key("v", "cmd")']) {
    assert.equal(src.includes(banned), false, `draw-image.mjs must not contain ${banned}`);
  }
  assert.match(src, /PREVIEW ONLY|OFF-SCREEN COMPOSITION PREVIEW/);
  assert.match(src, /REMOVED_FLAGS/);
  assert.match(src, /--target/); // old placement flag is explicitly rejected
});

test('the old placement flags are rejected at runtime', () => {
  // Static check of the rejection list is enough; spawning the script needs a
  // real reference image and a Pillow-capable python, which unit tests avoid.
  const src = read('scripts/draw-image.mjs');
  for (const flag of ['--place', '--url', '--port', '--target']) {
    assert.match(src, new RegExp(`"${flag}"`), `${flag} must be in REMOVED_FLAGS`);
  }
});

test('no playbook defines a shortcut route', () => {
  const src = read('lib/app-playbooks.mjs');
  assert.equal(src.includes('id: "exactCopy"'), false);
  assert.equal(src.includes('id: "handDrawn"'), false);
  assert.match(src, /PROHIBITED_DELIVERY_PATHS/);
  assert.match(src, /authoritativeStroke: true/);
});

test('skill text forbids the shortcut and states the principle', () => {
  const skill = read('skill/SKILL.md');
  assert.match(skill, /Process authenticity/);
  assert.match(skill, /process\s+fraud/);
  assert.match(skill, /must consist of stroke objects created inside the target/);
  assert.equal(skill.includes('should be placed as a rendered PNG'), false);
  assert.equal(skill.includes('Most reliable pixel-exact recipe'), false);
  assert.equal(skill.includes('do not paint at all'), false);
});

test('rasterizer documents its preview-only status', () => {
  const py = read('scripts/plan-to-png.py');
  assert.match(py, /PREVIEW ONLY|NEVER be uploaded/);
  assert.match(py, /process-authenticity-oracle/);
});

test('prohibited list is concrete and complete', () => {
  assert.ok(PROHIBITED_DELIVERY_PATHS.length >= 5);
  assert.ok(PROHIBITED_DELIVERY_PATHS.every((x) => typeof x === 'string' && x.length > 0));
  const joined = PROHIBITED_DELIVERY_PATHS.join(' ');
  for (const term of ['PNG', 'Cmd+V', 'setFileInputFiles', 'draw-image.mjs', '粘贴', '上传']) {
    assert.ok(joined.includes(term), `${term} must be named`);
  }
});

test('every drawing route ends in an authoritative in-app stroke tool', () => {
  for (const [name, args] of [
    ['Freeform', { intent: '画出这幅图', appName: 'Freeform' }],
    ['Canva', { intent: 'draw this image', url: 'https://www.canva.com/design/X/edit' }],
  ]) {
    const r = routeFor(args);
    assert.equal(r.noRoute, false, name);
    const authoritative = (r.recommended.tools ?? []).filter((t) => TOOL_CHANNELS[t]?.authoritativeStroke);
    assert.ok(authoritative.length > 0, `${name} route must use cu_paint / cu_cdp_paint`);
    assert.ok(r.prohibited.length >= 3, name);
    assert.ok(r.acceptance.length > 0, name);
  }
});

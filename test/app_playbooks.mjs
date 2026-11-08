// App playbooks are the capability router: before operating an unfamiliar app,
// cu_discover matches it to a verified map of controls and flows. These tests
// keep that map honest (matches Canva, falls back to the generic entry, and
// never ships an unfinished flow name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYBOOKS, detectPlaybook, playbookSummary } from '../lib/app-playbooks.mjs';

test('Canva design URLs match the whiteboard playbook', () => {
  const pb = detectPlaybook('https://www.canva.com/design/DAHaUi49zEE/xxx/edit', '未命名的设计- 白板');
  assert.equal(pb.id, 'canva-whiteboard');
});

test('unknown URLs fall back to the generic canvas entry', () => {
  const pb = detectPlaybook('https://example.com/app', 'Something');
  assert.equal(pb.id, 'web-canvas-generic');
});

test('the Canva playbook documents the verified brush controls', () => {
  const pb = PLAYBOOKS.find((p) => p.id === 'canva-whiteboard');
  const names = pb.controls.map((c) => c.name);
  for (const expected of ['画笔', '颜色', '添加新颜色', '设置', '缩放选项']) {
    assert.ok(names.includes(expected), `control ${expected} documented`);
  }
  assert.ok(pb.flows.drawImage.length >= 4);
  assert.ok(pb.pitfalls.some((p) => /Cmd\+Z/.test(p)), 'undo limitation recorded');
});

test('playbookSummary strips the matcher regex', () => {
  const pb = PLAYBOOKS.find((p) => p.id === 'canva-whiteboard');
  const s = playbookSummary(pb);
  assert.equal(s.match, undefined);
  assert.equal(s.id, 'canva-whiteboard');
  assert.ok(Array.isArray(s.flows.drawImage));
});

test('native app names match the Freeform playbook', async () => {
  const { detectNativePlaybook } = await import('../lib/app-playbooks.mjs');
  const pb = detectNativePlaybook('Freeform', 'Untitled');
  assert.equal(pb.id, 'apple-freeform');
  assert.equal(detectNativePlaybook('Finder', 'Desktop'), null);
  const names = pb.controls.map((c) => c.name);
  for (const expected of ['Drawing Tools', 'Choose a drawing tool', 'Choose a color']) {
    assert.ok(names.includes(expected), `control ${expected} documented`);
  }
});

test('Freeform playbook records the process-authenticity ruling', () => {
  const pb = PLAYBOOKS.find((p) => p.id === 'apple-freeform');
  assert.equal(pb.routes.length, 1, 'exactly one legitimate route');
  const route = pb.routes.find((r) => r.id === 'freehandNative');
  assert.ok(route, 'the real-stroke route exists');
  assert.equal(route.prefer, true);
  assert.ok(route.steps.some((s) => s.includes('cu_paint')));
  assert.match(route.avoid.join(' '), /严禁|粘贴|上传/);
  assert.ok(route.preflight.some((p) => /前台|activate/.test(p)));
  assert.ok(route.acceptance.length > 0);
  assert.equal(pb.routes.some((r) => r.id === 'exactCopy'), false, 'the PNG shortcut is gone');
  assert.ok(pb.prohibited.length >= 3);
  assert.match(pb.pitfalls.join(' '), /跳回|重新 arm|前台/);
  assert.match(pb.pitfalls.join(' '), /过程造假|禁止|不得/);
});

test('playbookSummary routes are JSON-safe (no regex objects)', () => {
  const s = playbookSummary(PLAYBOOKS.find((p) => p.id === 'apple-freeform'));
  assert.equal(s.routes.length, 1);
  assert.ok(s.prohibited.length >= 3);
  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /"match":\{/);
  assert.ok(s.routes.every((r) => Array.isArray(r.when.keywords)));
});

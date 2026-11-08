// The strategy router is the "brain" half of computer use: a deterministic
// intent -> route lookup. These tests pin the user's 2026-11-08 ruling that
// off-screen rendering + upload/paste is process fraud, so no future edit can
// reintroduce a shortcut route or drop the prohibited/acceptance guardrails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYBOOKS,
  TOOL_CHANNELS,
  PROHIBITED_DELIVERY_PATHS,
  detectNativePlaybook,
  detectPlaybook,
  playbookSummary,
  routeFor,
} from '../lib/app-playbooks.mjs';

const FISH = { intent: '在 Freeform 上画出这幅图', appName: 'Freeform' };

test('the original failing request routes to real in-app strokes', () => {
  const r = routeFor(FISH);
  assert.equal(r.noRoute, false);
  assert.equal(r.app, 'apple-freeform');
  assert.equal(r.recommended.id, 'freehandNative');
  assert.ok(r.recommended.tools.includes('cu_paint'), 'the only legitimate native channel');
  assert.ok(r.recommended.steps.some((s) => s.includes('cu_paint')), 'steps actually paint');
  assert.ok(r.preflight.some((p) => /前台|activate/.test(p)));
  assert.ok(Array.isArray(r.acceptance) && r.acceptance.length > 0);
});

test('prohibited paths are always returned and explicitly name the shortcut', () => {
  const r = routeFor(FISH);
  assert.ok(Array.isArray(r.prohibited) && r.prohibited.length >= 3);
  assert.match(r.prohibited.join(' '), /上传|粘贴/);
  assert.match(r.recommended.avoid.join(' '), /严禁|不得|禁止/);
  // Even an unmatched app must never be told a shortcut is acceptable.
  const unknown = routeFor({ intent: '在 Finder 里整理文件', appName: 'Finder' });
  assert.ok(unknown.prohibited.length >= 3);
});

test('acceptance demands process evidence, not a screenshot', () => {
  const r = routeFor(FISH);
  const text = r.acceptance.join(' ');
  assert.match(text, /笔画|落笔|过程证据/);
  assert.match(text, /截图.*不|不是交付证明/);
});

test('NO route anywhere offers a delivery shortcut', () => {
  const banned = /上传并放置|粘贴到|拖入画布|Cmd\+V|--target freeform|setFileInputFiles|作为.*图片对象.*交付/;
  for (const pb of PLAYBOOKS) {
    assert.ok(pb.prohibited?.length, `${pb.id} needs prohibited paths`);
    for (const route of pb.routes ?? []) {
      const text = [...(route.steps ?? []), ...(route.tools ?? []), route.why ?? ''].join(' ');
      assert.doesNotMatch(text, banned, `${pb.id}/${route.id} must not offer a delivery shortcut`);
      assert.ok(route.acceptance?.length, `${pb.id}/${route.id} needs acceptance criteria`);
      assert.ok(route.verifiedAt && route.source, `${pb.id}/${route.id} needs provenance`);
      assert.ok(route.cost && Number.isFinite(route.cost.roundTrips));
    }
  }
});

test('hand-drawn and pixel-exact intents share the SAME legitimate route', () => {
  for (const intent of ['用画笔在 Freeform 上画出这幅图', '手绘笔触版本', '像素级精确还原', 'hand-drawn brush strokes']) {
    const r = routeFor({ ...FISH, intent });
    assert.equal(r.recommended.id, 'freehandNative', intent);
  }
  // There is no alternative route that bypasses painting.
  const r = routeFor(FISH);
  assert.equal(r.alternatives.length, 0, 'exactly one legitimate route');
});

test('web canvas URLs route to CDP strokes, not an upload', () => {
  const r = routeFor({ intent: 'draw this reference image', url: 'https://www.canva.com/design/ABC/edit' });
  assert.equal(r.app, 'canva-whiteboard');
  assert.equal(r.recommended.id, 'freehandCdp');
  assert.ok(r.recommended.tools.includes('cu_cdp_paint'));
  assert.match(r.recommended.avoid.join(' '), /严禁|不得/);
  assert.match(r.recommended.steps.join(' '), /连通区域|RegionStrokes/);
});

test('unknown apps and empty intents return noRoute instead of a guessed plan', () => {
  const unknown = routeFor({ intent: '在 Finder 里整理文件', appName: 'Finder' });
  assert.equal(unknown.noRoute, true);
  assert.equal(unknown.recommended, null);
  assert.ok(Array.isArray(unknown.fallback) && unknown.fallback.length > 0);
  const empty = routeFor({ intent: '', appName: 'Freeform' });
  assert.equal(empty.noRoute, true);
  assert.equal(empty.recommended, null);
  assert.ok(empty.acceptance.length > 0);
});

test('route output is JSON-safe and never leaks the matcher regex', () => {
  const r = routeFor(FISH);
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /"match":\{/);
  assert.equal(r.playbook.match, undefined);
  assert.deepEqual(JSON.parse(json).recommended.id, 'freehandNative');
  assert.ok(r.playbook.prohibited.length >= 3);
  assert.ok(Object.keys(r.channels).length > 0);
  assert.ok(Object.keys(r.channels).length < Object.keys(TOOL_CHANNELS).length);
});

test('native matching is generic, not hardcoded to Freeform', () => {
  assert.equal(detectNativePlaybook('Freeform', 'Untitled')?.id, 'apple-freeform');
  assert.equal(detectNativePlaybook('finder', 'Desktop'), null);
  assert.equal(detectPlaybook('https://example.com/app', 'x')?.id, 'web-canvas-generic');
});

test('the two painting tools are marked as the authoritative stroke channels', () => {
  assert.equal(TOOL_CHANNELS.cu_paint.authoritativeStroke, true);
  assert.equal(TOOL_CHANNELS.cu_cdp_paint.authoritativeStroke, true);
  assert.equal(TOOL_CHANNELS.cu_paint.needsForeground, true);
  assert.equal(TOOL_CHANNELS.cu_cdp_paint.channel, 'cdp');
  assert.match(TOOL_CHANNELS.cu_screenshot.note, /NEVER a delivery proof/);
});

test('PROHIBITED_DELIVERY_PATHS names every known shortcut', () => {
  const text = PROHIBITED_DELIVERY_PATHS.join(' ');
  for (const term of ['PNG', '粘贴', '上传', 'Cmd+V', 'setFileInputFiles', 'draw-image.mjs']) {
    assert.match(text, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${term} listed`);
  }
});

test('playbookSummary keeps flows/pitfalls back-compat and adds prohibited', () => {
  const s = playbookSummary(PLAYBOOKS.find((p) => p.id === 'apple-freeform'));
  assert.ok(Array.isArray(s.flows.drawImage));
  assert.ok(Array.isArray(s.pitfalls) && s.pitfalls.length > 0);
  assert.equal(s.routes.length, 1, 'one legitimate route only');
  assert.equal(s.match, undefined);
  assert.ok(s.prohibited.length >= 3);
});

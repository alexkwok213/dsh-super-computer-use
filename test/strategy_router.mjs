// The strategy router is the "brain" half of computer use: a deterministic
// intent -> route lookup. These tests pin the decision rules that the 16-minute
// Freeform failure exposed, so no future edit can silently make the pixel-exact
// PNG route lose to 16 colour passes of a round-tipped brush.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYBOOKS,
  TOOL_CHANNELS,
  detectNativePlaybook,
  detectPlaybook,
  playbookSummary,
  routeFor,
} from '../lib/app-playbooks.mjs';

const FISH = { intent: '在 Freeform 上画出这幅图', appName: 'Freeform' };

test('the original failing request routes to exactCopy, not the brush', () => {
  const r = routeFor(FISH);
  assert.equal(r.noRoute, false);
  assert.equal(r.app, 'apple-freeform');
  assert.equal(r.recommended.id, 'exactCopy');
  assert.equal(r.recommended.cost.roundTrips, 1);
  assert.ok(r.recommended.steps.some((s) => s.includes('--target freeform')));
  const avoid = r.recommended.avoid.join(' ');
  assert.match(avoid, /横纹|条纹/);
  assert.match(avoid, /16 色|16 次|换色/);
  assert.ok(r.preflight.some((p) => /前台|activate/.test(p)), 'preflight mentions the foreground requirement');
});

test('hand-drawn intent wins over the pixel-exact route', () => {
  for (const intent of ['用画笔在 Freeform 上画出这幅图', '手绘笔触版本', 'hand-drawn brush strokes']) {
    const r = routeFor({ ...FISH, intent });
    assert.equal(r.recommended.id, 'handDrawn', intent);
    assert.ok(r.alternatives.some((a) => a.id === 'exactCopy'));
  }
});

test('alternatives are priceable, so the model can compare routes', () => {
  const r = routeFor(FISH);
  const exact = r.recommended.cost.roundTrips;
  const hand = r.alternatives.find((a) => a.id === 'handDrawn').cost.roundTrips;
  assert.ok(hand > exact, `brush route (${hand}) must cost more than PNG route (${exact})`);
});

test('web canvas URLs route to the CDP/PNG path', () => {
  const r = routeFor({ intent: 'draw this reference image', url: 'https://www.canva.com/design/ABC/edit' });
  assert.equal(r.app, 'canva-whiteboard');
  assert.equal(r.recommended.id, 'exactCopy');
  assert.ok(r.recommended.tools.includes('scripts/draw-image.mjs'));
});

test('unknown apps and empty intents return noRoute instead of a guessed plan', () => {
  const unknown = routeFor({ intent: '在 Finder 里整理文件', appName: 'Finder' });
  assert.equal(unknown.noRoute, true);
  assert.equal(unknown.recommended, null);
  assert.ok(Array.isArray(unknown.fallback) && unknown.fallback.length > 0);
  const empty = routeFor({ intent: '', appName: 'Freeform' });
  assert.equal(empty.noRoute, true);
  assert.equal(empty.recommended, null);
});

test('every route is traceable (verifiedAt + source + cost)', () => {
  for (const pb of PLAYBOOKS) {
    for (const route of pb.routes ?? []) {
      assert.ok(route.verifiedAt, `${pb.id}/${route.id} needs verifiedAt`);
      assert.ok(route.source, `${pb.id}/${route.id} needs source`);
      assert.ok(route.cost && Number.isFinite(route.cost.roundTrips), `${pb.id}/${route.id} needs a cost`);
      assert.ok(Array.isArray(route.avoid), `${pb.id}/${route.id} needs avoid`);
      assert.ok(Array.isArray(route.steps) && route.steps.length, `${pb.id}/${route.id} needs steps`);
    }
  }
});

test('route output is JSON-safe and never leaks the matcher regex', () => {
  const r = routeFor(FISH);
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /"match":\{/);
  assert.equal(r.playbook.match, undefined);
  assert.equal(r.recommended.when.keywords.length > 0, true);
  assert.deepEqual(JSON.parse(json).recommended.id, 'exactCopy');
  // channels only contains tools actually referenced by these routes
  assert.ok(Object.keys(r.channels).length > 0);
  assert.ok(Object.keys(r.channels).length < Object.keys(TOOL_CHANNELS).length);
});

test('native matching is generic, not hardcoded to Freeform', () => {
  assert.equal(detectNativePlaybook('Freeform', 'Untitled')?.id, 'apple-freeform');
  assert.equal(detectNativePlaybook('finder', 'Desktop'), null);
  assert.equal(detectPlaybook('https://example.com/app', 'x')?.id, 'web-canvas-generic');
});

test('tool channel metadata covers the drawing tools the router names', () => {
  for (const tool of ['cu_paint', 'cu_cdp_paint', 'cu_paint_plan', 'cu_discover', 'cu_route', 'cu_screenshot']) {
    assert.ok(TOOL_CHANNELS[tool], `${tool} needs a channel entry`);
    assert.ok(TOOL_CHANNELS[tool].note);
  }
  assert.equal(TOOL_CHANNELS.cu_paint.needsForeground, true);
  assert.equal(TOOL_CHANNELS.cu_cdp_paint.channel, 'cdp');
});

test('playbookSummary keeps flows/pitfalls back-compat and adds routes', () => {
  const s = playbookSummary(PLAYBOOKS.find((p) => p.id === 'apple-freeform'));
  assert.ok(Array.isArray(s.flows.drawImage));
  assert.ok(Array.isArray(s.pitfalls) && s.pitfalls.length > 0);
  assert.equal(s.routes.length, 2);
  assert.equal(s.match, undefined);
});

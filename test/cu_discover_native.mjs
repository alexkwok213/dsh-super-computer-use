// Native & universal discovery tests: cu_discover partitions controls into 5
// universal spatial UI zones (`zones`), builds an `onboarding` exploration
// plan, supports optional OCR enrichment for custom canvas apps (like 剪映), and
// matches verified native playbooks (Freeform, 剪映专业版, Final Cut Pro)
// without touching Chrome/CDP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

const WINDOWS = {
  ok: true,
  frontmost: { app: 'Freeform', pid: 63103 },
  windows: [
    {
      app: 'Freeform', title: 'Untitled', pid: 63103, windowId: 10429, frontmost: true,
      bounds: { x: 0, y: 33, width: 1204, height: 993 },
    },
  ],
};

const AX = {
  ok: true,
  count: 2,
  nodes: [
    { role: 'AXButton', title: 'Choose a color', value: 'black', x: 629, y: 978, w: 25, h: 25 },
    { role: 'AXButton', title: 'Choose a drawing tool', value: '', x: 605, y: 982, w: 16, h: 16 },
    { role: 'AXGroup', title: '', value: '', x: 0, y: 33, w: 1204, h: 993 },
  ],
};

function harness(axOverride = AX) {
  const tools = new Map();
  const calls = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get: () => undefined,
  };
  const manager = new CuSessionManager();
  manager._cursorWrite = () => true;
  manager.writeActivity = () => {};
  manager.captureShotViaDaemon = async () => ({ ok: false, error: 'no_daemon' });
  manager.stopCaptureDaemon = () => {};
  manager.exec = async (argv) => {
    calls.push(argv.slice());
    if (argv[0] === 'windows') return WINDOWS;
    if (argv[0] === 'snapshot' || argv[0] === 'ax') return axOverride;
    if (argv[0] === 'ocr') {
      return {
        ok: true,
        items: [
          { text: '媒体', x: 60, y: 60, w: 40, h: 20 },
          { text: '导出', x: 1120, y: 55, w: 50, h: 24 },
          { text: '画面', x: 1050, y: 260, w: 45, h: 20 },
          { text: '00:00:05:12', x: 520, y: 890, w: 90, h: 18 },
        ],
      };
    }
    return { ok: true };
  };
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });
  const run = { signal: new AbortController().signal, agent: { options: { provider: 'p', model: 'm' } } };
  return { calls, call: (name, args) => tools.get(name).execute(args, run) };
}

test('native discovery by appName returns the Freeform playbook without Chrome', async () => {
  const h = harness();
  const r = await h.call('cu_discover', { appName: 'Freeform' });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'native');
  assert.equal(r.playbook.id, 'apple-freeform');
  assert.ok(r.playbook.pitfalls.length > 0);
  assert.ok(Array.isArray(r.next) && r.next.length > 0, 'flow names are returned');
  assert.ok(r.playbook.routes.some((x) => x.id === 'freehandNative'),
    'the only legitimate route is the real-stroke one');
  assert.equal(r.playbook.routes.some((x) => x.id === 'exactCopy'), false,
    'the off-screen PNG shortcut must not be discoverable');
  assert.ok(r.playbook.prohibited.length >= 3, 'prohibited paths reach the model via discover');
  assert.equal(h.calls.some((c) => /cdp|launch|chrome/i.test(c.join(' '))), false,
    'native branch must not touch CDP or launch a browser');
});

test('native discovery by pid/windowId enumerates AX controls and builds 5 spatial UI zones', async () => {
  const h = harness();
  const r = await h.call('cu_discover', { pid: 63103, windowId: 10429 });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'native');
  assert.equal(r.target.appName, 'Freeform');
  assert.equal(r.playbook.id, 'apple-freeform');
  assert.equal(r.counts.controls, 2, 'only named controls are listed');
  assert.deepEqual(r.controls.buttons.map((c) => c.title), ['Choose a color', 'Choose a drawing tool']);
  assert.ok(r.zones && Array.isArray(r.zones.bottomBarOrTimeline), '5 spatial UI zones are returned');
  assert.equal(r.zones.bottomBarOrTimeline.length, 2, 'Freeform bottom drawing tools land in bottomBarOrTimeline');
  assert.ok(r.onboarding && Array.isArray(r.onboarding.steps), 'onboarding plan is returned');
  assert.ok(h.calls.some((c) => c[0] === 'windows'));
  assert.ok(h.calls.some((c) => c[0] === 'snapshot'), 'discover reads the full AX snapshot');
  assert.equal(h.calls.some((c) => c[0] === 'ax'), false, 'the shallow ax walk is no longer used');
});

test('native discovery with includeOcr enriches self-drawn canvas apps like 剪映', async () => {
  const h = harness();
  const r = await h.call('cu_discover', { appName: '剪映专业版', windowId: 10429, includeOcr: true });
  assert.equal(r.ok, true);
  assert.equal(r.playbook.id, 'jianying-pro');
  assert.equal(r.counts.ocrItems, 4);
  assert.ok(r.zones.topToolbar.some((c) => c.label === '媒体' || c.label === '导出'));
  assert.ok(r.zones.rightInspector.some((c) => c.label === '画面'));
  assert.ok(r.zones.bottomBarOrTimeline.some((c) => c.label.includes('00:00:05')));
});

test('an unknown native app is reported as unmatched, not silently guessed', async () => {
  const h = harness();
  const r = await h.call('cu_discover', { appName: 'SomeUnknownApp' });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'native');
  assert.equal(r.playbook.id, 'web-canvas-generic');
  assert.match(r.hint, /no verified playbook/);
  assert.ok(r.onboarding && r.onboarding.knownPlaybook === null);
});

// 剪映 11.x 把 automation ID 写在 AXDescription；完整快照的 title 字段已经是
// description 兜底后的 label。回归：discover 与 find 必须走完整快照，不能再
// 退回只读 AXTitle/AXValue 的浅层 ax 遍历（否则会误判成自绘界面）。
const JIANYING_AX = {
  ok: true,
  count: 6,
  nodes: [
    { role: 'AXWindow', title: '剪映专业版', x: 20, y: 33, w: 1203, h: 994 },
    { role: 'AXStaticText', title: 'root_素材', x: 33, y: 70, w: 40, h: 42 },
    { role: 'AXStaticText', title: 'root_文本', x: 131, y: 70, w: 40, h: 42 },
    { role: 'AXStaticText', title: 'automationtextArea', value: '默认文本', x: 898, y: 170, w: 304, h: 64 },
    { role: 'AXButton', title: 'MainWindowTitleBarExportBtn', x: 1159, y: 40, w: 54, h: 22 },
    { role: 'AXStaticText', title: 'PlayerPlayBtn', x: 663, y: 546, w: 28, h: 28 },
  ],
};

test('剪映式 AXDescription 控件进入完整快照的 discover 分区', async () => {
  const h = harness(JIANYING_AX);
  const r = await h.call('cu_discover', { pid: 63103, windowId: 10429, appName: '剪映专业版' });
  assert.equal(r.ok, true);
  assert.equal(r.playbook.id, 'jianying-pro');
  assert.equal(r.counts.axNodes, 6);
  const labels = r.controls.buttons.map((c) => c.title);
  assert.ok(labels.includes('root_素材'), 'automation-ID tab is visible');
  assert.ok(labels.includes('automationtextArea'), 'inspector text field is visible');
  assert.ok(r.zones.topToolbar.length > 0, 'top toolbar zone is populated');
  assert.equal(r.onboarding.uiArchitecture, 'native_accessibility_tree',
    'a full AX tree must not be misclassified as a self-drawn canvas');
  assert.ok(h.calls.some((c) => c[0] === 'snapshot'));
  assert.equal(h.calls.some((c) => c[0] === 'ax'), false);
});

test('cu_find(ax) matches automation-ID controls from the full snapshot', async () => {
  const h = harness(JIANYING_AX);
  const r = await h.call('cu_find', { query: 'root_素材', pid: 63103, windowId: 10429, mode: 'ax' });
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'ax');
  assert.ok(r.matches.some((m) => m.title === 'root_素材'));
  assert.ok(h.calls.some((c) => c[0] === 'snapshot'));
});

test('sparse controls but a full AX tree is not flagged as self-drawn', async () => {
  const { buildOnboardingPlan } = await import('../lib/app-playbooks.mjs');
  const plan = buildOnboardingPlan({ channel: 'native', controlsCount: 4, axNodesCount: 190 });
  assert.equal(plan.uiArchitecture, 'native_accessibility_tree');
});

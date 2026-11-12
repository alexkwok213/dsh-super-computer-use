import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'client.js'), 'utf8');

function loadClient({ language = 'zh-CN', lang = 'zh-CN' } = {}) {
  let captured = null;
  const style = { dataset: {}, textContent: '', remove() {} };
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { captured = spec; } } },
    document: {
      currentScript: null,
      head: { appendChild() {} },
      createElement: () => style,
      querySelectorAll: () => [],
      documentElement: { lang },
    },
    navigator: { language },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: () => Promise.reject(new Error('offline in test')),
  };
  vm.runInNewContext(source, sandbox);
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
    useSyncExternalStore: (_subscribe, get) => get(),
  };
  const mod = captured.factory((name) => (name === 'react' ? React : {}));
  const ctx = {
    slots: { inject: (_name, factory) => factory(), register: () => () => {} },
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => {
      const dispose = fn();
      return () => dispose?.();
    },
  };
  mod.apply(ctx);
  return mod;
}

function collect(node) {
  const classes = [];
  const variants = [];
  const configured = [];
  const texts = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const props = value.props || {};
    if (props.className) classes.push(String(props.className));
    if (props['data-variant']) variants.push(props['data-variant']);
    if ('data-configured' in props) configured.push(props['data-configured']);
    for (const child of value.children || []) {
      if (typeof child === 'string' && child.trim()) texts.push(child.trim());
      else walk(child);
    }
  };
  walk(node);
  return { classes, variants, configured, texts };
}

test('settings panel renders localized copy with the built-in panel shape', () => {
  const mod = loadClient({ language: 'zh-CN', lang: 'zh-CN' });
  const tree = mod.__test.SettingsPanel({ close: () => {} });
  const { classes, variants, configured, texts } = collect(tree);
  assert.equal(tree.props['data-cua-settings'], '');
  assert.ok(texts.includes('给 Super Computer Use 授权'));
  assert.ok(texts.includes('偏好'));
  assert.ok(texts.includes('保存偏好'));
  assert.ok(texts.includes('已保存'));
  // The hint must appear once, not twice as in the earlier duplicated layout.
  assert.equal(texts.filter((t) => t.includes('在系统设置中管理')).length, 1);
  // No English copy leaked into a Chinese shell.
  assert.equal(texts.some((t) => /Authorize|Preferences|Refresh|Granted/.test(t)), false);
});

test('completed save button is an outline, never a filled black primary', () => {
  const mod = loadClient();
  const { classes, variants, configured } = collect(mod.__test.SettingsPanel({ close: () => {} }));
  assert.equal(classes.some((c) => c.includes('scu-native-btn-primary')), false);
  assert.ok(variants.includes('outline'), 'configured state must use the outline variant');
  assert.ok(configured.includes(''), 'configured state must carry data-configured');
  assert.equal(variants.includes('primary'), false);
});

test('an English shell still renders English copy', () => {
  const mod = loadClient({ language: 'en-US', lang: 'en' });
  const { texts } = collect(mod.__test.SettingsPanel({ close: () => {} }));
  assert.ok(texts.includes('Authorize Super Computer Use'));
  assert.ok(texts.includes('Preferences'));
  assert.ok(texts.includes('Saved'));
});

test('plugin-page view omits the settings-only Close toolbar', () => {
  const mod = loadClient();
  const withClose = collect(mod.__test.SettingsPanel({ close: () => {} }));
  const pageView = collect(mod.__test.SettingsPanel({ view: 'page' }));
  assert.ok(withClose.classes.includes('scu-native-toolbar'));
  assert.equal(pageView.classes.includes('scu-native-toolbar'), false);
});

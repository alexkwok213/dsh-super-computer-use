import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import {
  clientRevMatches,
  hashEngineSources,
  hashHostSources,
  parseClientRev,
  parseClientVersion,
  readJson,
  sha256File,
  writeJsonAtomic,
} from '../lib/dev-sync.mjs';
import { planSync } from '../scripts/dev-sync.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'scu-dev-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'engine', 'Sources'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-super-computer-use', version: '0.3.0' }));
  writeFileSync(join(root, 'lib', 'index.mjs'), 'export const a = 1;\n');
  writeFileSync(join(root, 'lib', 'core.mjs'), 'export const b = 2;\n');
  writeFileSync(join(root, 'engine', 'Sources', 'main.swift'), '// swift\n');
  writeFileSync(join(root, 'scripts', 'build-universal.sh'), '#!/bin/bash\n');
  writeFileSync(join(root, 'bin', 'cu'), 'native-one\n');
  writeFileSync(join(root, 'bin', 'cu-preview'), 'native-preview-one\n');
  return root;
}

test('host fingerprint covers package.json and every lib/*.mjs file', (t) => {
  const root = fixture(t);
  const first = hashHostSources(root);
  assert.deepEqual(first.files, ['package.json', 'lib/core.mjs', 'lib/index.mjs']);

  writeFileSync(join(root, 'lib', 'core.mjs'), 'export const b = 3;\n');
  const second = hashHostSources(root);
  assert.notEqual(second.hash, first.hash);

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-super-computer-use', version: '0.3.1' }));
  const third = hashHostSources(root);
  assert.notEqual(third.hash, second.hash);
});

test('engine fingerprint follows Swift sources and the build recipe', (t) => {
  const root = fixture(t);
  const first = hashEngineSources(root);
  assert.ok(first.files.includes('engine/Sources/main.swift'));
  assert.ok(first.files.includes('scripts/build-universal.sh'));

  writeFileSync(join(root, 'engine', 'Sources', 'main.swift'), '// swift changed\n');
  assert.notEqual(hashEngineSources(root).hash, first.hash);

  writeFileSync(join(root, 'scripts', 'build-universal.sh'), '#!/bin/bash\n# changed\n');
  assert.notEqual(hashEngineSources(root).hash, first.hash);
});

test('bundle revision parsing handles single and combo URLs', () => {
  assert.equal(parseClientRev('plugins/??dsh-super-computer-use/client.js&rev=abc123'), 'abc123');
  assert.equal(parseClientRev('/plugins/foo.js?rev=a%2Fb'), 'a/b');
  assert.equal(parseClientRev('plugins/foo.js'), null);
  assert.equal(parseClientRev(''), null);
});

test('client version is read from the shipped bundle and matches package.json', () => {
  const root = process.cwd();
  const source = readFileSync(join(root, 'client.js'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(parseClientVersion(source), pkg.version);
});

test('a reported revision matches the entry or a batch containing the entry', () => {
  const client = { entryRev: 'entry', batchRevs: ['batch-a', 'batch-b'] };
  assert.equal(clientRevMatches('entry', client), true);
  assert.equal(clientRevMatches('batch-b', client), true);
  assert.equal(clientRevMatches('old-batch', client), false);
  assert.equal(clientRevMatches('', client), false);
});

test('atomic JSON writes leave no temporary file behind', (t) => {
  const root = fixture(t);
  const path = join(root, 'state.json');
  writeJsonAtomic(path, { ok: true, rev: 'r1' });
  assert.deepEqual(readJson(path), { ok: true, rev: 'r1' });
  writeJsonAtomic(path, { ok: false });
  assert.deepEqual(readJson(path), { ok: false });
  assert.equal(readJson(join(root, 'missing.json')), null);
});

test('sync plan reloads only the parts that changed', (t) => {
  const root = fixture(t);
  const source = {
    host: { hash: 'host-1' },
    client: { sourceHash: 'client-1', version: '0.3.0' },
    native: { servicePath: join(root, 'bin', 'cu'), previewPath: join(root, 'bin', 'cu-preview'), serviceBuildId: 'native-1', previewBuildId: 'preview-1' },
    engine: { hash: 'engine-1', files: [] },
  };
  const runtime = {
    hostSourceHash: 'host-1',
    client: { sourceHash: 'client-1' },
    native: { serviceBuildId: 'native-1', previewBuildId: 'preview-1' },
  };
  const record = { engineHash: 'engine-1', serviceBuildId: 'native-1', previewBuildId: 'preview-1' };
  const options = { forceBuild: false };

  const unchanged = planSync(runtime, source, record, options);
  assert.equal(unchanged.hostChanged, false);
  assert.equal(unchanged.clientChanged, false);
  assert.equal(unchanged.nativeChanged, false);
  assert.equal(unchanged.needsBuild, false);
  assert.equal(unchanged.anyChange, false);

  const clientOnly = planSync(runtime, { ...source, client: { ...source.client, sourceHash: 'client-2' } }, record, options);
  assert.equal(clientOnly.clientChanged, true);
  assert.equal(clientOnly.hostChanged, false);
  assert.equal(clientOnly.anyChange, true);

  const engineChanged = planSync(runtime, { ...source, engine: { ...source.engine, hash: 'engine-2' } }, record, options);
  assert.equal(engineChanged.needsBuild, true);
  assert.equal(engineChanged.buildReason, 'engine_changed');
  assert.equal(engineChanged.anyChange, true);

  const forced = planSync(runtime, source, record, { forceBuild: true });
  assert.equal(forced.needsBuild, true);
  assert.equal(forced.buildReason, 'forced');
});

test('the binary hash is the native build identity', (t) => {
  const root = fixture(t);
  const first = sha256File(join(root, 'bin', 'cu'));
  assert.match(first, /^[a-f0-9]{64}$/);
  writeFileSync(join(root, 'bin', 'cu'), 'native-two\n');
  assert.notEqual(sha256File(join(root, 'bin', 'cu')), first);
});

test('client bundle survives a second classic-script execution (HMR swap)', () => {
  const source = readFileSync(join(process.cwd(), 'client.js'), 'utf8');
  let loads = 0;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          assert.equal(definition.id, 'dsh-super-computer-use');
          loads += 1;
        },
      },
    },
    console,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'client.js' });
  vm.runInContext(source, context, { filename: 'client.js' });
  assert.equal(loads, 2);
});

test('plan treats a live helper mismatch or missing helper as a native change', () => {
  const source = {
    host: { hash: 'host-1' },
    client: { sourceHash: 'client-1', version: '0.3.0' },
    native: { servicePath: '/tmp/cu', previewPath: '/tmp/cu-preview', serviceBuildId: 'native-1', previewBuildId: 'preview-1' },
    engine: { hash: 'engine-1', files: [] },
  };
  const runtime = {
    hostSourceHash: 'host-1',
    client: { sourceHash: 'client-1' },
    native: { serviceBuildId: 'native-1', previewBuildId: 'preview-1' },
  };
  const record = { engineHash: 'engine-1', serviceBuildId: 'native-1', previewBuildId: 'preview-1' };
  const options = { forceBuild: false };

  const matching = planSync(runtime, source, record, options, { runningHelper: { ok: true, buildId: 'native-1' } });
  assert.equal(matching.nativeChanged, false);

  const mismatched = planSync(runtime, source, record, options, { runningHelper: { ok: true, buildId: 'native-2' } });
  assert.equal(mismatched.nativeChanged, true);
  assert.equal(mismatched.anyChange, true);

  const missing = planSync(runtime, source, record, options, { runningHelper: null });
  assert.equal(missing.nativeChanged, true);
  assert.equal(missing.anyChange, true);
});

test('native replacement depends on the actual helper, not an earlier Host disk identity', async () => {
  const { nativeReplacementRequired } = await import('../lib/dev-sync.mjs');
  assert.equal(nativeReplacementRequired({ok:true,buildId:'current'}, 'current'), false);
  assert.equal(nativeReplacementRequired({ok:true,buildId:'old'}, 'current'), true);
  assert.equal(nativeReplacementRequired(null, 'current'), true);
});

import json
import tempfile
import unittest
from pathlib import Path

from engine.dsh.connection import ConflictError, UnsupportedError, connect, disconnect, inspect


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.profile = self.root / 'profile'
        self.plugin = self.root / 'dsh-plugin'
        self.profile.mkdir()
        self.plugin.mkdir()
        self.manifest = self.profile / 'package.json'
        self.manifest.write_text('{"dependencies": {}, "dsh": {"profile": {"bundles": []}}}')
        (self.plugin / 'package.json').write_text(json.dumps({
            'name': 'dsh-super-computer-use', 'dsh': {'bundle': {'patch': './cordis.patch.yml'}}
        }))
        (self.plugin / 'cordis.patch.yml').write_text('[]\n')

    def test_detection_does_not_claim_runtime_activation(self):
        status = inspect(self.profile, self.plugin)
        self.assertEqual(status['state'], 'unconfigured')
        self.assertFalse(status['runtime_verified'])

    def test_connect_disconnect_preserves_existing_entries_and_is_idempotent(self):
        original = b'{"dependencies":{"other":"^1"},"dsh":{"profile":{"bundles":["other"]}}}'
        self.manifest.write_bytes(original)
        connect(self.profile, self.plugin)
        data = json.loads(self.manifest.read_text())
        self.assertEqual(data['dependencies'], {'other': '^1', 'dsh-super-computer-use': 'link:' + str(self.plugin)})
        self.assertEqual(data['dsh']['profile']['bundles'], ['other', 'dsh-super-computer-use'])
        link = self.profile / 'node_modules' / 'dsh-super-computer-use'
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.readlink(), self.plugin)
        connect(self.profile, self.plugin)
        disconnect(self.profile, self.plugin)
        disconnect(self.profile, self.plugin)
        self.assertEqual(self.manifest.read_bytes(), original)
        self.assertFalse(link.exists())

    def test_external_manifest_change_refuses_disconnect(self):
        connect(self.profile, self.plugin)
        self.manifest.write_text('{"external":true}')
        with self.assertRaises(ConflictError):
            disconnect(self.profile, self.plugin)
        self.assertEqual(self.manifest.read_text(), '{"external":true}')
        self.assertTrue((self.profile / 'node_modules' / 'dsh-super-computer-use').is_symlink())

    def test_changed_symlink_refuses_disconnect(self):
        connect(self.profile, self.plugin)
        link = self.profile / 'node_modules' / 'dsh-super-computer-use'
        link.unlink()
        link.symlink_to(self.root)
        before = self.manifest.read_bytes()
        with self.assertRaises(ConflictError):
            disconnect(self.profile, self.plugin)
        self.assertEqual(link.readlink(), self.root)
        self.assertEqual(self.manifest.read_bytes(), before)

    def test_existing_dependency_is_a_conflict(self):
        self.manifest.write_text('{"dependencies":{"dsh-super-computer-use":"^1.0"}}')
        with self.assertRaises(ConflictError):
            inspect(self.profile, self.plugin)

    def test_existing_bundle_is_a_conflict(self):
        self.manifest.write_text('{"dsh":{"profile":{"bundles":["dsh-super-computer-use"]}}}')
        with self.assertRaises(ConflictError):
            inspect(self.profile, self.plugin)

    def test_invalid_or_duplicate_json_is_rejected(self):
        for text in ('{"dependencies": []}', '{"dependencies":{},"dependencies":{}}',
                     '{"dsh":{"profile":{"bundles":[1]}}}', '{bad'):
            self.manifest.write_text(text)
            with self.subTest(text=text), self.assertRaises(ConflictError):
                inspect(self.profile, self.plugin)

    def test_existing_package_link_is_conflict_even_if_target_matches(self):
        modules = self.profile / 'node_modules'
        modules.mkdir()
        (modules / 'dsh-super-computer-use').symlink_to(self.plugin)
        with self.assertRaises(ConflictError):
            inspect(self.profile, self.plugin)

    def test_plugin_metadata_must_be_valid(self):
        (self.plugin / 'package.json').write_text('{"name":"other"}')
        with self.assertRaises(ConflictError):
            inspect(self.profile, self.plugin)


if __name__ == '__main__':
    unittest.main()

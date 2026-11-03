#!/usr/bin/env python3
"""Exercise the Swift catalog with isolated installation and process fixtures."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'Sources' / 'main.swift'


class AgentCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        source = SOURCE.read_text()
        catalog = source.split('// MARK: - agent catalog (magpie-style)', 1)[1].split('func agentMCPEntry', 1)[0]
        start = catalog.index('func runningProcessNames()')
        end = catalog.index('func dshProfileState()', start)
        catalog = catalog[:start] + catalog[end:]
        catalog = catalog.replace('NSHomeDirectory()', 'fixtureRoot + "/home"')
        catalog = catalog.replace('["/Applications", NSHomeDirectory()', '[fixtureRoot + "/Applications", NSHomeDirectory()')
        catalog = catalog.replace('["/Applications", fixtureRoot + "/home"', '[fixtureRoot + "/Applications", fixtureRoot + "/home"')
        harness = '''import Foundation
let fixtureRoot = ProcessInfo.processInfo.environment["FIXTURE_ROOT"]!
func clientsReport() -> [String: Any] {
    let text = ProcessInfo.processInfo.environment["CLIENT_ROWS"] ?? "[]"
    return ["clients": (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [[String: Any]] ?? []]
}
func runningProcessNames() -> Set<String> {
    ProcessInfo.processInfo.environment["QODER_RUNNING"] == "1" ? ["Qoder"] : []
}
''' + catalog + '''
let data = try! JSONSerialization.data(withJSONObject: agentsCatalog())
print(String(data: data, encoding: .utf8)!)
'''
        swift = cls.root / 'main.swift'
        swift.write_text(harness)
        cls.binary = cls.root / 'catalog-test'
        subprocess.run(['swiftc', str(swift), '-o', str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def catalog(self, running=False, clients=None):
        env = dict(os.environ, FIXTURE_ROOT=str(self.root), QODER_RUNNING='1' if running else '0',
                   CLIENT_ROWS=json.dumps(clients or []))
        return json.loads(subprocess.check_output([str(self.binary)], env=env))

    def test_uninstalled_qoder_is_hidden_and_other_agents_remain(self):
        ids = {row['id'] for row in self.catalog()}
        self.assertNotIn('qoder', ids)
        self.assertEqual(ids, {'dsh', 'workbuddy', 'claude-code', 'claude-desktop'})

    def test_dsh_profile_configuration_and_live_calls(self):
        profile = self.root / 'home' / '.dsh' / 'profiles' / 'desktop' / 'package.json'
        profile.parent.mkdir(parents=True, exist_ok=True)
        cases = [
            ({'dependencies': {}, 'dsh': {'profile': {'bundles': []}}}, 'absent'),
            ({'dependencies': {'dsh-super-computer-use': 'link:/plugin'}, 'dsh': {'profile': {'bundles': []}}}, 'partial'),
            ({'dependencies': {}, 'dsh': {'profile': {'bundles': ['dsh-super-computer-use']}}}, 'partial'),
            ({'dependencies': {'dsh-super-computer-use': 'link:/plugin'}, 'dsh': {'profile': {'bundles': ['dsh-super-computer-use']}}}, 'configured'),
        ]
        try:
            for value, expected in cases:
                with self.subTest(expected=expected, value=value):
                    profile.write_text(json.dumps(value))
                    row = next(row for row in self.catalog() if row['id'] == 'dsh')
                    self.assertEqual(row['configState'], expected)
                    self.assertFalse(row['connected'])
                    self.assertFalse(row['configurable'])
                    self.assertNotIn('调用已验证', row['state'])
            profile.write_text('{')
            row = next(row for row in self.catalog() if row['id'] == 'dsh')
            self.assertEqual(row['configState'], 'unknown')
            row = next(row for row in self.catalog(clients=[{'client': 'dsh-computer-use', 'via': 'http', 'alive': True, 'lastOk': True, 'calls': 1, 'lastTool': 'list_windows'}]) if row['id'] == 'dsh')
            self.assertTrue(row['connected'])
            self.assertIn('调用已验证', row['state'])
            self.assertEqual(row['lastTool'], 'list_windows')
            for client in [
                {'client': 'dsh-computer-use', 'via': 'http', 'alive': False, 'lastOk': True, 'calls': 1},
                {'client': 'dsh-computer-use', 'via': 'http', 'alive': True, 'lastOk': False, 'calls': 1},
                {'client': 'not-dsh-computer-use', 'via': 'http', 'alive': True, 'lastOk': True, 'calls': 1},
            ]:
                row = next(row for row in self.catalog(clients=[client]) if row['id'] == 'dsh')
                self.assertFalse(row['connected'])
                self.assertNotIn('调用已验证', row['state'])
        finally:
            profile.unlink(missing_ok=True)

    def test_running_qoder_is_visible(self):
        self.assertIn('qoder', {row['id'] for row in self.catalog(running=True)})

    def test_installed_qoder_is_visible(self):
        app = self.root / 'Applications' / 'Qoder.app'
        app.mkdir(parents=True, exist_ok=True)
        try:
            self.assertIn('qoder', {row['id'] for row in self.catalog()})
        finally:
            app.rmdir()

    def test_user_installed_qoder_cn_is_visible(self):
        app = self.root / 'home' / 'Applications' / 'Qoder CN.app'
        app.mkdir(parents=True, exist_ok=True)
        try:
            self.assertIn('qoder', {row['id'] for row in self.catalog()})
        finally:
            app.rmdir()

    def test_configured_other_agent_remains_wired(self):
        config = self.root / 'home' / '.workbuddy' / 'mcp.json'
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text('{"mcpServers":{"computer-use":{}}}')
        try:
            row = next(row for row in self.catalog() if row['id'] == 'workbuddy')
            self.assertTrue(row['wired'])
        finally:
            config.unlink()


if __name__ == '__main__':
    unittest.main()

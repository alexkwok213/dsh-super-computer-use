#!/usr/bin/env python3
"""Run the production wiring functions against temporary agent configs only."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'Sources' / 'main.swift'


class AgentWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        source = SOURCE.read_text()
        functions = source[source.index('func agentMCPEntry('):source.index('func releaseMenuBarLock()')]
        harness = '''import Foundation
struct AgentSpec {
    let id: String
    let name: String
    let configPath: String?
    let managedNote: String?
    let serverName: String
}
func agentSpecs() -> [AgentSpec] {
    let root = ProcessInfo.processInfo.environment["FIXTURE_ROOT"]!
    return [AgentSpec(id: "workbuddy", name: "WorkBuddy", configPath: root + "/workbuddy.json", managedNote: nil, serverName: "computer-use"),
            AgentSpec(id: "claude-code", name: "Claude Code", configPath: root + "/claude.json", managedNote: nil, serverName: "cu"),
            AgentSpec(id: "claude-desktop", name: "Claude Desktop", configPath: root + "/desktop.json", managedNote: nil, serverName: "computer-use")]
}
func agentProxyScriptPath() -> String { "/fixture/server.py" }
func installedEnginePath() -> String { "/fixture/engine" }
''' + functions + '''
let args = CommandLine.arguments
let result = args[1] == "connect" ? agentsConnect(ids: [args[2]]) : agentsDisconnect(ids: [args[2]])
let data = try! JSONSerialization.data(withJSONObject: result)
print(String(data: data, encoding: .utf8)!)
'''
        swift = cls.root / 'main.swift'
        swift.write_text(harness)
        cls.binary = cls.root / 'wiring-test'
        subprocess.run(['swiftc', str(swift), '-o', str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(dir=self.root)
        self.root_path = Path(self.fixture.name)
        self.addCleanup(self.fixture.cleanup)

    def call(self, action, agent):
        env = dict(os.environ, FIXTURE_ROOT=str(self.root_path))
        return json.loads(subprocess.check_output([str(self.binary), action, agent], env=env))[0]

    def test_conflicting_entries_are_never_modified(self):
        for agent, filename, key in [('workbuddy', 'workbuddy.json', 'computer-use'),
                                     ('claude-code', 'claude.json', 'cu'),
                                     ('claude-desktop', 'desktop.json', 'computer-use')]:
            for value in [{'command': '/other/program', 'args': []}, None, 'foreign']:
                for action in ['connect', 'disconnect']:
                    with self.subTest(agent=agent, value=value, action=action):
                        path = self.root_path / filename
                        original = json.dumps({'mcpServers': {key: value, 'other': {'command': 'x'}}, 'setting': True})
                        path.write_text(original)
                        backup = Path(str(path) + '.bak-cu')
                        backup.write_text('existing backup')
                        result = self.call(action, agent)
                        self.assertEqual(result['status'], 'error')
                        self.assertEqual(path.read_text(), original)
                        self.assertEqual(backup.read_text(), 'existing backup')

    def test_owned_entry_is_idempotent_and_removable(self):
        path = self.root_path / 'claude.json'
        path.write_text(json.dumps({'setting': 42, 'mcpServers': {'other': {'command': 'x'}}}))
        self.assertEqual(self.call('connect', 'claude-code')['status'], 'wired')
        self.assertEqual(self.call('connect', 'claude-code')['status'], 'already')
        self.assertEqual(self.call('disconnect', 'claude-code')['status'], 'removed')
        self.assertEqual(json.loads(path.read_text()), {'setting': 42, 'mcpServers': {'other': {'command': 'x'}}})
        self.assertEqual(self.call('disconnect', 'claude-code')['status'], 'absent')

    def test_extra_field_is_a_conflict(self):
        path = self.root_path / 'workbuddy.json'
        self.assertEqual(self.call('connect', 'workbuddy')['status'], 'wired')
        value = json.loads(path.read_text())
        value['mcpServers']['computer-use']['extra'] = True
        original = json.dumps(value)
        path.write_text(original)
        for action in ['connect', 'disconnect']:
            self.assertEqual(self.call(action, 'workbuddy')['status'], 'error')
            self.assertEqual(path.read_text(), original)


if __name__ == '__main__':
    unittest.main()

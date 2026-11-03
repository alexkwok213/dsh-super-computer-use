"""MCP action indicators without spawning processes or accessing macOS UI."""
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'mcp'))
import server


class ActionIndicatorTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.indicators = []
        self.windows = {'ok': True, 'windows': [
            {'pid': 12, 'windowId': 120, 'app': 'Front', 'bounds': {'x': 0, 'y': 0, 'width': 100, 'height': 100}},
            {'pid': 34, 'windowId': 340, 'app': 'Back', 'bounds': {'x': 50, 'y': 0, 'width': 100, 'height': 100}},
        ]}
        self.patches = [
            patch.object(server, 'CAPSULE', True),
            patch.object(server, 'set_activity'),
            patch.object(server, 'windows_listing', return_value=self.windows),
            patch.object(server, 'auto_halo', side_effect=self.indicators.append),
            patch.object(server, 'ref_context', return_value=(12, 'AXTextField', '', 120)),
            patch.object(server, 'run_cu', side_effect=self.run_cu),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        self.result = {'ok': True}

    def run_cu(self, *args):
        self.calls.append(args)
        return self.result

    def test_ref_mutations_show_target_after_success(self):
        for name in ('set_value', 'select_text'):
            with self.subTest(name=name):
                self.indicators.clear()
                server.call_tool(name, {'ref': 'e1', 'text': 'a'})
                self.assertEqual(self.indicators, [12])

    def test_coordinate_actions_use_point_and_preserve_commands(self):
        for name, args, expected in [
            ('click', {'x': 70, 'y': 20, 'phantom': False}, ('click', '--x', '70', '--y', '20', '--button', 'left', '--count', '1')),
            ('scroll', {'x': 70, 'y': 20, 'dy': -3, 'pid': 34}, ('scroll', '--dy', '-3', '--x', '70', '--y', '20')),
            ('drag', {'from': {'x': 70, 'y': 20}, 'to': {'x': 80, 'y': 30}}, ('drag', '--from', '70,20', '--to', '80,30')),
        ]:
            with self.subTest(name=name):
                self.calls.clear(); self.indicators.clear()
                server.call_tool(name, args)
                self.assertEqual(self.calls, [expected])
                self.assertEqual(self.indicators, [12])

    def test_failed_or_dry_run_actions_do_not_show(self):
        for result, args in [({'ok': False}, {'x': 2, 'y': 2}), ({'ok': True}, {'x': 2, 'y': 2, 'dryRun': True})]:
            self.result = result
            server.call_tool('click', args)
        self.assertEqual(self.indicators, [])

    def test_existing_ref_click_and_action_errors_do_not_show(self):
        self.result = {'ok': False}
        server.call_tool('click', {'ref': 'e1'})
        server.call_tool('perform_action', {'ref': 'e1', 'name': 'AXPress'})
        self.assertEqual(self.indicators, [])

    def test_explicit_background_drag_uses_window_pid(self):
        server.call_tool('drag', {'from': {'x': 70, 'y': 20}, 'to': {'x': 80, 'y': 30}, 'windowId': 340})
        self.assertEqual(self.indicators, [34])
        self.assertIn('--background', self.calls[0])

    def test_preflight_failure_does_not_change_action(self):
        with patch.object(server, 'windows_listing', side_effect=RuntimeError('unavailable')):
            result = server.call_tool('scroll', {'x': 1, 'y': 1, 'dy': 4})
        self.assertFalse(result.get('isError'))
        self.assertEqual(self.calls, [('scroll', '--dy', '4', '--x', '1', '--y', '1')])
        self.assertEqual(self.indicators, [])

    def test_capsule_disabled_never_uses_halo_for_new_actions(self):
        with patch.object(server, 'CAPSULE', False):
            server.call_tool('set_value', {'ref': 'e1', 'text': 'x'})
        self.assertEqual(self.indicators, [])


if __name__ == '__main__':
    unittest.main()

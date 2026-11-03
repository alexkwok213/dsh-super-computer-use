#!/usr/bin/env python3
"""Go-to sheet detection with a prefilled path and no visible label."""
import pathlib
import sys
import unittest
from unittest.mock import Mock
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'mcp'))
from server import ImportFlow, ImportRunner


def sheet_nodes():
    return [
        {'ref': 'k2.67', 'role': 'AXSheet', 'title': '打开'},
        {'ref': 'k2.67.0', 'role': 'AXSheet'},
        {'ref': 'k2.67.0.1', 'role': 'AXButton', 'title': '关闭', 'cx': 1049, 'cy': 378},
        {'ref': 'k2.67.0.2', 'role': 'AXTextField', 'focused': True,
         'actions': ['AXShowMenu', 'AXConfirm'], 'value': '/old/file.mp4', 'cx': 800, 'cy': 378},
    ]


class GoToTests(unittest.TestCase):
    def flow(self, nodes):
        runner = Mock()
        runner.ax.return_value = {'ok': True, 'matches': []}
        runner.snapshot.return_value = {'ok': True, 'nodes': nodes}
        flow = ImportFlow(runner)
        flow.pid, flow.window_id, flow.use_app_scope = 17, 29, False
        flow.goto_anchor = None
        return flow, runner

    def test_prefilled_unlabelled_nested_sheet(self):
        flow, runner = self.flow(sheet_nodes())
        self.assertTrue(flow._goto_visible())
        self.assertEqual(flow.goto_anchor['ref'], 'k2.67.0.2')
        runner.snapshot.assert_called_once_with(17, 29)

    def test_unrelated_search_field_is_not_goto(self):
        nodes = sheet_nodes()
        nodes[1]['role'] = 'AXGroup'
        flow, _ = self.flow(nodes)
        self.assertFalse(flow._goto_visible())

    def test_ambiguous_sheets_are_rejected(self):
        nodes = sheet_nodes()
        nodes += [dict(n, ref=n['ref'].replace('k2', 'k3')) for n in sheet_nodes()]
        flow, _ = self.flow(nodes)
        self.assertFalse(flow._goto_visible())

    def test_unfocused_field_is_rejected(self):
        nodes = sheet_nodes()
        nodes[-1]['focused'] = False
        flow, _ = self.flow(nodes)
        self.assertFalse(flow._goto_visible())

    def test_label_path_does_not_need_snapshot(self):
        flow, runner = self.flow([])
        runner.ax.return_value = {'ok': True, 'matches': [{'role': 'AXStaticText', 'title': '前往：'}]}
        self.assertTrue(flow._goto_visible())
        runner.snapshot.assert_not_called()

    def test_snapshot_failure_is_not_absence(self):
        flow, runner = self.flow([])
        runner.snapshot.return_value = {'ok': False, 'error': 'window_gone'}
        with self.assertRaises(Exception):
            flow._goto_visible()

    def test_runner_snapshot_scope_and_no_settle(self):
        run = Mock(return_value={'ok': True, 'nodes': []})
        ImportRunner(run).snapshot(17, 29)
        run.assert_called_once_with('snapshot', '--pid', '17', '--settle', '0', '--window', '29')


if __name__ == '__main__':
    unittest.main()

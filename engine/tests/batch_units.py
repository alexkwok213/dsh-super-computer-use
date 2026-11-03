#!/usr/bin/env python3
"""Local batch execution: no desktop operations."""
import json
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'mcp'))
import server

CALL_BATCH = server.call_tool

def success(text='done'):
    return {'content': [{'type': 'text', 'text': text}]}

class BatchTests(unittest.TestCase):
    def setUp(self):
        server.BATCHING[0] = False
        self.t = 0.0
        self.calls = []

    def run_batch(self, arguments, action=None):
        def dispatch(tool, args):
            self.calls.append((tool, args))
            self.t += .2
            return action(tool, args) if action else success()
        with patch.object(server, 'call_tool', side_effect=dispatch), patch.object(server.time, 'monotonic', side_effect=lambda: self.t):
            return CALL_BATCH('batch', arguments)

    def test_invalid_later_tool_runs_nothing(self):
        r = self.run_batch({'steps': [{'tool': 'cursor_position'}, {'tool': 'typo'}]})
        self.assertTrue(r['isError'])
        self.assertEqual(self.calls, [])

    def test_invalid_shapes_run_nothing(self):
        for steps in ('oops', [None], [{'tool': 'click', 'arguments': []}]):
            with self.subTest(steps=steps):
                r = self.run_batch({'steps': steps})
                self.assertTrue(r['isError'])
                self.assertEqual(self.calls, [])

    def test_missing_required_argument_runs_nothing(self):
        r = self.run_batch({'steps': [{'tool': 'cursor_position'}, {'tool': 'press_key', 'arguments': {}}]})
        self.assertTrue(r['isError'])
        self.assertEqual(self.calls, [])

    def test_invalid_later_count_or_scalar_runs_nothing(self):
        for step in ({'tool': 'expect', 'arguments': {'pid': 17, 'count': -1}},
                     {'tool': 'press_key', 'arguments': {'name': 12}},
                     {'tool': 'click', 'arguments': {'x': True, 'y': 10}}):
            r = self.run_batch({'steps': [{'tool': 'cursor_position'}, step]})
            self.assertTrue(r['isError'])
            self.assertEqual(self.calls, [])

    def test_deadline_stops_before_next_dispatch_even_when_continue_requested(self):
        r = self.run_batch({'timeoutMs': 100, 'stopOnError': False,
                            'steps': [{'tool': 'cursor_position'}] * 2})
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(r['isError'])
        self.assertEqual(r['structuredContent']['error'], 'batch_timeout')
        self.assertEqual(r['structuredContent']['steps'][0]['ms'], 200)

    def test_deadline_overrun_on_final_step_is_reported(self):
        r = self.run_batch({'timeoutMs': 100, 'steps': [{'tool': 'cursor_position'}]})
        self.assertTrue(r['isError'])
        self.assertEqual(len(self.calls), 1)

    def test_invalid_budget_runs_nothing(self):
        for budget in (0, -1, True, '100', float('nan')):
            r = self.run_batch({'timeoutMs': budget, 'steps': [{'tool': 'cursor_position'}]})
            self.assertTrue(r['isError'])
        self.assertEqual(self.calls, [])

    def test_timings_and_images_are_preserved(self):
        r = self.run_batch({'steps': [{'tool': 'cursor_position'}]},
                           lambda *_: {'content': [{'type': 'image', 'data': 'abc', 'mimeType': 'image/png'}]})
        self.assertFalse(r['isError'])
        self.assertEqual(r['content'][1]['data'], 'abc')
        self.assertEqual(r['structuredContent']['elapsedMs'], 200)
        self.assertEqual(r['structuredContent']['steps'][0]['ms'], 200)

    def test_exception_stops_and_preserves_completed_steps(self):
        def action(*_):
            if len(self.calls) == 2:
                raise RuntimeError('private details')
            return success()
        r = self.run_batch({'stopOnError': False, 'steps': [{'tool': 'cursor_position'}] * 3}, action)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(r['isError'])
        self.assertEqual(len(r['structuredContent']['steps']), 2)
        self.assertNotIn('private details', json.dumps(r))
        self.assertFalse(server.BATCHING[0])

    def test_failure_stops_without_replay(self):
        r = self.run_batch({'steps': [{'tool': 'cursor_position'}] * 3},
                          lambda *_: dict(success(), isError=True))
        self.assertTrue(r['isError'])
        self.assertEqual(len(self.calls), 1)

    def test_observation_is_in_step_timing(self):
        def observe(args, result):
            self.t += .1
            return result
        with patch.object(server, 'observe_after', side_effect=observe):
            r = self.run_batch({'steps': [{'tool': 'press_key', 'arguments': {'name': 'right', 'observe': True}}]})
        self.assertEqual(r['structuredContent']['steps'][0]['ms'], 300)

if __name__ == '__main__':
    unittest.main()

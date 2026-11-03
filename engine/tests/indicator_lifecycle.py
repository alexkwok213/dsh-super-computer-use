#!/usr/bin/env python3
"""Indicator ownership tests: no macOS UI or user windows are touched."""
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'mcp'))
import server


class IndicatorTests(unittest.TestCase):
    def setUp(self):
        server.AUTO_SESSIONS.clear()
        server.INDICATOR_TIMER = None

    def tearDown(self):
        server.AUTO_SESSIONS.clear()

    def test_only_owned_live_children_are_terminated(self):
        live, exited = Mock(), Mock()
        live.poll.return_value = None
        exited.poll.return_value = 0
        server.AUTO_SESSIONS.update({1: live, 2: exited})
        server.stop_owned_indicators()
        live.terminate.assert_called_once()
        exited.terminate.assert_not_called()
        self.assertEqual(server.AUTO_SESSIONS, {})

    def test_same_app_reuses_live_indicator(self):
        live = Mock()
        live.poll.return_value = None
        server.AUTO_SESSIONS[1] = live
        with patch.object(server, 'AUTO_HALO', True), patch.object(server, 'spawn_detached') as spawn:
            server.auto_halo(1)
        spawn.assert_not_called()
        live.terminate.assert_not_called()

    def test_finished_indicator_can_be_recreated(self):
        dead, new = Mock(), Mock()
        dead.poll.return_value = 0
        server.AUTO_SESSIONS[1] = dead
        with patch.object(server, 'AUTO_HALO', True), patch.object(server, 'CAPSULE', True), patch.object(server, 'windows_listing', return_value={'windows': [{'pid': 1, 'windowId': 10, 'app': 'Test'}]}), patch.object(server, 'spawn_detached', return_value=new) as spawn:
            server.auto_halo(1)
        spawn.assert_called_once()
        self.assertIs(server.AUTO_SESSIONS[1], new)

    def test_exit_cancels_pending_cleanup(self):
        timer = Mock()
        server.INDICATOR_TIMER = timer
        server.finish_indicators()
        timer.cancel.assert_called_once()


if __name__ == '__main__':
    unittest.main()

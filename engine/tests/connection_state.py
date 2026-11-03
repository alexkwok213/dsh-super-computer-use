#!/usr/bin/env python3
"""Verify connection evidence without starting apps or touching host config."""
import io
import json
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'mcp'))
import server

class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.saved = dict(server.CLIENT)
        for key in ('initializedAt', 'toolsListedAt', 'lastSuccessfulCallAt'):
            server.CLIENT.pop(key, None)
    def tearDown(self):
        server.CLIENT.clear()
        server.CLIENT.update(self.saved)
    def test_protocol_records_handshake_and_tool_listing(self):
        messages = '\n'.join(json.dumps(m) for m in [
            {'id': 1, 'method': 'initialize', 'params': {}},
            {'id': 2, 'method': 'tools/list'}])
        with patch.object(sys, 'stdin', io.StringIO(messages)), patch.object(server, 'reply'), patch.object(server, 'announce_client'), patch.object(server.atexit, 'register'), patch.object(server, 'discover_service'):
            server.main()
        self.assertIn('initializedAt', server.CLIENT)
        self.assertIn('toolsListedAt', server.CLIENT)
        self.assertNotIn('lastSuccessfulCallAt', server.CLIENT)
    def test_mcp_success_envelope_counts_as_success(self):
        with patch.object(server, 'write_client_record'):
            server.record_call('list_windows', .01, {'content': [{'type': 'text', 'text': 'ok'}]})
        self.assertTrue(server.CLIENT['lastOk'])
        self.assertIn('lastSuccessfulCallAt', server.CLIENT)
    def test_error_does_not_verify_connection(self):
        with patch.object(server, 'write_client_record'):
            server.record_call('list_windows', .01, {'isError': True, 'content': []})
        self.assertFalse(server.CLIENT['lastOk'])
        self.assertNotIn('lastSuccessfulCallAt', server.CLIENT)

if __name__ == '__main__':
    unittest.main()

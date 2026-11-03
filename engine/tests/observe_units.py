#!/usr/bin/env python3
"""Change-driven observation: the caller learns the UI moved as soon as a
snapshot shows it, and an unchanged UI still gets the full observeMs budget
before the final snapshot. No desktop operations.

    python3 tests/observe_units.py
"""
import copy
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'mcp'))
import server

PID, WINDOW = 7, 10
SNAPSHOT_COST = 0.15  # simulated wall time each run_cu snapshot consumes


def node(ref, role, title="", value="", **extra):
    row = {"ref": ref, "role": role, "enabled": True}
    if title:
        row["title"] = title
    if value:
        row["value"] = value
    row.update(extra)
    return row


def tree(nodes):
    return {"ok": True, "pid": PID, "app": "Test", "version": 1,
            "count": len(nodes), "nodes": nodes}


BASE_NODES = [node("k0", "AXWindow", "Doc"), node("k0.1", "AXButton", "导入", x=10, y=10, w=50, h=20)]


class FakeClock:
    def __init__(self):
        self.t = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.t

    def sleep(self, seconds):
        assert seconds >= 0, seconds
        self.t += seconds
        self.sleeps.append(seconds)


class FakeRunCu:
    """Scripts snapshot results; records the clock at each dispatch."""

    def __init__(self, clock, results):
        self.clock = clock
        self.results = results
        self.calls = []
        self.call_clocks = []

    def __call__(self, *args):
        self.call_clocks.append(round(self.clock.t, 4))
        self.calls.append(args)
        self.clock.t += SNAPSHOT_COST
        index = min(len(self.calls) - 1, len(self.results) - 1)
        return copy.deepcopy(self.results[index])


def action_result():
    return {"content": [{"type": "text",
                         "text": json.dumps({"ok": True, "pid": PID, "windowId": WINDOW})}]}


class ObserveTests(unittest.TestCase):
    def setUp(self):
        server.SNAPSHOTS.clear()
        self.clock = FakeClock()

    def store_baseline(self, nodes=BASE_NODES):
        snap = tree(nodes)
        snap["windowId"] = WINDOW
        server.store_snapshot(PID, WINDOW, snap)

    def observe(self, scripted, **arguments):
        fake = FakeRunCu(self.clock, scripted)
        args = {"observe": True, "pid": PID, "windowId": WINDOW}
        args.update(arguments)
        with patch.object(server, "run_cu", fake), \
             patch.object(server.time, "monotonic", self.clock.monotonic), \
             patch.object(server.time, "sleep", self.clock.sleep):
            result = server.observe_after(args, action_result())
        payload = json.loads(result["content"][0]["text"])
        return fake, payload, result

    def test_change_returns_before_budget_is_spent(self):
        # Break this catches: the loop sleeps the whole observeMs even though
        # the first snapshot already showed the button renamed.
        self.store_baseline()
        moved = tree([node("k0", "AXWindow", "Doc"),
                      node("k0.1", "AXButton", "已导入", x=10, y=10, w=50, h=20)])
        fake, payload, _ = self.observe([moved], observeMs=350)
        self.assertEqual(len(fake.calls), 1, fake.call_clocks)
        self.assertTrue(payload.get("observationChanged"), payload)
        self.assertLess(payload.get("observationMs", 10 ** 9), 350)
        self.assertIn("changed k0.1", payload.get("observation", ""), payload.get("observation", "")[:200])

    def test_unchanged_ui_still_waits_out_the_budget_then_snaps_once_more(self):
        # Break this catches: polling replaces the guaranteed final snapshot,
        # so a change landing at observeMs-50ms is never seen.
        self.store_baseline()
        fake, payload, _ = self.observe([tree(BASE_NODES)], observeMs=350)
        self.assertEqual(fake.call_clocks, [0.08, 0.35])
        self.assertEqual(len(fake.calls), 2)
        self.assertFalse(payload.get("observationChanged"), payload)
        self.assertIn("no change", payload.get("observation", ""))
        self.assertEqual(payload.get("observationMs"),
                         round((0.35 + SNAPSHOT_COST) * 1000))

    def test_added_nodes_count_as_a_change(self):
        self.store_baseline()
        grown = tree(BASE_NODES + [node("k0.2", "AXStaticText", "16")])
        fake, payload, _ = self.observe([grown], observeMs=350)
        self.assertEqual(len(fake.calls), 1)
        self.assertTrue(payload.get("observationChanged"), payload)

    def test_empty_walk_is_not_reported_as_a_change(self):
        # Break this catches: tree_changed treats a failed/empty walk as UI
        # movement and returns an observation the caller cannot act on.
        self.store_baseline()
        fake, payload, _ = self.observe([tree([])], observeMs=350)
        self.assertEqual(fake.call_clocks, [0.08, 0.35])
        self.assertFalse(payload.get("observationChanged"), payload)

    def test_failed_snapshot_does_not_retry(self):
        self.store_baseline()
        fake, payload, result = self.observe(
            [{"ok": False, "error": "capture_failed", "message": "gone"}], observeMs=350)
        self.assertEqual(len(fake.calls), 1)
        self.assertTrue(result.get("isError"))
        self.assertEqual(payload["observationError"]["error"], "capture_failed")

    def test_without_a_baseline_the_fixed_wait_is_preserved(self):
        # Break this catches: change-driven polling is attempted with nothing
        # to compare against, turning every first observation into busy polls.
        fake, payload, _ = self.observe([tree(BASE_NODES)], observeMs=250)
        self.assertEqual(fake.call_clocks, [0.25])
        self.assertEqual(self.clock.sleeps, [0.25])
        self.assertFalse(payload.get("observationChanged"), payload)

    def test_zero_budget_snaps_immediately(self):
        # server_units.py pins sleep(0.0); this pins it with a baseline present.
        self.store_baseline()
        fake, payload, _ = self.observe([tree(BASE_NODES)], observeMs=0)
        self.assertEqual(fake.call_clocks, [0.0])
        self.assertEqual(self.clock.sleeps, [0.0])
        self.assertEqual(len(fake.calls), 1)

    def test_window_scope_survives_the_poll(self):
        self.store_baseline()
        fake, _, _ = self.observe([tree(BASE_NODES)], observeMs=350)
        for args in fake.calls:
            self.assertIn("--window", args)
            self.assertIn(str(WINDOW), args)

    def test_observation_is_stored_for_ref_resolution(self):
        # Later ref clicks must resolve against the observed tree, not the
        # pre-action baseline: break this by moving store_snapshot above the loop.
        self.store_baseline()
        moved = tree([node("k0", "AXWindow", "Doc"),
                      node("k0.1", "AXButton", "已导入", x=10, y=10, w=50, h=20)])
        self.observe([moved], observeMs=350)
        self.assertEqual(server.snapshot_for(PID, WINDOW)["nodes"][1]["title"], "已导入")


if __name__ == '__main__':
    unittest.main()

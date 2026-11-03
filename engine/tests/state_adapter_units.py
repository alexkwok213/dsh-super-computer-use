#!/usr/bin/env python3
"""Pure tests of inspection-to-executor translation, with no GUI access."""
import copy
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "mcp"))
import state_adapter
import execution

TARGET = {"pid": 10, "windowId": 20, "ref": "k0.1"}


def inspection():
    return {"ok": True, "status": "known", **TARGET, "role": "AXButton",
            "title": "Open", "enabled": {"status": "known", "value": True},
            "focused": {"status": "unknown"},
            "selection": {"status": "unknown", "complete": False}}


class AdapterTests(unittest.TestCase):
    def test_known_fields_and_unknowns(self):
        observed = state_adapter.executor_observation(inspection(), TARGET)
        self.assertEqual(observed, {"status": "ok", "target": {
            **TARGET, "role": "AXButton", "title": "Open", "enabled": True}})
        self.assertFalse(execution._matches({"target": TARGET,
                                           "equals": {"focused": False}}, observed))

    def test_identity_mismatch_or_unknown_fails_closed(self):
        for value in (None, {}, {**inspection(), "status": "unknown"},
                      {**inspection(), "pid": 11}, {**inspection(), "windowId": True},
                      {**inspection(), "ref": "k0.2"}):
            with self.subTest(value=value):
                self.assertEqual(state_adapter.executor_observation(value, TARGET),
                                 {"status": "unknown"})

    def test_selection_requires_known_complete_unique_strings(self):
        for selection in ({"complete": True, "items": ["a"]},
                          {"status": "unknown", "complete": True, "items": ["a"]},
                          {"status": "known", "complete": False, "items": ["a"]},
                          {"status": "known", "complete": True, "items": ["a", "a"]},
                          {"status": "known", "complete": True, "items": ["x" * 4097]},
                          {"status": "known", "complete": True,
                           "items": [str(i) for i in range(1001)]}):
            value = inspection()
            value["selection"] = selection
            observation = state_adapter.executor_observation(value, TARGET)
            self.assertNotIn("selection", observation)
        value = inspection()
        value["selection"] = {"status": "known", "complete": True, "items": ["b", "a"]}
        observation = state_adapter.executor_observation(value, TARGET)
        self.assertTrue(execution._matches({"target": TARGET, "selected_equals": ["a", "b"]}, observation))
        self.assertFalse(execution._matches({"target": TARGET, "selected_equals": ["a"]}, observation))
        value["selection"]["items"].append("c")
        self.assertEqual(observation["selection"]["items"], ["b", "a"])

    def test_executor_stops_when_adapter_cannot_prove_selection(self):
        condition = {"target": TARGET, "selected_equals": ["a", "b"]}
        request = {"timeout_s": 1, "steps": [{
            "action": {"tool": "click", "arguments": TARGET},
            "before": [condition], "after": [condition]}]}
        calls = []
        def dispatch(tool, arguments):
            calls.append(tool)
            if tool == "observe":
                return state_adapter.executor_observation(inspection(), arguments["target"])
            return {"status": "ok"}
        result = execution.execute_steps(request, dispatch, lambda: True, lambda: 0, lambda _: None)
        self.assertEqual(result["status"], "assertion_failed")
        self.assertFalse(result["action_may_have_run"])
        self.assertEqual(calls, ["observe"])

    def test_invalid_field_types_and_target_are_rejected(self):
        value = inspection()
        value["enabled"] = {"status": "known", "value": 1}
        self.assertNotIn("enabled", state_adapter.executor_observation(value, TARGET)["target"])
        invalid = copy.deepcopy(TARGET)
        invalid["pid"] = True
        self.assertEqual(state_adapter.executor_observation(value, invalid), {"status": "unknown"})


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Pure unit tests for execution.py. Run: python3 -B tests/execution_units.py"""
import copy
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "mcp"))
import execution

TARGET = {"pid": 123, "windowId": 456, "ref": "k0.1"}


def assertion(**expectations):
    return {"target": dict(TARGET), **expectations}


def request():
    condition = assertion(equals={"enabled": True})
    return {"timeout_s": 10, "steps": [{
        "action": {"tool": "click", "arguments": dict(TARGET)},
        "before": [copy.deepcopy(condition)], "after": [copy.deepcopy(condition)]}]}


class Harness:
    def __init__(self):
        self.time = 0.0
        self.calls = []
        self.control = True
        self.observation = {"status": "ok", "target": {**TARGET, "enabled": True}}
        self.action_result = {"status": "ok"}

    def clock(self):
        return self.time

    def dispatch(self, tool, arguments):
        self.calls.append((tool, arguments))
        return copy.deepcopy(self.observation if tool == "observe" else self.action_result)

    def execute(self, req=None):
        return execution.execute_steps(request() if req is None else req, self.dispatch,
                                       lambda: self.control, self.clock, lambda _: None)


class ExecutionTests(unittest.TestCase):
    def test_success_and_order(self):
        h = Harness()
        result = h.execute()
        self.assertEqual(result, {"status": "ok", "steps_completed": 1})
        self.assertEqual([call[0] for call in h.calls], ["observe", "click", "observe"])

    def test_before_failure_prevents_action(self):
        h = Harness()
        h.observation["target"]["enabled"] = False
        result = h.execute()
        self.assertEqual((result["status"], result["phase"]), ("assertion_failed", "before"))
        self.assertEqual([c[0] for c in h.calls], ["observe"])
        self.assertFalse(result["action_may_have_run"])

    def test_after_failure_stops_following_steps(self):
        h = Harness()
        req = request()
        req["steps"].append(copy.deepcopy(req["steps"][0]))
        original = h.dispatch
        def dispatch(tool, args):
            result = original(tool, args)
            if len(h.calls) == 3:
                result["target"]["enabled"] = False
            return result
        h.dispatch = dispatch
        result = h.execute(req)
        self.assertEqual((result["status"], result["phase"]), ("assertion_failed", "after"))
        self.assertTrue(result["action_may_have_run"])
        self.assertEqual([c[0] for c in h.calls], ["observe", "click", "observe"])

    def test_unknown_or_failed_action_never_retried(self):
        for response in (None, {}, {"status": "unknown"}, {"status": "failed"},
                         {"ok": True}, {"status": "ok", "unknown": True}):
            with self.subTest(response=response):
                h = Harness()
                h.action_result = response
                result = h.execute()
                self.assertEqual(result["status"], "action_unknown")
                self.assertTrue(result["action_may_have_run"])
                self.assertEqual([c[0] for c in h.calls], ["observe", "click"])

    def test_exception_in_action_never_retried(self):
        h = Harness()
        original = h.dispatch
        def dispatch(tool, args):
            if tool == "click":
                h.calls.append((tool, args))
                raise TimeoutError()
            return original(tool, args)
        h.dispatch = dispatch
        result = h.execute()
        self.assertEqual(result["status"], "exception")
        self.assertTrue(result["action_may_have_run"])
        self.assertEqual([c[0] for c in h.calls], ["observe", "click"])

    def test_control_loss_prevents_next_action(self):
        h = Harness()
        req = request()
        req["steps"].append(copy.deepcopy(req["steps"][0]))
        original = h.dispatch
        def dispatch(tool, args):
            result = original(tool, args)
            if tool == "click":
                h.control = False
            return result
        h.dispatch = dispatch
        result = h.execute(req)
        self.assertEqual((result["status"], result["step"], result["phase"]),
                         ("control_unavailable", 0, "after"))
        self.assertEqual(result["steps_completed"], 0)
        self.assertTrue(result["action_may_have_run"])
        self.assertEqual(sum(c[0] == "click" for c in h.calls), 1)
        for control in (False, None, 1, "true"):
            h = Harness()
            h.control = control
            self.assertEqual(h.execute()["status"], "control_unavailable")
            self.assertEqual(len(h.calls), 0)

    def test_deadline_checked_after_each_callback(self):
        for expire_call, phase in ((1, "before"), (2, "action"), (3, "after")):
            with self.subTest(phase=phase):
                h = Harness()
                original = h.dispatch
                def dispatch(tool, args):
                    result = original(tool, args)
                    if len(h.calls) == expire_call:
                        h.time = 10
                    return result
                h.dispatch = dispatch
                result = h.execute()
                self.assertEqual((result["status"], result["phase"]), ("timeout", phase))
                self.assertEqual(len(h.calls), expire_call)
                self.assertEqual(result["action_may_have_run"], expire_call >= 2)

    def test_control_exception_prevents_action(self):
        h = Harness()
        def control():
            raise RuntimeError("control check failed")
        result = execution.execute_steps(request(), h.dispatch, control, h.clock, lambda _: None)
        self.assertEqual((result["status"], result["phase"]), ("exception", "before"))
        self.assertEqual(h.calls, [])

    def test_deadline_after_control_prevents_action(self):
        h = Harness()
        def control():
            h.time = 10
            return True
        result = execution.execute_steps(request(), h.dispatch, control, h.clock, lambda _: None)
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(h.calls, [])

    def test_selection_requires_complete_exact_set(self):
        req = request()
        req["steps"][0]["before"] = [assertion(selected_equals=["a", "b"])]
        for selection in (None, {"items": ["a", "b"]},
                          {"complete": False, "items": ["a", "b"]},
                          {"complete": True, "items": ["a"]},
                          {"complete": True, "items": ["a", "b", "c"]},
                          {"complete": True, "items": ["a", "b", "b"]}):
            with self.subTest(selection=selection):
                h = Harness()
                h.observation["selection"] = selection
                self.assertEqual(h.execute(req)["status"], "assertion_failed")
                self.assertEqual(len(h.calls), 1)
        h = Harness()
        h.observation["selection"] = {"complete": True, "items": ["b", "a"]}
        self.assertEqual(h.execute(req)["status"], "ok")

    def test_missing_or_unknown_fields_cannot_match(self):
        for obs in ({"status": "unknown", "target": {**TARGET, "enabled": True}},
                    {"status": "ok", "target": TARGET},
                    {"status": "ok", "target": {**TARGET, "enabled": 1}},
                    {"status": "ok", "target": {**TARGET, "enabled": True, "ref": "other"}}):
            with self.subTest(obs=obs):
                h = Harness()
                h.observation = obs
                self.assertEqual(h.execute()["status"], "assertion_failed")
                self.assertEqual(len(h.calls), 1)

    def test_full_validation_before_any_dispatch(self):
        invalid = []
        for change in (lambda r: r.update(timeout_s=float("nan")),
                       lambda r: r.update(timeout_s=float("inf")),
                       lambda r: r.update(timeout_s=0),
                       lambda r: r.update(steps=[]),
                       lambda r: r.update(steps=r["steps"] * (execution.MAX_STEPS + 1)),
                       lambda r: r["steps"][0].update(after=[]),
                       lambda r: r["steps"][0]["action"]["arguments"].update(force=False),
                       lambda r: r["steps"][0]["action"].update(tool="launch_app"),
                       lambda r: r["steps"][0]["before"][0].update(equals={"mystery": True}),
                       lambda r: r["steps"][0]["before"][0]["target"].update(windowId=999),
                       lambda r: r["steps"][0]["action"]["arguments"].update(ref="k0.2"),
                       lambda r: r["steps"][0]["before"][0].update(selected_equals=["a", "a"])):
            r = request()
            change(r)
            invalid.append(r)
        r = request()
        r["steps"].append(copy.deepcopy(r["steps"][0]))
        r["steps"][1]["action"]["arguments"]["force"] = True
        invalid.append(r)
        for req in invalid:
            with self.subTest(req=req):
                h = Harness()
                self.assertEqual(h.execute(req)["status"], "invalid_request")
                self.assertEqual(h.calls, [])

    def test_bad_clock_never_reports_success(self):
        for values in ((float("nan"),), (0, -1), (0, float("inf"))):
            with self.subTest(values=values):
                h = Harness()
                times = iter(values)
                result = execution.execute_steps(request(), h.dispatch, lambda: True,
                                                 lambda: next(times), lambda _: None)
                self.assertIn(result["status"], ("invalid_clock", "exception"))
                self.assertFalse(any(c[0] == "click" for c in h.calls))

    def test_poll_delayed_match_and_events_do_not_expose_data(self):
        h = Harness()
        req = request()
        req["steps"][0]["action"] = {"tool": "set_value", "arguments": {
            **TARGET, "text": "secret input"}}
        req["steps"][0]["after"] = [assertion(equals={"value": "secret expected"})]
        original = h.dispatch
        events = []
        def dispatch(tool, args):
            result = original(tool, args)
            if tool == "observe" and len(h.calls) > 2:
                result["target"]["value"] = ("secret expected" if h.time >= 0.2 else "pending")
            return result
        def sleep(duration):
            h.time += duration
        result = execution.execute_steps(req, dispatch, lambda: h.control, h.clock, sleep,
                                         poll_timeout_s=1, poll_interval_s=0.1,
                                         on_event=events.append)
        self.assertEqual(result, {"status": "ok", "steps_completed": 1})
        self.assertEqual([c[0] for c in h.calls],
                         ["observe", "set_value", "observe", "observe", "observe"])
        self.assertNotIn("secret", repr(events))
        self.assertEqual([(e["phase"], e["event"]) for e in events],
                         [(p, e) for p in ("before", "control", "action", "after", "complete")
                          for e in ("start", "finish")])
        after = next(e for e in events if e["phase"] == "after" and e["event"] == "finish")
        self.assertAlmostEqual(after["duration_s"], 0.2)
        self.assertEqual(after["status"], "ok")

    def test_poll_timeout_unknown_and_global_deadline(self):
        for global_timeout, local_timeout in ((10, 0.25), (0.15, 1)):
            with self.subTest(global_timeout=global_timeout):
                h = Harness()
                req = request()
                req["timeout_s"] = global_timeout
                req["steps"][0]["action"] = {"tool": "press_key", "arguments": {
                    "pid": 123, "windowId": 456, "name": "return"}}
                original = h.dispatch
                def dispatch(tool, args):
                    result = original(tool, args)
                    if tool == "observe" and len(h.calls) > 2:
                        result["status"] = "unknown"
                    return result
                def sleep(duration):
                    h.time += duration
                result = execution.execute_steps(req, dispatch, lambda: h.control, h.clock, sleep,
                                                 poll_timeout_s=local_timeout, poll_interval_s=0.1)
                self.assertEqual((result["status"], result["phase"]), ("timeout", "after"))
                self.assertTrue(result["action_may_have_run"])
                self.assertEqual(sum(c[0] == "press_key" for c in h.calls), 1)
                self.assertAlmostEqual(h.time, min(global_timeout, local_timeout))

    def test_control_revoked_during_observations_and_sleep(self):
        for when in ("before_observe", "after_observe", "sleep"):
            with self.subTest(when=when):
                h = Harness()
                original = h.dispatch
                checks = 0
                def control():
                    nonlocal checks
                    checks += 1
                    if when == "before_observe" and checks == 5:
                        h.control = False
                    return h.control
                def dispatch(tool, args):
                    result = original(tool, args)
                    if tool == "observe" and len(h.calls) > 2:
                        result["target"]["enabled"] = False
                        if when == "after_observe":
                            h.control = False
                    return result
                def sleep(duration):
                    h.time += duration
                    if when == "sleep":
                        h.control = False
                result = execution.execute_steps(request(), dispatch, control, h.clock, sleep,
                                                 poll_timeout_s=1)
                self.assertEqual((result["status"], result["phase"]),
                                 ("control_unavailable", "after"))
                self.assertTrue(result["action_may_have_run"])
                self.assertEqual(sum(c[0] == "click" for c in h.calls), 1)

    def test_all_postconditions_must_match_in_one_pass(self):
        h = Harness()
        req = request()
        req["steps"][0]["after"] = [assertion(equals={"enabled": True}),
                                    assertion(equals={"focused": True})]
        original = h.dispatch
        def dispatch(tool, args):
            result = original(tool, args)
            if tool == "observe" and len(h.calls) > 2:
                result["target"]["enabled"] = h.time == 0
                result["target"]["focused"] = h.time > 0
            return result
        def sleep(duration):
            h.time += duration
        result = execution.execute_steps(req, dispatch, lambda: True, h.clock, sleep,
                                         poll_timeout_s=0.3, poll_interval_s=0.1)
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(sum(c[0] == "click" for c in h.calls), 1)

    def test_observation_exception_is_not_retried(self):
        h = Harness()
        original = h.dispatch
        def dispatch(tool, args):
            if tool == "observe" and len(h.calls) == 2:
                h.calls.append((tool, args))
                raise RuntimeError("sensitive message")
            return original(tool, args)
        events = []
        result = execution.execute_steps(request(), dispatch, lambda: h.control, h.clock,
                                         lambda duration: None, poll_timeout_s=1,
                                         on_event=events.append)
        self.assertEqual((result["status"], result["phase"]), ("exception", "after"))
        self.assertTrue(result["action_may_have_run"])
        self.assertEqual([c[0] for c in h.calls], ["observe", "click", "observe"])
        self.assertEqual(events[-1]["status"], "exception")
        self.assertNotIn("sensitive", repr(events))

    def test_events_per_step_and_callback_deadline(self):
        h = Harness()
        req = request()
        req["steps"].append(copy.deepcopy(req["steps"][0]))
        events = []
        result = execution.execute_steps(req, h.dispatch, lambda: True, h.clock,
                                         lambda _: None, on_event=events.append)
        self.assertEqual(result["steps_completed"], 2)
        self.assertEqual([e["step"] for e in events if e["phase"] == "complete"
                          and e["event"] == "finish"], [0, 1])
        h = Harness()
        def event(event):
            if event["phase"] == "complete" and event["event"] == "finish":
                h.time = 10
        result = execution.execute_steps(request(), h.dispatch, lambda: True, h.clock,
                                         lambda _: None, on_event=event)
        self.assertEqual((result["status"], result["phase"]), ("timeout", "complete"))
        self.assertTrue(result["action_may_have_run"])
        self.assertEqual(result["steps_completed"], 0)

    def test_control_revoked_by_completion_event_cannot_report_success(self):
        for event_name in ("start", "finish"):
            with self.subTest(event=event_name):
                h = Harness()
                def event(item):
                    if item["phase"] == "complete" and item["event"] == event_name:
                        h.control = False
                result = execution.execute_steps(request(), h.dispatch, lambda: h.control,
                                                 h.clock, lambda _: None, on_event=event)
                self.assertEqual((result["status"], result["phase"]),
                                 ("control_unavailable", "complete"))
                self.assertEqual(result["steps_completed"], 0)
                self.assertTrue(result["action_may_have_run"])
                self.assertEqual(sum(c[0] == "click" for c in h.calls), 1)

    def test_poll_validation_and_nonadvancing_clock(self):
        for config in ({"poll_timeout_s": -1}, {"poll_timeout_s": float("nan")},
                       {"poll_timeout_s": True}, {"poll_interval_s": 0},
                       {"poll_interval_s": float("inf")}, {"on_event": "bad"}):
            h = Harness()
            result = execution.execute_steps(request(), h.dispatch, lambda: True, h.clock,
                                             lambda _: None, **config)
            self.assertEqual(result["status"], "invalid_request")
            self.assertEqual(h.calls, [])
        h = Harness()
        req = request()
        req["steps"][0]["after"][0]["equals"]["enabled"] = False
        result = execution.execute_steps(req, h.dispatch, lambda: True, h.clock,
                                         lambda _: None, poll_timeout_s=1)
        self.assertEqual(result["status"], "exception")
        self.assertTrue(result["action_may_have_run"])

    def test_other_whitelisted_actions_and_no_input_mutation(self):
        for tool, extra in (("set_value", {"ref": "k0.1", "text": "new"}),
                            ("press_key", {"name": "return"})):
            with self.subTest(tool=tool):
                h = Harness()
                req = request()
                req["steps"][0]["action"] = {"tool": tool, "arguments": {
                    "pid": 123, "windowId": 456, **extra}}
                original = copy.deepcopy(req)
                self.assertEqual(h.execute(req)["status"], "ok")
                self.assertEqual(req, original)


if __name__ == "__main__":
    unittest.main()

"""Pure, fail-closed step executor; deliberately not connected to the MCP server.

Contract (all dictionaries have exactly the documented keys):

    arguments = {"timeout_s": 5, "steps": [{
        "action": {"tool": "click", "arguments":
                   {"pid": 1, "windowId": 2, "ref": "k0.1"}},
        "before": [assertion], "after": [assertion]}]}
    assertion = {"target": {"pid": 1, "windowId": 2, "ref": "k0.1"},
                 "equals": {"enabled": True}}
    # Alternatively, or additionally: "selected_equals": ["item-id", ...]

Each assertion calls dispatch("observe", {"target": target}). It must return
{"status": "ok", "target": {identity and requested known fields}, ...}.
Selection assertions additionally require "selection": {"complete": True,
"items": [unique string identities]}. An adapter must report complete only
when it has actually observed the entire selection, including an empty one.
Actions call dispatch(tool, arguments), and succeed only on {"status": "ok"}.
An executor success means the submitted assertions matched; it does not prove
that an action caused a change or that a larger task is complete. The caller
must choose meaningful, independently verifiable postconditions.
Every action is a write and requires check_control() is exactly True just before
it is dispatched. The caller must supply a trustworthy global control check;
this module implements neither a lease nor cross-client exclusion.

Optional keyword arguments poll_timeout_s and poll_interval_s configure a local
postcondition polling window per step; the default window is zero (one pass).
All assertions must match in the same pass. Only observations are repeated.
An optional on_event callback receives dictionaries containing step, phase,
event, elapsed_s, and, on phase completion, duration_s and status. No action
arguments, assertion values, observations, or exception messages are emitted.
Callback errors are ignored. All callbacks are synchronous and cannot be
interrupted; callers must bound them. The total deadline still applies.
"""
from __future__ import annotations

import copy
import math

MAX_STEPS = 20
MAX_ASSERTIONS = 10
MAX_TIMEOUT_S = 60.0
MAX_TEXT = 4096
MAX_SELECTION = 1000

_FIELDS = {"role": str, "title": str, "value": str, "enabled": bool,
           "focused": bool, "selected": bool}
_ACTIONS = {
    "click": {"pid": int, "windowId": int, "ref": str},
    "set_value": {"pid": int, "windowId": int, "ref": str, "text": str},
    "press_key": {"pid": int, "windowId": int, "name": str},
}
_KEYS = frozenset({"return", "tab", "space", "delete", "escape", "left",
                   "right", "up", "down", "home", "end", "pageup", "pagedown"}
                  | set("abcdefghijklmnopqrstuvwxyz0123456789")
                  | {f"f{i}" for i in range(1, 13)})


class _Invalid(ValueError):
    pass


def _object(value, required, optional=()):
    if type(value) is not dict or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        raise _Invalid("invalid object keys")


def _typed(value, kind):
    if type(value) is not kind:
        return False
    if kind is int:
        return 0 < value <= 2**31 - 1
    if kind is str:
        return len(value) <= MAX_TEXT
    return True


def _identity(target):
    _object(target, ("pid", "windowId", "ref"))
    if not all(_typed(target[k], t) for k, t in (("pid", int), ("windowId", int), ("ref", str))) or not target["ref"]:
        raise _Invalid("invalid target identity")


def _strings(items):
    return (type(items) is list and len(items) <= MAX_SELECTION
            and all(_typed(item, str) and item for item in items)
            and len(set(items)) == len(items))


def _assertion(assertion, action_args):
    _object(assertion, ("target",), ("equals", "selected_equals"))
    _identity(assertion["target"])
    if any(assertion["target"][key] != action_args[key] for key in ("pid", "windowId")):
        raise _Invalid("assertion and action scopes differ")
    if "equals" not in assertion and "selected_equals" not in assertion:
        raise _Invalid("assertion has no expectation")
    if "equals" in assertion:
        expected = assertion["equals"]
        if type(expected) is not dict or not expected or set(expected) - _FIELDS.keys():
            raise _Invalid("unsupported assertion field")
        if not all(_typed(value, _FIELDS[key]) for key, value in expected.items()):
            raise _Invalid("invalid assertion value")
    if "selected_equals" in assertion and not _strings(assertion["selected_equals"]):
        raise _Invalid("invalid selection")


def _validate(arguments):
    _object(arguments, ("timeout_s", "steps"))
    timeout = arguments["timeout_s"]
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= MAX_TIMEOUT_S:
        raise _Invalid("invalid timeout")
    steps = arguments["steps"]
    if type(steps) is not list or not 1 <= len(steps) <= MAX_STEPS:
        raise _Invalid("invalid step count")
    for step in steps:
        _object(step, ("action", "before", "after"))
        action = step["action"]
        _object(action, ("tool", "arguments"))
        tool = action["tool"]
        if type(tool) is not str or tool not in _ACTIONS:
            raise _Invalid("unsupported action")
        args = action["arguments"]
        schema = _ACTIONS[tool]
        _object(args, schema)
        if not all(_typed(args[key], kind) for key, kind in schema.items()):
            raise _Invalid("invalid action argument")
        if tool in ("click", "set_value") and not args["ref"]:
            raise _Invalid("empty ref")
        if tool == "press_key" and args["name"] not in _KEYS:
            raise _Invalid("unsupported key")
        for phase in ("before", "after"):
            assertions = step[phase]
            if type(assertions) is not list or not 1 <= len(assertions) <= MAX_ASSERTIONS:
                raise _Invalid("invalid assertion count")
            for assertion in assertions:
                _assertion(assertion, args)
        if tool in ("click", "set_value") and not any(
                assertion["target"]["ref"] == args["ref"] for assertion in step["before"]):
            raise _Invalid("action target requires a precondition")
    return copy.deepcopy(arguments)


def _matches(assertion, result):
    if type(result) is not dict or result.get("status") != "ok":
        return False
    target = result.get("target")
    if type(target) is not dict:
        return False
    for key, value in assertion["target"].items():
        if key not in target or type(target[key]) is not type(value) or target[key] != value:
            return False
    for key, expected in assertion.get("equals", {}).items():
        if key not in target or type(target[key]) is not type(expected) or target[key] != expected:
            return False
    if "selected_equals" in assertion:
        selection = result.get("selection")
        if (type(selection) is not dict or selection.get("complete") is not True
                or not _strings(selection.get("items"))
                or set(selection["items"]) != set(assertion["selected_equals"])):
            return False
    return True


def execute_steps(arguments, dispatch, check_control, clock, sleep, *,
                  poll_timeout_s=0, poll_interval_s=0.1, on_event=None):
    """Execute once; optional polling repeats only postcondition observations.

    Failures identify the zero-based step and phase and whether its action may
    have run. Local polling timeout returns timeout; without polling, a mismatch
    retains the original assertion_failed result. Events never contain user data.
    """
    completed = 0

    def failure(status, step=None, phase="validation", uncertain=False):
        return {"status": status, "step": step, "phase": phase,
                "steps_completed": completed, "action_may_have_run": uncertain}

    try:
        if not all(callable(fn) for fn in (dispatch, check_control, clock, sleep)):
            raise _Invalid("dependencies must be callable")
        if on_event is not None and not callable(on_event):
            raise _Invalid("event callback must be callable")
        if (type(poll_timeout_s) not in (int, float) or not math.isfinite(poll_timeout_s)
                or not 0 <= poll_timeout_s <= MAX_TIMEOUT_S
                or type(poll_interval_s) not in (int, float) or not math.isfinite(poll_interval_s)
                or not 0 < poll_interval_s <= MAX_TIMEOUT_S):
            raise _Invalid("invalid polling configuration")
        request = _validate(arguments)
    except (ValueError, TypeError, OverflowError, RecursionError):
        return failure("invalid_request")

    last_time = None

    def now():
        nonlocal last_time
        value = clock()
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError("invalid clock")
        if last_time is not None and value < last_time:
            raise ValueError("clock moved backwards")
        last_time = value
        return value

    try:
        start = now()
        deadline = start + request["timeout_s"]
        if not math.isfinite(deadline) or deadline <= start:
            return failure("invalid_clock", phase="clock")
    except Exception:
        return failure("invalid_clock", phase="clock")

    step_index = None
    phase = "before"
    phase_start = start
    action_called = False

    def emit(event, timestamp, status=None):
        if on_event is None:
            return
        data = {"step": step_index, "phase": phase, "event": event,
                "elapsed_s": timestamp - start}
        if status is not None:
            data.update(duration_s=timestamp - phase_start, status=status)
        try:
            on_event(data)
        except Exception:
            pass

    def begin(name):
        nonlocal phase, phase_start
        phase = name
        phase_start = now()
        emit("start", phase_start)

    def finish(status):
        emit("finish", now(), status)

    def stop(status):
        finish(status)
        return failure(status, step_index, phase, action_called)

    def guard():
        if now() >= deadline:
            return "timeout"
        controlled = check_control() is True
        if now() >= deadline:
            return "timeout"
        return None if controlled else "control_unavailable"

    def observe(assertion, local_deadline=None):
        problem = guard()
        if problem:
            return problem, False
        if local_deadline is not None and now() >= local_deadline:
            return "timeout", False
        error = None
        try:
            result = dispatch("observe", {"target": copy.deepcopy(assertion["target"])})
        except Exception as exc:
            error = exc
            result = None
        problem = guard()
        if problem:
            return problem, False
        if error is not None:
            raise error
        return None, _matches(assertion, result)

    try:
        for step_index, step in enumerate(request["steps"]):
            action_called = False
            begin("before")
            for assertion in step["before"]:
                problem, matched = observe(assertion)
                if problem:
                    return stop(problem)
                if not matched:
                    return stop("assertion_failed")
            finish("ok")
            begin("control")
            problem = guard()
            if problem:
                return stop(problem)
            finish("ok")
            begin("action")
            # Event callbacks may take time or revoke control.
            problem = guard()
            if problem:
                return stop(problem)
            action_called = True
            action = step["action"]
            result = dispatch(action["tool"], copy.deepcopy(action["arguments"]))
            if now() >= deadline:
                return stop("timeout")
            if type(result) is not dict or result != {"status": "ok"}:
                return stop("action_unknown")
            finish("ok")
            begin("after")
            local_deadline = min(deadline, phase_start + poll_timeout_s)
            while True:
                matched_all = True
                for assertion in step["after"]:
                    if poll_timeout_s and now() >= local_deadline:
                        return stop("timeout")
                    problem, matched = observe(assertion, local_deadline if poll_timeout_s else None)
                    if problem:
                        return stop(problem)
                    if poll_timeout_s and now() >= local_deadline:
                        return stop("timeout")
                    if not matched:
                        matched_all = False
                        break
                if matched_all:
                    break
                if not poll_timeout_s:
                    return stop("assertion_failed")
                current = now()
                if current >= local_deadline:
                    return stop("timeout")
                sleep(min(poll_interval_s, local_deadline - current))
                if now() <= current:
                    # A broken sleep/clock pair must not spin forever.
                    return stop("exception")
            finish("ok")
            begin("complete")
            problem = guard()
            if problem:
                return stop(problem)
            finish("ok")
            # The event callback can revoke control or consume the remaining
            # budget; check again before reporting this step as completed.
            problem = guard()
            if problem:
                return failure(problem, step_index, phase, action_called)
            completed += 1
        return {"status": "ok", "steps_completed": completed}
    except Exception:
        # Do not let a broken clock suppress the original fail-closed result.
        try:
            finish("exception")
        except Exception:
            pass
        return failure("exception", step_index, phase, action_called)

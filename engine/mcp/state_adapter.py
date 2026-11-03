"""Convert conservative AX inspection results to executor observations.

This adapter does not obtain or establish identity: the inspection must already
have checked an element retained by the same process. Unknown attributes are
omitted, and an unproven selection is never reported as complete.
"""
from __future__ import annotations

_FIELDS = {"value": str, "enabled": bool, "focused": bool, "selected": bool}
_MAX_SELECTION = 1000
_MAX_TEXT = 4096


def executor_observation(inspection, target):
    """Map an inspection result for a specific target, failing closed."""
    if (type(target) is not dict or set(target) != {"pid", "windowId", "ref"}
            or type(target["pid"]) is not int or target["pid"] <= 0
            or type(target["windowId"]) is not int or target["windowId"] <= 0
            or type(target["ref"]) is not str or not target["ref"]):
        return {"status": "unknown"}
    if (type(inspection) is not dict or inspection.get("ok") is not True
            or inspection.get("status") != "known"
            or any(type(inspection.get(key)) is not type(value)
                   or inspection.get(key) != value for key, value in target.items())):
        return {"status": "unknown"}
    observed = dict(target)
    for key in ("role", "title"):
        if type(inspection.get(key)) is str:
            observed[key] = inspection[key]
    for key, kind in _FIELDS.items():
        field = inspection.get(key)
        if (type(field) is dict and field.get("status") == "known"
                and type(field.get("value")) is kind):
            observed[key] = field["value"]
    result = {"status": "ok", "target": observed}
    selection = inspection.get("selection")
    if (type(selection) is dict and selection.get("status") == "known"
            and selection.get("complete") is True):
        items = selection.get("items")
        if (type(items) is list and len(items) <= _MAX_SELECTION
                and all(type(item) is str and 0 < len(item) <= _MAX_TEXT for item in items)
                and len(set(items)) == len(items)):
            result["selection"] = {"complete": True, "items": list(items)}
    return result

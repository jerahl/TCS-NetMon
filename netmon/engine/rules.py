"""Pure rule-condition evaluation.

A rule's ``condition`` is stored data, not code: ``{"op": ..., "value": ...}``.
Kept pure (no DB/IO) so it is unit-tested directly.
"""

from __future__ import annotations

import json
from typing import Any


def parse_condition(raw: str | dict) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        obj = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    return obj if isinstance(obj, dict) else {}


def evaluate(condition: str | dict, value: str | None) -> bool:
    """True if ``value`` (a device_state value) matches the condition.

    Supported ops: eq, ne, in, contains. Unknown/empty op → never matches
    (fail closed — a malformed rule must not fire spuriously).
    """
    cond = parse_condition(condition)
    op = cond.get("op")
    target = cond.get("value")
    v = "" if value is None else str(value)

    if op == "eq":
        return v == str(target)
    if op == "ne":
        return v != str(target)
    if op == "in":
        return isinstance(target, (list, tuple)) and v in {str(t) for t in target}
    if op == "contains":
        return str(target) in v
    return False

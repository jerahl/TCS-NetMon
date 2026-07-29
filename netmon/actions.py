"""Operator write actions — the ONE place NetMon calls a source non-GET.

Spec 11 D4, approved 2026-07-28. Everything in this module exists because these
four calls break the read-only-first invariant the rest of the project is built
on (CLAUDE.md §4.1), so they are deliberately funnelled through a single
chokepoint that cannot be bypassed by accident:

* the action must be a member of ``ACTIONS`` — a closed registry, not a path a
  caller supplies. There is no way to ask this module to POST an arbitrary URL;
* its per-action config flag must be on (§4.3 per-step reversibility);
* an ``action_audit`` row is written **before** the call and updated after, so a
  timeout or crash still leaves evidence somebody bounced a port;
* the outcome is recorded whether it succeeded, failed or was refused.

**Owner deviation, recorded 2026-07-29.** D4's signed design said per-action
flags default *off* with a dry-run first (§4.2). The owner chose "live on merge"
and an `operator` role floor instead, so the flags default **true**. They still
exist, so any action remains individually disableable without a deploy — which
is the property §4.3 actually cares about.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db

log = logging.getLogger("netmon.actions")


class ActionError(Exception):
    """The action could not be carried out. Message is operator-facing."""


class ActionRefused(ActionError):
    """Refused before any call went out — disabled, unknown, or unresolvable.

    Distinct from a failure: nothing was sent to the source.
    """


@dataclass(frozen=True)
class ActionSpec:
    key: str
    source: str          # xiq | packetfence | rconfig
    label: str
    # What it does to the device, in one line, for the audit trail and the UI's
    # confirmation prompt. Written plainly on purpose: an operator about to
    # bounce a port should read what happens, not a verb.
    effect: str
    disruptive: bool


# The closed set. Adding one is a deliberate edit here plus a config flag plus a
# spec update — never a caller-supplied string.
ACTIONS: dict[str, ActionSpec] = {
    "reevaluate_access": ActionSpec(
        key="reevaluate_access", source="packetfence", label="Reevaluate Access",
        effect="PacketFence re-runs authorisation for this endpoint; it may change VLAN/role.",
        disruptive=False,
    ),
    "restart_port": ActionSpec(
        key="restart_port", source="packetfence", label="Restart Port",
        effect="PacketFence bounces the switch port this endpoint is on — the device loses link briefly.",
        disruptive=True,
    ),
    "poe_cycle": ActionSpec(
        key="poe_cycle", source="rconfig", label="Cycle PoE",
        effect="rConfig runs the stored 'Cycle POE' snippet on this switch port — anything powered by it reboots.",
        disruptive=True,
    ),
    "ap_reboot": ActionSpec(
        key="ap_reboot", source="xiq", label="Reboot AP",
        effect="ExtremeCloud IQ reboots this access point; every client on it is disconnected for ~2 minutes.",
        disruptive=True,
    ),
}


def action_or_refuse(key: str) -> ActionSpec:
    spec = ACTIONS.get(key)
    if spec is None:
        raise ActionRefused(f"unknown action {key!r}")
    return spec


class AuditedAction:
    """Context manager wrapping one attempt: audit → call → outcome.

    Usage::

        with AuditedAction(engine, spec, actor="x", role="operator",
                           device_id=7, target="1:12", params={...}) as audit:
            result = await client.do_the_thing()
            audit.ok(result.message, http_status=result.status)

    Leaving the block without calling ``ok``/``failed`` records ``failed`` with
    the exception text — so nothing exits silently.
    """

    def __init__(self, engine: Engine, spec: ActionSpec, *, actor: str, role: str,
                 device_id: int | None, target: str | None,
                 params: dict[str, Any] | None = None) -> None:
        self.engine = engine
        self.spec = spec
        self.actor = actor
        self.role = role
        self.device_id = device_id
        self.target = target
        self.params = params or {}
        self.audit_id: int | None = None
        self._t0 = 0.0
        self._settled = False

    def __enter__(self) -> "AuditedAction":
        self._t0 = time.monotonic()
        db.execute(
            self.engine,
            "INSERT INTO action_audit "
            "(requested_at, actor, actor_role, action, source, device_id, target, params, outcome) "
            "VALUES (:at, :actor, :role, :action, :source, :dev, :target, :params, 'pending')",
            {
                "at": datetime.now(timezone.utc), "actor": self.actor, "role": self.role,
                "action": self.spec.key, "source": self.spec.source,
                "dev": self.device_id, "target": self.target,
                "params": json.dumps(_sanitise(self.params), sort_keys=True),
            },
        )
        row = db.fetch_one(
            self.engine,
            "SELECT id FROM action_audit WHERE actor = :actor AND action = :action "
            "ORDER BY id DESC LIMIT 1",
            {"actor": self.actor, "action": self.spec.key},
        )
        self.audit_id = int(row["id"]) if row else None
        log.info("action %s requested by %s (%s) target=%s audit=%s",
                 self.spec.key, self.actor, self.role, self.target, self.audit_id)
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if not self._settled:
            if exc is not None:
                outcome = "refused" if isinstance(exc, ActionRefused) else "failed"
                self._settle(outcome, str(exc)[:500], None)
            else:
                # Neither ok() nor failed() was called and no exception — a code
                # path that forgot to settle. Record it rather than lose it.
                self._settle("failed", "action completed without recording an outcome", None)
        return False  # never swallow

    def ok(self, message: str = "ok", http_status: int | None = None) -> None:
        self._settle("ok", message, http_status)

    def failed(self, message: str, http_status: int | None = None) -> None:
        self._settle("failed", message, http_status)

    def _settle(self, outcome: str, message: str, http_status: int | None) -> None:
        self._settled = True
        if self.audit_id is None:  # pragma: no cover — insert failed; already logged
            return
        db.execute(
            self.engine,
            "UPDATE action_audit SET completed_at = :at, outcome = :o, message = :m, "
            "http_status = :s, duration_ms = :d WHERE id = :id",
            {
                "at": datetime.now(timezone.utc), "o": outcome, "m": (message or "")[:500],
                "s": http_status, "d": int((time.monotonic() - self._t0) * 1000),
                "id": self.audit_id,
            },
        )
        log.info("action %s -> %s (%s) audit=%s", self.spec.key, outcome,
                 (message or "")[:120], self.audit_id)


_SECRET_HINTS = ("pass", "token", "secret", "community", "key", "credential", "auth")


def _sanitise(params: dict[str, Any]) -> dict[str, Any]:
    """Never let a credential reach the audit table (§4.6).

    The audit row is read by operators and pasted into tickets, so a
    secret-shaped key is dropped entirely rather than masked — a mask still
    leaks the length.
    """
    out: dict[str, Any] = {}
    for k, v in params.items():
        if any(h in k.lower() for h in _SECRET_HINTS):
            out[k] = "<omitted>"
        else:
            out[k] = v
    return out

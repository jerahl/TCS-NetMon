"""The guards. Spec 22 §5, W4.

Every action an automated workflow wants to take passes through here first, and
**no graph can turn one off**. The editor composes intent; this module keeps the
invariants. A visual workflow builder whose canvas could delete the blast-radius
check would be a footgun with a GUI.

Each guard returns None to allow, or a `Refusal` carrying its code and a
sentence an operator can read without opening the source. Refusals are recorded
on the run step, which is how the shadow report explains why nothing happened.

Order matters: the cheap, certain refusals come first, so a site-wide outage is
dismissed before NetMon goes looking for a port.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.actions import ACTIONS
from netmon.automation.portmemory import recall
from netmon.state import device_down, native_trustworthy

if TYPE_CHECKING:  # `context` imports this module for `Refusal`.
    from netmon.automation.context import Context


@dataclass(frozen=True)
class Refusal:
    code: str      # "G4"
    reason: str    # operator-facing


def _as_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def g1_source_not_blind(ctx: "Context") -> Refusal | None:
    """A blind source is evidence about the source, not the device.

    147 cameras here sit behind a Milestone that could not be reached. Treating
    that as a camera fault would remediate the wrong thing 147 times.
    """
    if ctx.state_value("source_status") == "blind":
        return Refusal("G1", "the source reports itself blind for this device — "
                             "that is a fact about the source, not the device")
    return None


def g2_state_fresh(ctx: "Context") -> Refusal | None:
    """Never act on stale data (CLAUDE.md §4.5).

    A collector that died an hour ago leaves its last verdict sitting in
    `device_state` looking exactly like a fresh one. Acting on it would
    remediate a device based on what was true before the outage.
    """
    seen = _as_dt(ctx.state_updated_at(ctx.trigger_dimension))
    if seen is None:
        return Refusal("G2", "no timestamp on the state this decision rests on")
    age = (ctx.now - seen).total_seconds()
    if age > ctx.cfg.max_state_age_s:
        return Refusal("G2", f"the {ctx.trigger_dimension} reading is "
                             f"{int(age // 60)}m old (limit "
                             f"{ctx.cfg.max_state_age_s // 60}m) — the collector "
                             "behind it may be down")
    return None


def g3_native_agrees(ctx: "Context") -> Refusal | None:
    """The native poller is the tiebreaker (CLAUDE.md §1).

    The same check `engine.py` applies before opening an alert: a federated
    source claiming `down` for a device that answers ICMP or SNMP is making a
    claim, not stating a fact. Also refuses when the address is contested —
    `native_trustworthy` false means the probe cannot say which device answered,
    which is not a basis for cutting power to one of them.
    """
    if not native_trustworthy(ctx.flags):
        return Refusal("G3", "more than one device claims this management IP, so no "
                             "probe can say which one answered")
    if not device_down(ctx.flags):
        return Refusal("G3", "the native poller still reaches this device, so the "
                             "source's down report is not corroborated")
    return None


def g4_blast_radius(ctx: "Context") -> Refusal | None:
    """Failures cluster, and a cluster is not a device fault.

    On 2026-09-11 the 82 down cameras sat 11 at MLK, 10 at University Place,
    7 at Southview. Eleven cameras in one building did not independently fail;
    that is a closet, an uplink or an NVR. Remediating each one issues eleven
    PoE cycles chasing one upstream fault — and repeats every cycle.
    """
    n = ctx.peers_down_at_site()
    if n > ctx.cfg.site_cluster_max:
        return Refusal("G4", f"{n} {ctx.device_type}s are down at {ctx.site} "
                             f"(limit {ctx.cfg.site_cluster_max}) — this looks like an "
                             "upstream fault, not this device")
    mem = ctx.port_memory()
    if mem and mem.get("switch_device_id"):
        m = ctx.peers_down_behind_switch(int(mem["switch_device_id"]))
        if m > ctx.cfg.switch_cluster_max:
            return Refusal("G4", f"{m} devices behind {mem.get('switch_name') or 'that switch'} "
                                 f"are down (limit {ctx.cfg.switch_cluster_max}) — "
                                 "the switch or its uplink is the likelier fault")
    return None


def g5_port_confidence(ctx: "Context") -> Refusal | None:
    """Only applies to actions that act on a port. Spec 22 §2b.

    `uplink.py` already refuses to let an operator PoE-cycle an unconfirmed
    port, because the fewest-MACs pick can land on a 10G uplink carrying 168
    MACs. An unattended engine gets the stricter version of the same rule: the
    port must have been *confirmed safe while the device was healthy*, and
    recently enough that the cabling plausibly has not changed.
    """
    if ctx.action_key not in ("poe_cycle",):
        return None
    mem = ctx.port_memory()
    if not mem:
        return Refusal("G5", "no access port was ever recorded for this device while it "
                             "was healthy, and a dead device has already aged out of the "
                             "switch forwarding tables")
    if not mem.get("poe_cycle_safe"):
        return Refusal("G5", f"the remembered port was never confirmed safe to cycle: "
                             f"{mem.get('why') or 'unconfirmed'}")
    seen = _as_dt(mem.get("confirmed_at"))
    if seen is None:
        return Refusal("G5", "the remembered port carries no confirmation time")
    age = (ctx.now - seen).total_seconds()
    if age > ctx.cfg.require_port_confirmed_within_s:
        return Refusal("G5", f"the remembered port was last confirmed "
                             f"{int(age // 3600)}h ago (limit "
                             f"{ctx.cfg.require_port_confirmed_within_s // 3600}h) — "
                             "too old to power-cycle on")
    return None


def g6_upstream_alive(ctx: "Context") -> Refusal | None:
    """Don't remediate a camera when its switch is the thing that is down."""
    mem = ctx.port_memory()
    if not mem or not mem.get("switch_device_id"):
        return None
    if ctx.device_is_down(int(mem["switch_device_id"])):
        return Refusal("G6", f"{mem.get('switch_name') or 'the switch'} holding that port "
                             "is itself down — the device is not the fault")
    return None


def g7_cooldown(ctx: "Context") -> Refusal | None:
    """One attempt per device per cooldown, or a flapping camera gets bounced
    every evaluation cycle for as long as it stays broken."""
    # `id <> :self` matters: the runner opens the run row *before* evaluating
    # the guards, so without it every live run refuses itself for having acted
    # "-1m ago".
    row = db.fetch_one(
        ctx.engine,
        "SELECT MAX(started_at) AS t FROM workflow_runs "
        "WHERE workflow_id = :w AND device_id = :d AND shadow = 0 "
        "AND status <> 'refused' AND id <> :self",
        {"w": ctx.workflow_id, "d": ctx.device_id, "self": ctx.run_id or -1},
    )
    last = _as_dt(row["t"]) if row else None
    if last is None:
        return None
    age = (ctx.now - last).total_seconds()
    if age < ctx.cfg.per_device_cooldown_s:
        return Refusal("G7", f"this workflow already acted on this device "
                             f"{int(age // 60)}m ago (cooldown "
                             f"{ctx.cfg.per_device_cooldown_s // 60}m)")
    return None


def g8_rate_limit(ctx: "Context") -> Refusal | None:
    """A fleet-wide ceiling. Whatever goes wrong, it goes wrong at most N times
    an hour before a human is the one deciding."""
    since = ctx.now - timedelta(hours=1)
    row = db.fetch_one(
        ctx.engine,
        "SELECT COUNT(*) AS n FROM workflow_runs "
        "WHERE workflow_id = :w AND shadow = 0 AND started_at >= :since "
        "AND status IN ('done', 'awaiting_approval') AND id <> :self",
        {"w": ctx.workflow_id, "since": since, "self": ctx.run_id or -1},
    )
    n = int((row or {}).get("n") or 0)
    if n >= ctx.cfg.fleet_rate_limit:
        return Refusal("G8", f"this workflow has already acted {n} times in the last hour "
                             f"(limit {ctx.cfg.fleet_rate_limit})")
    return None


def g9_maintenance(ctx: "Context") -> Refusal | None:
    """Respect the same maintenance windows the alert engine respects."""
    rows = db.fetch_all(
        ctx.engine,
        "SELECT scope_type, scope_value FROM maintenance_windows "
        "WHERE starts_at <= :now AND ends_at >= :now",
        {"now": ctx.now},
    )
    for w in rows:
        st, sv = w["scope_type"], w["scope_value"]
        if ((st == "device" and sv == str(ctx.device_id))
                or (st == "site" and sv == (ctx.site or ""))
                or (st == "device_type" and sv == ctx.device_type)):
            return Refusal("G9", f"a maintenance window covers this {st}")
    return None


def g10_action_enabled(ctx: "Context") -> Refusal | None:
    """Delegated to the config, not reimplemented.

    `netmon.actions` and `api/actions.py` already own what "this action is
    switched on" means; duplicating that logic here would let the two drift and
    leave an action that looks disabled in Settings but fires from a workflow.
    """
    if ctx.action_key not in ACTIONS:
        return Refusal("G10", f"{ctx.action_key!r} is not a registered action")
    if not ctx.action_is_enabled(ctx.action_key):
        return Refusal("G10", f"the {ctx.action_key} action is switched off in config")
    return None


#: Applied in order to every action step. Cheap and certain first: a site-wide
#: outage is dismissed before NetMon goes looking for a port.
GUARDS = (
    g1_source_not_blind,
    g2_state_fresh,
    g3_native_agrees,
    g4_blast_radius,
    g5_port_confidence,
    g6_upstream_alive,
    g7_cooldown,
    g8_rate_limit,
    g9_maintenance,
    g10_action_enabled,
)


def check_all(ctx: "Context") -> Refusal | None:
    """First refusal wins; None means every guard allowed the action."""
    for guard in GUARDS:
        refusal = guard(ctx)
        if refusal is not None:
            return refusal
    return None

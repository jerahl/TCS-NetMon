"""Everything a run needs to know about one device, read once.

The guards and predicates ask a lot of small questions about the same device —
is it down, is its source blind, how many peers are down at its site, what port
do we remember. Answering each one with its own query would run a dozen
statements per evaluated device, and worse, would let two guards disagree
because the fleet moved between their reads.

So the facts are gathered once, at the top of the run, and every guard reads the
same snapshot. `now` is fixed for the same reason: a run that takes four seconds
should not see two different "now"s when it compares ages.

Nothing in here calls a source. Every answer comes from NetMon's own tables —
CLAUDE.md §6, the same rule the dashboards follow.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.automation.portmemory import recall
from netmon.state import REACHABILITY_FLAGS_SQL, device_down

_FLAGS_ONE_SQL = f"""
SELECT d.id AS device_id, d.name AS name, d.site AS site,
       d.device_type AS device_type, d.mgmt_ip AS mgmt_ip,
{REACHABILITY_FLAGS_SQL}
FROM devices d
LEFT JOIN device_state s ON s.device_id = d.id
WHERE d.id = :id
GROUP BY d.id
"""


@dataclass
class Context:
    engine: Engine
    cfg: Any                      # AutomationConfig
    workflow_id: int
    workflow_name: str
    device_id: int
    now: datetime
    trigger_dimension: str
    #: The value the trigger matched. `still_down` re-reads the dimension and
    #: compares against this, rather than asking a different question.
    trigger_value: str = "down"
    #: The action the guards are currently being asked about. Set by the runner
    #: before each action step, because G5 and G10 are action-specific.
    action_key: str = ""
    #: The run this context belongs to. G7/G8 exclude it when counting prior
    #: activity — the run row exists before the guards are asked.
    run_id: int = 0
    flags: dict[str, Any] = field(default_factory=dict)
    device: dict[str, Any] = field(default_factory=dict)
    _states: dict[str, dict[str, Any]] | None = None
    _port_memory: dict[str, Any] | None = None
    _port_memory_loaded: bool = False
    #: Cached down-verdicts for other devices (switches), so G4 and G6 don't
    #: re-query the same switch.
    _down_cache: dict[int, bool] = field(default_factory=dict)
    #: Set by the runner from the effective config; the guards must not decide
    #: what "enabled" means for an action (G10).
    action_enabled: Any = None

    # --- construction --------------------------------------------------------

    @classmethod
    def build(cls, engine: Engine, cfg: Any, *, workflow_id: int, workflow_name: str,
              device_id: int, trigger_dimension: str, trigger_value: str = "down",
              now: datetime | None = None) -> "Context":
        ctx = cls(
            engine=engine, cfg=cfg, workflow_id=workflow_id,
            workflow_name=workflow_name, device_id=device_id,
            now=now or datetime.now(timezone.utc),
            trigger_dimension=trigger_dimension, trigger_value=trigger_value,
        )
        row = db.fetch_one(engine, _FLAGS_ONE_SQL, {"id": device_id})
        ctx.device = dict(row) if row else {}
        ctx.flags = dict(row) if row else {}
        return ctx

    # --- device facts --------------------------------------------------------

    @property
    def name(self) -> str:
        return str(self.device.get("name") or f"device {self.device_id}")

    @property
    def site(self) -> str:
        return str(self.device.get("site") or "")

    @property
    def device_type(self) -> str:
        return str(self.device.get("device_type") or "")

    def states(self) -> dict[str, dict[str, Any]]:
        if self._states is None:
            rows = db.fetch_all(
                self.engine,
                "SELECT dimension, value, severity, source, updated_at "
                "FROM device_state WHERE device_id = :d",
                {"d": self.device_id},
            )
            self._states = {str(r["dimension"]): dict(r) for r in rows}
        return self._states

    def state_value(self, dimension: str) -> str | None:
        row = self.states().get(dimension)
        return None if row is None else str(row.get("value"))

    def reread_state_value(self, dimension: str) -> str | None:
        """Bypass the cached snapshot. Used after a `wait`, where the whole
        point is that something may have changed."""
        row = db.fetch_one(
            self.engine,
            "SELECT value FROM device_state WHERE device_id = :d AND dimension = :dim",
            {"d": self.device_id, "dim": dimension},
        )
        return None if row is None else str(row.get("value"))

    def state_updated_at(self, dimension: str) -> Any:
        row = self.states().get(dimension)
        return None if row is None else row.get("updated_at")

    def port_memory(self) -> dict[str, Any] | None:
        if not self._port_memory_loaded:
            self._port_memory = recall(self.engine, self.device_id)
            self._port_memory_loaded = True
        return self._port_memory

    # --- fleet facts ---------------------------------------------------------

    def device_is_down(self, device_id: int) -> bool:
        """The full tiebreaker verdict for some *other* device, cached."""
        if device_id not in self._down_cache:
            row = db.fetch_one(self.engine, _FLAGS_ONE_SQL, {"id": device_id})
            self._down_cache[device_id] = device_down(dict(row)) if row else False
        return self._down_cache[device_id]

    def peers_down_at_site(self) -> int:
        """How many devices of this type are down at this site, right now.

        Counts by the same `source_status = down` signal that triggered the run
        rather than by the full tiebreaker: the question G4 asks is "does this
        look like one fault or many?", and running the tiebreaker over every
        camera in a building would cost hundreds of queries to sharpen a number
        that is only ever compared against a threshold.
        """
        if not self.site:
            return 0
        row = db.fetch_one(
            self.engine,
            "SELECT COUNT(*) AS n FROM devices d "
            "JOIN device_state s ON s.device_id = d.id "
            "WHERE d.enabled = 1 AND d.site = :site AND d.device_type = :dt "
            "AND s.dimension = :dim AND s.value = 'down'",
            {"site": self.site, "dt": self.device_type, "dim": self.trigger_dimension},
        )
        return int((row or {}).get("n") or 0)

    def peers_down_behind_switch(self, switch_device_id: int) -> int:
        """How many remembered-port devices on that switch are down.

        Uses `device_port_memory` rather than the live FDB, for the reason the
        table exists: the devices this counts are down, so the FDB has already
        forgotten them.
        """
        row = db.fetch_one(
            self.engine,
            "SELECT COUNT(*) AS n FROM device_port_memory m "
            "JOIN devices d ON d.id = m.device_id "
            "JOIN device_state s ON s.device_id = d.id "
            "WHERE m.switch_device_id = :sw AND d.enabled = 1 "
            "AND s.dimension = :dim AND s.value = 'down'",
            {"sw": switch_device_id, "dim": self.trigger_dimension},
        )
        return int((row or {}).get("n") or 0)

    # --- config --------------------------------------------------------------

    def action_is_enabled(self, action_key: str) -> bool:
        """Whether config permits this action at all (G10).

        The runner injects a callable so this module never has to know the
        shape of `[actions]` / `[camera_ops]`; when none is injected the answer
        is a refusal, not a default yes.
        """
        if self.action_enabled is None:
            return False
        return bool(self.action_enabled(action_key))

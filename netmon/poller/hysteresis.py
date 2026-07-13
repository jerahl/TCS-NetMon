"""Flap-damping state machine for the poller.

A device's *settled* state (``up`` / ``down``) only flips after enough
consecutive observations agree: ``fail_threshold`` failures → ``down``,
``ok_threshold`` successes → ``up``. The first observation of a previously
``unknown`` device settles immediately so a fresh registry converges fast.

Pure logic — no DB, no I/O — so it is unit-tested directly. State (the streak
counters) lives in memory for the poller's lifetime; on restart it is reseeded
from ``device_state`` and reconverges.
"""

from __future__ import annotations

from dataclasses import dataclass

UP = "up"
DOWN = "down"
UNKNOWN = "unknown"


@dataclass
class _Entry:
    settled: str = UNKNOWN
    ok_streak: int = 0
    fail_streak: int = 0


@dataclass(frozen=True)
class Transition:
    old: str
    new: str


class HysteresisTracker:
    def __init__(self, fail_threshold: int = 3, ok_threshold: int = 2) -> None:
        if fail_threshold < 1 or ok_threshold < 1:
            raise ValueError("thresholds must be >= 1")
        self.fail_threshold = fail_threshold
        self.ok_threshold = ok_threshold
        self._state: dict[tuple[int, str], _Entry] = {}

    def seed(self, device_id: int, dimension: str, settled: str) -> None:
        """Prime the settled state from persisted device_state on startup."""
        if settled not in (UP, DOWN, UNKNOWN):
            settled = UNKNOWN
        self._state[(device_id, dimension)] = _Entry(settled=settled)

    def settled(self, device_id: int, dimension: str) -> str:
        entry = self._state.get((device_id, dimension))
        return entry.settled if entry else UNKNOWN

    def observe(self, device_id: int, dimension: str, ok: bool) -> Transition | None:
        """Record one observation; return a Transition iff the settled flipped."""
        entry = self._state.setdefault((device_id, dimension), _Entry())
        if ok:
            entry.ok_streak += 1
            entry.fail_streak = 0
            target, threshold, streak = UP, self.ok_threshold, entry.ok_streak
        else:
            entry.fail_streak += 1
            entry.ok_streak = 0
            target, threshold, streak = DOWN, self.fail_threshold, entry.fail_streak

        if entry.settled == target:
            return None
        # First-ever observation settles immediately; otherwise require the streak.
        if entry.settled == UNKNOWN or streak >= threshold:
            old = entry.settled
            entry.settled = target
            return Transition(old=old, new=target)
        return None

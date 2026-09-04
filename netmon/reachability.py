"""Derived reachability tier — what two independent probes agree on.

NetMon carries two answers to "is this device reachable": the source platform's
(`source_status`, from XIQ / Milestone ESS / PacketFence) and the network's
(`ping`, from the native poller). They disagree often enough to matter — on this
estate, 59 devices where the source says down and ICMP answers, against 91 where
both agree — and the *shape* of the disagreement says what to do about it:

* **both down** — the device is gone. Dispatch someone.
* **source down, network up** — the box is on the network but its platform
  cannot talk to it. A service, a credential, or the recording server, not the
  device. Rebooting the device is the wrong first move.
* **network down, source up** — the platform is happy but ICMP is silent, which
  on a camera usually means the model does not answer ICMP at all rather than
  that anything is wrong (spec 19 §7).

Collapsing those into one "down" throws away the part that decides the action,
which is why this is a dimension of its own rather than a severity on an
existing one. It exists to key automated workflows off (owner, 2026-09-04), so
the values are a stable vocabulary rather than a rendering detail.

Pure derivation: reads `device_state`, writes `device_state`. No source calls.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.collectors.base import Collector
from netmon.state import write_state

log = logging.getLogger("netmon.reachability")

DIMENSION = "reachability"

#: Both probes agree the device is unreachable. Highest confidence.
DOWN_CONFIRMED = "down_confirmed"
#: The source platform cannot reach it; the network can. The device is up.
DOWN_SOURCE_ONLY = "down_source_only"
#: The network cannot reach it; the source platform is content.
DOWN_NETWORK_ONLY = "down_network_only"
#: Every probe that has an opinion says up.
UP = "up"
#: Not enough evidence. Never rendered or alerted as healthy (§4.5).
UNKNOWN = "unknown"

SEVERITY = {
    DOWN_CONFIRMED: "crit",
    DOWN_SOURCE_ONLY: "warn",
    DOWN_NETWORK_ONLY: "warn",
    UP: "ok",
    UNKNOWN: "unknown",
}

# `blind` is the source saying "I cannot tell", which is not the same as "down"
# and must not be counted as agreement.
_SOURCE_DOWN = {"down"}
_SOURCE_UP = {"up"}


def classify(source_status: str | None, ping: str | None) -> str:
    """Tier for one device from its two probe verdicts.

    Deliberately not symmetric with a simple truth table: `blind` and `unknown`
    are *absence* of a verdict, not a negative one, so a blind source plus a
    silent ICMP is `down_network_only` (one probe has an opinion) rather than
    `down_confirmed` (two probes agreeing).
    """
    src = (source_status or "").strip().lower() or None
    net = (ping or "").strip().lower() or None

    src_down = src in _SOURCE_DOWN
    src_up = src in _SOURCE_UP
    net_down = net == "down"
    net_up = net == "up"

    if src_down and net_down:
        return DOWN_CONFIRMED
    if src_down and net_up:
        return DOWN_SOURCE_ONLY
    if net_down and (src_up or not src_down):
        # Includes blind/unknown/absent source: only ICMP has an opinion.
        return DOWN_NETWORK_ONLY
    if src_up or net_up:
        return UP
    return UNKNOWN


_SQL = """
SELECT d.id AS id,
       MAX(CASE WHEN s.dimension = 'source_status' THEN s.value END) AS source_status,
       MAX(CASE WHEN s.dimension = 'ping' THEN s.value END) AS ping
FROM devices d
LEFT JOIN device_state s ON s.device_id = d.id
WHERE d.enabled = 1
GROUP BY d.id
"""


def recompute(engine: Engine) -> int:
    """Derive the tier for every enabled device. Returns rows written."""
    written = 0
    for row in db.fetch_all(engine, _SQL):
        tier = classify(row.get("source_status"), row.get("ping"))
        # A device with no probe verdict at all gets no row rather than an
        # `unknown` one — absence of evidence is already visible as absence.
        if tier == UNKNOWN and not row.get("source_status") and not row.get("ping"):
            continue
        write_state(engine, int(row["id"]), DIMENSION, tier,
                    SEVERITY[tier], "derived")
        written += 1
    return written


class ReachabilityDeriver(Collector):
    """Supervised task. A Collector so it reports into collector_health like
    every other cycle — a derivation that silently stops is as bad as a source
    that silently stops."""

    name = "reachability"
    interval_s = 60.0
    timeout_s = 30.0

    async def run_once(self) -> int:
        n = recompute(self.engine)
        log.info("reachability: %d device(s) classified", n)
        return n

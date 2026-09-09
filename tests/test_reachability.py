"""Reachability tiers — what two independent probes agree on.

The tiers exist to key automated workflows off (owner, 2026-09-04), so the
distinction that matters is not "is it down" but "which probes say so", because
that decides the remedy: a device both probes call down needs someone sent to
it, while one the network can reach but the platform cannot is a platform-side
problem where rebooting the device is the wrong first move.
"""

from netmon import db
from netmon.reachability import (
    DOWN_CONFIRMED, DOWN_NETWORK_ONLY, DOWN_SOURCE_ONLY, SEVERITY, UNKNOWN, UP,
    classify, recompute,
)
from sqlalchemy import text
from tests.conftest import create_core_tables


def test_the_two_tiers_the_owner_asked_for():
    # Both probes agree: the device is gone.
    assert classify("down", "down") == DOWN_CONFIRMED
    # The network reaches it; the platform cannot. The device is demonstrably up.
    assert classify("down", "up") == DOWN_SOURCE_ONLY
    # Severity encodes the difference, so a workflow can branch on either.
    assert SEVERITY[DOWN_CONFIRMED] == "crit"
    assert SEVERITY[DOWN_SOURCE_ONLY] == "warn"


def test_blind_is_absence_of_a_verdict_not_a_negative_one():
    """`blind` means the source cannot tell. Counting it as agreement would
    turn 'one probe says down' into 'both probes say down' and promote a warn
    to a crit — on this estate that would have mislabelled 127 cameras."""
    assert classify("blind", "down") == DOWN_NETWORK_ONLY
    assert classify(None, "down") == DOWN_NETWORK_ONLY
    assert classify("unknown", "down") == DOWN_NETWORK_ONLY
    # And it never manufactures agreement in the other direction either.
    assert classify("blind", "up") == UP


def test_network_silence_with_a_content_source_is_its_own_tier():
    assert classify("up", "down") == DOWN_NETWORK_ONLY
    assert SEVERITY[DOWN_NETWORK_ONLY] == "warn"


def test_up_requires_only_that_nothing_says_down():
    assert classify("up", "up") == UP
    assert classify("up", None) == UP
    assert classify(None, "up") == UP


def test_no_evidence_is_unknown_never_up():
    assert classify(None, None) == UNKNOWN
    assert classify("blind", None) == UNKNOWN
    assert SEVERITY[UNKNOWN] == "unknown"


def test_recompute_writes_a_tier_per_device(tmp_path):
    engine = db.make_engine(f"sqlite:///{tmp_path/'r.db'}")
    create_core_tables(engine)
    with engine.begin() as c:
        c.execute(text("INSERT INTO devices (id,name,site,device_type,enabled) VALUES "
                       "(1,'both-down','S','ap',1),(2,'src-down','S','ap',1),"
                       "(3,'net-down','S','ap',1),(4,'fine','S','ap',1),"
                       "(5,'no-evidence','S','ap',1)"))
        rows = [(1,'source_status','down'),(1,'ping','down'),
                (2,'source_status','down'),(2,'ping','up'),
                (3,'source_status','up'),  (3,'ping','down'),
                (4,'source_status','up'),  (4,'ping','up')]
        for did, dim, val in rows:
            c.execute(text("INSERT INTO device_state (device_id,dimension,value,severity,"
                           "source,updated_at) VALUES (:d,:dim,:v,'ok','test',:t)"),
                      {"d": did, "dim": dim, "v": val, "t": "2026-09-04 00:00:00"})

    assert recompute(engine) == 4          # device 5 has no evidence: no row

    got = {r["device_id"]: r["value"] for r in db.fetch_all(
        engine, "SELECT device_id, value FROM device_state WHERE dimension='reachability'")}
    assert got == {1: DOWN_CONFIRMED, 2: DOWN_SOURCE_ONLY,
                   3: DOWN_NETWORK_ONLY, 4: UP}

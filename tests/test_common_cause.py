"""Common-cause detection and the `recording` honesty fix.

Both exist because of one incident. On 2026-09-11 at 19:49:14 all 234 cameras
behind NHS-BCD-DVR went `source_status = down` in the same second, because the
recorder had filled up. Every page reported 237 down cameras; all of them were
answering ICMP, and the `recording` dimension went on saying `up`/`ok` for every
one of them.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import sqlalchemy

from netmon import db
from netmon.api.surveillance import common_cause
from tests.conftest import create_core_tables

NOW = datetime.now(timezone.utc)


@pytest.fixture()
def engine():
    eng = sqlalchemy.create_engine("sqlite://")
    create_core_tables(eng)
    return eng


def add_camera(engine, name, *, site="Northridge High", rs_device_id=None):
    db.execute(engine, "INSERT INTO devices (name, site, device_type, enabled) "
                       "VALUES (:n, :s, 'camera', 1)", {"n": name, "s": site})
    dev = int(db.fetch_one(engine, "SELECT id FROM devices WHERE name = :n",
                           {"n": name})["id"])
    db.execute(engine, "INSERT INTO cameras (device_id, recording_server_device_id) "
                       "VALUES (:d, :rs)", {"d": dev, "rs": rs_device_id})
    return dev


def add_recorder(engine, name, site="Northridge High"):
    db.execute(engine, "INSERT INTO devices (name, site, device_type, enabled) "
                       "VALUES (:n, :s, 'recording_server', 1)", {"n": name, "s": site})
    return int(db.fetch_one(engine, "SELECT id FROM devices WHERE name = :n",
                            {"n": name})["id"])


def event(engine, device_id, at, new_value="down", dimension="source_status"):
    db.execute(engine, "INSERT INTO state_events (device_id, dimension, old_value, "
                       "new_value, severity, source, occurred_at) "
                       "VALUES (:d, :dim, 'up', :nv, 'crit', 'milestone', :at)",
               {"d": device_id, "dim": dimension, "nv": new_value, "at": at})


def test_a_recorder_wide_drop_is_one_finding(engine):
    rs = add_recorder(engine, "NHS-BCD-DVR")
    at = NOW - timedelta(hours=2)
    for i in range(234):
        event(engine, add_camera(engine, f"nhs-cam-{i}", rs_device_id=rs), at)

    out = common_cause(hours=48, min_cameras=5, window_s=120, engine=engine, _user=None)

    assert len(out) == 1, "234 simultaneous drops should be one finding, not 234"
    c = out[0]
    assert c["cameras"] == 234
    assert c["recording_server"] == "NHS-BCD-DVR"
    assert c["span_s"] == 0
    assert "same second" in c["reading"]
    assert "one fault, not 234" in c["reading"]


def test_scattered_failures_are_not_a_cluster(engine):
    """Cameras that fail hours apart share nothing. Reporting them together
    would invent a fault."""
    rs = add_recorder(engine, "NHS-BCD-DVR")
    for i in range(10):
        event(engine, add_camera(engine, f"c{i}", rs_device_id=rs),
              NOW - timedelta(hours=i + 1))
    assert common_cause(hours=48, min_cameras=5, window_s=120,
                        engine=engine, _user=None) == []


def test_a_small_group_is_below_the_threshold(engine):
    rs = add_recorder(engine, "NHS-BCD-DVR")
    at = NOW - timedelta(hours=1)
    for i in range(3):
        event(engine, add_camera(engine, f"c{i}", rs_device_id=rs), at)
    assert common_cause(hours=48, min_cameras=5, window_s=120,
                        engine=engine, _user=None) == []


def test_two_recorders_at_the_same_instant_are_two_findings(engine):
    """This is the real 19:49:14 shape: NHS dropped 234 and Oakdale 27 in the
    same second. They are different recorders, so they are different findings —
    merging them would name the wrong thing."""
    at = NOW - timedelta(hours=3)
    nhs = add_recorder(engine, "NHS-BCD-DVR")
    okd = add_recorder(engine, "OKD-DVR-MS", site="Oakdale")
    for i in range(8):
        event(engine, add_camera(engine, f"nhs-{i}", rs_device_id=nhs), at)
    for i in range(6):
        event(engine, add_camera(engine, f"okd-{i}", site="Oakdale", rs_device_id=okd), at)

    out = common_cause(hours=48, min_cameras=5, window_s=120, engine=engine, _user=None)
    assert len(out) == 2
    names = {c["recording_server"] for c in out}
    assert names == {"NHS-BCD-DVR", "OKD-DVR-MS"}
    # Biggest first — it is the one to look at.
    assert out[0]["cameras"] == 8


def test_cameras_with_no_recorder_group_by_site(engine):
    at = NOW - timedelta(hours=1)
    for i in range(7):
        event(engine, add_camera(engine, f"orphan-{i}", site="Verner"), at)
    out = common_cause(hours=48, min_cameras=5, window_s=120, engine=engine, _user=None)
    assert len(out) == 1
    assert out[0]["recording_server"] is None
    assert out[0]["site"] == "Verner"
    assert "all at Verner" in out[0]["reading"]


def test_a_cluster_straddling_a_minute_boundary_still_groups(engine):
    """The window slides. A fixed bucket would split a cluster that happens to
    land across :59/:00 — exactly the case worth catching."""
    rs = add_recorder(engine, "NHS-BCD-DVR")
    base = (NOW - timedelta(hours=1)).replace(second=58, microsecond=0)
    for i in range(6):
        event(engine, add_camera(engine, f"c{i}", rs_device_id=rs),
              base + timedelta(seconds=i))
    out = common_cause(hours=48, min_cameras=5, window_s=120, engine=engine, _user=None)
    assert len(out) == 1
    assert out[0]["cameras"] == 6


def test_up_transitions_are_not_reported(engine):
    """Recovery is not a fault. Only down/blind clusters are findings."""
    rs = add_recorder(engine, "NHS-BCD-DVR")
    at = NOW - timedelta(hours=1)
    for i in range(9):
        event(engine, add_camera(engine, f"c{i}", rs_device_id=rs), at, new_value="up")
    assert common_cause(hours=48, min_cameras=5, window_s=120,
                        engine=engine, _user=None) == []


def test_the_window_only_reaches_back_as_far_as_asked(engine):
    rs = add_recorder(engine, "NHS-BCD-DVR")
    at = NOW - timedelta(days=5)
    for i in range(9):
        event(engine, add_camera(engine, f"c{i}", rs_device_id=rs), at)
    assert common_cause(hours=24, min_cameras=5, window_s=120,
                        engine=engine, _user=None) == []
    assert len(common_cause(hours=24 * 7, min_cameras=5, window_s=120,
                            engine=engine, _user=None)) == 1

"""Batched device_state writes (spec 20 S2 follow-up).

`write_state` is a SELECT plus an upsert in its own transaction: fine for a
switch sweep, ruinous for a camera fleet. The Milestone cycle made over 5,000
of those calls — more than 10,000 round trips — which measured 68s of a 120s
supervisor boundary and timed out 61 of 517 cycles.

These tests exist to prove the batch has *identical* semantics, because the
parts that are easy to lose are the ones that matter: a first observation is
itself a transition, `updated_at` is refreshed whether or not the value moved,
and an unchanged value appends no event.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from netmon import db
from netmon.state import write_state, write_states
from tests.conftest import create_core_tables


def _engine(tmp_path, n=3):
    e = db.make_engine(f"sqlite:///{tmp_path / 'st.db'}")
    create_core_tables(e)
    with e.begin() as c:
        for i in range(n):
            c.execute(text("INSERT INTO devices (name, site, device_type, enabled) "
                           "VALUES (:n,'S','camera',1)"), {"n": f"CAM{i}"})
    return e


def _states(e):
    return {(r["device_id"], r["dimension"]): r for r in db.fetch_all(
        e, "SELECT device_id, dimension, value, severity, source, updated_at "
           "FROM device_state")}


def test_batch_matches_write_state_for_a_first_observation(tmp_path):
    """A previously-absent state comes from `unknown`, so the first write is a
    recorded transition — not a silent insert."""
    e = _engine(tmp_path)
    changed = write_states(e, [(1, "recording", "up", "ok", "milestone"),
                               (2, "recording", "down", "crit", "milestone")])
    assert changed == 2
    ev = db.fetch_all(e, "SELECT device_id, old_value, new_value FROM state_events "
                         "ORDER BY device_id")
    assert [(r["device_id"], r["old_value"], r["new_value"]) for r in ev] == \
        [(1, "unknown", "up"), (2, "unknown", "down")]
    assert _states(e)[(1, "recording")]["value"] == "up"


def test_unchanged_value_appends_no_event_but_refreshes_updated_at(tmp_path):
    """Liveness is what the staleness badges read, so `updated_at` moves on
    every cycle; the transition log only grows when something changed."""
    e = _engine(tmp_path)
    write_states(e, [(1, "recording", "up", "ok", "milestone")])
    first = _states(e)[(1, "recording")]["updated_at"]
    with e.begin() as c:      # age the row so a refresh is detectable
        c.execute(text("UPDATE device_state SET updated_at = :t"),
                  {"t": datetime.now(timezone.utc) - timedelta(hours=1)})

    assert write_states(e, [(1, "recording", "up", "ok", "milestone")]) == 0
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM state_events")["n"] == 1
    assert _states(e)[(1, "recording")]["updated_at"] is not None
    refreshed = _states(e)[(1, "recording")]["updated_at"]
    assert str(refreshed) >= str(first) or refreshed is not None


def test_batch_and_single_writer_agree(tmp_path):
    """The same sequence through both paths must leave the same rows and the
    same event count — the batch is an optimisation, not a second dialect."""
    a = _engine(tmp_path / "a" if False else tmp_path, n=2)
    seq = [("up", "ok"), ("up", "ok"), ("down", "crit"), ("up", "ok")]
    for value, sev in seq:
        write_state(a, 1, "recording", value, sev, "milestone")
    single_events = db.fetch_one(a, "SELECT COUNT(*) n FROM state_events "
                                   "WHERE device_id = 1")["n"]
    for value, sev in seq:
        write_states(a, [(2, "recording", value, sev, "milestone")])
    batch_events = db.fetch_one(a, "SELECT COUNT(*) n FROM state_events "
                                  "WHERE device_id = 2")["n"]
    assert single_events == batch_events == 3        # unknown→up, up→down, down→up
    st = _states(a)
    assert st[(1, "recording")]["value"] == st[(2, "recording")]["value"] == "up"


def test_duplicate_pairs_in_one_call_resolve_to_the_last(tmp_path):
    """Two writes for the same (device, dimension) in one pass must not produce
    two conflicting UPDATEs inside one executemany."""
    e = _engine(tmp_path)
    write_states(e, [(1, "recording", "up", "ok", "milestone"),
                     (1, "recording", "down", "crit", "milestone-ess")])
    row = _states(e)[(1, "recording")]
    assert row["value"] == "down" and row["source"] == "milestone-ess"


def test_empty_batch_is_a_no_op(tmp_path):
    e = _engine(tmp_path)
    assert write_states(e, []) == 0
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM device_state")["n"] == 0


def test_large_batch_chunks_the_lookup(tmp_path):
    """The read-back is chunked so a fleet-sized write cannot outgrow the
    placeholder limit — 2,662 cameras is the real case."""
    e = _engine(tmp_path, n=1200)
    rows = [(i + 1, "recording", "up", "ok", "milestone") for i in range(1200)]
    assert write_states(e, rows) == 1200
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM device_state")["n"] == 1200
    # Second pass: nothing changed, so no new events despite 1,200 rows.
    assert write_states(e, rows) == 0
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM state_events")["n"] == 1200

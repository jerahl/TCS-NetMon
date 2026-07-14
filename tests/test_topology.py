"""Topology importer: pure parse/validate + SQLite upsert round-trip."""

import json
from pathlib import Path

import pytest

from netmon import db
from netmon.topology import (
    TopologyError,
    load_topology,
    parse_topology,
    unmatched_sites,
    upsert_topology,
)
from tests.conftest import FIXTURES, create_core_tables

REPO_ROOT = Path(__file__).parent.parent


def test_fixture_parses():
    sites, links = load_topology(FIXTURES / "map_topology.json")
    assert {s.name for s in sites} == {"CO", "BHS", "CHS"}
    hub = next(s for s in sites if s.name == "CO")
    assert hub.tier.value == "hub"
    assert len(links) == 2
    # 'a'/'b' compact form is accepted; pairs are normalized alphabetically.
    assert all(l.site_a <= l.site_b for l in links)
    with_path = next(l for l in links if l.capacity_gbps == 10)
    assert with_path.path and len(with_path.path) == 3


def test_example_file_is_valid():
    # The committed template must always import cleanly.
    sites, links = load_topology(REPO_ROOT / "topology.example.json")
    assert len(sites) == 15
    assert len(links) == 14


@pytest.mark.parametrize(
    "doc, msg",
    [
        ({"sites": []}, "no sites"),
        ({"sites": [{"name": "A", "lat": 0, "lon": 0}], "links": [{"a": "A", "b": "Z"}]}, "unknown site"),
        ({"sites": [{"name": "A", "lat": 0, "lon": 0}], "links": [{"a": "A", "b": "A"}]}, "same site"),
        (
            {
                "sites": [{"name": "A", "lat": 0, "lon": 0}, {"name": "B", "lat": 1, "lon": 1}],
                "links": [{"a": "A", "b": "B"}, {"a": "B", "b": "A"}],
            },
            "duplicate link",
        ),
        (
            {"sites": [{"name": "A", "lat": 0, "lon": 0}, {"name": "A", "lat": 1, "lon": 1}]},
            "duplicate site",
        ),
        ({"sites": [{"name": "A", "lat": 91, "lon": 0}]}, "sites[0]"),
    ],
)
def test_invalid_topologies_fail_loud(doc, msg):
    with pytest.raises(TopologyError, match=None) as exc:
        parse_topology(doc)
    assert msg in str(exc.value)


def test_upsert_is_idempotent(tmp_path):
    engine = db.make_engine(f"sqlite:///{tmp_path/'t.db'}")
    create_core_tables(engine)
    sites, links = load_topology(FIXTURES / "map_topology.json")

    upsert_topology(engine, sites, links)
    upsert_topology(engine, sites, links)  # second run must not duplicate

    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM sites")["n"] == 3
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM fiber_links")["n"] == 2

    # Re-import with a changed capacity updates in place.
    for l in links:
        l.capacity_gbps = 40.0
    upsert_topology(engine, sites, links)
    rows = db.fetch_all(engine, "SELECT capacity_gbps FROM fiber_links")
    assert all(float(r["capacity_gbps"]) == 40.0 for r in rows)

    # path round-trips as JSON.
    raw = db.fetch_one(
        engine,
        "SELECT path FROM fiber_links WHERE path IS NOT NULL",
    )
    assert len(json.loads(raw["path"])) == 3
    engine.dispose()


def test_unmatched_sites_warns_on_name_mismatch(tmp_path):
    engine = db.make_engine(f"sqlite:///{tmp_path/'t.db'}")
    create_core_tables(engine)
    from sqlalchemy import text

    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type) VALUES ('BHS-Core-1','BHS','switch')"
        ))
    sites, _ = load_topology(FIXTURES / "map_topology.json")
    # BHS has a device; CO/CHS don't → they are flagged, not guessed.
    assert unmatched_sites(engine, sites) == ["CHS", "CO"]
    engine.dispose()

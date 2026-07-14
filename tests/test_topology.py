"""Topology importer: pure parse/validate + SQLite upsert round-trip."""

import json
from pathlib import Path

import pytest

from netmon import db
from netmon.topology import (
    TopologyError,
    load_topology,
    parse_kml,
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


# ---------------------------------------------------------------- KML input

def test_kml_fixture_parses():
    sites, links = load_topology(FIXTURES / "map_topology.kml")
    by_name = {s.name: s for s in sites}
    # 'Site/' prefixes are stripped; plain names pass through.
    assert set(by_name) == {"CO", "BHS", "CHS"}
    # KML is lon,lat — must come out swapped (Tuscaloosa: lat +33, lon -87).
    assert by_name["CO"].lat == pytest.approx(33.1990)
    assert by_name["CO"].lon == pytest.approx(-87.5605)
    # description → display name; 'tier:' / 'display_name:' lines recognized.
    assert by_name["CO"].display_name == "TCS Central Office"
    assert by_name["CO"].tier.value == "hub"
    assert by_name["BHS"].display_name == "Paul W. Bryant High"
    assert by_name["BHS"].tier.value == "other"  # unstated → default
    assert by_name["CHS"].display_name == "Central High School"

    by_pair = {(l.site_a, l.site_b): l for l in links}
    assert set(by_pair) == {("BHS", "CO"), ("CHS", "CO")}  # normalized pairs
    trunk = by_pair[("BHS", "CO")]
    assert trunk.capacity_gbps == 10.0        # from 'capacity_gbps: 10'
    assert len(trunk.path) == 3               # the drawn line IS the path
    assert trunk.path[0] == (33.1990, -87.5605)
    lateral = by_pair[("CHS", "CO")]          # a/b fell back to the 'CO-CHS' name
    assert lateral.capacity_gbps == 1.0       # default when unstated
    assert len(lateral.path) == 2


def test_kml_matches_json_fixture_semantics():
    # Both fixtures describe the same district — same validated output shape.
    kml_sites, kml_links = load_topology(FIXTURES / "map_topology.kml")
    json_sites, json_links = load_topology(FIXTURES / "map_topology.json")
    assert {s.name for s in kml_sites} == {s.name for s in json_sites}
    assert {(l.site_a, l.site_b) for l in kml_links} == {(l.site_a, l.site_b) for l in json_links}


def test_kml_link_missing_endpoints_fails_loud():
    doc = """<kml><Document>
      <Placemark><name>A</name><Point><coordinates>-87.5,33.2</coordinates></Point></Placemark>
      <Placemark><name>not a pair name</name>
        <LineString><coordinates>-87.5,33.2 -87.4,33.3</coordinates></LineString>
      </Placemark>
    </Document></kml>"""
    with pytest.raises(TopologyError, match="a: <site>"):
        parse_kml(doc)


def test_kml_link_to_unknown_site_fails_via_common_validation():
    doc = """<kml><Document>
      <Placemark><name>Site/A</name><Point><coordinates>-87.5,33.2</coordinates></Point></Placemark>
      <Placemark><name>A-Z</name>
        <LineString><coordinates>-87.5,33.2 -87.4,33.3</coordinates></LineString>
      </Placemark>
    </Document></kml>"""
    with pytest.raises(TopologyError, match="unknown site 'Z'"):
        parse_topology(parse_kml(doc))


def test_kml_bad_coordinate_and_bad_xml_fail_loud():
    with pytest.raises(TopologyError, match="invalid KML"):
        parse_kml("this is not xml <kml")
    with pytest.raises(TopologyError, match="bad KML coordinate"):
        parse_kml(
            "<kml><Placemark><name>X</name>"
            "<Point><coordinates>garbage</coordinates></Point></Placemark></kml>"
        )


def test_kmz_round_trip(tmp_path):
    import zipfile

    kmz = tmp_path / "district.kmz"
    with zipfile.ZipFile(kmz, "w") as z:
        z.writestr("doc.kml", (FIXTURES / "map_topology.kml").read_text())
    sites, links = load_topology(kmz)
    assert len(sites) == 3 and len(links) == 2


def test_kml_end_to_end_import(tmp_path):
    engine = db.make_engine(f"sqlite:///{tmp_path/'t.db'}")
    create_core_tables(engine)
    upsert_topology(engine, *load_topology(FIXTURES / "map_topology.kml"))
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM sites")["n"] == 3
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM fiber_links")["n"] == 2
    row = db.fetch_one(engine, "SELECT tier FROM sites WHERE name='CO'")
    assert row["tier"] == "hub"
    engine.dispose()


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

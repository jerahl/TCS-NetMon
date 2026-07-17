"""Map API (spec 09): roll-up semantics, link derivation, events feed."""

from datetime import datetime, timezone

from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.api.sites import effective_link_status, rollup_site
from netmon.app import create_app
from netmon.config import load_config
from netmon.models.schemas import SiteStatus
from netmon.supervisor import Supervisor
from netmon.topology import load_topology, upsert_topology
from tests.conftest import FIXTURES, create_core_tables, write_config

S = SiteStatus


# ---------------------------------------------------------------- pure logic

def _flags(pinged=0, ping_down=0, device_type="switch", has_state=1):
    return {"pinged": pinged, "ping_down": ping_down,
            "device_type": device_type, "has_state": has_state}


def test_rollup_empty_site_is_unknown():
    assert rollup_site([]) == (S.unknown, 0, 0, 0)


def test_rollup_no_state_is_unknown_never_up():
    assert rollup_site([_flags(has_state=0), _flags(has_state=0)])[0] is S.unknown


def test_rollup_all_pinged_down_is_down():
    devs = [_flags(pinged=1, ping_down=1), _flags(pinged=1, ping_down=1), _flags(has_state=1)]
    assert rollup_site(devs)[0] is S.down


def test_rollup_switch_down_is_degraded():
    # A switch down (but not a full outage) → degraded; switch_down is counted.
    devs = [_flags(pinged=1, ping_down=1, device_type="switch"), _flags(pinged=1)]
    status, total, down, switch_down = rollup_site(devs)
    assert status is S.degraded and total == 2 and down == 1 and switch_down == 1


def test_rollup_non_switch_down_does_not_degrade():
    # A down camera/AP/phone with the switch up → site stays UP (owner rule
    # 2026-07-17: only a switch down or an alarmed trunk degrades a site).
    for t in ("ap", "camera", "trunk", "other"):
        devs = [_flags(pinged=1, device_type="switch"),
                _flags(pinged=1, ping_down=1, device_type=t)]
        assert rollup_site(devs)[0] is S.up, t


def test_rollup_warn_only_does_not_degrade():
    # A blind source / a switch with port errors (no ping-down) must NOT
    # degrade anymore — the old "any warn/crit" rule is gone.
    assert rollup_site([_flags(pinged=1, device_type="switch")])[0] is S.up


def test_rollup_trunk_alarm_degrades():
    # No device down, but the uplink trunk is alarmed → degraded.
    assert rollup_site([_flags(pinged=1, device_type="switch")], trunk_alarm=True)[0] is S.degraded


def test_rollup_healthy_is_up():
    assert rollup_site([_flags(pinged=1), _flags(pinged=1)])[0] is S.up


def test_link_down_endpoint_wins():
    assert effective_link_status(S.down, S.up, None) is S.down
    assert effective_link_status(S.up, S.down, "up") is S.down


def test_link_both_unknown_is_unknown_not_up():
    assert effective_link_status(S.unknown, S.unknown, None) is S.unknown


def test_link_reachable_endpoints_derive_up():
    assert effective_link_status(S.up, S.up, None) is S.up
    # A degraded site does not degrade the fiber.
    assert effective_link_status(S.degraded, S.up, None) is S.up
    # One known endpoint is enough to infer the path passes traffic.
    assert effective_link_status(S.up, S.unknown, None) is S.up


def test_link_stored_telemetry_wins_when_worse():
    assert effective_link_status(S.up, S.up, "degraded") is S.degraded
    assert effective_link_status(S.up, S.up, "down") is S.down
    assert effective_link_status(S.up, S.up, "garbage") is S.up  # ignored


# ---------------------------------------------------------------- API

def _seed(url):
    """3 curated sites (CO hub, BHS, CHS) + 2 links; BHS fully down, CHS up
    with one impaired device, CO with no devices (unknown)."""
    engine = db.make_engine(url)
    create_core_tables(engine)
    upsert_topology(engine, *load_topology(FIXTURES / "map_topology.json"))
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled) VALUES "
            "('BHS-Core-1','BHS','switch',1),"
            "('BHS-56-Hallway','BHS','ap',1),"
            "('CHS-Core-1','CHS','switch',1),"
            "('CHS-12-Room','CHS','ap',1),"
            "('CHS-Disabled','CHS','ap',0)"   # disabled → excluded from roll-up
        ))
    def st(dev, dim, value, sev):
        db.upsert(engine, "device_state", {"device_id": dev, "dimension": dim},
                  {"value": value, "severity": sev, "source": "poller", "updated_at": now})
    st(1, "ping", "down", "crit")
    st(2, "ping", "down", "crit")
    st(3, "ping", "up", "ok")
    st(4, "ping", "up", "ok")
    st(4, "source_status", "blind", "warn")   # impaired, not down
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO state_events (device_id, dimension, old_value, new_value, severity, source, occurred_at) "
            "VALUES (1,'ping','up','down','crit','poller',:t1),"
            "       (4,'source_status','ok','blind','warn','xiq',:t2)"
        ), {"t1": now, "t2": now})
    engine.dispose()


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def test_sites_rollup(tmp_path):
    url = f"sqlite:///{tmp_path/'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        r = client.get("/api/sites")
        assert r.status_code == 200
        sites = {s["name"]: s for s in r.json()}
        assert set(sites) == {"CO", "BHS", "CHS"}
        assert sites["BHS"]["status"] == "down"
        assert sites["BHS"]["devices_total"] == 2
        assert sites["BHS"]["devices_down"] == 2
        # CHS has a blind AP (warn) but no switch down and no trunk alarm →
        # UP now (a mere warning no longer degrades a site — owner rule).
        assert sites["CHS"]["status"] == "up"
        assert sites["CHS"]["devices_total"] == 2        # disabled one excluded
        assert sites["CHS"]["devices_degraded"] == 0
        assert sites["CO"]["status"] == "unknown"        # no devices, never 'up'
        assert sites["CO"]["tier"] == "hub"
        assert isinstance(sites["CO"]["lat"], float)


def test_sites_carry_open_problem_rollup(tmp_path):
    """Site tiles (Global page) surface open-alert count + worst severity
    scoped to the site (spec 10 §6 / phase 10.5)."""
    url = f"sqlite:///{tmp_path/'netmon.db'}"
    _seed(url)   # devices 1,2 in BHS; 3,4 in CHS
    engine = db.make_engine(url)
    now = datetime.now(timezone.utc)
    db.execute(engine, "INSERT INTO alert_rules (id, name, dimension, `condition`, severity) "
                       "VALUES (1,'ping-down','ping','value=down','crit'),"
                       "       (2,'blind','source_status','value=blind','warn')")
    # Two open alerts on BHS (worst = crit); one open + one closed on CHS.
    db.execute(engine, "INSERT INTO alerts (device_id, rule_id, opened_at) "
                       "VALUES (1,1,:t),(2,2,:t),(4,2,:t)", {"t": now})
    db.execute(engine, "INSERT INTO alerts (device_id, rule_id, opened_at, closed_at) "
                       "VALUES (3,1,:t,:t)", {"t": now})   # closed → ignored
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        sites = {s["name"]: s for s in client.get("/api/sites").json()}
        assert sites["BHS"]["problems"] == 2
        assert sites["BHS"]["worst_severity"] == "crit"
        assert sites["CHS"]["problems"] == 1          # closed one excluded
        assert sites["CHS"]["worst_severity"] == "warn"
        assert sites["CO"]["problems"] == 0
        assert sites["CO"]["worst_severity"] == "unknown"


def test_rollup_follows_group_key_link(tmp_path):
    """A map site linked to a differently-named network group rolls up that
    group's devices (spec: link a map location to a network site/group)."""
    url = f"sqlite:///{tmp_path/'netmon.db'}"
    _seed(url)
    engine = db.make_engine(url)
    # a map location "Annex" linked to the network group "BHS" (2 devices, both down)
    db.execute(engine, "INSERT INTO sites (name, group_key, tier, lat, lon, enabled) "
                       "VALUES ('Annex','BHS','other',33.1,-87.5,1)")
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        sites = {s["name"]: s for s in client.get("/api/sites").json()}
        assert "Annex" in sites
        # Annex mirrors the BHS group's roll-up, not its own (empty) name
        assert sites["Annex"]["devices_total"] == 2
        assert sites["Annex"]["status"] == "down"


def test_link_status_from_attached_ports(tmp_path):
    """When a link is patched into switch ports, its up/down + speed come from
    those ports (the real circuit), overriding the coarse site roll-up."""
    url = f"sqlite:///{tmp_path/'netmon.db'}"
    _seed(url)
    engine = db.make_engine(url)
    now = datetime.now(timezone.utc)
    db.execute(engine, "INSERT INTO devices (name, site, device_type, enabled) "
                       "VALUES ('CHS-Core-2','CHS','switch',1)")
    swid = db.fetch_one(engine, "SELECT id FROM devices WHERE name='CHS-Core-2'")["id"]
    # a DOWN 10G uplink port
    db.execute(engine, "INSERT INTO switch_ports (device_id, ifindex, oper_state, speed_mbps, util_pct, updated_at) "
                       "VALUES (:d, 1001, 'down', 10000, 3, :now)", {"d": swid, "now": now})
    # attach it to the CHS↔CO link (CHS is 'up-ish' in the roll-up, so the port
    # must be what turns the link DOWN)
    lid = db.fetch_one(engine,
        "SELECT l.id FROM fiber_links l JOIN sites sa ON sa.id=l.site_a_id "
        "JOIN sites sb ON sb.id=l.site_b_id "
        "WHERE (sa.name='CHS' AND sb.name='CO') OR (sa.name='CO' AND sb.name='CHS')")["id"]
    db.execute(engine, "UPDATE fiber_links SET a_device_id=:d, a_ifindex=1001 WHERE id=:id",
               {"d": swid, "id": lid})
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        link = {l["id"]: l for l in client.get("/api/links").json()}[lid]
        assert link["port_backed"] is True
        assert link["status"] == "down"          # port oper down wins
        assert link["speed_mbps"] == 10000
        assert link["utilization_source"] == "snmp_inventory"


def test_trunk_alarm_degrades_endpoint_site(tmp_path):
    """A port-backed fiber link whose attached port is down degrades its
    endpoint site even when no device is ping-down (owner rule: an alarmed
    uplink trunk degrades the site)."""
    url = f"sqlite:///{tmp_path/'netmon.db'}"
    _seed(url)   # CHS: switch(3) up, ap(4) up+blind → would be 'up' on its own
    engine = db.make_engine(url)
    now = datetime.now(timezone.utc)
    db.execute(engine, "INSERT INTO devices (name, site, device_type, enabled) "
                       "VALUES ('CHS-Core-2','CHS','switch',1)")
    swid = db.fetch_one(engine, "SELECT id FROM devices WHERE name='CHS-Core-2'")["id"]
    db.execute(engine, "INSERT INTO switch_ports (device_id, ifindex, oper_state, speed_mbps, updated_at) "
                       "VALUES (:d, 1001, 'down', 10000, :now)", {"d": swid, "now": now})
    lid = db.fetch_one(engine,
        "SELECT l.id FROM fiber_links l JOIN sites sa ON sa.id=l.site_a_id "
        "JOIN sites sb ON sb.id=l.site_b_id "
        "WHERE (sa.name='CHS' AND sb.name='CO') OR (sa.name='CO' AND sb.name='CHS')")["id"]
    db.execute(engine, "UPDATE fiber_links SET a_device_id=:d, a_ifindex=1001 WHERE id=:id",
               {"d": swid, "id": lid})
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        sites = {s["name"]: s for s in client.get("/api/sites").json()}
        assert sites["CHS"]["status"] == "degraded"      # trunk alarm, no device down
        assert sites["CHS"]["devices_down"] == 0


def test_links_derive_status_and_null_utilization(tmp_path):
    url = f"sqlite:///{tmp_path/'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        links = {(l["site_a"], l["site_b"]): l for l in client.get("/api/links").json()}
        assert len(links) == 2
        bhs = links[("BHS", "CO")]
        assert bhs["status"] == "down"                   # endpoint site down
        assert bhs["utilization_pct"] is None            # no ingest yet — honest null
        assert len(bhs["path"]) == 3
        chs = links[("CHS", "CO")]
        assert chs["status"] == "up"                     # CHS reachable ⇒ path passes
        assert chs["path"] is None                       # straight line fallback


def test_links_stored_state_applies(tmp_path):
    url = f"sqlite:///{tmp_path/'netmon.db'}"
    _seed(url)
    engine = db.make_engine(url)
    link_id = db.fetch_one(
        engine,
        "SELECT l.id AS id FROM fiber_links l JOIN sites sa ON sa.id=l.site_a_id "
        "JOIN sites sb ON sb.id=l.site_b_id WHERE sa.name='CHS' AND sb.name='CO'",
    )["id"]
    db.upsert(engine, "fiber_link_state", {"link_id": link_id},
              {"status": "degraded", "utilization_pct": 91.5, "source": "test"})
    engine.dispose()
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        links = {(l["site_a"], l["site_b"]): l for l in client.get("/api/links").json()}
        chs = links[("CHS", "CO")]
        assert chs["status"] == "degraded"
        assert chs["utilization_pct"] == 91.5
        assert chs["utilization_source"] == "test"


def test_events_feed(tmp_path):
    url = f"sqlite:///{tmp_path/'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        events = client.get("/api/events?limit=10").json()
        assert len(events) == 2
        # Newest first (append-only ids are monotonic).
        assert events[0]["device"] == "CHS-12-Room"
        assert events[0]["new_value"] == "blind"
        assert events[0]["site"] == "CHS"
        assert events[1]["device"] == "BHS-Core-1"
        assert events[1]["severity"] == "crit"
        one = client.get("/api/events?limit=1").json()
        assert len(one) == 1


def test_map_api_requires_auth(tmp_path):
    url = f"sqlite:///{tmp_path/'netmon.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(_app(conf)) as client:
        for path in ("/api/sites", "/api/links", "/api/events"):
            assert client.get(path).status_code == 401, path

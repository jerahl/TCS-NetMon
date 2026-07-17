"""Registry admin API — site CRUD + XIQ import (admin, edit-gated)."""

from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config


def _conf(tmp_path, url, *, allow_edit=True, xiq=False):
    conf = tmp_path / "netmon.conf"
    lines = [
        f"[db]\nurl = {url}\n",
        "[web]\nsecure_cookies = false\n",
        "[auth]\ndev_bypass_user = admin\ndev_bypass_role = admin\n",
        f"[security]\nallow_web_edit = {'true' if allow_edit else 'false'}\n",
    ]
    if xiq:
        lines.append("[xiq]\nenabled = true\napi_token = tok\nbase_url = https://xiq.example\n")
    conf.write_text("\n".join(lines))
    return conf


def _seed(url):
    engine = db.make_engine(url)
    create_core_tables(engine)
    with engine.begin() as c:
        c.execute(text("INSERT INTO sites (name, display_name, tier, lat, lon, enabled) "
                       "VALUES ('BHS','Big High','high',33.2,-87.5,1)"))
        c.execute(text("INSERT INTO devices (name, site, device_type, enabled) "
                       "VALUES ('sw-1','BHS','switch',1)"))
    engine.dispose()


def _client(conf):
    return TestClient(create_app(config=load_config(conf), supervisor=Supervisor()))


def test_site_create_update_delete(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url)) as client:
        assert len(client.get("/api/registry/sites").json()) == 1

        r = client.post("/api/registry/sites", json={"name": "CHS", "tier": "high"})
        assert r.status_code == 200
        # duplicate name → 409
        assert client.post("/api/registry/sites", json={"name": "CHS"}).status_code == 409

        chs = [s for s in client.get("/api/registry/sites").json() if s["name"] == "CHS"][0]
        r = client.put(f"/api/registry/sites/{chs['id']}", json={"name": "CHS-Main", "tier": "high"})
        assert r.status_code == 200 and r.json()["renamed_from"] == "CHS"

        # deleting a site with devices assigned → 409 (no silent orphaning)
        bhs = [s for s in client.get("/api/registry/sites").json() if s["name"] == "BHS"][0]
        assert bhs["device_count"] == 1
        assert client.delete(f"/api/registry/sites/{bhs['id']}").status_code == 409
        # the empty renamed site deletes fine
        assert client.delete(f"/api/registry/sites/{chs['id']}").status_code == 200


def test_site_rename_repoints_devices(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url)) as client:
        bhs = client.get("/api/registry/sites").json()[0]
        client.put(f"/api/registry/sites/{bhs['id']}", json={"name": "BHS-Renamed", "tier": "high"})
    engine = db.make_engine(url)
    # the device's site join key followed the rename
    assert db.fetch_one(engine, "SELECT site FROM devices WHERE name='sw-1'")["site"] == "BHS-Renamed"


def test_edit_gate_blocks_writes(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url, allow_edit=False)) as client:
        # reads still work; writes are 403 until allow_web_edit=true
        assert client.get("/api/registry/sites").status_code == 200
        assert client.post("/api/registry/sites", json={"name": "X"}).status_code == 403


def test_list_and_assign_devices(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    engine = db.make_engine(url)
    # a second site + an unassigned AP to move around
    db.execute(engine, "INSERT INTO sites (name, display_name, tier, lat, lon, enabled) "
                       "VALUES ('CHS','C High','high',0,0,1)")
    db.execute(engine, "INSERT INTO devices (name, site, device_type, mgmt_ip, enabled) "
                       "VALUES ('ap-loose', NULL, 'ap', '10.0.0.9', 1)")

    with _client(_conf(tmp_path, url)) as client:
        all_dev = client.get("/api/registry/devices").json()
        assert len(all_dev) == 2
        # filter by the literal unassigned sentinel
        loose = client.get("/api/registry/devices?site=__none__").json()
        assert len(loose) == 1 and loose[0]["name"] == "ap-loose"

        ids = [d["id"] for d in all_dev]
        r = client.post("/api/registry/devices/assign", json={"device_ids": ids, "site": "CHS"})
        assert r.status_code == 200 and r.json()["count"] == 2

    # both devices now roll up under CHS
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM devices WHERE site='CHS'")["n"] == 2


def test_assign_unknown_site_rejected(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url)) as client:
        d = client.get("/api/registry/devices").json()[0]
        r = client.post("/api/registry/devices/assign",
                        json={"device_ids": [d["id"]], "site": "Nope"})
        assert r.status_code == 404


def test_assign_unassign_and_edit_gate(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with _client(_conf(tmp_path, url)) as client:
        d = client.get("/api/registry/devices").json()[0]
        # null site unassigns (no existence check)
        r = client.post("/api/registry/devices/assign", json={"device_ids": [d["id"]], "site": None})
        assert r.status_code == 200
    assert db.fetch_one(engine, "SELECT site FROM devices WHERE name='sw-1'")["site"] is None
    # gate off → assignment is 403
    with _client(_conf(tmp_path, url, allow_edit=False)) as client:
        d = client.get("/api/registry/devices").json()[0]
        assert client.post("/api/registry/devices/assign",
                           json={"device_ids": [d["id"]], "site": "BHS"}).status_code == 403


def test_device_create_edit_delete(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)   # site BHS + switch sw-1
    engine = db.make_engine(url)
    with _client(_conf(tmp_path, url)) as client:
        # manual add — a camera the sources don't know about, placed at BHS
        r = client.post("/api/registry/devices", json={
            "name": "cam-9", "device_type": "camera", "site": "BHS", "mgmt_ip": "10.0.0.9"})
        assert r.status_code == 200
        # unknown site → 404; duplicate name → 409
        assert client.post("/api/registry/devices",
                           json={"name": "x", "site": "Nope"}).status_code == 404
        assert client.post("/api/registry/devices",
                           json={"name": "cam-9"}).status_code == 409

        cam = [d for d in client.get("/api/registry/devices").json() if d["name"] == "cam-9"][0]
        assert cam["site"] == "BHS" and cam["device_type"] == "camera"
        assert cam["snmp_capable"] == 0    # non-switch default

        # change the type (the core ask) — camera → switch flips SNMP default on
        r = client.put(f"/api/registry/devices/{cam['id']}", json={
            "name": "cam-9", "device_type": "switch"})
        assert r.status_code == 200 and r.json()["type_changed_from"] == "camera"
        cam = [d for d in client.get("/api/registry/devices").json() if d["name"] == "cam-9"][0]
        assert cam["device_type"] == "switch" and cam["snmp_capable"] == 1

        # delete
        assert client.delete(f"/api/registry/devices/{cam['id']}").status_code == 200
        assert all(d["name"] != "cam-9" for d in client.get("/api/registry/devices").json())


def test_device_writes_are_edit_gated(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url, allow_edit=False)) as client:
        sw = client.get("/api/registry/devices").json()[0]
        assert client.post("/api/registry/devices", json={"name": "z"}).status_code == 403
        assert client.put(f"/api/registry/devices/{sw['id']}",
                          json={"name": "sw-1", "device_type": "ap"}).status_code == 403
        assert client.delete(f"/api/registry/devices/{sw['id']}").status_code == 403


def test_site_label_pos(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url)) as client:
        assert client.post("/api/registry/sites",
                           json={"name": "X", "label_pos": "bottom", "tier": "other"}).status_code == 200
        x = {s["name"]: s for s in client.get("/api/registry/sites").json()}["X"]
        assert x["label_pos"] == "bottom"
        # invalid position → 422
        assert client.put(f"/api/registry/sites/{x['id']}",
                          json={"name": "X", "label_pos": "sideways"}).status_code == 422
        # blank clears back to default (NULL → top)
        assert client.put(f"/api/registry/sites/{x['id']}",
                          json={"name": "X", "label_pos": ""}).status_code == 200
        x = {s["name"]: s for s in client.get("/api/registry/sites").json()}["X"]
        assert x["label_pos"] is None


def test_link_kind_provider_and_ports(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)   # site BHS + switch sw-1 (device_type switch)
    engine = db.make_engine(url)
    db.execute(engine, "INSERT INTO sites (name, tier, lat, lon, enabled) VALUES ('CHS','high',0,0,1)")
    swid = db.fetch_one(engine, "SELECT id FROM devices WHERE name='sw-1'")["id"]
    with _client(_conf(tmp_path, url)) as client:
        # leased link with a provider
        r = client.post("/api/registry/links",
                        json={"site_a": "BHS", "site_b": "CHS", "link_kind": "leased", "provider": "C-Spire"})
        assert r.status_code == 200
        link = client.get("/api/registry/links").json()[0]
        assert link["link_kind"] == "leased" and link["provider"] == "C-Spire"
        lid = link["id"]
        # bad kind → 422
        assert client.put(f"/api/registry/links/{lid}", json={"link_kind": "rented"}).status_code == 422

        # attach the A end to a real switch port
        r = client.put(f"/api/registry/links/{lid}",
                       json={"set_ports": True, "a_device_id": swid, "a_ifindex": 1001,
                             "b_device_id": None, "b_ifindex": None})
        assert r.status_code == 200
        link = client.get("/api/registry/links").json()[0]
        assert link["a_device_id"] == swid and link["a_ifindex"] == 1001

        # a half-specified end is rejected; a non-switch device is rejected
        assert client.put(f"/api/registry/links/{lid}",
                          json={"set_ports": True, "a_device_id": swid, "a_ifindex": None}).status_code == 422
        db.execute(engine, "INSERT INTO devices (name, device_type, enabled) VALUES ('cam','camera',1)")
        camid = db.fetch_one(engine, "SELECT id FROM devices WHERE name='cam'")["id"]
        assert client.put(f"/api/registry/links/{lid}",
                          json={"set_ports": True, "a_device_id": camid, "a_ifindex": 5}).status_code == 422

        # clear_ports detaches both ends
        assert client.put(f"/api/registry/links/{lid}", json={"clear_ports": True}).status_code == 200
        link = client.get("/api/registry/links").json()[0]
        assert link["a_device_id"] is None and link["b_device_id"] is None


def test_group_key_link_and_counts(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)   # site BHS + device sw-1 at site 'BHS'
    engine = db.make_engine(url)
    with _client(_conf(tmp_path, url)) as client:
        # groups picklist: one network group 'BHS' with 1 device, already linked
        groups = {g["name"]: g for g in client.get("/api/registry/groups").json()}
        assert groups["BHS"]["device_count"] == 1 and groups["BHS"]["linked"] is True

        # a NEW map location whose label differs, linked to the 'BHS' group
        r = client.post("/api/registry/sites",
                        json={"name": "Main Campus", "group_key": "BHS", "tier": "hub"})
        assert r.status_code == 200
        rows = {s["name"]: s for s in client.get("/api/registry/sites").json()}
        mc = rows["Main Campus"]
        # device_count + join_key follow the linked group, not the label
        assert mc["group_key"] == "BHS" and mc["join_key"] == "BHS" and mc["device_count"] == 1
        # the label-only site 'BHS' still counts by its name
        assert rows["BHS"]["join_key"] == "BHS"

        # unlink (blank group_key) → joins by name again, count drops to 0
        r = client.put(f"/api/registry/sites/{mc['id']}",
                       json={"name": "Main Campus", "group_key": "", "tier": "hub"})
        assert r.status_code == 200
        mc = {s["name"]: s for s in client.get("/api/registry/sites").json()}["Main Campus"]
        assert mc["group_key"] is None and mc["device_count"] == 0


def test_linked_site_rename_does_not_touch_devices(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    engine = db.make_engine(url)
    # link a site to group 'BHS', then rename the label — devices must NOT move
    with _client(_conf(tmp_path, url)) as client:
        client.post("/api/registry/sites", json={"name": "Campus", "group_key": "BHS", "tier": "hub"})
        cid = {s["name"]: s for s in client.get("/api/registry/sites").json()}["Campus"]["id"]
        client.put(f"/api/registry/sites/{cid}", json={"name": "Campus 2", "group_key": "BHS", "tier": "hub"})
    assert db.fetch_one(engine, "SELECT site FROM devices WHERE name='sw-1'")["site"] == "BHS"


def test_assign_uses_group_key(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    engine = db.make_engine(url)
    db.execute(engine, "INSERT INTO devices (name, device_type, enabled) VALUES ('ap-x','ap',1)")
    with _client(_conf(tmp_path, url)) as client:
        # a map site linked to network group 'CORE'
        client.post("/api/registry/sites", json={"name": "HQ", "group_key": "CORE", "tier": "hub"})
        dev = [d for d in client.get("/api/registry/devices").json() if d["name"] == "ap-x"][0]
        r = client.post("/api/registry/devices/assign", json={"device_ids": [dev["id"]], "site": "HQ"})
        # device is written with the group_key, not the label
        assert r.status_code == 200 and r.json()["site"] == "CORE"
    assert db.fetch_one(engine, "SELECT site FROM devices WHERE name='ap-x'")["site"] == "CORE"


def test_move_site(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    engine = db.make_engine(url)
    sid = db.fetch_one(engine, "SELECT id FROM sites WHERE name='BHS'")["id"]
    with _client(_conf(tmp_path, url)) as client:
        r = client.post(f"/api/registry/sites/{sid}/location", json={"lat": 33.25, "lon": -87.55})
        assert r.status_code == 200 and r.json()["lat"] == 33.25
        assert client.post("/api/registry/sites/9999/location",
                           json={"lat": 1, "lon": 1}).status_code == 404
        assert client.post(f"/api/registry/sites/{sid}/location",
                           json={"lat": 999, "lon": 0}).status_code == 422
    got = db.fetch_one(engine, "SELECT lat, lon FROM sites WHERE id=:id", {"id": sid})
    assert float(got["lat"]) == 33.25 and float(got["lon"]) == -87.55


def _two_sites(engine):
    db.execute(engine, "INSERT INTO sites (name, display_name, tier, lat, lon, enabled) "
                       "VALUES ('CHS','C High','high',33.3,-87.6,1)")


def test_fiber_link_crud(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    engine = db.make_engine(url)
    _two_sites(engine)
    with _client(_conf(tmp_path, url)) as client:
        # create (endpoints normalised to sorted-name order)
        r = client.post("/api/registry/links", json={"site_a": "CHS", "site_b": "BHS", "capacity_gbps": 10})
        assert r.status_code == 200 and r.json()["site_a"] == "BHS" and r.json()["site_b"] == "CHS"
        # duplicate (reversed) → 409
        assert client.post("/api/registry/links",
                           json={"site_a": "BHS", "site_b": "CHS"}).status_code == 409
        # unknown site → 404; same-site → 422
        assert client.post("/api/registry/links",
                           json={"site_a": "BHS", "site_b": "NOPE"}).status_code == 404
        assert client.post("/api/registry/links",
                           json={"site_a": "BHS", "site_b": "BHS"}).status_code == 422

        links = client.get("/api/registry/links").json()
        assert len(links) == 1 and links[0]["capacity_gbps"] == 10.0 and links[0]["path"] is None
        lid = links[0]["id"]

        # edit the waypoint path + capacity
        r = client.put(f"/api/registry/links/{lid}",
                       json={"path": [[33.2, -87.5], [33.25, -87.55], [33.3, -87.6]], "capacity_gbps": 40})
        assert r.status_code == 200
        # bad path shape → 422
        assert client.put(f"/api/registry/links/{lid}",
                          json={"path": [[33.2]]}).status_code == 422
        # clear_path reverts to straight (site-tracking) line
        assert client.put(f"/api/registry/links/{lid}", json={"clear_path": True}).status_code == 200
        row = client.get("/api/registry/links").json()[0]
        assert row["path"] is None and row["capacity_gbps"] == 40.0

        # delete
        assert client.delete(f"/api/registry/links/{lid}").status_code == 200
        assert client.get("/api/registry/links").json() == []
        assert client.delete(f"/api/registry/links/{lid}").status_code == 404


def test_map_edits_require_gate(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    engine = db.make_engine(url)
    sid = db.fetch_one(engine, "SELECT id FROM sites WHERE name='BHS'")["id"]
    with _client(_conf(tmp_path, url, allow_edit=False)) as client:
        assert client.get("/api/registry/links").status_code == 200       # read ok
        assert client.post(f"/api/registry/sites/{sid}/location",
                           json={"lat": 1, "lon": 1}).status_code == 403
        assert client.post("/api/registry/links",
                           json={"site_a": "BHS", "site_b": "CHS"}).status_code == 403


def test_enum_map_edit_and_reset(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url)) as client:
        rows = client.get("/api/registry/enums").json()
        stack = [r for r in rows if r["name"] == "stack_status"][0]
        assert stack["default"]["1"] == "up" and stack["overridden"] is False

        # override one label; effective reflects it, default is untouched
        r = client.put("/api/registry/enums/stack_status",
                       json={"entries": {"0": "unknown", "1": "online", "2": "down", "3": "mismatch"}})
        assert r.status_code == 200 and r.json()["overridden"] is True
        assert r.json()["effective"]["1"] == "online"

        eff = [x for x in client.get("/api/registry/enums").json() if x["name"] == "stack_status"][0]
        assert eff["effective"]["1"] == "online" and eff["default"]["1"] == "up"

        # reset drops the override
        assert client.delete("/api/registry/enums/stack_status").json()["overridden"] is False
        back = [x for x in client.get("/api/registry/enums").json() if x["name"] == "stack_status"][0]
        assert back["effective"]["1"] == "up"


def test_enum_map_validation_and_gate(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url)) as client:
        assert client.put("/api/registry/enums/nope", json={"entries": {"1": "x"}}).status_code == 404
        # non-integer code and empty label are rejected
        assert client.put("/api/registry/enums/stack_status",
                          json={"entries": {"x": "up"}}).status_code == 422
        assert client.put("/api/registry/enums/stack_status",
                          json={"entries": {"1": "  "}}).status_code == 422
    # edit gate off → write is 403, read still works
    with _client(_conf(tmp_path, url, allow_edit=False)) as client:
        assert client.get("/api/registry/enums").status_code == 200
        assert client.put("/api/registry/enums/stack_status",
                          json={"entries": {"1": "up"}}).status_code == 403


def test_import_xiq_dry_run(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)

    async def fake_get_devices(self, view="BASIC"):
        return [
            {"id": "900001", "hostname": "BHS-Core-9", "device_function": "SWITCH", "ip_address": "192.0.2.9"},
            {"id": "900002", "hostname": "BHS-AP-9", "device_function": "AP", "ip_address": "192.0.2.19"},
        ]
    monkeypatch.setattr("netmon.collectors.xiq_client.XiqClient.get_devices", fake_get_devices)

    with _client(_conf(tmp_path, url, xiq=True)) as client:
        r = client.post("/api/registry/import-xiq", json={"dry_run": True}).json()
        assert r["dry_run"] is True and r["fetched"] == 2 and r["would_add"] == 2
        assert {d["name"] for d in r["new_devices"]} == {"BHS-Core-9", "BHS-AP-9"}
    # dry-run wrote nothing
    engine = db.make_engine(url)
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM devices WHERE xiq_device_id IS NOT NULL")["n"] == 0


def test_import_xiq_writes_and_preserves_site(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    # Pre-existing device carries a site; the import must preserve it (D9).
    engine = db.make_engine(url)
    db.execute(engine, "UPDATE devices SET xiq_device_id='900001', site='BHS' WHERE name='sw-1'")

    async def fake_get_devices(self, view="BASIC"):
        return [{"id": "900001", "hostname": "sw-1", "device_function": "SWITCH"},
                {"id": "900002", "hostname": "new-ap", "device_function": "AP"}]
    monkeypatch.setattr("netmon.collectors.xiq_client.XiqClient.get_devices", fake_get_devices)

    with _client(_conf(tmp_path, url, xiq=True)) as client:
        r = client.post("/api/registry/import-xiq", json={"dry_run": False}).json()
        assert r["added"] == 1 and r["updated"] == 1
    assert db.fetch_one(engine, "SELECT site FROM devices WHERE xiq_device_id='900001'")["site"] == "BHS"
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM devices")["n"] == 2


def test_import_xiq_requires_source_enabled(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url, xiq=False)) as client:
        assert client.post("/api/registry/import-xiq", json={"dry_run": True}).status_code == 400


def test_registry_requires_admin(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)  # SAML, no session → 401
    with TestClient(create_app(config=load_config(conf), supervisor=Supervisor())) as client:
        assert client.get("/api/registry/sites").status_code == 401

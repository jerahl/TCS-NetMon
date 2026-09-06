"""Surveillance + VoIP API — DB-only (spec 10 §6, Phase 10.4)."""

from datetime import datetime, timezone

from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.snapshots import write_snapshot
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config


def _seed(url):
    engine = db.make_engine(url)
    create_core_tables(engine)
    now = datetime.now(timezone.utc)
    with engine.begin() as c:
        c.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled) VALUES "
            "('NVR-1','Central','recording_server',1),"      # id 1
            "('CAM-Hall','BHS','camera',1),"                 # id 2
            "('CAM-Gym','BHS','camera',1),"                  # id 3
            "('BHS-Core-1','BHS','switch',1),"               # id 4
            "('SIP-Trunk','Central','trunk',1)"))            # id 5
        c.execute(text(
            "INSERT INTO device_state (device_id, dimension, value, severity, source, updated_at) VALUES "
            "(1,'source_status','up','ok','milestone',:t),"
            "(2,'recording','up','ok','milestone',:t),"
            "(3,'recording','down','crit','milestone',:t),"
            "(5,'trunk','up','ok','threecx',:t)"), {"t": now})
        c.execute(text(
            "INSERT INTO recording_servers (device_id, hostname, role, version, chans_total, "
            "chans_recording, storage_used_gb, storage_total_gb, retention_days, updated_at) "
            "VALUES (1,'nvr-1.tcs','recording','23.2',40,38,4200,8000,30,:t)"), {"t": now})
        c.execute(text(
            "INSERT INTO cameras (device_id, model, resolution, fps_target, mac, "
            "recording_server_device_id, enabled, updated_at) VALUES "
            "(2,'AXIS P3255','1920x1080',15,'00:40:8c:aa:bb:cc',1,1,:t),"
            "(3,'AXIS M3067','2688x1520',20,'00:40:8c:dd:ee:ff',1,1,:t)"), {"t": now})
        # FDB entry so the camera→switch-port join lights up for CAM-Hall.
        c.execute(text(
            "INSERT INTO switch_ports (device_id, ifindex, name, oper_state, updated_at) "
            "VALUES (4,1042,'1:42','up',:t)"), {"t": now})
        c.execute(text(
            "INSERT INTO fdb_entries (device_id, mac, ifindex, updated_at) "
            "VALUES (4,'00:40:8c:aa:bb:cc',1042,:t)"), {"t": now})
        c.execute(text(
            "INSERT INTO trunks (device_id, name, provider_host, did, reg_status, ch_total, ch_in_use, updated_at) "
            "VALUES (5,'SIP-A','sip.provider.net','2055550100','registered',30,4,:t)"), {"t": now})
        c.execute(text(
            "INSERT INTO extensions (ext, name, site, registered, dnd, updated_at) VALUES "
            "('1001','Ada Byte','BHS',1,0,:t),('1002','Front Desk','BHS',0,1,:t)"), {"t": now})
    write_snapshot(engine, "milestone.overview", {"cameras": 2, "recording_servers": 1}, "milestone")
    write_snapshot(engine, "threecx.system", {"Version": "20.0.5", "CallsActive": 4}, "threecx")
    engine.dispose()


def _client(tmp_path, url):
    return TestClient(create_app(config=load_config(write_config(tmp_path, db_url=url)),
                                 supervisor=Supervisor()))


def test_surveillance_summary_and_cameras(tmp_path):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        s = client.get("/api/surveillance/summary").json()
        assert s["cameras_total"] == 2
        assert s["cameras_recording"] == 1 and s["cameras_not_recording"] == 1
        assert s["servers_total"] == 1 and s["servers_up"] == 1
        assert s["storage_total_gb"] == 8000
        assert s["overview"]["payload"]["cameras"] == 2

        cams = client.get("/api/surveillance/cameras").json()
        assert len(cams) == 2
        hall = [c for c in cams if c["name"] == "CAM-Hall"][0]
        assert hall["recording_state"] == "up" and hall["recording_server"] == "NVR-1"


def test_camera_detail_switch_port_join(tmp_path):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        d = client.get("/api/surveillance/cameras/2").json()
        # The marquee FDB join: camera MAC → switch + port.
        assert d["switch_port"]["switch_name"] == "BHS-Core-1"
        assert d["switch_port"]["port"] == "1:42"
        # CAM-Gym's MAC isn't in any FDB table → no link, honestly null.
        d2 = client.get("/api/surveillance/cameras/3").json()
        assert d2["switch_port"] is None
        assert client.get("/api/surveillance/cameras/999").status_code == 404


def test_surveillance_servers_and_storage(tmp_path):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        srv = client.get("/api/surveillance/servers").json()
        assert srv[0]["hostname"] == "nvr-1.tcs" and srv[0]["status"] == "up"
        st = client.get("/api/surveillance/storage").json()
        assert st[0]["storage_total_gb"] == 8000 and st[0]["retention_days"] == 30


def test_voip_summary_trunks_extensions(tmp_path):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        s = client.get("/api/voip/summary").json()
        assert s["trunks_total"] == 1 and s["trunks_registered"] == 1
        assert s["channels_in_use"] == 4 and s["channels_total"] == 30
        assert s["extensions_total"] == 2 and s["extensions_registered"] == 1
        assert s["system"]["payload"]["Version"] == "20.0.5"

        trunks = client.get("/api/voip/trunks").json()
        assert trunks[0]["name"] == "SIP-A" and trunks[0]["trunk_state"] == "up"

        exts = client.get("/api/voip/extensions").json()
        assert len(exts) == 2
        assert len(client.get("/api/voip/extensions?registered=true").json()) == 1
        assert len(client.get("/api/voip/extensions?q=Ada").json()) == 1


def test_surveillance_voip_require_auth(tmp_path):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(create_app(config=load_config(conf), supervisor=Supervisor())) as client:
        assert client.get("/api/surveillance/summary").status_code == 401
        assert client.get("/api/voip/trunks").status_code == 401


def test_summary_never_reports_zero_used_storage_when_it_is_unknown(tmp_path):
    """The Config API exposes configured size but not consumed space.

    Coercing that unknown to 0 let the UI divide a real 1.8 PB total by a
    fabricated zero and render "0% used" across the estate — a confident wrong
    number where an honest gap belongs (§4.5). Consumed space is the WinRM
    dependency (OpenProject #111).
    """
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        c.execute(text("UPDATE recording_servers SET storage_total_gb = 120600, "
                       "storage_used_gb = NULL, retention_days = 61"))
    engine.dispose()

    with _client(tmp_path, url) as client:
        s = client.get("/api/surveillance/summary").json()
        assert s["storage_total_gb"] == 120600      # configured is real
        assert s["storage_used_gb"] is None         # and must stay unknown
        assert s["storage_used_known"] is False     # so the UI can say why


def test_summary_reports_used_storage_when_it_is_known(tmp_path):
    """The flag must not hard-code "unknown" — a real reading still gets through."""
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        c.execute(text("UPDATE recording_servers SET storage_total_gb = 100, "
                       "storage_used_gb = 40"))
    engine.dispose()

    with _client(tmp_path, url) as client:
        s = client.get("/api/surveillance/summary").json()
        assert s["storage_used_gb"] == 40 and s["storage_used_known"] is True


def test_camera_status_filter_narrows_by_reachability_tier(tmp_path):
    """"Show me what's down" has to mean any tier where something says down.

    Filtering to `down_confirmed` alone would hide the cameras Milestone cannot
    reach but the network can — a platform-side fault, still a fault, and the
    one with a different remedy (spec 19 §13).
    """
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        cams = [r["device_id"] for r in db.fetch_all(engine, "SELECT device_id FROM cameras")]
        tiers = ["down_confirmed", "down_source_only"]
        for did, tier in zip(cams, tiers):
            c.execute(text("INSERT INTO device_state (device_id,dimension,value,severity,"
                           "source,updated_at) VALUES (:d,'reachability',:v,'crit','derived',:t)"),
                      {"d": did, "v": tier, "t": "2026-09-06 00:00:00"})
    engine.dispose()

    with _client(tmp_path, url) as client:
        assert len(client.get("/api/surveillance/cameras?status=down").json()) == 2
        assert len(client.get("/api/surveillance/cameras?status=down_confirmed").json()) == 1
        assert len(client.get("/api/surveillance/cameras?status=down_source_only").json()) == 1
        assert client.get("/api/surveillance/cameras?status=up").json() == []


def test_camera_rows_carry_both_probe_verdicts(tmp_path):
    """The row needs the source verdict *and* the derived tier: "down" alone
    cannot distinguish a dead camera from one the platform cannot reach."""
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        rows = client.get("/api/surveillance/cameras").json()
        assert rows
        assert "source_status" in rows[0] and "reachability" in rows[0]


def test_blind_is_counted_apart_from_down(tmp_path):
    """`blind` is the source saying it cannot tell. Folding it into `down`
    would report an outage NetMon has no evidence for."""
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        did = db.fetch_one(engine, "SELECT device_id FROM cameras")["device_id"]
        c.execute(text("INSERT INTO device_state (device_id,dimension,value,severity,"
                       "source,updated_at) VALUES (:d,'source_status','blind','warn','milestone',:t)"),
                  {"d": did, "t": "2026-09-06 00:00:00"})
    engine.dispose()

    with _client(tmp_path, url) as client:
        counts = client.get("/api/surveillance/summary").json()["cameras_by_status"]
        assert counts["blind"] == 1
        assert counts["down"] == 0
        assert len(client.get("/api/surveillance/cameras?status=blind").json()) == 1


def test_camera_sites_counts_each_failure_shape_separately(tmp_path):
    """The by-school grid must not collapse the tiers into one "down".

    A school with cameras Milestone cannot reach has a different problem from
    one with genuinely dead cameras, and the grid is where an operator decides
    which school to drive to — so the roll-up keeps them apart (spec 19 §13).
    """
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        c.execute(text("INSERT INTO device_state (device_id,dimension,value,severity,"
                       "source,updated_at) VALUES "
                       "(2,'reachability','down_confirmed','crit','derived',:t),"
                       "(3,'reachability','down_source_only','warn','derived',:t)"),
                  {"t": "2026-09-06 00:00:00"})
    engine.dispose()

    with _client(tmp_path, url) as client:
        rows = {r["site"]: r for r in client.get("/api/surveillance/sites").json()}
        bhs = rows["BHS"]
        assert bhs["total"] == 2
        assert bhs["down_confirmed"] == 1
        assert bhs["down_source_only"] == 1
        # Recording state is its own axis and is reported alongside, not merged:
        # a camera can be reachable and not recording, or the reverse.
        assert bhs["recording"] == 1
        # Only cameras — the switch and the recording server at these sites must
        # not inflate the count the grid renders.
        assert "Central" not in rows


def test_camera_sites_excludes_disabled_devices(tmp_path):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        c.execute(text("UPDATE devices SET enabled = 0 WHERE id = 3"))
    engine.dispose()
    with _client(tmp_path, url) as client:
        rows = {r["site"]: r for r in client.get("/api/surveillance/sites").json()}
        assert rows["BHS"]["total"] == 1


def test_camera_detail_carries_probe_state_and_siblings(tmp_path):
    """The detail page shows which probe said what, plus the other cameras on
    the same physical device — they share an interface, so a fault on one is a
    fault on all, and that is only visible if the page says they exist."""
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        c.execute(text("UPDATE cameras SET hardware_id = 'hw-1' WHERE device_id IN (2,3)"))
        c.execute(text("INSERT INTO device_state (device_id,dimension,value,severity,"
                       "source,updated_at) VALUES "
                       "(2,'source_status','up','ok','milestone-ess',:t),"
                       "(2,'ping','down','warn','poller',:t),"
                       "(2,'reachability','down_network_only','warn','derived',:t)"),
                  {"t": "2026-09-06 00:00:00"})
    engine.dispose()

    with _client(tmp_path, url) as client:
        d = client.get("/api/surveillance/cameras/2").json()
        # Both verdicts survive to the page, unmerged.
        assert d["state"]["source_status"]["value"] == "up"
        assert d["state"]["ping"]["value"] == "down"
        assert d["state"]["reachability"]["value"] == "down_network_only"
        assert [s["device_id"] for s in d["siblings"]] == [3]


def test_camera_detail_resolves_port_through_packetfence_when_milestone_has_no_mac(tmp_path):
    """The fallback for cameras the Milestone identity backfill has not reached.

    Milestone does expose a MAC (migration 025), but it arrives a batch at a
    time, so at any moment some cameras still have none. PacketFence knows
    IP -> MAC and covers those; without the fallback their port pane would go
    blank until the backfill caught up.
    """
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        # CAM-Gym: no MAC of its own, but an IP PacketFence has seen.
        c.execute(text("UPDATE cameras SET mac = NULL, ip = '10.32.18.7' WHERE device_id = 3"))
        c.execute(text("INSERT INTO pf_nodes (mac, ip, computername, role, reg_status, "
                       "last_switch, last_port, online, updated_at) VALUES "
                       "('00:40:8c:99:88:77','10.32.18.7','cam-gym','cameras','reg',"
                       "'10.0.0.9','1:43',1,:t)"), {"t": "2026-09-06 00:00:00"})
        # is_sfp must be an explicit 0. NULL means "not confirmed as copper",
        # which the resolver deliberately treats as not safe to power-cycle.
        c.execute(text("INSERT INTO switch_ports (device_id, ifindex, name, oper_state, "
                       "poe_delivering, is_sfp, updated_at) VALUES "
                       "(4,1043,'1:43','up',1,0,:t)"), {"t": "2026-09-06 00:00:00"})
        c.execute(text("INSERT INTO fdb_entries (device_id, mac, ifindex, updated_at) "
                       "VALUES (4,'00:40:8c:99:88:77',1043,:t)"), {"t": "2026-09-06 00:00:00"})
    engine.dispose()

    with _client(tmp_path, url) as client:
        d = client.get("/api/surveillance/cameras/3").json()
        assert d["pf"]["mac"] == "00:40:8c:99:88:77"
        sp = d["switch_port"]
        assert sp["switch_name"] == "BHS-Core-1" and sp["port"] == "1:43"
        # PacketFence independently recorded the same port, which is what makes
        # this port safe to power-cycle rather than merely the best guess.
        assert sp["pf_agrees"] is True
        assert sp["poe_cycle_safe"] is True


def test_camera_detail_without_an_address_offers_no_port_to_cycle(tmp_path):
    """No address means no MAC means no port. The pane must say so rather than
    fall back to a guess — bouncing an unconfirmed port risks an uplink."""
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        c.execute(text("UPDATE cameras SET mac = NULL, ip = NULL WHERE device_id = 3"))
    engine.dispose()
    with _client(tmp_path, url) as client:
        d = client.get("/api/surveillance/cameras/3").json()
        assert d["pf"] is None
        assert d["switch_port"] is None


def test_camera_port_on_an_unconfirmed_link_is_not_offered_for_poe_cycle(tmp_path):
    """The gate on the destructive action, exercised on the camera path.

    A MAC is learned on every port in its path, so the resolver picks the one
    with the fewest MACs and then wants corroboration: PoE-delivering copper.
    Without it the port is still shown — hiding it would leave the operator
    guessing — but Cycle PoE must not be offered, because an unconfirmed pick
    can be a 10 G uplink carrying a whole wiring closet.
    """
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        # Fibre, no PoE — the shape of an uplink, not an access port.
        c.execute(text("UPDATE switch_ports SET is_sfp = 1, poe_delivering = 0 "
                       "WHERE device_id = 4 AND ifindex = 1042"))
    engine.dispose()
    with _client(tmp_path, url) as client:
        sp = client.get("/api/surveillance/cameras/2").json()["switch_port"]
        assert sp is not None and sp["port"] == "1:42"      # still shown
        assert sp["poe_cycle_safe"] is False                # but not actionable
        assert "uplink" in sp["why"]

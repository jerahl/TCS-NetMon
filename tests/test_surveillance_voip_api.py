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
        assert d["switch_port"]["switch"] == "BHS-Core-1"
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

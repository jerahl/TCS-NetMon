"""NAC API — Phase 10.3: served from pf_nodes + snapshot_cache (DB-only)."""

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
            "INSERT INTO pf_nodes (mac, computername, owner, role, reg_status, vlan, "
            "last_switch, last_port, conn_method, online, last_seen, updated_at) VALUES "
            "('aa:bb:cc:00:00:11','student-cb','student1@example.org','Student','reg','100',"
            " 'BHS-Core-1','1001','Wireless-802.11-EAP',1,:t,:t),"
            "('aa:bb:cc:00:00:22','rogue-thing','default',NULL,'pending',NULL,"
            " NULL,NULL,NULL,0,:t,:t),"
            "('aa:bb:cc:00:00:33','printer-1','svc','Printer','reg',NULL,"
            " 'BHS-Core-1','1002','Ethernet-NoEAP',1,:t,:t)"), {"t": now})
    write_snapshot(engine, "pf.rejects", [{"mac": "aa:bb:cc:00:00:44", "reason": "eap"}], "packetfence")
    write_snapshot(engine, "pf.cluster", {"items": [{"host": "pf-1"}]}, "packetfence")
    write_snapshot(engine, "pf.violations", {"items": [{"id": "1100013", "desc": "Rogue DHCP"}]}, "packetfence")
    engine.dispose()


def _client(tmp_path, url):
    return TestClient(create_app(config=load_config(write_config(tmp_path, db_url=url)),
                                 supervisor=Supervisor()))


def test_nac_summary_from_db(tmp_path):
    url = f"sqlite:///{tmp_path/'n.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        s = client.get("/api/nac").json()
        assert s["enabled"] is True
        assert s["total"] == 3 and s["registered"] == 2 and s["pending"] == 1
        assert s["online"] == 2
        assert s["by_role"][0]["n"] == 1
        assert s["rejects"]["payload"][0]["reason"] == "eap"
        assert s["updated_at"]


def test_nac_nodes_filters(tmp_path):
    url = f"sqlite:///{tmp_path/'n.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        assert len(client.get("/api/nac/nodes").json()) == 3
        assert len(client.get("/api/nac/nodes?q=student").json()) == 1
        # MAC search works in any separator format (spec 10.5 follow-up).
        assert len(client.get("/api/nac/nodes?q=aabbcc000011").json()) == 1
        assert len(client.get("/api/nac/nodes?q=AA-BB-CC-00-00-11").json()) == 1
        assert len(client.get("/api/nac/nodes?q=aabbcc").json()) == 3   # shared OUI
        assert len(client.get("/api/nac/nodes?status=pending").json()) == 1
        assert len(client.get("/api/nac/nodes?role=Printer").json()) == 1
        assert len(client.get("/api/nac/nodes?online=true").json()) == 2


def test_nac_sessions_quarantine_policies_cluster(tmp_path):
    url = f"sqlite:///{tmp_path/'n.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        sess = client.get("/api/nac/sessions").json()
        assert len(sess["sessions"]) == 2
        assert {a["conn_method"] for a in sess["auth_split"]} == {"Wireless-802.11-EAP", "Ethernet-NoEAP"}

        q = client.get("/api/nac/quarantine").json()
        assert [n["mac"] for n in q["nodes"]] == ["aa:bb:cc:00:00:22"]
        assert q["violations"]["payload"]["items"][0]["desc"] == "Rogue DHCP"

        pol = client.get("/api/nac/policies").json()
        assert pol["violations"]["ok"] is True and pol["sources"] is None  # never written

        cl = client.get("/api/nac/cluster").json()
        assert cl["cluster"]["payload"]["items"][0]["host"] == "pf-1"


def test_nac_requires_auth(tmp_path):
    url = f"sqlite:///{tmp_path/'n.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(create_app(config=load_config(conf), supervisor=Supervisor())) as client:
        assert client.get("/api/nac").status_code == 401
        assert client.get("/api/nac/nodes").status_code == 401

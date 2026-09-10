"""⌘K search API (spec 10 §6 / phase 10.5): devices + pf_nodes + fdb_entries."""

from datetime import datetime, timezone

from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config


def _seed(url):
    engine = db.make_engine(url)
    create_core_tables(engine)
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, mgmt_ip, enabled) VALUES "
            "('BHS-Core-1','BHS','switch','192.0.2.2',1),"
            "('BHS-56-AP','BHS','ap','192.0.2.11',1)"
        ))
        conn.execute(text(
            "INSERT INTO pf_nodes (mac, computername, ip, dot1x_user, role, reg_status, "
            "last_switch, last_port, updated_at) VALUES "
            "('aa:bb:cc:11:22:33', 'LAPTOP-JDOE', '10.1.2.3', 'jdoe', 'staff', 'reg', "
            " 'BHS-Core-1', '1:12', :now)"), {"now": now})
        conn.execute(text(
            "INSERT INTO fdb_entries (device_id, mac, vlan_id, ifindex, updated_at) VALUES "
            "(1, 'aa:bb:cc:11:22:33', 100, 12, :now)"), {"now": now})
    engine.dispose()


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def test_search_device_by_name_and_ip(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        data = client.get("/api/search?q=Core").json()
        assert [h["title"] for h in data["devices"]] == ["BHS-Core-1"]
        assert data["devices"][0]["href"] == "#/switches/1"

        by_ip = client.get("/api/search?q=192.0.2.11").json()
        assert by_ip["devices"][0]["title"] == "BHS-56-AP"
        assert by_ip["devices"][0]["href"] == "#/ap/2"


def test_search_endpoint_by_user_and_hostname(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        by_user = client.get("/api/search?q=jdoe").json()
        assert len(by_user["endpoints"]) == 1
        hit = by_user["endpoints"][0]
        assert hit["title"] == "LAPTOP-JDOE"
        assert "aa:bb:cc:11:22:33" in hit["subtitle"]
        # Pre-filtered to the node's MAC (URL-encoded colons).
        assert hit["href"] == "#/nac?q=aa%3Abb%3Acc%3A11%3A22%3A33"


def test_search_mac_hits_endpoint_and_fdb(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        data = client.get("/api/search?q=aa:bb:cc:11").json()
        # MAC matches both the NAC node and the FDB entry.
        assert len(data["endpoints"]) == 1
        assert len(data["macs"]) == 1
        mac = data["macs"][0]
        # Pre-filtered to the MAC on that switch's FDB tab.
        assert mac["href"] == "#/switches/1?mac=aa%3Abb%3Acc%3A11%3A22%3A33"
        assert "on BHS-Core-1" in mac["subtitle"]
        assert data["total"] == 2


def test_search_mac_any_separator_format(tmp_path):
    """MAC search matches regardless of separator style (spec 10.5 follow-up):
    stored 'aa:bb:cc:11:22:33' is found by colon, dash, or no-separator input."""
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        for form in ("aabbcc112233",        # no separators, full
                     "AABBCC112233",         # uppercase
                     "aa-bb-cc-11-22-33",    # dashes
                     "aabbcc",               # no-separator fragment
                     "AA:BB:CC"):            # colon fragment, uppercase
            data = client.get(f"/api/search?q={form}").json()
            assert len(data["endpoints"]) == 1, form
            assert data["endpoints"][0]["subtitle"].startswith("aa:bb:cc:11:22:33"), form
            assert len(data["macs"]) == 1, form


def test_search_text_query_not_misread_as_mac(tmp_path):
    """A hostname/IP query must not spuriously match the FDB by MAC."""
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        # 'Core' has non-hex letters → not a MAC fragment → no FDB hits.
        assert client.get("/api/search?q=Core").json()["macs"] == []
        # An IP keeps its dots → not all-hex → searched as text, not MAC.
        assert client.get("/api/search?q=192.0.2.11").json()["macs"] == []


def test_search_short_query_is_empty(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        data = client.get("/api/search?q=a").json()
        assert data["total"] == 0
        assert data["devices"] == []


def test_search_requires_auth(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(_app(conf)) as client:
        assert client.get("/api/search?q=Core").status_code == 401


# ── the FDB scan that could never match (2026-09-10) ──────────────────────
#
# `fdb_entries` holds nothing but MACs. A query carrying any non-hex character
# cannot match one, so scanning 82,000 rows to prove it was ~40% of the cost of
# every search for a device or site name — which is what the palette is mostly
# used for. These pin the skip rather than the timing.

def _count_queries(monkeypatch):
    """Record every SQL statement the search path issues."""
    import netmon.api.search as search_mod

    seen = []
    real = search_mod.db.fetch_all

    def spy(engine, sql, params=None):
        seen.append(" ".join(sql.split()))
        return real(engine, sql, params)

    monkeypatch.setattr(search_mod.db, "fetch_all", spy)
    return seen


def _tables(seen):
    return {t for t in ("devices", "pf_nodes", "fdb_entries")
            for s in seen if f"FROM {t}" in s or f" {t} " in s}


def test_a_name_search_does_not_touch_the_fdb(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        seen = _count_queries(monkeypatch)
        body = client.get("/api/search?q=BHS-Core").json()
    assert body["devices"], "the device hit should still be found"
    assert body["macs"] == []
    assert not any("fdb_entries" in s for s in seen), \
        "scanned the FDB for a query that cannot be a MAC"


def test_a_subnet_search_does_not_touch_the_fdb(tmp_path, monkeypatch):
    """`10.92.18` strips to `109218`, which is hex-shaped — the case that made
    every subnet search scan every MAC in the estate."""
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        seen = _count_queries(monkeypatch)
        client.get("/api/search?q=10.1.2")
    assert not any("fdb_entries" in s for s in seen)


def test_a_mac_search_still_reaches_the_fdb(tmp_path, monkeypatch):
    """The skip must not cost the feature: a real MAC still finds its port."""
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        seen = _count_queries(monkeypatch)
        body = client.get("/api/search?q=aabbcc112233").json()
    assert any("fdb_entries" in s for s in seen)
    assert [h["title"] for h in body["macs"]] == ["aa:bb:cc:11:22:33"]


def test_a_separator_style_mac_still_finds_its_port(tmp_path):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        body = client.get("/api/search?q=AA-BB-CC-11-22-33").json()
    assert [h["title"] for h in body["macs"]] == ["aa:bb:cc:11:22:33"]
    assert body["macs"][0]["subtitle"].startswith("on BHS-Core-1")

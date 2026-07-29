"""Operator write actions (spec 11 D4).

The gates matter more than the happy paths here: these are the only non-GET
calls NetMon makes to a source, so the tests are weighted towards proving that
nothing reaches a source platform unless it should.
"""

import json

from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config


def _db_url(tmp_path) -> str:
    """write_config points the app at tmp_path/netmon.db — seed and read that."""
    return f"sqlite:///{tmp_path / 'netmon.db'}"


def _seed(url: str) -> None:
    engine = db.make_engine(url)
    create_core_tables(engine)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled, xiq_device_id) "
            "VALUES ('BHS-AP-1','BHS','ap','192.0.2.11',0,1,'12345'),"
            "       ('BHS-Core-1','BHS','switch','192.0.2.2',1,1,NULL),"
            "       ('BHS-AP-NOXIQ','BHS','ap','192.0.2.12',0,1,NULL),"
            "       ('BHS-OLD','BHS','switch','192.0.2.9',1,0,NULL)"
        ))
        conn.execute(text(
            "INSERT INTO switch_ports (device_id, ifindex, name, updated_at) "
            "VALUES (2, 12, '1:12', CURRENT_TIMESTAMP)"
        ))
    engine.dispose()


def _conf(tmp_path, *, actions_extra: str = "", role: str = "admin"):
    """Dev-bypass config with an [actions] section and PF/rConfig/XIQ present."""
    extra = (
        "[actions]\n" + (actions_extra or "") + "\n"
        "[packetfence]\nenabled = true\nurl = https://pf.example.invalid\nuser = u\npass = p\n\n"
        "[rconfig]\nenabled = true\nurl = https://rc.example.invalid\napi_token = t\n\n"
        "[xiq]\nenabled = true\napi_token = tok\n"
    )
    conf = write_config(tmp_path, extra_sections=extra)
    if role != "admin":
        # write_config hardcodes dev_bypass_role = admin; rewrite it in place
        # rather than pass a duplicate option (configparser is strict).
        text_ = conf.read_text().replace("dev_bypass_role = admin",
                                         f"dev_bypass_role = {role}")
        conf.write_text(text_)
    return conf


def _app(conf_path):
    return create_app(config=load_config(conf_path), supervisor=Supervisor())


def _audit(url):
    engine = db.make_engine(url)
    rows = db.fetch_all(engine, "SELECT * FROM action_audit ORDER BY id")
    engine.dispose()
    return rows


# ───────────────────────── advertisement ─────────────────────────

def test_actions_list_advertises_all_four(tmp_path):
    url = _db_url(tmp_path)
    _seed(url)
    with TestClient(_app(_conf(tmp_path))) as c:
        r = c.get("/api/actions")
        assert r.status_code == 200
        keys = {a["key"] for a in r.json()["actions"]}
        assert keys == {"reevaluate_access", "restart_port", "poe_cycle", "ap_reboot"}
        # Every action states its effect in plain language for the confirm prompt.
        assert all(a["effect"] for a in r.json()["actions"])
        assert {a["key"] for a in r.json()["actions"] if a["disruptive"]} == {
            "restart_port", "poe_cycle", "ap_reboot"}


def test_disabled_action_is_advertised_with_a_reason(tmp_path):
    url = _db_url(tmp_path)
    _seed(url)
    conf = _conf(tmp_path, actions_extra="ap_reboot = false\n")
    with TestClient(_app(conf)) as c:
        by = {a["key"]: a for a in c.get("/api/actions").json()["actions"]}
        assert by["ap_reboot"]["enabled"] is False
        assert "disabled" in by["ap_reboot"]["reason"]
        assert by["restart_port"]["enabled"] is True


# ───────────────────────── the gates ─────────────────────────

def test_master_switch_off_blocks_every_action(tmp_path):
    """[actions] enabled = false must stop all four regardless of their flags."""
    url = _db_url(tmp_path)
    _seed(url)
    conf = _conf(tmp_path, actions_extra="enabled = false\n")
    with TestClient(_app(conf)) as c:
        r = c.post("/api/actions/ap-reboot", json={"device_id": 1})
        assert r.status_code >= 400
    # Refusal is still audited — an attempt is evidence even when nothing was sent.
    rows = _audit(url)
    assert len(rows) == 1 and rows[0]["outcome"] == "refused"
    assert "disabled" in (rows[0]["message"] or "")


def test_per_action_flag_off_blocks_only_that_action(tmp_path):
    url = _db_url(tmp_path)
    _seed(url)
    conf = _conf(tmp_path, actions_extra="poe_cycle = false\n")
    with TestClient(_app(conf)) as c:
        r = c.post("/api/actions/poe-cycle", json={"device_id": 2, "port": "1:12"})
        assert r.status_code >= 400
    rows = _audit(url)
    assert rows[-1]["outcome"] == "refused" and rows[-1]["action"] == "poe_cycle"


def test_viewer_cannot_invoke_an_action(tmp_path):
    """A read-only role must never reach a source."""
    url = _db_url(tmp_path)
    _seed(url)
    with TestClient(_app(_conf(tmp_path, role="viewer"))) as c:
        r = c.post("/api/actions/restart-port", json={"mac": "00:00:5e:00:53:01"})
        assert r.status_code == 403
    # Rejected before any audit row: authorisation precedes the attempt.
    assert _audit(url) == []


def test_min_role_viewer_is_refused_at_config_load(tmp_path):
    """A config that would let viewers reboot APs must fail loudly at boot."""
    import pytest

    from netmon.config import ConfigError
    conf = _conf(tmp_path, actions_extra="min_role = viewer\n")
    with pytest.raises(ConfigError, match="min_role"):
        load_config(conf)


def test_unknown_device_is_refused_without_calling_the_source(tmp_path):
    url = _db_url(tmp_path)
    _seed(url)
    with TestClient(_app(_conf(tmp_path))) as c:
        r = c.post("/api/actions/ap-reboot", json={"device_id": 9999})
        assert r.status_code >= 400
    rows = _audit(url)
    assert rows[-1]["outcome"] == "refused" and "registry" in (rows[-1]["message"] or "")


def test_disabled_device_is_refused(tmp_path):
    url = _db_url(tmp_path)
    _seed(url)
    with TestClient(_app(_conf(tmp_path))) as c:
        r = c.post("/api/actions/poe-cycle", json={"device_id": 4, "port": "1:1"})
        assert r.status_code >= 400
    assert _audit(url)[-1]["outcome"] == "refused"


def test_wrong_device_type_is_refused(tmp_path):
    """Rebooting a switch via the AP endpoint must not be possible."""
    url = _db_url(tmp_path)
    _seed(url)
    with TestClient(_app(_conf(tmp_path))) as c:
        r = c.post("/api/actions/ap-reboot", json={"device_id": 2})  # a switch
        assert r.status_code >= 400
    assert "not a ap" in (_audit(url)[-1]["message"] or "") or \
           "not an ap" in (_audit(url)[-1]["message"] or "")


def test_ap_without_an_xiq_id_is_refused(tmp_path):
    url = _db_url(tmp_path)
    _seed(url)
    with TestClient(_app(_conf(tmp_path))) as c:
        r = c.post("/api/actions/ap-reboot", json={"device_id": 3})  # AP, no xiq id
        assert r.status_code >= 400
    assert "XIQ device id" in (_audit(url)[-1]["message"] or "")


def test_unknown_port_is_refused_so_snippet_args_stay_trusted(tmp_path):
    """The rConfig snippet is trusted; its arguments are not.

    Without this check a caller could have any port string substituted into a
    stored CLI snippet.
    """
    url = _db_url(tmp_path)
    _seed(url)
    with TestClient(_app(_conf(tmp_path))) as c:
        r = c.post("/api/actions/poe-cycle", json={"device_id": 2, "port": "9:99"})
        assert r.status_code >= 400
    assert "not a known port" in (_audit(url)[-1]["message"] or "")


# ───────────────────────── audit trail ─────────────────────────

def test_audit_row_is_written_before_the_call_and_never_holds_a_secret(tmp_path):
    url = _db_url(tmp_path)
    _seed(url)
    with TestClient(_app(_conf(tmp_path))) as c:
        # PF host does not resolve, so the call fails — the row must still exist
        # with the actor, target and a failure outcome.
        c.post("/api/actions/restart-port",
               json={"mac": "00:00:5E:00:53:01", "device_id": 2})
    rows = _audit(url)
    assert len(rows) == 1
    row = rows[0]
    assert row["action"] == "restart_port" and row["source"] == "packetfence"
    assert row["actor"] and row["actor_role"] == "admin"
    assert row["target"] == "00:00:5e:00:53:01"        # normalised to lower
    assert row["outcome"] in ("failed", "refused")     # never left 'pending'
    assert row["requested_at"] is not None and row["completed_at"] is not None
    params = json.loads(row["params"])
    assert params["op"] == "restart_switchport"
    assert "pass" not in json.dumps(params).lower()


def test_audit_endpoint_lists_and_filters(tmp_path):
    url = _db_url(tmp_path)
    _seed(url)
    with TestClient(_app(_conf(tmp_path))) as c:
        c.post("/api/actions/ap-reboot", json={"device_id": 9999})       # refused
        c.post("/api/actions/poe-cycle", json={"device_id": 2, "port": "1:12"})
        allr = c.get("/api/actions/audit").json()
        assert len(allr) >= 2
        assert allr[0]["id"] > allr[1]["id"]            # newest first
        only2 = c.get("/api/actions/audit?device_id=2").json()
        assert only2 and all(r["device_id"] == 2 for r in only2)


def test_secret_shaped_params_are_omitted_not_masked():
    """A mask still leaks the length; drop the value entirely (§4.6)."""
    from netmon.actions import _sanitise

    out = _sanitise({"port": "1:12", "api_token": "abc123", "pass": "hunter2",
                     "snmp_community": "public", "member": 1})
    assert out["port"] == "1:12" and out["member"] == 1
    for k in ("api_token", "pass", "snmp_community"):
        assert out[k] == "<omitted>"


# ───────────────────────── the closed registry ─────────────────────────

def test_action_registry_is_closed():
    """No caller-supplied action key can reach a source."""
    import pytest

    from netmon.actions import ActionRefused, action_or_refuse

    for good in ("reevaluate_access", "restart_port", "poe_cycle", "ap_reboot"):
        assert action_or_refuse(good).key == good
    for bad in ("delete_node", "../../etc/passwd", "", "reboot", "poe_cycle "):
        with pytest.raises(ActionRefused):
            action_or_refuse(bad)


def test_pf_client_refuses_an_op_outside_the_two_allowed():
    import asyncio

    import pytest

    from netmon.collectors.pf_client import PfClient, PfError

    cl = PfClient(url="https://pf.example.invalid", user="u", password="p")
    for bad in ("delete", "deregister", "reevaluate_access/../x"):
        with pytest.raises(PfError, match="refuses"):
            asyncio.run(cl.node_action("00:00:5e:00:53:01", bad))


def test_xiq_and_rconfig_reject_non_positive_ids():
    import asyncio

    import pytest

    from netmon.collectors.rconfig_client import RConfigClient, RConfigError
    from netmon.collectors.xiq_client import XiqClient, XiqError

    with pytest.raises(XiqError):
        asyncio.run(XiqClient(token="t").reboot_device(0))
    with pytest.raises(XiqError):
        asyncio.run(XiqClient(token="t").reboot_device(True))   # bool is not an id
    rc = RConfigClient(url="https://rc.example.invalid", token="t")
    with pytest.raises(RConfigError):
        asyncio.run(rc.deploy_snippet(0, 4, {}))
    with pytest.raises(RConfigError):
        asyncio.run(rc.deploy_snippet(1, 0, {}))

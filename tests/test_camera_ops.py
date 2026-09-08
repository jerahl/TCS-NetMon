"""Bulk camera operations: pre-flight and planning (spec 20 S8 / D11).

Nothing here sends anything to a camera — there is no executor yet, and the
config that would allow one is off by default. What is tested is the part that
decides *whether* a camera may be touched, because on a fleet-wide hardware
write that is the safety mechanism: a refused camera costs nothing, and a camera
that should have been refused costs a truck roll.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from netmon import db
from netmon.cameras.ops import create_batch, plan_rings, preflight_firmware
from netmon.cameras.vendors import profile_for
from netmon.config import ConfigError, load_config
from tests.conftest import create_core_tables, write_config

NOW = datetime(2026, 9, 8, 20, 0, tzinfo=timezone.utc)

IMAGE = {
    "id": 1, "vendor": "bosch", "version": "7.90.0123",
    "filename": "bosch_7_90.fw", "rel_path": "bosch/bosch_7_90.fw",
    "size_bytes": 1024, "sha256": "a" * 64,
    "models": json.dumps(["FLEXIDOME IP 5000i IR", "FLEXIDOME IP 4000i"]),
}


def _cfg(tmp_path, **ops):
    body = "\n".join(f"{k} = {v}" for k, v in ops.items())
    return load_config(write_config(tmp_path, extra_sections=f"[camera_ops]\n{body}"))


def _seed(url):
    """Six cameras, each failing exactly one pre-flight check but the first."""
    engine = db.make_engine(url)
    create_core_tables(engine)
    with engine.begin() as c:
        c.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled) VALUES "
            "('cam-ok','BHS','camera',1),"          # 1 — the only allowed one
            "('cam-wrong-model','BHS','camera',1),"  # 2
            "('cam-current','BHS','camera',1),"      # 3 — already on target
            "('cam-down','BHS','camera',1),"         # 4
            "('cam-onvif','BHS','camera',1),"        # 5 — no vendor profile
            "('cam-maint','BHS','camera',1),"        # 6 — maintenance window
            "('bhs-sw-1','BHS','switch',1)"))        # 7 — not a camera at all
        c.execute(text(
            "INSERT INTO cameras (device_id, model, firmware, vendor, ip, updated_at) VALUES "
            "(1,'FLEXIDOME IP 5000i IR','783','Bosch1ch','10.1.1.1',:t),"
            "(2,'FLEXIDOME multi 7000i','7.83.0027','Bosch1ch','10.1.1.2',:t),"
            "(3,'FLEXIDOME IP 4000i','790','Bosch','10.1.1.3',:t),"
            "(4,'FLEXIDOME IP 4000i','7.83.0027','Bosch','10.1.1.4',:t),"
            "(5,'FLEXIDOME IP 5000i IR','7.83.0027','ONVIF','10.1.1.5',:t),"
            "(6,'FLEXIDOME IP 4000i','7.83.0027','Bosch','10.1.1.6',:t)"), {"t": NOW})
        rows = [(i, "up") for i in (1, 2, 3, 5, 6)] + [(4, "down_confirmed")]
        for device_id, reach in rows:
            c.execute(text(
                "INSERT INTO device_state (device_id,dimension,value,severity,source,updated_at) "
                "VALUES (:d,'reachability',:v,'ok','derived',:t),"
                "       (:d,'source_status','up','ok','milestone',:t)"),
                {"d": device_id, "v": reach, "t": NOW})
        c.execute(text(
            "INSERT INTO maintenance_windows (scope_type,scope_value,starts_at,ends_at,created_by) "
            "VALUES ('device','6',:s,:e,'sappleby')"),
            {"s": NOW - timedelta(hours=1), "e": NOW + timedelta(hours=1)})
    engine.dispose()
    return db.make_engine(url)


def _reasons(pre):
    return {r.name: r.reason for r in pre.refused}


def test_preflight_refuses_each_camera_for_its_own_reason(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'o1.db'}")
    cfg = _cfg(tmp_path, user="svc-cam", **{"pass": "x"})

    pre = preflight_firmware(engine, cfg, [1, 2, 3, 4, 5, 6, 7], IMAGE, now=NOW)

    assert [r["device_id"] for r in pre.allowed] == [1]
    reasons = _reasons(pre)
    assert "not on this image's allow-list" in reasons["cam-wrong-model"]
    assert reasons["cam-current"] == "already on 7.90.0123"
    assert "reachability is down_confirmed" in reasons["cam-down"]
    assert "no vendor profile" in reasons["cam-onvif"]
    assert reasons["cam-maint"] == "inside an active maintenance window"
    assert reasons["bhs-sw-1"] == "not a camera in the registry"


def test_a_compact_firmware_string_still_counts_as_already_current(tmp_path):
    """The 888-camera trap. `790` and `7.90.0123` are one release, so this
    camera must be skipped rather than pushed firmware it already runs."""
    engine = _seed(f"sqlite:///{tmp_path/'o2.db'}")
    cfg = _cfg(tmp_path, user="svc-cam", **{"pass": "x"})
    pre = preflight_firmware(engine, cfg, [3], IMAGE, now=NOW)
    assert pre.allowed == []
    assert _reasons(pre)["cam-current"] == "already on 7.90.0123"


def test_an_unreadable_firmware_string_is_refused_not_assumed(tmp_path):
    """31 cameras report strings with no documented reading. Neither "push it"
    nor "skip it" is knowable, so the camera is refused and said so."""
    url = f"sqlite:///{tmp_path/'o3.db'}"
    engine = _seed(url)
    with engine.begin() as c:
        c.execute(text("UPDATE cameras SET firmware = '03500623' WHERE device_id = 1"))
    cfg = _cfg(tmp_path, user="svc-cam", **{"pass": "x"})

    pre = preflight_firmware(engine, cfg, [1], IMAGE, now=NOW)
    assert pre.allowed == []
    assert "refusing rather than guessing" in _reasons(pre)["cam-ok"]


def test_an_image_with_no_model_allow_list_may_touch_nothing(tmp_path):
    """There is no "all models" value by design: 84 model×firmware pairs live
    here and a wrong image is a truck roll."""
    engine = _seed(f"sqlite:///{tmp_path/'o4.db'}")
    cfg = _cfg(tmp_path, user="svc-cam", **{"pass": "x"})
    image = dict(IMAGE, models=json.dumps([]))
    pre = preflight_firmware(engine, cfg, [1], image, now=NOW)
    assert pre.allowed == []
    assert "no model allow-list" in _reasons(pre)["cam-ok"]


def test_without_a_privileged_account_every_camera_is_refused(tmp_path):
    """And the reason names the right section — the snapshot proxy's read-only
    account is explicitly not allowed to be reused here."""
    engine = _seed(f"sqlite:///{tmp_path/'o5.db'}")
    cfg = _cfg(tmp_path)                       # no user/pass
    pre = preflight_firmware(engine, cfg, [1], IMAGE, now=NOW)
    assert pre.allowed == []
    assert "[camera_ops] user/pass" in _reasons(pre)["cam-ok"]


def test_a_site_wide_maintenance_window_covers_its_cameras(tmp_path):
    url = f"sqlite:///{tmp_path/'o6.db'}"
    engine = _seed(url)
    with engine.begin() as c:
        c.execute(text(
            "INSERT INTO maintenance_windows (scope_type,scope_value,starts_at,ends_at,created_by) "
            "VALUES ('site','BHS',:s,:e,'sappleby')"),
            {"s": NOW - timedelta(hours=1), "e": NOW + timedelta(hours=1)})
    cfg = _cfg(tmp_path, user="svc-cam", **{"pass": "x"})
    pre = preflight_firmware(engine, cfg, [1], IMAGE, now=NOW)
    assert pre.allowed == []
    assert _reasons(pre)["cam-ok"] == "inside an active maintenance window"


def test_the_canary_runs_alone_even_when_the_ring_would_swallow_it():
    """Ring 0 is the only thing between a bad image and the second camera."""
    rings = plan_rings([1, 2, 3, 4, 5], canary_count=1, ring_size=10)
    assert rings == [[1], [2, 3, 4, 5]]

    rings = plan_rings(list(range(1, 26)), canary_count=2, ring_size=10)
    assert rings[0] == [1, 2]
    assert [len(r) for r in rings] == [2, 10, 10, 3]
    assert plan_rings([], canary_count=1, ring_size=10) == []


def test_a_dry_run_batch_writes_would_run_and_sends_nothing(tmp_path):
    url = f"sqlite:///{tmp_path/'o7.db'}"
    engine = _seed(url)
    cfg = _cfg(tmp_path, user="svc-cam", **{"pass": "x"})   # dry_run defaults true

    result = create_batch(engine, cfg, op="firmware_update",
                          device_ids=[1, 2, 3], image=IMAGE, actor="sappleby", now=NOW)

    assert result["dry_run"] is True
    batch = db.fetch_one(engine, "SELECT * FROM camera_batches WHERE id = :i",
                         {"i": result["batch_id"]})
    assert batch["status"] == "previewed" and batch["dry_run"] == 1
    # The rules are copied onto the batch, so editing config mid-roll cannot
    # change the safety margin of something already created.
    assert (batch["canary_count"], batch["ring_size"], batch["abort_pct"]) == (1, 10, 10)

    items = {r["device_id"]: r for r in db.fetch_all(
        engine, "SELECT * FROM camera_batch_items WHERE batch_id = :i",
        {"i": result["batch_id"]})}
    assert items[1]["status"] == "would_run"
    assert items[1]["before_value"] == "783"       # the camera's own string, unnormalised
    # Refused cameras are recorded, not omitted: a batch that quietly dropped
    # them leaves an operator unsure whether a camera was fine or forgotten.
    assert items[2]["status"] == "skipped" and "allow-list" in items[2]["message"]
    assert items[3]["status"] == "skipped"


def test_a_batch_larger_than_max_batch_is_refused(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'o8.db'}")
    cfg = _cfg(tmp_path, user="svc-cam", max_batch=2, **{"pass": "x"})
    with pytest.raises(ValueError, match="max_batch"):
        create_batch(engine, cfg, op="firmware_update", device_ids=[1, 2, 3],
                     image=IMAGE, actor="sappleby", now=NOW)


def test_the_deferred_config_catalogue_is_refused_not_stubbed(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'o9.db'}")
    cfg = _cfg(tmp_path, user="svc-cam", **{"pass": "x"})
    with pytest.raises(ValueError, match="only firmware_update"):
        create_batch(engine, cfg, op="config_change", device_ids=[1],
                     image=None, actor="sappleby", now=NOW)


def test_a_batch_where_everything_is_refused_says_so(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'o10.db'}")
    cfg = _cfg(tmp_path, user="svc-cam", **{"pass": "x"})
    result = create_batch(engine, cfg, op="firmware_update", device_ids=[2, 4, 5],
                          image=IMAGE, actor="sappleby", now=NOW)
    batch = db.fetch_one(engine, "SELECT status, message FROM camera_batches WHERE id = :i",
                         {"i": result["batch_id"]})
    assert batch["status"] == "failed"
    assert "refused at pre-flight" in batch["message"]


# ── config gates ──────────────────────────────────────────────────────────

def test_camera_ops_is_off_and_dry_by_default(tmp_path):
    cfg = load_config(write_config(tmp_path))
    ops = cfg.camera_ops
    assert (ops.enabled, ops.dry_run, ops.config_change, ops.firmware_update) == \
        (False, True, False, False)


def test_arming_it_without_a_privileged_account_fails_at_boot(tmp_path):
    with pytest.raises(ConfigError, match="NOT the read-only"):
        _cfg(tmp_path, enabled="true", dry_run="false")


@pytest.mark.parametrize("bad,match", [
    ({"canary_count": "0"}, "canary_count"),
    ({"abort_pct": "0"}, "abort_pct"),
    ({"ring_size": "0"}, "positive"),
])
def test_a_setting_that_would_disable_the_safety_margin_is_refused(tmp_path, bad, match):
    with pytest.raises(ConfigError, match=match):
        _cfg(tmp_path, **bad)


# ── vendor registry ───────────────────────────────────────────────────────

def test_only_bosch_has_a_profile_and_the_others_say_so():
    assert profile_for("Bosch1ch").VENDOR == "bosch"
    assert profile_for("Bosch").VENDOR == "bosch"
    for driver in ("ONVIF", "Axis1ChDevice", "Hanwha", None, ""):
        assert profile_for(driver) is None


def test_the_rcp_helper_only_builds_reads():
    from netmon.cameras.vendors.bosch import parse_rcp_payload, rcp_read_url

    url = rcp_read_url("https://10.1.1.1/", "0x0600")
    assert url.endswith("/rcp.xml?command=0x0600&type=P_OCTET&direction=READ")
    assert "direction=READ" in url
    with pytest.raises(ValueError):
        rcp_read_url("https://10.1.1.1", "0x0600&direction=WRITE")
    assert parse_rcp_payload("<rcp><payload>7.83.0027</payload></rcp>") == "7.83.0027"
    assert parse_rcp_payload("<rcp><payload></payload></rcp>") is None


def test_the_version_read_uses_the_documented_command():
    """RCP+ reference 9.80 §2.612: CONF_SOFTWARE_VERSION_FORMATTED, 0x0cd4,
    returning <major>.<minor>.<build> — the precision that lets a firmware roll
    verify rather than come back indeterminate."""
    from netmon.cameras.vendors.bosch import (
        CMD_SOFTWARE_VERSION_FORMATTED, version_read_request,
    )

    assert CMD_SOFTWARE_VERSION_FORMATTED == "0x0cd4"
    req = version_read_request("https://10.1.1.1/")
    assert req["method"] == "GET"
    assert req["url"] == ("https://10.1.1.1/rcp.xml?command=0x0cd4"
                          "&type=P_STRING&direction=READ")


def test_the_version_comes_from_result_str_not_payload():
    """Found live: <payload> echoes the *request* and is always empty. Reading
    it returned None on every camera while the answer sat one element away."""
    from netmon.cameras.vendors.bosch import parse_rcp_payload, parse_version

    reply = ("<rcp><command><hex>0x0cd4</hex></command><type>P_STRING</type>"
             "<direction>READ</direction><payload></payload>"
             "<result><str>7.83.0027</str></result></rcp>")
    assert parse_version(reply) == "7.83.0027"
    assert parse_rcp_payload(reply) is None
    # A reply with no result at all is None, not an empty string that would
    # later be compared against a version.
    assert parse_version("<rcp><payload></payload></rcp>") is None


def test_the_upload_error_taxonomy_is_the_vendors_own():
    """A failed push should be explained in Bosch's words — "wrong or no
    signature" — not as "the version did not change"."""
    from netmon.cameras.vendors.bosch import UPLOAD_ERRORS

    assert UPLOAD_ERRORS[118] == "wrong or no signature"
    assert UPLOAD_ERRORS[112] == "flash type incompatible"
    assert UPLOAD_ERRORS[111] == "version too low"


def test_the_upload_request_matches_the_camera_s_own_form():
    """Endpoint and part name are read off the camera's service page markup.

        <form method="post" action="upload.htm" enctype="multipart/form-data">
          <input type="file" name="net.bin" id="fwfile">

    `net.bin` is not derivable from anything — it is not an RCP+ command, and no
    documentation this project holds mentions it. Sending the part as `file` is
    what made the first live attempt fail with the connection dropped 0.8s in.
    """
    from netmon.cameras.vendors import bosch

    assert bosch.UPLOAD_PATH == "/upload.htm"
    assert bosch.UPLOAD_FIELD == "net.bin"

    req = bosch.firmware_upload_request("https://10.1.1.1", "CPP7.3_FW_7.93.0024.fw", b"\x00")
    assert req["method"] == "POST" and req["url"] == "https://10.1.1.1/upload.htm"
    # The part name is fixed; the filename inside it stays the image's own, which
    # is what the device logs and what the UI checks ends in .fw.
    assert list(req["files"]) == ["net.bin"]
    assert req["files"]["net.bin"][0] == "CPP7.3_FW_7.93.0024.fw"
    # A firmware upload is not a request to retry: a second attempt landing
    # mid-flash is how a camera stops coming back.
    assert req["retries"] == 0

    with pytest.raises(ValueError):
        bosch.firmware_upload_request("https://10.1.1.1", "../../etc/passwd", b"x")
    with pytest.raises(ValueError, match="empty"):
        bosch.firmware_upload_request("https://10.1.1.1", "bosch.fw", b"")

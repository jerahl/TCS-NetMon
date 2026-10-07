"""NETworkManager profile export (scripts/netwm_profiles.py).

The output is consumed by a Windows application nobody here can run in CI, so
the tests do the two things that are actually checkable: assert the document
shape against the schema read from the NETworkManager source, and assert the
rules this writer imposes on itself — no credentials, no disabled or
address-less devices, an atomic write that leaves nothing behind on failure.

What is NOT tested, and cannot be: that NETworkManager parses the result. That
needs one manual open of the file after the first run.
"""

import json
import os
import stat

import pytest
from sqlalchemy import text

from netmon import db
from scripts.netwm_profiles import (
    DEFAULT_TYPES,
    SECRET_FIELDS,
    build,
    main,
    write_atomically,
)
from tests.conftest import create_core_tables, write_config

FLEET = [
    (1, "nms-core-1", "NMS", "switch", "10.1.0.1", 1, 1),
    (2, "ap-nms-204", "NMS", "ap", "10.1.4.20", 1, 1),
    (3, "ap-nms-206", "NMS", "ap", "10.1.4.22", 0, 1),
    (4, "cam-nms-hall", "NMS", "camera", "10.1.8.5", 1, 1),
    (5, "rs-nms-01", "NMS", "recording_server", "10.1.9.2", 0, 1),
    (6, "wms-core-1", "WMS", "switch", "10.2.0.1", 1, 1),
    (7, "retired-sw", "WMS", "switch", "10.2.0.9", 1, 0),      # disabled
    (8, "no-address", "WMS", "switch", None, 1, 1),            # no mgmt_ip
    (9, "blank-address", "WMS", "switch", "", 1, 1),           # empty mgmt_ip
    (10, "orphan", None, "other", "10.9.9.9", 0, 1),           # no site
]


@pytest.fixture
def engine(tmp_path):
    url = f"sqlite:///{tmp_path/'netwm.db'}"
    eng = db.make_engine(url)
    create_core_tables(eng)
    with eng.begin() as c:
        for row in FLEET:
            c.execute(text(
                "INSERT INTO devices (id,name,site,device_type,mgmt_ip,snmp_capable,enabled)"
                " VALUES (:a,:b,:c,:d,:e,:f,:g)"),
                dict(zip("abcdefg", row)))
    yield eng
    eng.dispose()


def _profiles(payload):
    return [p for g in payload["Groups"] for p in g["Profiles"]]


def _by_name(payload):
    return {p["Name"]: p for p in _profiles(payload)}


# ── document shape ───────────────────────────────────────────────────────────

def test_wrapper_matches_the_netwm_schema(engine):
    """`ProfileFileData` serialises Version / LastBackup / Groups, with the
    groups list carrying [JsonPropertyName("Groups")]. Each group has Name,
    Description, Profiles. If a NETworkManager release renames these, this is
    the test that fails."""
    payload = build(engine, DEFAULT_TYPES)
    assert set(payload) == {"Version", "LastBackup", "Groups"}
    assert payload["Version"] == 1
    assert payload["LastBackup"] is None
    for group in payload["Groups"]:
        assert set(group) == {"Name", "Description", "Profiles"}
        assert isinstance(group["Profiles"], list)


def test_grouped_by_site_and_sorted(engine):
    payload = build(engine, DEFAULT_TYPES)
    names = [g["Name"] for g in payload["Groups"]]
    assert names == sorted(names)
    assert set(names) == {"NMS", "WMS", "Unassigned"}
    assert {p["Name"] for p in payload["Groups"][0]["Profiles"]} == {
        "nms-core-1", "ap-nms-204", "ap-nms-206", "rs-nms-01"}


def test_every_profile_carries_name_host_and_group(engine):
    payload = build(engine, DEFAULT_TYPES)
    for p in _profiles(payload):
        assert p["Name"] and p["Host"]
        assert p["Group"], "a profile with no group lands nowhere in the UI"


def test_a_site_less_device_still_gets_a_group(engine):
    """Dropping it would silently shrink the fleet; "Unassigned" is honest and
    visible, which is the point."""
    payload = build(engine, DEFAULT_TYPES)
    assert _by_name(payload)["orphan"]["Group"] == "Unassigned"


# ── what is excluded ─────────────────────────────────────────────────────────

def test_disabled_and_addressless_devices_are_left_out(engine):
    """A profile with no host is a row that does nothing but take up space, and
    a disabled device is one somebody deliberately stopped monitoring."""
    names = set(_by_name(build(engine, DEFAULT_TYPES)))
    assert "retired-sw" not in names
    assert "no-address" not in names
    assert "blank-address" not in names


def test_cameras_are_out_by_default_and_in_on_request(engine):
    """2,659 cameras would bury the hosts a technician actually opens."""
    assert "cam-nms-hall" not in _by_name(build(engine, DEFAULT_TYPES))
    with_cams = _by_name(build(engine, DEFAULT_TYPES + ("camera",)))
    assert "cam-nms-hall" in with_cams


# ── the tool mapping ─────────────────────────────────────────────────────────

def test_everything_gets_ping_and_traceroute(engine):
    payload = build(engine, DEFAULT_TYPES + ("camera",))
    for p in _profiles(payload):
        assert p["PingMonitor_Enabled"] is True
        assert p["PingMonitor_InheritHost"] is True


def test_ssh_goes_to_switches_and_aps_only(engine):
    """Nobody SSHes a camera, and offering it invites trying."""
    by = _by_name(build(engine, DEFAULT_TYPES + ("camera",)))
    assert by["nms-core-1"]["PuTTY_Enabled"] is True
    assert by["ap-nms-204"]["PuTTY_Enabled"] is True
    assert "PuTTY_Enabled" not in by["cam-nms-hall"]
    assert "PuTTY_Enabled" not in by["rs-nms-01"]


def test_rdp_goes_to_the_recording_servers_only(engine):
    """They are the estate's Windows hosts — the ones NetMon cannot see inside
    (OpenProject #111) and a technician opens over RDP anyway."""
    by = _by_name(build(engine, DEFAULT_TYPES + ("camera",)))
    assert by["rs-nms-01"]["RemoteDesktop_Enabled"] is True
    assert by["rs-nms-01"]["PowerShell_Enabled"] is True
    for other in ("nms-core-1", "ap-nms-204", "cam-nms-hall"):
        assert "RemoteDesktop_Enabled" not in by[other]


def test_snmp_follows_the_registry_not_the_device_type(engine):
    """Offering SNMP where the registry says it does not answer buys a tool
    that times out."""
    by = _by_name(build(engine, DEFAULT_TYPES))
    assert by["ap-nms-204"]["SNMP_Enabled"] is True      # snmp_capable = 1
    assert "SNMP_Enabled" not in by["ap-nms-206"]        # snmp_capable = 0
    assert "SNMP_Enabled" not in by["rs-nms-01"]


def test_web_console_points_at_the_device(engine):
    by = _by_name(build(engine, DEFAULT_TYPES + ("camera",)))
    assert by["cam-nms-hall"]["WebConsole_Url"] == "https://10.1.8.5"
    assert by["nms-core-1"]["WebConsole_Url"] == "https://10.1.0.1"


def test_tags_are_written_both_ways(engine):
    """The Tags string separator could not be established from the source, so
    the array is written too — whichever the app reads is correct."""
    by = _by_name(build(engine, DEFAULT_TYPES))
    p = by["ap-nms-204"]
    assert set(p["TagsCollection"]) == {"ap", "NMS", "snmp"}
    for tag in p["TagsCollection"]:
        assert tag in p["Tags"]


def test_deep_link_is_opt_in_and_routes_by_type(engine):
    plain = _by_name(build(engine, DEFAULT_TYPES))
    assert "http" not in plain["ap-nms-204"]["Description"]

    linked = _by_name(build(engine, DEFAULT_TYPES + ("camera",),
                            netmon_url="https://netmon.example/"))
    assert "/ui/#/ap/2" in linked["ap-nms-204"]["Description"]
    assert "/ui/#/camera/4" in linked["cam-nms-hall"]["Description"]
    assert "/ui/#/switches/1" in linked["nms-core-1"]["Description"]
    # One slash, not two, however the base URL was typed.
    assert "//ui" not in linked["ap-nms-204"]["Description"]


# ── secrets ──────────────────────────────────────────────────────────────────

def test_no_credential_field_is_ever_written(engine):
    blob = json.dumps(build(engine, DEFAULT_TYPES + ("camera",)))
    for field in SECRET_FIELDS:
        assert field not in blob, f"{field} reached the export"


def test_a_credential_field_fails_the_write(engine, monkeypatch):
    """The guard runs on the assembled document, so a field added later by
    somebody who did not read the docstring fails here rather than landing on
    a share."""
    import scripts.netwm_profiles as mod
    real = mod._tools_for
    monkeypatch.setattr(mod, "_tools_for",
                        lambda *a, **k: {**real(*a, **k), "SNMP_Community": "public"})
    with pytest.raises(SystemExit) as exc:
        build(engine, DEFAULT_TYPES)
    assert "SNMP_Community" in str(exc.value)


# ── writing ──────────────────────────────────────────────────────────────────

def test_write_is_atomic_and_mode_restricted(engine, tmp_path):
    out = tmp_path / "share" / "TCS-NetMon.json"
    write_atomically(build(engine, DEFAULT_TYPES), out)
    assert json.loads(out.read_text())["Version"] == 1
    assert stat.S_IMODE(out.stat().st_mode) == 0o640
    # No temp file left in the destination directory.
    assert [f.name for f in out.parent.iterdir()] == ["TCS-NetMon.json"]


def test_a_failed_write_leaves_nothing_behind(tmp_path, monkeypatch):
    """The share is read by every technician's install on a schedule nobody
    coordinates; a half-written document must never be visible."""
    out = tmp_path / "share" / "x.json"
    monkeypatch.setattr(json, "dump", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        write_atomically({"Version": 1}, out)
    assert not out.exists()
    assert list(out.parent.iterdir()) == []


def test_replacing_an_existing_file_keeps_one_file(engine, tmp_path):
    out = tmp_path / "TCS-NetMon.json"
    write_atomically(build(engine, DEFAULT_TYPES), out)
    first = out.read_text()
    write_atomically(build(engine, DEFAULT_TYPES + ("camera",)), out)
    assert out.read_text() != first
    assert len([f for f in tmp_path.iterdir() if f.name.startswith(".netwm-")]) == 0


# ── CLI ──────────────────────────────────────────────────────────────────────

def test_cli_writes_the_file(engine, tmp_path, capsys):
    conf = write_config(tmp_path, db_url=f"sqlite:///{tmp_path/'netwm.db'}")
    out = tmp_path / "out.json"
    assert main(["--config", str(conf), "--out", str(out)]) == 0
    assert "profile(s)" in capsys.readouterr().out
    assert json.loads(out.read_text())["Groups"]


def test_cli_dry_run_writes_nothing(engine, tmp_path, capsys):
    conf = write_config(tmp_path, db_url=f"sqlite:///{tmp_path/'netwm.db'}")
    out = tmp_path / "nope.json"
    assert main(["--config", str(conf), "--out", str(out), "--dry-run"]) == 0
    assert "nothing written" in capsys.readouterr().out
    assert not out.exists()


def test_cli_all_includes_cameras(engine, tmp_path, capsys):
    conf = write_config(tmp_path, db_url=f"sqlite:///{tmp_path/'netwm.db'}")
    assert main(["--config", str(conf), "--types", "all", "--dry-run"]) == 0
    assert "camera" in capsys.readouterr().out


def test_cli_mode_is_honoured(engine, tmp_path):
    conf = write_config(tmp_path, db_url=f"sqlite:///{tmp_path/'netwm.db'}")
    out = tmp_path / "m.json"
    assert main(["--config", str(conf), "--out", str(out), "--mode", "600"]) == 0
    assert stat.S_IMODE(out.stat().st_mode) == 0o600

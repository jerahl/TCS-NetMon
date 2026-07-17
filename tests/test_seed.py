from netmon.models.schemas import Device, DeviceType
from netmon.seed import (
    UNASSIGNED_SITE,
    assign_sites,
    build_site_index,
    canon_mac,
    load_fixture,
    load_site_index,
    normalize_pf,
    normalize_xiq,
    reconcile,
)
from tests.conftest import FIXTURES


def test_canon_mac():
    assert canon_mac("AABBCC000011") == "aa:bb:cc:00:00:11"
    assert canon_mac("aa:bb:cc:00:00:11") == "aa:bb:cc:00:00:11"
    assert canon_mac("aa-bb-cc-00-00-11") == "aa:bb:cc:00:00:11"
    assert canon_mac("not-a-mac") == ""
    assert canon_mac("") == ""


def test_build_site_index_first_site_group_wins():
    idx = build_site_index([
        {"host": "a", "hostgroups": [{"name": "Switches"}, {"name": "Site/BHS"}]},
        {"host": "b", "hostgroups": [{"name": "Site/CHS"}]},
        {"host": "c", "hostgroups": [{"name": "Wireless"}]},  # no Site/ → omitted
    ])
    assert idx == {"a": "BHS", "b": "CHS"}


def test_load_site_index_from_zabbix_export_and_plain_map(tmp_path):
    idx = load_site_index(FIXTURES / "zbx_sites.json")
    assert idx["BHS-56-Hallway"] == "BHS"
    assert idx["CHS-12-Room"] == "CHS"
    assert "UNGROUPED-HOST" not in idx  # only in a non-Site/ group

    plain = tmp_path / "map.json"
    plain.write_text('{"_note": "x", "BHS-Core-1": "BHS"}')
    assert load_site_index(plain) == {"BHS-Core-1": "BHS"}


def test_assign_sites_defaults_to_unassigned():
    devices = [Device(name="BHS-Core-1"), Device(name="mystery-host")]
    assign_sites(devices, {"bhs-core-1": "BHS"})  # case-insensitive match
    assert devices[0].site == "BHS"
    assert devices[1].site == UNASSIGNED_SITE


def test_normalize_xiq_types_and_snmp():
    rows = load_fixture(FIXTURES / "xiq_devices.json")
    devices = normalize_xiq(rows)
    assert len(devices) == 3
    ap = next(d for d in devices if d.name == "BHS-56-Hallway")
    assert ap.device_type is DeviceType.ap
    assert ap.snmp_capable is False
    assert ap.xiq_device_id == "100001"
    assert ap.site is None  # site not assigned until the Site/ export is applied
    sw = next(d for d in devices if d.name == "BHS-Core-1")
    assert sw.device_type is DeviceType.switch
    assert sw.snmp_capable is True


def test_normalize_pf_synthesizes_name_and_camera():
    rows = load_fixture(FIXTURES / "pf_nodes.json")
    devices = normalize_pf(rows)
    cam = next(d for d in devices if d.name == "NURSE-CAM-1")
    assert cam.device_type is DeviceType.camera
    assert cam.pf_node_mac == "aa:bb:cc:00:00:aa"
    # Empty computername + unknown class → synthesized pf-<mac>.
    synth = next(d for d in devices if d.name == "pf-aa:bb:cc:00:00:bb")
    assert synth.device_type is DeviceType.other
    assert synth.site is None


def test_reconcile_merges_by_name_and_ip():
    xiq = normalize_xiq(load_fixture(FIXTURES / "xiq_devices.json"))
    pf = normalize_pf(load_fixture(FIXTURES / "pf_nodes.json"))
    merged = reconcile(xiq, pf)

    # 3 XIQ + 4 PF; two PF rows match XIQ (by name, by IP) → 5 distinct devices.
    assert len(merged) == 5

    # PF MAC attached to the XIQ AP matched by name.
    ap = next(d for d in merged if d.name == "BHS-56-Hallway")
    assert ap.xiq_device_id == "100001"
    assert ap.pf_node_mac == "aa:bb:cc:00:00:11"

    # PF switch matched to XIQ core switch by mgmt_ip (192.0.2.2), MAC attached.
    core = next(d for d in merged if d.name == "BHS-Core-1")
    assert core.pf_node_mac == "aa:bb:cc:00:00:99"

    # PF-only camera survives.
    assert any(d.name == "NURSE-CAM-1" and d.device_type is DeviceType.camera for d in merged)

    # Sites applied from the Zabbix Site/ export; the synthesized PF-only node
    # is in no Site/ group → Unassigned.
    assign_sites(merged, load_site_index(FIXTURES / "zbx_sites.json"))
    assert next(d for d in merged if d.name == "BHS-56-Hallway").site == "BHS"
    assert next(d for d in merged if d.name == "NURSE-CAM-1").site == "BHS"
    assert next(d for d in merged if d.name == "pf-aa:bb:cc:00:00:bb").site == UNASSIGNED_SITE


def test_seed_cli_dry_run(capsys, tmp_path):
    from netmon.seed import main

    rc = main([
        "--xiq", str(FIXTURES / "xiq_devices.json"),
        "--pf", str(FIXTURES / "pf_nodes.json"),
        "--sites", str(FIXTURES / "zbx_sites.json"),
        "--dry-run",
    ])
    assert rc == 0
    out = capsys.readouterr().out
    assert "reconciled 5 device(s)" in out
    assert "1 unassigned" in out  # only the synthesized PF-only node
    assert "BHS" in out


def _registry_engine(tmp_path):
    from netmon import db
    from tests.conftest import create_core_tables

    engine = db.make_engine(f"sqlite:///{tmp_path/'seed.db'}")
    create_core_tables(engine)
    return engine


def test_upsert_devices_portable_and_idempotent(tmp_path):
    """Portable upsert (spec 11 §8): runs on SQLite, merges instead of
    regressing, and a re-run with identical rows is a no-op, not an error."""
    from netmon import db
    from netmon.seed import upsert_devices

    engine = _registry_engine(tmp_path)
    first = Device(name="sw-1", site="BHS", device_type=DeviceType.switch,
                   mgmt_ip="10.0.0.1", snmp_capable=True, xiq_device_id="42")
    assert upsert_devices(engine, [first]) == 1
    assert upsert_devices(engine, [first]) == 1  # idempotent re-seed

    # Operator disables the device; a later re-seed must not re-enable it and
    # must not blank the XIQ key when the fresh export lacks it.
    db.execute(engine, "UPDATE devices SET enabled = 0 WHERE name = 'sw-1'")
    again = Device(name="sw-1", site="Central", device_type=DeviceType.switch,
                   mgmt_ip="10.0.0.2", snmp_capable=True,
                   pf_node_mac="aa:bb:cc:dd:ee:ff")
    upsert_devices(engine, [again])

    row = db.fetch_one(engine, "SELECT * FROM devices WHERE name = 'sw-1'")
    assert row["site"] == "Central"          # fresh export wins
    assert row["mgmt_ip"] == "10.0.0.2"
    assert row["enabled"] == 0               # insert-only, operator's call kept
    assert row["xiq_device_id"] == "42"      # never regresses to NULL
    assert row["pf_node_mac"] == "aa:bb:cc:dd:ee:ff"  # new source key attached
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM devices")["n"] == 1


def test_site_index_from_db(tmp_path):
    """--sites-from-db (spec 11 D9): the registry's own assignments are the
    site source of truth; Unassigned rows don't pin devices to Unassigned."""
    from netmon import db
    from netmon.seed import site_index_from_db

    engine = _registry_engine(tmp_path)
    db.execute(
        engine,
        "INSERT INTO devices (name, site, device_type) VALUES "
        "('sw-1', 'BHS', 'switch'), ('ap-1', 'Central', 'ap'), "
        "('cam-1', 'Unassigned', 'camera'), ('trk-1', NULL, 'trunk')",
    )
    index = site_index_from_db(engine)
    assert index == {"sw-1": "BHS", "ap-1": "Central"}


def test_seed_cli_sites_from_db(capsys, tmp_path, monkeypatch):
    """Re-seed without Zabbix: sites survive from the DB (spec 11 D9)."""
    from netmon import db
    from netmon.seed import main
    from tests.conftest import write_config

    conf = write_config(tmp_path, db_url=f"sqlite:///{tmp_path/'seed.db'}")
    engine = _registry_engine(tmp_path)
    # BHS-Core-1 exists in the XIQ fixture — a prior seed assigned its site.
    db.execute(
        engine,
        "INSERT INTO devices (name, site, device_type) VALUES "
        "('BHS-Core-1', 'BHS', 'switch')",
    )
    engine.dispose()

    rc = main([
        "--config", str(conf),
        "--xiq", str(FIXTURES / "xiq_devices.json"),
        "--pf", str(FIXTURES / "pf_nodes.json"),
        "--sites-from-db",
    ])
    assert rc == 0
    out = capsys.readouterr().out
    assert "NOTE: no --sites" not in out

    engine = db.make_engine(f"sqlite:///{tmp_path/'seed.db'}")
    # The re-seeded row kept its site from the DB — no Zabbix export involved.
    row = db.fetch_one(engine, "SELECT site FROM devices WHERE name = 'BHS-Core-1'")
    assert row["site"] == "BHS"
    # A device the DB had never sited stays honestly Unassigned.
    row = db.fetch_one(engine, "SELECT site FROM devices WHERE name = 'CHS-12-Room'")
    assert row["site"] == "Unassigned"

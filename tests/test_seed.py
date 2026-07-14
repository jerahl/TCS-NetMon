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

from netmon.models.schemas import DeviceType
from netmon.seed import (
    canon_mac,
    load_fixture,
    normalize_pf,
    normalize_xiq,
    reconcile,
    site_from_name,
)
from tests.conftest import FIXTURES


def test_canon_mac():
    assert canon_mac("AABBCC000011") == "aa:bb:cc:00:00:11"
    assert canon_mac("aa:bb:cc:00:00:11") == "aa:bb:cc:00:00:11"
    assert canon_mac("aa-bb-cc-00-00-11") == "aa:bb:cc:00:00:11"
    assert canon_mac("not-a-mac") == ""
    assert canon_mac("") == ""


def test_site_from_name():
    assert site_from_name("BHS-56-Hallway") == "BHS"
    assert site_from_name("CHS-12-Room") == "CHS"
    assert site_from_name("noseparator") is None
    assert site_from_name("") is None


def test_normalize_xiq_types_and_snmp():
    rows = load_fixture(FIXTURES / "xiq_devices.json")
    devices = normalize_xiq(rows)
    assert len(devices) == 3
    ap = next(d for d in devices if d.name == "BHS-56-Hallway")
    assert ap.device_type is DeviceType.ap
    assert ap.snmp_capable is False
    assert ap.xiq_device_id == "100001"
    assert ap.site == "BHS"
    sw = next(d for d in devices if d.name == "BHS-Core-1")
    assert sw.device_type is DeviceType.switch
    assert sw.snmp_capable is True


def test_normalize_pf_synthesizes_name_and_camera():
    rows = load_fixture(FIXTURES / "pf_nodes.json")
    devices = normalize_pf(rows)
    cam = next(d for d in devices if d.name == "NURSE-CAM-1")
    assert cam.device_type is DeviceType.camera
    assert cam.pf_node_mac == "aa:bb:cc:00:00:aa"
    # Empty computername + unknown class → synthesized pf-<mac>, site unknown.
    synth = next(d for d in devices if d.name == "pf-aa:bb:cc:00:00:bb")
    assert synth.device_type is DeviceType.other
    assert synth.site == "unknown"


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


def test_seed_cli_dry_run(capsys, tmp_path):
    from netmon.seed import main

    rc = main([
        "--xiq", str(FIXTURES / "xiq_devices.json"),
        "--pf", str(FIXTURES / "pf_nodes.json"),
        "--dry-run",
    ])
    assert rc == 0
    out = capsys.readouterr().out
    assert "reconciled 5 device(s)" in out
    assert "BHS-56-Hallway" in out

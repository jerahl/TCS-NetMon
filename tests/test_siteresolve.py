"""Site attribution — group ranking, canonicalisation, and learned maps.

The properties worth protecting here are not "does it resolve a device" but
"does it refuse to resolve one when the evidence is bad". Each test below
corresponds to a way the live registry actually went wrong.
"""

from netmon.siteresolve import (
    NON_LOCATION_SITES,
    Resolution,
    canonical_site,
    classify_site_group,
    dissenting,
    learn_prefix_map,
    learn_subnet_map,
    learn_subnet_map_stage2,
    name_prefix,
    net16,
    norm_name,
    plan,
    resolve,
    site_from_groups,
)

SITES = ["Bryant High", "Central High", "Rock Quarry", "Westlawn Middle",
         "Central Elementary", "TMS", "TASPA", "New Heights", "Verner", "MLK"]


# --------------------------------------------------------------------------
# Group ranking — the bug that mis-sited 717 APs
# --------------------------------------------------------------------------

def test_location_group_outranks_functional_catchall():
    """The whole defect in one assertion: membership order must not decide."""
    groups = [{"name": "Site/Wireless APs"},
              {"name": "Site/Wireless/Bryant High School/1st Floor"}]
    assert site_from_groups(groups) == (2, "Bryant High School")
    # ...and the reverse order must give the same answer.
    assert site_from_groups(list(reversed(groups))) == (2, "Bryant High School")


def test_functional_groups_name_no_location():
    for g in ("Site/Wireless APs", "Site/Servers", "Site/Video/Milestone"):
        rank, raw = classify_site_group(g)
        assert rank == 0, g
        assert raw == ""


def test_flat_site_group_is_rank_one():
    assert classify_site_group("Site/Central High") == (1, "Central High")


def test_non_site_groups_ignored():
    assert classify_site_group("Templates/Network") == (0, "")
    assert classify_site_group("") == (0, "")
    assert site_from_groups([{"name": "Discovered hosts"}]) == (0, "")


def test_flat_group_used_when_no_location_group():
    groups = [{"name": "Site/Wireless APs"}, {"name": "Site/Central High"}]
    assert site_from_groups(groups) == (1, "Central High")


# --------------------------------------------------------------------------
# Canonicalisation
# --------------------------------------------------------------------------

def test_progressive_trim_keeps_meaningful_suffixes():
    # "High" is part of the site name; "School" is not.
    assert canonical_site("Bryant High School", SITES) == "Bryant High"
    assert canonical_site("Rock Quarry Elementary School", SITES) == "Rock Quarry"
    assert canonical_site("Central Elementary School", SITES) == "Central Elementary"


def test_aliases_cover_names_no_rule_reaches():
    assert canonical_site("Tuscaloosa Magnet Schools", SITES) == "TMS"
    assert canonical_site("Alberta Performing Arts", SITES) == "TASPA"
    assert canonical_site("SHEC", SITES) == "New Heights"


def test_unknown_site_is_none_not_invented():
    assert canonical_site("Some New School", SITES) is None
    assert canonical_site("", SITES) is None


# --------------------------------------------------------------------------
# Learned maps — refusal is the feature
# --------------------------------------------------------------------------

def test_subnet_map_rejects_shared_ranges():
    """172.16/192.168 carry many sites; resolving them caused the July bug."""
    obs = [("172.16.1.%d" % i, s) for i, s in
           enumerate(["Central High", "Bryant High", "Verner", "MLK"] * 5)]
    accepted, rejected = learn_subnet_map(obs)
    assert "172.16" not in accepted
    assert any(r[0] == "172.16" for r in rejected)


def test_subnet_map_accepts_a_pure_range():
    obs = [(f"10.128.18.{i}", "Bryant High") for i in range(10)]
    accepted, _ = learn_subnet_map(obs)
    assert accepted["10.128"] == "Bryant High"


def test_subnet_map_rejects_thin_evidence():
    accepted, _ = learn_subnet_map([("10.99.1.1", "Verner")])
    assert accepted == {}


def test_prefix_map_survives_a_single_bad_row():
    """40 devices agree, 2 are mis-assigned; the prefix must still resolve."""
    obs = [(f"WMS-{i}", "Westlawn Middle") for i in range(40)]
    obs += [("WMS-Faculty", "Verner"), ("WMS-160", "Verner")]
    accepted, _ = learn_prefix_map(obs)
    assert accepted["WMS"] == "Westlawn Middle"


def test_prefix_map_rejects_a_genuine_split():
    accepted, rejected = learn_prefix_map(
        [("X-1", "Verner"), ("X-2", "MLK"), ("X-3", "Verner")])
    assert "X" not in accepted
    assert any(r[0] == "X" for r in rejected)


def test_dissent_is_reported_not_swallowed():
    obs = [(f"WMS-{i}", "Westlawn Middle") for i in range(40)]
    obs += [("WMS-Faculty", "Verner")]
    accepted, _ = learn_prefix_map(obs)
    d = dissenting(((name_prefix(n), s) for n, s in obs), accepted)
    assert ("WMS", "Westlawn Middle", "Verner", 1) in d


def test_stage2_demands_unanimity():
    """Peer-inferred evidence is weaker, so any disagreement rejects it."""
    obs = [(f"10.84.18.{i}", "Bryant High") for i in range(9)]
    obs += [("10.84.18.99", "Verner")]
    accepted, _ = learn_subnet_map_stage2(obs, already={})
    assert "10.84" not in accepted


def test_stage2_does_not_override_stage1():
    obs = [(f"10.32.1.{i}", "Verner") for i in range(9)]
    accepted, _ = learn_subnet_map_stage2(obs, already={"10.32": "Central High"})
    assert "10.32" not in accepted


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def test_name_prefix_and_net16():
    assert name_prefix("CHS229-AP") == "CHS"
    assert name_prefix("10.108.18.31 - Camera 1") == ""
    assert net16("10.128.18.4") == "10.128"
    assert net16("not-an-ip") is None
    assert net16("10.999.1.1") is None
    assert net16(None) is None


def test_norm_name_folds_separator_drift():
    assert norm_name("WMS-160/Band") == norm_name("WMS-160-Band")
    assert norm_name("NMS-KITCHEN#1") == "nms-kitchen-1"


def test_resolve_prefers_prefix_then_subnet_then_nothing():
    pm, sm = {"BHS": "Bryant High"}, {"10.128": "Bryant High"}
    assert resolve("BHS-101", None, prefix_map=pm, subnet_map=sm).method == "prefix"
    assert resolve("FLEXIDOME x", "10.128.1.1", prefix_map=pm, subnet_map=sm).method == "subnet"
    assert not resolve("mystery", "192.168.1.1", prefix_map=pm, subnet_map=sm).resolved


def test_resolve_reads_an_address_out_of_the_name():
    """Some cameras are named for their IP and carry no address field."""
    r = resolve("10.108.18.31 - Camera 1", None,
                prefix_map={}, subnet_map={"10.108": "Woodland Forrest"})
    assert r.site == "Woodland Forrest"


# --------------------------------------------------------------------------
# plan() — the never-overwrite guarantee
# --------------------------------------------------------------------------

def _dev(i, name, site, ip=None, dt="camera"):
    return {"id": i, "name": name, "site": site, "ip": ip, "device_type": dt}


def test_plan_never_overwrites_a_real_site():
    devices = [_dev(1, "BHS-CAM-1", "Verner", "10.128.1.1"),
               _dev(2, "BHS-SW-1", "Bryant High", "10.128.1.2", "switch")]
    p = plan(devices, SITES)
    assert p["changes"] == []          # device 1 keeps its (wrong) manual site
    assert p["unresolved"] == []


def test_plan_fills_every_non_location_placeholder():
    for placeholder in sorted(NON_LOCATION_SITES):
        devices = [_dev(1, "BHS-SW", "Bryant High", "10.128.1.1", "switch"),
                   _dev(2, "BHS-CAM", placeholder, "10.128.1.2")]
        p = plan(devices, SITES)
        assert [c["to"] for c in p["changes"]] == ["Bryant High"], placeholder


def test_plan_leaves_unresolvable_devices_alone():
    devices = [_dev(1, "BHS-SW", "Bryant High", "10.128.1.1", "switch"),
               _dev(2, "FLEXIDOME IP 4000i", "Unassigned", "10.84.18.20")]
    p = plan(devices, SITES)
    assert p["changes"] == []
    assert [u["id"] for u in p["unresolved"]] == [2]


def test_plan_reports_registry_vs_zabbix_conflicts():
    devices = [_dev(1, "WMS-160/Band", "Verner", None, "ap")]
    p = plan(devices, SITES, {"WMS-160-Band": "Westlawn Middle"})
    assert p["conflicts"] == [{"id": 1, "name": "WMS-160/Band",
                               "registry": "Verner", "zabbix": "Westlawn Middle"}]
    assert p["changes"] == []


def test_plan_zabbix_location_outranks_inference():
    devices = [_dev(1, "BHS-SW", "Bryant High", "10.128.1.1", "switch"),
               _dev(2, "BHS-AP-9", "Wireless APs", "10.128.1.9", "ap")]
    p = plan(devices, SITES, {"BHS-AP-9": "Central High"})
    assert p["changes"][0]["to"] == "Central High"
    assert p["changes"][0]["method"] == "zbx-location"

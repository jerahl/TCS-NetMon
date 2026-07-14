"""Parse tests for the Zabbix 7.4 export transforms (scripts/zabbix_export.py).

Exercises the pure functions only — no network. The export must stay
compatible with ``netmon.seed`` (a host.get dump feeds ``--sites``).
"""

from __future__ import annotations

from scripts.zabbix_export import build_export, derive_site, groups_export, main_ip
from netmon.seed import build_site_index

HOSTS = [
    {
        "hostid": "1001",
        "host": "BHS-Core-1",
        "name": "BHS Core 1",
        "status": "0",
        "hostgroups": [{"name": "Switches"}, {"name": "Site/BHS"}],
        "interfaces": [
            {"ip": "10.1.0.2", "type": "1", "main": "0"},
            {"ip": "10.1.0.1", "type": "2", "main": "1"},
        ],
    },
    {
        "hostid": "1002",
        "host": "CHS-12-Room",
        "name": "CHS 12",
        "status": "0",
        "hostgroups": [{"name": "Site/CHS"}],
        "interfaces": [{"ip": "10.2.0.5", "type": "1", "main": "1"}],
    },
    {
        "hostid": "1003",
        "host": "UNGROUPED-HOST",
        "name": "Ungrouped",
        "status": "1",
        "hostgroups": [{"name": "Switches"}],
        "interfaces": [],
    },
]

GROUPS = [
    {"groupid": "1", "name": "Switches"},
    {"groupid": "2", "name": "Site/BHS"},
    {"groupid": "3", "name": "Site/CHS"},
]


def test_derive_site_first_site_group_wins():
    assert derive_site([{"name": "Switches"}, {"name": "Site/BHS"}]) == "BHS"
    assert derive_site([{"name": "Site/CHS"}]) == "CHS"
    assert derive_site([{"name": "Wireless"}]) is None
    assert derive_site([]) is None


def test_derive_site_custom_prefix():
    assert derive_site([{"name": "Campus/West"}], prefix="Campus/") == "West"


def test_main_ip_prefers_main_then_snmp():
    # SNMP main interface (type 2, main 1) wins over the agent interface.
    assert main_ip(HOSTS[0]["interfaces"]) == "10.1.0.1"
    assert main_ip(HOSTS[1]["interfaces"]) == "10.2.0.5"
    assert main_ip([]) is None
    assert main_ip([{"ip": "", "main": "1"}]) is None


def test_build_export_meta_and_rows():
    export = build_export(HOSTS, GROUPS, version="7.4.0")
    meta = export["_meta"]
    assert meta["host_count"] == 3
    assert meta["site_count"] == 2
    assert meta["sites"] == ["BHS", "CHS"]
    assert meta["hosts_without_site"] == 1
    assert meta["zabbix_version"] == "7.4.0"

    rows = {r["host"]: r for r in export["result"]}
    assert rows["BHS-Core-1"]["site"] == "BHS"
    assert rows["BHS-Core-1"]["mgmt_ip"] == "10.1.0.1"
    assert rows["UNGROUPED-HOST"]["site"] is None


def test_build_export_is_seed_compatible():
    # The export's `result` array must drive netmon.seed.build_site_index.
    export = build_export(HOSTS, GROUPS, version="7.4.0")
    idx = build_site_index(export["result"])
    assert idx == {"BHS-Core-1": "BHS", "CHS-12-Room": "CHS"}
    assert "UNGROUPED-HOST" not in idx


def test_groups_export():
    out = groups_export(GROUPS, version="7.4.0")
    assert out["_meta"]["group_count"] == 3
    assert {g["name"] for g in out["result"]} == {"Switches", "Site/BHS", "Site/CHS"}

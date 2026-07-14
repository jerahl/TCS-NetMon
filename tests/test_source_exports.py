"""Tests for the XIQ / PacketFence seed-export scripts.

The scripts wrap the collector HTTP clients in a thin CLI that writes the
``{"data": [...]}`` / ``{"items": [...]}`` envelope ``netmon-seed`` consumes.
The network is mocked; the assertion is that the emitted file feeds the seed.
"""

from __future__ import annotations

import json

import scripts.pf_export as pe
import scripts.xiq_export as xe
from netmon.collectors.pf_client import PfClient
from netmon.collectors.xiq_client import XiqClient
from netmon.seed import load_fixture, normalize_pf, normalize_xiq
from tests.conftest import FIXTURES

_CONF = """\
[db]
url = sqlite:///./x.db
[auth]
dev_bypass_user = dev
[xiq]
enabled = true
api_token = FAKE
[packetfence]
enabled = true
url = https://pf.example
user = ro
pass = FAKE
"""


def _conf(tmp_path):
    p = tmp_path / "netmon.conf"
    p.write_text(_CONF)
    return str(p)


def test_xiq_export_is_seed_compatible(tmp_path, monkeypatch):
    rows = json.loads((FIXTURES / "xiq_devices.json").read_text())["data"]

    async def fake_devices(self, view="BASIC"):
        return rows

    monkeypatch.setattr(XiqClient, "get_devices", fake_devices)
    out = tmp_path / "xiq.json"
    rc = xe.main(["--config", _conf(tmp_path), "--out", str(out)])
    assert rc == 0

    payload = json.loads(out.read_text())
    assert payload["_meta"]["device_count"] == len(rows)
    assert "api_token" not in out.read_text()  # secret never leaks into the export
    devices = normalize_xiq(load_fixture(out))
    assert {d.name for d in devices} == {"BHS-56-Hallway", "BHS-Core-1", "CHS-12-Room"}


def test_xiq_export_missing_token(tmp_path):
    conf = tmp_path / "netmon.conf"
    conf.write_text("[db]\nurl = sqlite:///./x.db\n[auth]\ndev_bypass_user = dev\n[xiq]\nenabled = true\n")
    assert xe.main(["--config", str(conf)]) == 1


def test_pf_export_is_seed_compatible(tmp_path, monkeypatch):
    rows = json.loads((FIXTURES / "pf_nodes.json").read_text())["items"]

    async def fake_nodes(self, limit=5000):
        return rows

    monkeypatch.setattr(PfClient, "nodes", fake_nodes)
    out = tmp_path / "pf.json"
    rc = pe.main(["--config", _conf(tmp_path), "--out", str(out)])
    assert rc == 0

    payload = json.loads(out.read_text())
    assert payload["_meta"]["node_count"] == len(rows)
    assert payload["_meta"]["truncated"] is False
    devices = normalize_pf(load_fixture(out))
    assert any(d.pf_node_mac == "aa:bb:cc:00:00:11" for d in devices)


def test_pf_export_truncation_flag(tmp_path, monkeypatch):
    rows = json.loads((FIXTURES / "pf_nodes.json").read_text())["items"]

    async def fake_nodes(self, limit=5000):
        return rows

    monkeypatch.setattr(PfClient, "nodes", fake_nodes)
    out = tmp_path / "pf.json"
    # --limit equal to the row count trips the truncation warning.
    pe.main(["--config", _conf(tmp_path), "--limit", str(len(rows)), "--out", str(out)])
    assert json.loads(out.read_text())["_meta"]["truncated"] is True

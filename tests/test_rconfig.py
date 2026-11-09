import asyncio
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from netmon import db
from netmon.collectors.rconfig import RConfigCollector, _last_backup, _parse_ts
from netmon.collectors.rconfig_client import RConfigError
from tests.conftest import create_core_tables


class FakeRc:
    def __init__(self):
        self.devices_data = []
        self.fail = None

    async def devices(self):
        if self.fail:
            raise self.fail
        return self.devices_data


def test_parse_ts_and_last_backup():
    assert _parse_ts(None) is None
    assert _parse_ts("2026-07-01T00:00:00Z").year == 2026
    assert _parse_ts(1_700_000_000).tzinfo is not None
    assert _last_backup({"last_success": "2026-07-01T00:00:00Z"}) is not None
    assert _last_backup({"nothing": 1}) is None


def _engine(tmp_path):
    e = db.make_engine(f"sqlite:///{tmp_path / 'rc.db'}")
    create_core_tables(e)
    with e.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, device_type, enabled, rconfig_device_id) "
            "VALUES ('SW-Fresh','switch',1,'1'),('SW-Stale','switch',1,'2'),('SW-Unknown','switch',1,'3')"
        ))
    return e


def _cb_state(engine):
    return {r["rconfig_device_id"]: r for r in db.fetch_all(
        engine,
        "SELECT d.rconfig_device_id, s.value, s.severity FROM devices d "
        "JOIN device_state s ON s.device_id = d.id AND s.dimension='config_backup'")}


def test_rconfig_freshness(tmp_path):
    engine = _engine(tmp_path)
    now = datetime.now(timezone.utc)
    fake = FakeRc()
    fake.devices_data = [
        {"id": 1, "last_backup": (now - timedelta(days=1)).isoformat()},   # fresh
        {"id": 2, "last_backup": (now - timedelta(days=30)).isoformat()},  # stale
        {"id": 3},                                                          # unknown
    ]
    n = asyncio.run(RConfigCollector(engine, fake, stale_after_s=604800).run_once())
    assert n == 3
    st = _cb_state(engine)
    assert st["1"]["value"] == "fresh" and st["1"]["severity"] == "ok"
    assert st["2"]["value"] == "stale" and st["2"]["severity"] == "warn"
    assert st["3"]["value"] == "unknown" and st["3"]["severity"] == "unknown"


def test_rconfig_blind_on_unreachable(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeRc()
    fake.devices_data = [{"id": 1, "last_backup": datetime.now(timezone.utc).isoformat()}]
    coll = RConfigCollector(engine, fake)
    asyncio.run(coll.run_once())
    fake.fail = RConfigError("rconfig down")
    asyncio.run(coll.run_guarded())
    st = _cb_state(engine)
    assert st["1"]["value"] == "blind"
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='rconfig'")
    assert h["consecutive_failures"] == 1


def test_last_backup_prefers_a_real_backup_field_over_row_mtime():
    """Ordering in _TS_KEYS is the contract — most specific first.

    Live payloads (confirmed 2026-07-28) carry `last_backup_at`, which was
    missing from the alias list while `updated_at` was present. Because
    _last_backup returns the FIRST key it finds, freshness was measured off the
    row's modification time: a device whose backup had not run in weeks looked
    fresh whenever anything else about the row changed.
    """
    from datetime import timezone

    dev = {
        "updated_at": "2026-07-28T12:00:00Z",     # row mtime — today
        "last_backup_at": "2026-07-01T00:00:00Z",  # actual backup — weeks old
    }
    got = _last_backup(dev)
    assert got is not None
    assert (got.year, got.month, got.day) == (2026, 7, 1), \
        "must report the real backup time, not the row mtime"
    assert got.tzinfo is not None

    # updated_at is still honoured when it is genuinely all that exists.
    only_mtime = _last_backup({"updated_at": "2026-07-28T12:00:00Z"})
    assert only_mtime is not None and only_mtime.day == 28

    # And a real backup field wins regardless of dict insertion order.
    reordered = {"last_backup_at": "2026-07-01T00:00:00Z", "updated_at": "2026-07-28T12:00:00Z"}
    assert _last_backup(reordered).day == 1


# --- snippet deploy (rConfig V8.4: dynamic_vars + wait) ---------------------

import json as _json

import httpx as _httpx
import pytest as _pytest

from netmon.collectors import rconfig_client as _rcc

_REAL_ASYNC_CLIENT = _httpx.AsyncClient


def _deploy_with(monkeypatch, payload, status=200):
    seen = {}

    def handler(request):
        seen["path"] = request.url.path
        seen["body"] = _json.loads(request.content)
        seen["token"] = request.headers.get("apitoken")
        return _httpx.Response(status, json=payload)

    def fake_client(*a, **kw):
        kw["transport"] = _httpx.MockTransport(handler)
        return _REAL_ASYNC_CLIENT(*a, **kw)

    monkeypatch.setattr(_rcc.httpx, "AsyncClient", fake_client)
    c = _rcc.RConfigClient(url="https://rc.example", token="t0k")
    return c, seen


def test_deploy_sends_dynamic_vars_and_wait(monkeypatch):
    payload = {"success": True, "message": "Snippet sent to 1 device(s)",
               "data": {"results": [{"device_id": 7, "status": "success"}]}}
    c, seen = _deploy_with(monkeypatch, payload)
    msg, code = asyncio.run(c.deploy_snippet(7, 4, {"port": "41", "member": "3"}))
    assert seen["path"] == "/api/v1/snippets/4/deploy"
    assert seen["token"] == "t0k"
    assert seen["body"] == {"devices": [7], "dynamic_vars": {"port": "41", "member": "3"},
                            "wait": True}
    assert "dynamicVariables" not in seen["body"]
    assert code == 200 and "success" in msg


@_pytest.mark.parametrize("status", ["failed", "connection_failed", "no_output", "weird"])
def test_deploy_device_failure_raises(monkeypatch, status):
    payload = {"success": True, "message": "Snippet sent to 1 device(s): 1 failed",
               "data": {"results": [{"device_id": 7, "status": status,
                                     "reason": "Device rejected it",
                                     "failed_line": "disable inline-power ports 3:41"}]}}
    c, _ = _deploy_with(monkeypatch, payload)
    with _pytest.raises(RConfigError) as ei:
        asyncio.run(c.deploy_snippet(7, 4, {"port": "41"}))
    assert status in str(ei.value) and "Device rejected it" in str(ei.value)


def test_deploy_not_checked_and_legacy_responses(monkeypatch):
    c, _ = _deploy_with(monkeypatch, {"success": True, "message": "ok",
                                      "data": {"results": [{"device_id": 7,
                                                            "status": "not_checked"}]}})
    msg, _ = asyncio.run(c.deploy_snippet(7, 4, {}))
    assert "not checked" in msg
    c, _ = _deploy_with(monkeypatch, {"success": True, "message": "queued", "data": "queued"})
    msg, _ = asyncio.run(c.deploy_snippet(7, 4, {}))
    assert "outcome not reported" in msg


def test_deploy_http_error_raises(monkeypatch):
    c, _ = _deploy_with(monkeypatch, {"message": "Forbidden"}, status=403)
    with _pytest.raises(RConfigError, match="HTTP 403"):
        asyncio.run(c.deploy_snippet(7, 4, {}))

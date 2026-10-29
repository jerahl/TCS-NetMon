"""VCA configuration read (spec 13 §11) — parse, decode, pull, store.

Every camera is a fake transport. The replies are shaped from the RCP+
reference's own CGI examples: numbers in `<result><hex/><dec/>`, strings in
`<result><str>`, an unknown command as `<result><err>0x40</err>`.
"""

import asyncio
from datetime import datetime, timezone

from sqlalchemy import text

from netmon import db
from netmon.cameras import vca
from netmon.cameras.vendors import bosch
from netmon.config import load_config
from tests.conftest import create_core_tables, write_config

NOW = datetime(2026, 10, 29, 14, 0, tzinfo=timezone.utc)


def _dec(n):
    return (f"<rcp><payload /><result><hex>0x{n:08x}</hex><dec>{n}</dec></result></rcp>")


def _str(s):
    return f"<rcp><payload /><result><str>{s}</str></result></rcp>"


ERR = "<rcp><payload /><result><err>0x40</err></result></rcp>"

#: What a camera on profile 2 answers, by command.
PROFILE_2 = {"0x0803": _dec(1), "0x0a65": _dec(2), "0x0a40": _str("Hallway"),
             "0x0804": _str("IVA"), "0x0a96": _dec(1)}


class FakeResponse:
    def __init__(self, status_code=200, text=""):
        self.status_code = status_code
        self.text = text


class FakeFleet:
    """`answers[ip][(command, line)]` or `answers[ip][command]` → reply body."""

    def __init__(self, answers, *, dead=()):
        self.answers = answers
        self.dead = set(dead)
        self.calls: list[str] = []

    def client(self):
        fleet = self

        class _Client:
            async def __aenter__(self_inner):
                return self_inner

            async def __aexit__(self_inner, *exc):
                return False

            async def get(self_inner, url, auth=None):
                fleet.calls.append(url)
                ip = url.split("//", 1)[1].split("/")[0].split(":")[0]
                if ip in fleet.dead:
                    raise ConnectionError("unreachable")
                q = dict(p.split("=", 1) for p in url.split("?", 1)[1].split("&"))
                by_ip = fleet.answers.get(ip, {})
                body = by_ip.get((q["command"], int(q.get("num", 0))),
                                 by_ip.get(q["command"], ERR))
                return FakeResponse(200, body)

        return _Client()


def _seed(url, cameras):
    engine = db.make_engine(url)
    create_core_tables(engine)
    with engine.begin() as c:
        for device_id, name, ip, vendor in cameras:
            c.execute(text("INSERT INTO devices (id,name,site,device_type,enabled) "
                           "VALUES (:i,:n,'BHS','camera',1)"), {"i": device_id, "n": name})
            c.execute(text("INSERT INTO cameras (device_id, vendor, ip, https_enabled, "
                           "https_port, updated_at) VALUES (:i,:v,:ip,0,NULL,:t)"),
                      {"i": device_id, "v": vendor, "ip": ip, "t": NOW})
    return engine


def _cfg(tmp_path):
    return load_config(write_config(
        tmp_path, extra_sections="[camera_ops]\nuser = svc-cam\npass = x"))


# ── the profile ───────────────────────────────────────────────────────────

def test_reads_are_reads_on_the_requested_line():
    reqs = bosch.vca_read_requests("http://10.1.1.1", line=2)
    assert [r["field"] for r in reqs] == ["viproc_id", "mode", "profile_name",
                                         "engine", "running"]
    for r in reqs:
        assert r["method"] == "GET"
        assert "direction=READ" in r["url"] and r["url"].endswith("&num=2")


def test_version_url_is_unchanged_without_a_line():
    assert bosch.rcp_read_url("http://x", "0x0cd4", type_="P_STRING") == (
        "http://x/rcp.xml?command=0x0cd4&type=P_STRING&direction=READ")


def test_parse_dec_reads_the_result_not_the_command():
    # `<command>` carries a <dec> too; only the one under <result> is the answer.
    body = ("<rcp><command><hex>0x0a65</hex><dec>2661</dec></command>"
            "<result><hex>0xfd</hex><dec>253</dec></result></rcp>")
    assert bosch.parse_dec(body) == 253
    assert bosch.parse_dec(ERR) is None


def test_mode_labels_follow_the_reference():
    assert bosch.vca_mode_label(3) == "profile 3"
    assert bosch.vca_mode_label(0xFD) == "off"
    assert bosch.vca_mode_label(0xFE) == "scheduler"
    assert bosch.vca_mode_label(0xFF) == "script"
    assert bosch.vca_mode_label(0x40) == "unknown (0x40)"
    assert bosch.vca_mode_label(None) is None


# ── the pull ──────────────────────────────────────────────────────────────

def test_pull_decodes_and_records_failures(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path}/t.db", [
        (1, "cam-a", "10.1.1.1", "Bosch1ch"),
        (2, "cam-b", "10.1.1.2", "Bosch1ch"),
        (3, "cam-c", "10.1.1.3", "Bosch1ch"),
        (4, "axis-d", "10.1.1.4", "AXIS"),       # no profile: not read at all
    ])
    fleet = FakeFleet({
        "10.1.1.1": PROFILE_2,
        "10.1.1.2": {**PROFILE_2, "0x0a65": _dec(0xFD), "0x0a96": ERR},
    }, dead={"10.1.1.3"})
    cameras = vca.cameras_to_read(engine)
    assert [c["name"] for c in cameras] == ["cam-a", "cam-b", "cam-c"]

    rows = asyncio.run(vca.pull(cameras, _cfg(tmp_path), client_factory=fleet.client))
    by = {r["name"]: r for r in rows}
    assert by["cam-a"]["mode_label"] == "profile 2"
    assert by["cam-a"]["profile_name"] == "Hallway"
    assert by["cam-a"]["running"] == 1 and by["cam-a"]["error"] is None
    assert by["cam-b"]["mode_label"] == "off"
    assert by["cam-b"]["error"] == "not answered: running"
    assert by["cam-c"]["mode"] is None and "ConnectionError" in by["cam-c"]["error"]
    assert not any("10.1.1.4" in u for u in fleet.calls)


def test_extra_lines_stop_where_the_camera_has_none(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path}/t.db", [(1, "cam-a", "10.1.1.1", "Bosch1ch")])
    answers = {(cmd, 1): body for cmd, body in PROFILE_2.items()}
    fleet = FakeFleet({"10.1.1.1": answers})
    rows = asyncio.run(vca.pull(vca.cameras_to_read(engine), _cfg(tmp_path), lines=4,
                                client_factory=fleet.client))
    assert [r["line"] for r in rows] == [1]


def test_store_keeps_last_good_values_when_a_camera_goes_quiet(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path}/t.db", [(1, "cam-a", "10.1.1.1", "Bosch1ch")])
    cfg = _cfg(tmp_path)
    cams = vca.cameras_to_read(engine)
    vca.store(engine, asyncio.run(vca.pull(
        cams, cfg, client_factory=FakeFleet({"10.1.1.1": PROFILE_2}).client)))
    vca.store(engine, asyncio.run(vca.pull(
        cams, cfg, client_factory=FakeFleet({}, dead={"10.1.1.1"}).client)))

    row = db.fetch_one(engine, "SELECT * FROM camera_vca WHERE device_id = 1 AND line = 1")
    assert row["mode_label"] == "profile 2" and row["profile_name"] == "Hallway"
    assert "ConnectionError" in row["error"]
    assert row["checked_at"] != row["updated_at"]


def test_camera_filter_and_report(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path}/t.db", [
        (1, "cam-a", "10.1.1.1", "Bosch1ch"), (2, "cam-b", "10.1.1.2", "Bosch1ch")])
    assert [c["name"] for c in vca.cameras_to_read(engine, "cam-b")] == ["cam-b"]
    rows = asyncio.run(vca.pull(vca.cameras_to_read(engine, "cam-b"), _cfg(tmp_path),
                                client_factory=FakeFleet({"10.1.1.2": PROFILE_2}).client))
    report = vca.format_report(rows)
    assert "cam-b" in report and "Hallway" in report
    assert report.endswith("lines by mode: profile 2 1")

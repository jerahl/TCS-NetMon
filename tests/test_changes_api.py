"""Change tracking API (spec 24 §10).

Most of these tests defend one idea: the record has to stay trustworthy after
the fact. A change log that can be tidied once the answer is known is one that
will be, and then it records nothing worth reading.

So the sharp edges get the attention — `expected` locking at apply, a verdict
being refused on something that never happened, a live change refusing to be
deleted, and an applied-but-unverified change being surfaced rather than
waiting to be filtered for.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config


def _client(tmp_path, *, role="operator"):
    tmp_path.mkdir(parents=True, exist_ok=True)
    url = f"sqlite:///{tmp_path/'api.db'}"
    engine = db.make_engine(url)
    if not inspect(engine).has_table("changes"):
        create_core_tables(engine)
        with engine.begin() as c:
            c.execute(text(
                "INSERT INTO devices (id,name,site,device_type,enabled) VALUES "
                "(1,'NMS-B111','Northridge Middle','ap',1),"
                "(2,'NMS-B108','Northridge Middle','ap',1),"
                "(3,'NMS-IDF-A102','Northridge Middle','switch',1)"))
            c.execute(text(
                "INSERT INTO issues (id,title,body,status,severity,category,"
                "reported_by,created_at,updated_at) VALUES "
                "(1,'Session table growth','x','open','crit','wireless',"
                "'sappleby','2026-10-01','2026-10-01')"))
    engine.dispose()
    conf = write_config(tmp_path, db_url=url,
                        extra_sections=f"[issues]\nattachment_dir = {tmp_path/'att'}")
    if role != "admin":
        conf.write_text(conf.read_text().replace("dev_bypass_role = admin",
                                                 f"dev_bypass_role = {role}"))
    return TestClient(create_app(config=load_config(conf), supervisor=Supervisor())), url


def _propose(client, **over):
    body = {
        "title": "Shorten DNS session timeout to 10s on NMS-B111",
        "what": "XIQ service object: DNS udp/53 timeout 60s → 10s, Students ip-policy.",
        "why": "DNS is 73% of the session table and each lookup is held 60s for a "
               "sub-second exchange.",
        "expected": "DNS entries 4,620 → ~1,087 (−76%). Total sessions well under "
                    "16,383 across a school day. No client-visible effect.",
        "issue_id": 1,
        "risk": "low",
        "rollback": "Restore the 60s timeout in XIQ and push.",
        "target_device_ids": [1],
        "baseline_device_ids": [2],
    }
    body.update(over)
    return client.post("/api/changes", json=body)


# ── the round trip ───────────────────────────────────────────────────────────

def test_propose_apply_verify(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        created = _propose(client)
        assert created.status_code == 201, created.text
        c = created.json()
        cid = c["id"]
        assert c["status"] == "proposed"
        assert c["verdict"] == "pending"
        assert c["actual"] is None
        assert c["issue"]["id"] == 1

        assert client.post(f"/api/changes/{cid}/apply", json={}).status_code == 200
        applied = client.get(f"/api/changes/{cid}").json()
        assert applied["status"] == "applied"
        assert applied["applied_at"] and applied["applied_by"] == "devadmin"
        assert applied["verdict"] == "pending"

        done = client.post(f"/api/changes/{cid}/verify", json={
            "actual": "DNS entries 4,620 → 1,140 (−75%). Peak total 3,980.",
            "verdict": "as_expected"})
        assert done.status_code == 200
        v = done.json()
        assert v["status"] == "verified"
        assert v["verdict"] == "as_expected"
        assert "1,140" in v["actual"]
        # The prediction survives alongside the result — that is the point.
        assert "4,620 → ~1,087" in v["expected"]


def test_target_and_baseline_are_distinguishable(tmp_path):
    """The standing method is change one AP, hold a neighbour as a control. A
    record that lists both without saying which was which cannot be read."""
    client, _ = _client(tmp_path)
    with client:
        c = _propose(client).json()
        roles = {d["name"]: d["role"] for d in c["devices"]}
        assert roles == {"NMS-B111": "target", "NMS-B108": "baseline"}


def test_a_device_cannot_be_both_target_and_baseline(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        bad = _propose(client, target_device_ids=[1, 2], baseline_device_ids=[2])
        assert bad.status_code == 409
        assert "both a target and a baseline" in bad.json()["detail"]


# ── the rule that matters ────────────────────────────────────────────────────

def test_expected_locks_once_applied(tmp_path):
    """A prediction that can be revised after the result is known is not a
    prediction. This is the single rule the table exists to enforce."""
    client, _ = _client(tmp_path)
    with client:
        cid = _propose(client).json()["id"]
        # Editable while it is still only proposed.
        assert client.patch(f"/api/changes/{cid}",
                            json={"expected": "sharpened before applying"}).status_code == 200

        client.post(f"/api/changes/{cid}/apply", json={})
        locked = client.patch(f"/api/changes/{cid}", json={"expected": "what I meant"})
        assert locked.status_code == 409
        assert "cannot be edited once a change has been applied" in locked.json()["detail"]

        # Everything else stays editable — a rollback note is worth improving
        # at any point.
        assert client.patch(f"/api/changes/{cid}",
                            json={"rollback": "Also revert the NTP object."}).status_code == 200


def test_cannot_verify_something_that_was_never_applied(tmp_path):
    """A result for a change that did not happen is the one entry that would
    make the whole log untrustworthy."""
    client, _ = _client(tmp_path)
    with client:
        cid = _propose(client).json()["id"]
        bad = client.post(f"/api/changes/{cid}/verify",
                          json={"actual": "looked fine", "verdict": "as_expected"})
        assert bad.status_code == 409
        assert "has not been applied" in bad.json()["detail"]


def test_verifying_requires_an_actual_verdict(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        cid = _propose(client).json()["id"]
        client.post(f"/api/changes/{cid}/apply", json={})
        bad = client.post(f"/api/changes/{cid}/verify",
                          json={"actual": "unclear", "verdict": "pending"})
        assert bad.status_code == 409


def test_negative_verdicts_are_first_class(tmp_path):
    """A change log where every entry reads as a success teaches nothing."""
    client, _ = _client(tmp_path)
    with client:
        for verdict in ("no_effect", "worse", "partial"):
            cid = _propose(client, title=f"Change judged {verdict}").json()["id"]
            client.post(f"/api/changes/{cid}/apply", json={})
            r = client.post(f"/api/changes/{cid}/verify",
                            json={"actual": "measured", "verdict": verdict})
            assert r.status_code == 200
            assert r.json()["verdict"] == verdict


# ── outstanding work ─────────────────────────────────────────────────────────

def test_outstanding_lists_applied_but_unverified(tmp_path):
    """The number the page leads with. Left as a filter nobody applies it."""
    client, _ = _client(tmp_path)
    with client:
        unverified = _propose(client, title="Applied, never checked").json()["id"]
        client.post(f"/api/changes/{unverified}/apply", json={})

        checked = _propose(client, title="Applied and checked").json()["id"]
        client.post(f"/api/changes/{checked}/apply", json={})
        client.post(f"/api/changes/{checked}/verify",
                    json={"actual": "fine", "verdict": "as_expected"})

        _propose(client, title="Only proposed")

        out = client.get("/api/changes/outstanding").json()
        assert out["count"] == 1
        assert [c["id"] for c in out["changes"]] == [unverified]


def test_status_live_and_unverified_pseudo_filters(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        a = _propose(client, title="Applied, unverified").json()["id"]
        b = _propose(client, title="Applied and verified").json()["id"]
        _propose(client, title="Still only proposed")
        client.post(f"/api/changes/{a}/apply", json={})
        client.post(f"/api/changes/{b}/apply", json={})
        client.post(f"/api/changes/{b}/verify",
                    json={"actual": "x", "verdict": "partial"})

        live = {c["id"] for c in client.get("/api/changes?status=live").json()}
        assert live == {a, b}
        unver = {c["id"] for c in client.get("/api/changes?status=unverified").json()}
        assert unver == {a}


# ── the issue timeline ───────────────────────────────────────────────────────

def test_lifecycle_lands_on_the_issue_timeline(tmp_path):
    """Changes get no thread of their own — a second comment system would split
    one problem's story across two places."""
    client, _ = _client(tmp_path)
    with client:
        cid = _propose(client).json()["id"]
        client.post(f"/api/changes/{cid}/apply", json={"note": "Pushed at 06:40."})
        client.post(f"/api/changes/{cid}/verify",
                    json={"actual": "DNS entries down 75%.", "verdict": "as_expected"})

        timeline = client.get("/api/issues/1").json()["comments"]
        bodies = "\n".join(c["body"] for c in timeline)
        assert f"change #{cid} proposed" in bodies
        assert f"change #{cid} applied" in bodies
        assert "Pushed at 06:40." in bodies
        assert f"change #{cid} verified — as_expected" in bodies
        # Both halves of the comparison reach the issue, not just the outcome.
        assert "Expected:" in bodies and "Actual:" in bodies
        assert all(c["kind"] == "status_change" for c in timeline)


def test_a_change_without_an_issue_is_allowed(tmp_path):
    """Routine work happens that nobody opened an issue for; refusing it means
    it goes unrecorded, not that an issue gets opened."""
    client, _ = _client(tmp_path)
    with client:
        c = _propose(client, issue_id=None)
        assert c.status_code == 201
        assert c.json()["issue"] is None


def test_an_unknown_issue_is_refused(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        assert _propose(client, issue_id=999).status_code == 409


# ── revert and delete ────────────────────────────────────────────────────────

def test_revert_keeps_the_record(tmp_path):
    """A change that had to be backed out is the most informative row here."""
    client, _ = _client(tmp_path)
    with client:
        cid = _propose(client).json()["id"]
        client.post(f"/api/changes/{cid}/apply", json={})
        r = client.post(f"/api/changes/{cid}/revert",
                        json={"note": "Clients lost DNS intermittently."})
        assert r.status_code == 200
        assert r.json()["status"] == "reverted"
        assert r.json()["reverted_at"]
        assert "REVERTED" in "\n".join(
            c["body"] for c in client.get("/api/issues/1").json()["comments"])


def test_cannot_revert_what_was_never_applied(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        cid = _propose(client).json()["id"]
        bad = client.post(f"/api/changes/{cid}/revert", json={})
        assert bad.status_code == 409
        assert "abandoned" in bad.json()["detail"]


def test_a_live_change_cannot_be_deleted(tmp_path):
    """Deleting it would leave the configuration with no explanation."""
    client, _ = _client(tmp_path, role="admin")
    with client:
        cid = _propose(client).json()["id"]
        client.post(f"/api/changes/{cid}/apply", json={})
        bad = client.delete(f"/api/changes/{cid}")
        assert bad.status_code == 409
        assert "on the network" in bad.json()["detail"]
        # Reverted, it is no longer live and may be removed.
        client.post(f"/api/changes/{cid}/revert", json={})
        assert client.delete(f"/api/changes/{cid}").status_code == 200


# ── roles ────────────────────────────────────────────────────────────────────

def test_viewers_read_but_never_record(tmp_path):
    """Deliberately unlike issues, where a viewer may file a report. Recording
    that the network was reconfigured is not something a reporter can do."""
    client, _ = _client(tmp_path, role="operator")
    with client:
        cid = _propose(client).json()["id"]

    ro, _ = _client(tmp_path, role="viewer")
    with ro:
        assert ro.get("/api/changes").status_code == 200
        assert ro.get(f"/api/changes/{cid}").status_code == 200
        assert ro.get("/api/changes/outstanding").status_code == 200
        assert _propose(ro).status_code == 403
        assert ro.post(f"/api/changes/{cid}/apply", json={}).status_code == 403
        assert ro.patch(f"/api/changes/{cid}", json={"why": "no"}).status_code == 403


def test_delete_is_admin_only(tmp_path):
    client, _ = _client(tmp_path, role="operator")
    with client:
        cid = _propose(client).json()["id"]
        assert client.delete(f"/api/changes/{cid}").status_code == 403


def test_meta_reports_capability(tmp_path):
    for role, record in (("viewer", False), ("operator", True)):
        client, _ = _client(tmp_path / role, role=role)
        with client:
            meta = client.get("/api/changes/meta").json()
            assert meta["can"]["record"] is record
            assert "as_expected" in meta["verdicts"]
            assert "worse" in meta["verdicts"]


# ── filters ──────────────────────────────────────────────────────────────────

def test_filters(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        cid = _propose(client, site="Northridge Middle").json()["id"]
        assert client.get("/api/changes?issue_id=1").json()
        assert client.get("/api/changes?device_id=1").json()
        assert client.get("/api/changes?device_id=2").json()   # the baseline counts
        assert client.get("/api/changes?site=Northridge+Middle").json()
        assert client.get("/api/changes?q=DNS").json()
        assert client.get("/api/changes?issue_id=2").json() == []
        assert client.get("/api/changes?device_id=3").json() == []
        row = client.get("/api/changes").json()[0]
        assert row["id"] == cid
        assert row["target_count"] == 1 and row["baseline_count"] == 1
        assert row["issue_title"] == "Session table growth"


def test_bad_vocabulary_is_refused(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        assert _propose(client, risk="catastrophic").status_code == 409
        cid = _propose(client).json()["id"]
        assert client.patch(f"/api/changes/{cid}",
                            json={"status": "nearly"}).status_code == 409
        assert client.patch(f"/api/changes/{cid}",
                            json={"verdict": "great"}).status_code == 409


def test_disabled_tracker_404s(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        _propose(client)
    conf = tmp_path / "netmon.conf"
    conf.write_text(conf.read_text().replace("[issues]", "[issues]\nenabled = false"))
    off = TestClient(create_app(config=load_config(conf), supervisor=Supervisor()))
    with off:
        assert off.get("/api/changes").status_code == 404
        assert off.get("/api/changes/outstanding").status_code == 404

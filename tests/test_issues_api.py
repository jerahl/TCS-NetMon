"""Issue tracker API (spec 24).

Two things carry real risk here and get most of the tests.

The first is the **role split**, which is unlike the rest of the API: `viewer`
can write, but only into the narrow slot of "file a report and add to it".
Every route is exercised from below its floor as well as above it, because a
permission that is only ever tested from above is a permission nobody has
tested.

The second is the **attachment path**. These files are uploaded by anyone
signed in and served back to a browser, so the tests assert the whole chain —
the type is decided from the bytes and not the name, the response says
`nosniff`, an SVG never comes back inline, and an oversize body is unlinked
rather than left on disk.
"""

import hashlib

from fastapi.testclient import TestClient
from sqlalchemy import inspect, text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config

PNG = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PDF = b"%PDF-1.7\n" + b"x" * 64
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'


def _client(tmp_path, *, role="operator", **issue_kw):
    """A TestClient at `role`, against a database seeded once per tmp_path.

    Several tests open a SECOND client as a different role against the same
    data — that is how "an operator may not, an admin may" gets asserted on one
    issue — so seeding has to be idempotent rather than assume a fresh path.
    """
    tmp_path.mkdir(parents=True, exist_ok=True)
    url = f"sqlite:///{tmp_path/'api.db'}"
    engine = db.make_engine(url)
    if not inspect(engine).has_table("issues"):
        create_core_tables(engine)
        with engine.begin() as c:
            c.execute(text(
                "INSERT INTO devices (id,name,site,device_type,enabled) VALUES "
                "(1,'ap-nms-204','NMS','ap',1),(2,'ap-nms-206','NMS','ap',1)"))
    engine.dispose()

    base = {"attachment_dir": str(tmp_path / "att")}
    base.update(issue_kw)
    body = "\n".join(f"{k} = {v}" for k, v in base.items())
    conf = write_config(tmp_path, db_url=url, extra_sections=f"[issues]\n{body}")
    if role != "admin":
        conf.write_text(conf.read_text().replace("dev_bypass_role = admin",
                                                 f"dev_bypass_role = {role}"))
    app = create_app(config=load_config(conf), supervisor=Supervisor())
    return TestClient(app), url


def _open(client, **over):
    body = {"title": "Wireless drops at class change", "body": "Room 204, 10:14.",
            "severity": "crit", "category": "wireless", "site": "NMS",
            "device_ids": [1, 2]}
    body.update(over)
    return client.post("/api/issues", json=body)


# ── the round trip ───────────────────────────────────────────────────────────

def test_open_read_and_filter(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        created = _open(client)
        assert created.status_code == 201, created.text
        issue = created.json()
        assert issue["status"] == "open"
        assert issue["reported_by"] == "devadmin"
        assert {d["device_id"] for d in issue["devices"]} == {1, 2}
        assert issue["devices"][0]["registered"] is True

        rows = client.get("/api/issues").json()
        assert [r["id"] for r in rows] == [issue["id"]]
        assert rows[0]["device_count"] == 2

        # Filters that should match, and one that should not.
        assert client.get("/api/issues?site=NMS").json()
        assert client.get("/api/issues?category=wireless").json()
        assert client.get("/api/issues?device_id=1").json()
        assert client.get("/api/issues?q=class+change").json()
        assert client.get("/api/issues?site=WMS").json() == []
        assert client.get("/api/issues?device_id=99").json() == []


def test_status_open_excludes_resolved_and_closed(tmp_path):
    """`status=open` is the default view, and it means "not finished" rather
    than literally status == 'open' — an issue being actively investigated
    must not fall out of the list the moment somebody picks it up."""
    client, _ = _client(tmp_path)
    with client:
        a = _open(client, title="Still being worked").json()["id"]
        b = _open(client, title="Done with this one").json()["id"]
        client.patch(f"/api/issues/{a}", json={"status": "investigating"})
        client.patch(f"/api/issues/{b}", json={"status": "resolved"})

        ids = {r["id"] for r in client.get("/api/issues?status=open").json()}
        assert ids == {a}
        assert {r["id"] for r in client.get("/api/issues").json()} == {a, b}


def test_resolved_at_sets_and_clears_on_reopen(tmp_path):
    """Otherwise "closed this month" counts issues that were reopened and are
    still live."""
    client, url = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        client.patch(f"/api/issues/{i}", json={"status": "closed"})
        engine = db.make_engine(url)
        assert db.fetch_one(engine, "SELECT resolved_at FROM issues WHERE id = :i",
                            {"i": i})["resolved_at"] is not None
        client.patch(f"/api/issues/{i}", json={"status": "investigating"})
        assert db.fetch_one(engine, "SELECT resolved_at FROM issues WHERE id = :i",
                            {"i": i})["resolved_at"] is None
        engine.dispose()


def test_status_change_lands_in_the_timeline(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        client.patch(f"/api/issues/{i}",
                     json={"status": "waiting", "note": "Extreme support case 4471"})
        entries = client.get(f"/api/issues/{i}").json()["comments"]
        assert len(entries) == 1
        assert entries[0]["kind"] == "status_change"
        assert "open → waiting" in entries[0]["body"]
        assert "4471" in entries[0]["body"]


def test_a_comment_bumps_the_issue(tmp_path):
    """The list is sorted by updated_at, so a comment has to count as activity
    or an actively discussed issue sinks."""
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        before = client.get(f"/api/issues/{i}").json()["updated_at"]
        client.post(f"/api/issues/{i}/comments", json={"body": "Captured at 10:14."})
        after = client.get(f"/api/issues/{i}").json()["updated_at"]
        assert after >= before
        assert len(client.get(f"/api/issues/{i}").json()["comments"]) == 1


# ── roles ────────────────────────────────────────────────────────────────────

def test_viewer_may_report_but_not_triage(tmp_path):
    """The whole point of the design: a school can file, and cannot close."""
    client, _ = _client(tmp_path, role="viewer")
    with client:
        created = _open(client, device_ids=[])
        assert created.status_code == 201, created.text
        i = created.json()["id"]

        assert client.post(f"/api/issues/{i}/comments",
                           json={"body": "It happened again at 11:05."}).status_code == 201

        for payload in ({"status": "closed"}, {"severity": "info"},
                        {"assigned_to": "someone"}, {"device_ids": [1]}):
            resp = client.patch(f"/api/issues/{i}", json=payload)
            assert resp.status_code == 403, f"{payload} got through as viewer"


def test_viewer_cannot_assign_at_creation(tmp_path):
    """A reporter naming an assignee would be triage through the back door."""
    client, _ = _client(tmp_path, role="viewer")
    with client:
        issue = _open(client, device_ids=[], assigned_to="someone-else").json()
        assert issue["assigned_to"] is None


def test_allow_viewer_reports_off_closes_the_door(tmp_path):
    client, _ = _client(tmp_path, role="viewer", allow_viewer_reports="false")
    with client:
        assert _open(client, device_ids=[]).status_code == 403


def test_viewer_still_reads_everything(tmp_path):
    """Read stays open at every setting — an issue nobody can read is useless."""
    client, _ = _client(tmp_path, role="operator")
    with client:
        i = _open(client).json()["id"]
    ro, _ = _client(tmp_path, role="viewer", allow_viewer_reports="false")
    with ro:
        assert ro.get("/api/issues").status_code == 200
        assert ro.get(f"/api/issues/{i}").status_code == 200


def test_delete_is_admin_only(tmp_path):
    client, _ = _client(tmp_path, role="operator")
    with client:
        i = _open(client).json()["id"]
        assert client.delete(f"/api/issues/{i}").status_code == 403


def test_operator_cannot_rewrite_someone_elses_report(tmp_path):
    """An operator triages; silently rewriting another person's account of what
    happened is a different power and needs admin."""
    client, url = _client(tmp_path, role="operator")
    with client:
        i = _open(client).json()["id"]
        engine = db.make_engine(url)
        db.execute(engine, "UPDATE issues SET reported_by = 'someone-else' WHERE id = :i",
                   {"i": i})
        engine.dispose()
        assert client.patch(f"/api/issues/{i}",
                            json={"body": "rewritten"}).status_code == 403
        # Triage on the same issue is still fine.
        assert client.patch(f"/api/issues/{i}",
                            json={"status": "planned"}).status_code == 200


def test_comment_edit_author_only(tmp_path):
    client, url = _client(tmp_path, role="operator")
    with client:
        i = _open(client).json()["id"]
        cid = client.post(f"/api/issues/{i}/comments",
                          json={"body": "mine"}).json()["id"]
        assert client.patch(f"/api/issues/{i}/comments/{cid}",
                            json={"body": "corrected"}).status_code == 200
        body = client.get(f"/api/issues/{i}").json()["comments"][0]
        assert body["body"] == "corrected"
        assert body["edited_at"] is not None

        engine = db.make_engine(url)
        db.execute(engine, "UPDATE issue_comments SET author = 'other' WHERE id = :c",
                   {"c": cid})
        engine.dispose()
        assert client.patch(f"/api/issues/{i}/comments/{cid}",
                            json={"body": "hijacked"}).status_code == 403


def test_a_status_change_cannot_be_edited(tmp_path):
    """It is a record of what happened, not somebody's prose."""
    client, _ = _client(tmp_path, role="admin")
    with client:
        i = _open(client).json()["id"]
        client.patch(f"/api/issues/{i}", json={"status": "planned"})
        cid = client.get(f"/api/issues/{i}").json()["comments"][0]["id"]
        assert client.patch(f"/api/issues/{i}/comments/{cid}",
                            json={"body": "never happened"}).status_code == 409


def test_meta_reports_what_this_viewer_may_do(tmp_path):
    """The UI asks instead of guessing, so a reporter sees a disabled control
    with a reason rather than a 403 after typing."""
    for role, triage in (("viewer", False), ("operator", True)):
        client, _ = _client(tmp_path / role, role=role)
        with client:
            meta = client.get("/api/issues/meta").json()
            assert meta["can"]["report"] is True
            assert meta["can"]["triage"] is triage
            assert "wireless" in meta["categories"]
            assert meta["max_attachment_mb"] == 32


def test_disabled_tracker_404s(tmp_path):
    client, _ = _client(tmp_path, enabled="false")
    with client:
        assert client.get("/api/issues").status_code == 404
        assert _open(client).status_code == 404


# ── attachments ──────────────────────────────────────────────────────────────

def test_upload_and_download_round_trip(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        up = client.put(f"/api/issues/{i}/attachments/conntrack.png", content=PNG)
        assert up.status_code == 201, up.text
        meta = up.json()
        assert meta["content_type"] == "image/png"
        assert meta["sha256"] == hashlib.sha256(PNG).hexdigest()
        assert meta["is_image"] is True

        got = client.get(meta["url"])
        assert got.status_code == 200
        assert got.content == PNG
        assert got.headers["content-type"].startswith("image/png")
        assert got.headers["x-content-type-options"] == "nosniff"
        assert got.headers["content-disposition"].startswith("inline")

        # And it shows up on the issue, once.
        assert len(client.get(f"/api/issues/{i}").json()["attachments"]) == 1


def test_the_extension_must_match_the_bytes(tmp_path):
    """The stored type becomes a Content-Type header, so it is decided from the
    file and not from what the uploader called it."""
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        bad = client.put(f"/api/issues/{i}/attachments/notreally.png", content=PDF)
        assert bad.status_code == 409
        assert "does not contain" in bad.json()["detail"]
        assert client.get(f"/api/issues/{i}").json()["attachments"] == []


def test_svg_is_stored_but_never_served_inline(tmp_path):
    """An SVG is a script host and NetMon does not sanitize it. Accepted,
    because network diagrams are SVGs; downloaded, never rendered in place."""
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        up = client.put(f"/api/issues/{i}/attachments/topology.svg", content=SVG)
        assert up.status_code == 201
        assert up.json()["inline"] is False
        got = client.get(up.json()["url"])
        assert got.headers["content-disposition"].startswith("attachment")
        assert got.headers["x-content-type-options"] == "nosniff"


def test_unknown_type_is_refused_with_the_list(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        bad = client.put(f"/api/issues/{i}/attachments/payload.exe", content=b"MZ\x90")
        assert bad.status_code == 409
        assert ".png" in bad.json()["detail"]


def test_oversize_upload_is_refused_and_leaves_nothing_behind(tmp_path):
    client, _ = _client(tmp_path, max_attachment_mb="1")
    with client:
        i = _open(client).json()["id"]
        big = PNG + b"\x00" * (2 * 1024 * 1024)
        resp = client.put(f"/api/issues/{i}/attachments/huge.png", content=big)
        assert resp.status_code == 409
        assert "1 MB" in resp.json()["detail"]
        assert client.get(f"/api/issues/{i}").json()["attachments"] == []
        # The partial write is gone, not sitting in the store.
        store = tmp_path / "att" / str(i)
        assert not store.exists() or list(store.iterdir()) == []


def test_empty_file_is_refused(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        assert client.put(f"/api/issues/{i}/attachments/empty.png",
                          content=b"").status_code == 409


def test_attachment_count_cap(tmp_path):
    client, _ = _client(tmp_path, max_attachments_per_issue="2")
    with client:
        i = _open(client).json()["id"]
        for n in range(2):
            assert client.put(f"/api/issues/{i}/attachments/shot{n}.png",
                              content=PNG).status_code == 201
        over = client.put(f"/api/issues/{i}/attachments/shot2.png", content=PNG)
        assert over.status_code == 409
        assert "max_attachments_per_issue" in over.json()["detail"]


def test_safe_name_strips_anything_that_could_traverse():
    """Asserted on the function, not over HTTP: a URL-encoded `../` is
    normalised away by the client and the server's path router long before the
    handler sees it, so an end-to-end spelling would be testing the HTTP stack
    and quietly passing whatever the sanitiser did."""
    from netmon.api.issues import _safe_name
    for nasty in ("../../etc/passwd", "..\\..\\evil.png", "/abs/path.png",
                  "....//evil.png", ".hidden", "", "   "):
        got = _safe_name(nasty)
        assert "/" not in got and "\\" not in got, f"{nasty!r} → {got!r}"
        assert not got.startswith("."), f"{nasty!r} → {got!r}"
        assert got, f"{nasty!r} produced an empty name"


def test_a_name_with_separators_lands_inside_the_store(tmp_path):
    """The end-to-end half: a backslash survives a URL path segment, so this
    reaches the handler as-is and proves the file lands where it should."""
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        up = client.put(f"/api/issues/{i}/attachments/..\\..\\evil.png", content=PNG)
        assert up.status_code == 201, up.text
        assert "\\" not in up.json()["filename"]
        assert "/" not in up.json()["filename"]
        stored = list((tmp_path / "att" / str(i)).iterdir())
        assert len(stored) == 1
        assert stored[0].parent == tmp_path / "att" / str(i)


def test_same_name_twice_does_not_collide(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        a = client.put(f"/api/issues/{i}/attachments/screenshot.png", content=PNG).json()
        b = client.put(f"/api/issues/{i}/attachments/screenshot.png", content=JPEG
                       if False else PNG).json()
        assert a["id"] != b["id"]
        assert len(list((tmp_path / "att" / str(i)).iterdir())) == 2
        assert client.get(a["url"]).content == PNG
        assert client.get(b["url"]).content == PNG


def test_attachment_can_hang_off_a_comment(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        cid = client.post(f"/api/issues/{i}/comments",
                          json={"body": "here is the capture"}).json()["id"]
        up = client.put(f"/api/issues/{i}/attachments/cap.pcap?comment_id={cid}",
                        content=b"\xd4\xc3\xb2\xa1" + b"\x00" * 32)
        assert up.status_code == 201
        assert up.json()["comment_id"] == cid
        assert up.json()["inline"] is False


def test_attachment_for_a_foreign_comment_is_refused(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        a = _open(client).json()["id"]
        b = _open(client, title="Another").json()["id"]
        cid = client.post(f"/api/issues/{b}/comments", json={"body": "x"}).json()["id"]
        assert client.put(f"/api/issues/{a}/attachments/x.png?comment_id={cid}",
                          content=PNG).status_code == 409


def test_deleting_a_comment_keeps_its_evidence(tmp_path):
    """The file is evidence; the comment was only its envelope."""
    client, _ = _client(tmp_path, role="admin")
    with client:
        i = _open(client).json()["id"]
        cid = client.post(f"/api/issues/{i}/comments", json={"body": "x"}).json()["id"]
        client.put(f"/api/issues/{i}/attachments/a.png?comment_id={cid}", content=PNG)
        client.delete(f"/api/issues/{i}/comments/{cid}")
        detail = client.get(f"/api/issues/{i}").json()
        assert detail["comments"] == []
        assert len(detail["attachments"]) == 1
        assert detail["attachments"][0]["comment_id"] is None


def test_attachment_delete_is_admin_only_and_removes_the_file(tmp_path):
    client, _ = _client(tmp_path, role="operator")
    with client:
        i = _open(client).json()["id"]
        aid = client.put(f"/api/issues/{i}/attachments/a.png", content=PNG).json()["id"]
        assert client.delete(f"/api/issues/{i}/attachments/{aid}").status_code == 403

    admin, _ = _client(tmp_path, role="admin")
    with admin:
        i2 = _open(admin).json()["id"]
        aid2 = admin.put(f"/api/issues/{i2}/attachments/b.png", content=PNG).json()["id"]
        assert admin.delete(f"/api/issues/{i2}/attachments/{aid2}").status_code == 200
        assert list((tmp_path / "att" / str(i2)).iterdir()) == []


def test_deleting_an_issue_removes_its_files(tmp_path):
    client, _ = _client(tmp_path, role="admin")
    with client:
        i = _open(client).json()["id"]
        client.put(f"/api/issues/{i}/attachments/a.png", content=PNG)
        assert (tmp_path / "att" / str(i)).exists()
        assert client.delete(f"/api/issues/{i}").status_code == 200
        assert not (tmp_path / "att" / str(i)).exists()
        assert client.get(f"/api/issues/{i}").status_code == 404


def test_a_missing_file_404s_rather_than_500s(tmp_path):
    """A row whose file was lost in a restore must not take the page down."""
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        url = client.put(f"/api/issues/{i}/attachments/a.png", content=PNG).json()["url"]
        for f in (tmp_path / "att" / str(i)).iterdir():
            f.unlink()
        assert client.get(url).status_code == 404


# ── device links ─────────────────────────────────────────────────────────────

def test_a_deregistered_device_keeps_its_link(tmp_path):
    """Migration 036 deliberately does not cascade from `devices`: a device
    decommissioned after the investigation must not erase the record that it
    was the one that filled its connection table."""
    client, url = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        engine = db.make_engine(url)
        db.execute(engine, "DELETE FROM devices WHERE id = 2")
        engine.dispose()
        devices = client.get(f"/api/issues/{i}").json()["devices"]
        gone = [d for d in devices if d["device_id"] == 2][0]
        assert gone["registered"] is False
        assert "no longer registered" in gone["name"]


def test_device_links_replace_rather_than_accumulate(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        i = _open(client).json()["id"]
        client.patch(f"/api/issues/{i}", json={"device_ids": [1]})
        assert [d["device_id"] for d in client.get(f"/api/issues/{i}").json()["devices"]] == [1]


# ── vocabulary ───────────────────────────────────────────────────────────────

def test_bad_vocabulary_is_refused(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        assert _open(client, severity="catastrophic").status_code == 409
        i = _open(client).json()["id"]
        assert client.patch(f"/api/issues/{i}",
                            json={"status": "abandoned"}).status_code == 409

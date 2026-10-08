"""Helpdesk adapter + API (docs/spec/25-helpdesk.md).

A fake Frontline server (httpx.MockTransport) stands in for the real one. Its
payload shapes follow the workbook: login returns {token, refreshToken}; the
export grid returns {totalCount, result} with ``result`` a JSON *string*.
Field names in the fake rows are the workbook's candidates — the live probe
(scripts/helpdesk_probe.py) is what confirms them against the real instance.
"""

from __future__ import annotations

import base64
import json
import logging
import time
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import HelpdeskConfig, load_config
from netmon.helpdesk import (FrontlineClient, HelpdeskError, html_to_text,
                             normalize_ticket, parse_grid, parse_login, parse_rows)
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config

KEY, PASS = "sekret-key-123", "sekret-pass-456"


# ── fake Frontline ───────────────────────────────────────────────────────────

def _jwt(exp: float) -> str:
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
    return f"{enc({'alg': 'none'})}.{enc({'exp': int(exp)})}.sig"


# Shapes as returned by the live instance (probe, 2026-10-08, Frontline
# v10.2.0): export rows carry `ticketSummary`, `site`, `location`,
# `problemTypeHierarchy`, `assignedTo` and no active flag; GET Ticket/{n}
# nests site/location/category/description under `ticketDetails`.
TICKETS = [
    {"ticketNumber": 4821, "ticketSummary": "Projector dead in 204", "statusName": "Open",
     "statusID": 1, "priorityName": "High", "ticketPriorityID": 2, "site": "Central High",
     "location": "Room 204", "problemTypeHierarchy": "AV > Projector",
     "assignedTo": "Tech A", "assignedToUserID": 7,
     "createdDate": "2026-10-01T14:00:00Z", "lastModifiedDate": "2026-10-07T09:00:00Z",
     "slaTargetDate": "2026-10-09T14:00:00Z"},
    {"ticketNumber": "004822", "ticketSummary": "Wi-Fi drops in library", "statusName": "In Progress",
     "statusID": 3, "priorityName": "Medium", "ticketPriorityID": 3, "site": "Bryant High",
     "createdDate": "2026-10-05T14:00:00Z"},
    {"ticketSummary": "row with no ticket number — must be dropped",
     "createdDate": "2026-09-01T00:00:00Z"},
]


def _detail(row: dict) -> dict:
    flat = {k: v for k, v in row.items()
            if k not in ("site", "location", "problemTypeHierarchy")}
    flat["ticketDetails"] = {"site": row.get("site"), "location": row.get("location"),
                             "problemTypeHierarchy": row.get("problemTypeHierarchy"),
                             "ticketDescription": "<p>Lamp <b>out</b></p><script>alert(1)</script>"}
    return flat


class FakeFrontline:
    def __init__(self):
        self.logins = 0
        self.calls: list[str] = []
        self.down = False
        self.expire_next = False
        self.detail_code = 200

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path.split("/api/", 1)[1]
        self.calls.append(f"{req.method} {path}")
        if self.down:
            raise httpx.ConnectError("boom")
        if path == "Login/AuthorizeAPI":
            body = json.loads(req.content)
            if body != {"SecretKey": KEY, "Passphrase": PASS}:
                return httpx.Response(401)
            self.logins += 1
            return httpx.Response(200, json={"token": _jwt(time.time() + 8 * 3600),
                                             "refreshToken": "r"})
        auth = req.headers.get("authorization", "")
        if not auth.startswith("Bearer ") or self.expire_next:
            self.expire_next = False
            return httpx.Response(401)
        if path.startswith("Ticket/GetExportDataTickets/"):
            body = json.loads(req.content)
            assert body["visibleCustomColumns"] == []
            rows = list(TICKETS) if body["state"] in (0, 2) else []
            for srt in body.get("sort") or []:      # createdDate sort, as validated
                rows.sort(key=lambda r: r.get(srt["field"]) or "", reverse=srt["dir"] == "desc")
            total = len(rows)
            n, size = body["pageNumber"], body["pageCount"]
            if size:                                 # zero-based paging, as validated
                rows = rows[n * size:(n + 1) * size]
            return httpx.Response(200, json={"totalCount": total, "result": json.dumps(rows)})
        if path in ("Ticket/4821", "Ticket/004822"):
            if self.detail_code != 200:
                return httpx.Response(self.detail_code)
            num = path.split("/")[1]
            row = next(t for t in TICKETS if str(t.get("ticketNumber")) == num.lstrip("0") or
                       t.get("ticketNumber") == num)
            return httpx.Response(200, json=_detail(row))
        if path.startswith("Ticket/") and path.count("/") == 1:
            return httpx.Response(404)
        if path.endswith("/TicketFieldHistory/GetTicketHistory"):
            return httpx.Response(403)              # as on the live instance
        if path.endswith("/GetTicketComments"):
            return httpx.Response(200, json=[{"commentID": 1, "comment": "<i>hi</i>",
                                              "createdByName": "Tech A"}])
        if path in ("TicketPriority/GetPriorities", "Location/GetSites"):
            return httpx.Response(403)              # as on the live instance
        if path == "Status/GetActiveStatuses":
            return httpx.Response(200, json=[{"statusID": 1, "statusName": "Open"},
                                             {"statusID": 3, "statusName": "In Progress"}])
        return httpx.Response(444)


def _cfg(**kw) -> HelpdeskConfig:
    base = dict(enabled=True, base_url="https://hd.example/api/", scope_user_id="99",
                api_key=KEY, passphrase=PASS)
    base.update(kw)
    return HelpdeskConfig(**base)


# ── parsers ──────────────────────────────────────────────────────────────────

def test_parse_grid_unwraps_the_json_string_layer():
    total, rows = parse_grid({"totalCount": 2, "result": json.dumps([{"a": 1}, {"b": 2}])})
    assert total == 2 and rows == [{"a": 1}, {"b": 2}]
    # A later build that stops double-encoding still parses.
    assert parse_grid({"TotalCount": 1, "Result": [{"a": 1}]}) == (1, [{"a": 1}])


@pytest.mark.parametrize("bad", [
    [], {"totalCount": 1}, {"totalCount": 1, "result": "{not json"},
    {"totalCount": 1, "result": json.dumps({"x": 1})}, {"result": json.dumps([1, 2])},
])
def test_parse_grid_rejects_malformed_layers(bad):
    with pytest.raises(HelpdeskError) as e:
        parse_grid(bad)
    assert e.value.kind == "bad_response"


def test_parse_grid_never_invents_a_total():
    assert parse_grid({"result": "[]"}) == (0, [])
    assert parse_grid({"totalCount": "lots", "result": json.dumps([{}])})[0] == 1


def test_parse_login_reads_jwt_expiry_and_tolerates_opaque_tokens():
    now = 1_000_000.0
    tok, exp = parse_login({"token": _jwt(now + 3600), "refreshToken": "x"}, now=now)
    assert exp == now + 3600
    tok, exp = parse_login({"Token": "opaque"}, now=now)
    assert tok == "opaque" and exp == now + 8 * 3600
    with pytest.raises(HelpdeskError):
        parse_login({"refreshToken": "x"}, now=now)


def test_ticket_ids_are_preserved_as_labels():
    t = normalize_ticket({"ticketNumber": "004822", "subject": "x"})
    assert t["ticket"] == "004822"           # no int() round-trip dropping zeros
    assert normalize_ticket({"ticketNumber": 4821.0})["ticket"] == "4821"
    assert normalize_ticket({"ticketNumber": 4821.5}) is None
    assert normalize_ticket({"subject": "no id"}) is None


def test_missing_fields_are_none_not_guessed():
    t = normalize_ticket({"TICKETNUMBER": 5})
    assert t["ticket"] == "5" and t["subject"] is None and t["status"] is None


def test_html_is_reduced_to_text():
    out = html_to_text('<p>Hello <b>there</b></p><script>steal()</script><ul><li>a</li></ul>&amp;')
    assert "<" not in out and "steal" not in out
    assert "Hello there" in out and "• a" in out and "&" in out


def test_parse_rows_accepts_the_shapes_seen():
    assert parse_rows([{"a": 1}], "x") == [{"a": 1}]
    assert parse_rows({"result": json.dumps([{"a": 1}])}, "x") == [{"a": 1}]
    assert parse_rows({"data": [{"a": 1}]}, "x") == [{"a": 1}]


# ── client ───────────────────────────────────────────────────────────────────

def test_token_is_reused_and_renewed_once_on_401():
    fake = FakeFrontline()
    c = FrontlineClient(_cfg(), transport=httpx.MockTransport(fake))
    c.ticket_grid(0, None)
    c.ticket_grid(0, None)
    assert fake.logins == 1
    fake.expire_next = True
    c.ticket_grid(0, None)
    assert fake.logins == 2


def test_backoff_fails_fast_after_an_outage_and_404_does_not_trip_it():
    fake = FakeFrontline()
    c = FrontlineClient(_cfg(), transport=httpx.MockTransport(fake))
    with pytest.raises(HelpdeskError) as e:
        c.ticket("1")
    assert e.value.kind == "not_found" and c.status()["backoff_s"] == 0
    fake.down = True
    with pytest.raises(HelpdeskError) as e:
        c.ticket_grid(0, None)
    assert e.value.kind == "unavailable"
    before = len(fake.calls)
    with pytest.raises(HelpdeskError):
        c.ticket_grid(0, None)
    assert len(fake.calls) == before          # refused without touching the network


def test_credentials_never_appear_in_errors_or_logs(caplog):
    caplog.set_level(logging.DEBUG)
    fake = FakeFrontline()
    c = FrontlineClient(_cfg(passphrase="wrong"), transport=httpx.MockTransport(fake))
    with pytest.raises(HelpdeskError) as e:
        c.ticket_grid(0, None)
    assert e.value.kind == "auth"
    blob = e.value.message + caplog.text + repr(c.cfg) + json.dumps(c.status())
    assert KEY not in blob and "wrong" not in blob


def test_missing_credentials_is_unconfigured_not_a_crash():
    c = FrontlineClient(_cfg(api_key="", passphrase=""),
                        transport=httpx.MockTransport(FakeFrontline()))
    with pytest.raises(HelpdeskError) as e:
        c.ticket_grid(0, None)
    assert e.value.kind == "unconfigured"


def test_ticket_identifier_is_validated_before_it_reaches_a_path():
    fake = FakeFrontline()
    c = FrontlineClient(_cfg(), transport=httpx.MockTransport(fake))
    with pytest.raises(HelpdeskError):
        c.ticket("../User/GetAllTechnicians")
    assert fake.calls == []


# ── API ──────────────────────────────────────────────────────────────────────

def _app(tmp_path, *, role="admin", enabled=True, extra=""):
    url = f"sqlite:///{tmp_path / 'hd.db'}"
    engine = db.make_engine(url)
    if not (tmp_path / "seeded").exists():
        create_core_tables(engine)
        now = datetime.now(timezone.utc)
        with engine.begin() as c:
            c.execute(text("INSERT INTO devices (name, site, device_type, enabled) "
                           "VALUES ('CHS-AP-1','Central High','ap',1)"))
            c.execute(text("INSERT INTO alert_rules (name, dimension, `condition`, severity, "
                           "enabled) VALUES ('AP down','ping','down','crit',1)"))
            c.execute(text("INSERT INTO alerts (device_id, rule_id, opened_at, last_seen_at) "
                           "VALUES (1,1,:t,:t)"), {"t": now})
            c.execute(text("INSERT INTO issues (title, body, status, severity, category, site, "
                           "reported_by, created_at, updated_at) VALUES "
                           "('Library Wi-Fi','', 'open','warn','wireless','Bryant High','x',:t,:t)"),
                      {"t": now})
            c.execute(text("INSERT INTO changes (title, what, why, expected, proposed_by, "
                           "proposed_at, updated_at) VALUES ('Raise TX power','w','y','e','x',:t,:t)"),
                      {"t": now})
        (tmp_path / "seeded").write_text("1")
    engine.dispose()
    conf = write_config(tmp_path, db_url=url, extra_sections=(
        f"[helpdesk]\nenabled = {'true' if enabled else 'false'}\nscope_user_id = 99\n"
        f"base_url = https://hd.example/api/\n{extra}"))
    if role != "admin":
        conf.write_text(conf.read_text().replace("dev_bypass_role = admin",
                                                 f"dev_bypass_role = {role}"))
    return conf


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("HD_API_KEY", KEY)
    monkeypatch.setenv("HD_API_PASSPHRASE", PASS)


def _client(conf, fake):
    app = create_app(config=load_config(conf), supervisor=Supervisor())
    app.state.helpdesk_transport = httpx.MockTransport(fake)
    return TestClient(app)


def test_ticket_list_filters_pages_and_never_leaks_credentials(tmp_path, env):
    fake = FakeFrontline()
    with _client(_app(tmp_path), fake) as c:
        r = c.get("/api/helpdesk/tickets?view=active")
        assert r.status_code == 200
        body = r.json()
        assert [t["ticket"] for t in body["items"]] == ["004822", "4821"]  # created desc
        assert body["paging"] == "server" and body["stale"] is False
        assert body["items"][0]["is_active"] is True                      # from the view
        assert c.get("/api/helpdesk/tickets?q=projector").json()["total"] == 1
        assert c.get("/api/helpdesk/tickets?status=3").json()["items"][0]["ticket"] == "004822"
        assert c.get("/api/helpdesk/tickets?site=Central High").json()["total"] == 1
        assert c.get("/api/helpdesk/tickets?limit=1&offset=1").json()["items"][0]["ticket"] == "4821"
        # Bounded: the filtered queries share one cached window pull; plain
        # pages are one server page each.
        assert sum("GetExportDataTickets" in x for x in fake.calls) == 3
        for path in ("/api/helpdesk/status", "/api/helpdesk/tickets", "/api/helpdesk/tickets/4821"):
            text_ = c.get(path).text
            assert KEY not in text_ and PASS not in text_ and "Bearer" not in text_


def test_inactive_and_all_views_carry_a_date_window(tmp_path, env):
    fake = FakeFrontline()
    seen = []
    def spy(req):
        if "GetExportDataTickets" in req.url.path:
            seen.append(json.loads(req.content))
        return fake(req)
    with _client(_app(tmp_path), spy) as c:
        c.get("/api/helpdesk/tickets?view=all&days=30")
        c.get("/api/helpdesk/tickets?view=active")
    all_body, active_body = seen
    assert all_body["state"] == 2
    f = all_body["filter"]["filters"][0]
    assert f["field"] == "createdDate" and f["operator"] == "gte" and f["value"].endswith(".000Z")
    assert active_body["state"] == 0 and active_body["filter"] is None


def test_outage_serves_the_last_list_marked_stale(tmp_path, env):
    fake = FakeFrontline()
    conf = _app(tmp_path, extra="list_cache_s = 0\n")
    with _client(conf, fake) as c:
        assert c.get("/api/helpdesk/tickets").json()["stale"] is False
        fake.down = True
        r = c.get("/api/helpdesk/tickets")
        assert r.status_code == 200 and r.json()["stale"] is True
        assert r.json()["error"]["kind"] == "unavailable"
        assert len(r.json()["items"]) == 2


def test_ticket_detail_strips_html_and_404s_honestly(tmp_path, env):
    with _client(_app(tmp_path), FakeFrontline()) as c:
        t = c.get("/api/helpdesk/tickets/4821").json()
        assert t["ticket"]["description"] == "Lamp out"
        r = c.get("/api/helpdesk/tickets/777")
        assert r.status_code == 404 and r.json()["detail"]["kind"] == "not_found"
        assert c.get("/api/helpdesk/tickets/..%2Fx").status_code in (404, 422)


def test_roles_gate_ticket_content_not_link_facts(tmp_path, env):
    fake = FakeFrontline()
    with _client(_app(tmp_path), fake) as c:          # admin creates a link
        assert c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "issue",
                                                   "record_id": 1}).status_code == 201
    with _client(_app(tmp_path, role="viewer"), fake) as c:
        assert c.get("/api/helpdesk/tickets").status_code == 403
        assert c.get("/api/helpdesk/tickets/4821").status_code == 403
        links = c.get("/api/helpdesk/links?record_type=issue&record_id=1").json()["links"]
        assert links[0]["ticket_ref"] == "4821"
        assert "subject" not in links[0]["ticket_summary"]     # number yes, content no
        assert c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "change",
                                                   "record_id": 1}).status_code == 403
    with _client(_app(tmp_path, role="operator"), fake) as c:
        assert c.get("/api/helpdesk/tickets").status_code == 200
        # Comments may hold private notes; admin-only by default.
        assert c.get("/api/helpdesk/tickets/4821/comments").status_code == 403
        s = c.get("/api/helpdesk/status").json()
        assert s["can_read"] and s["can_link"] and not s["can_read_detail"]
    with _client(_app(tmp_path), fake) as c:
        com = c.get("/api/helpdesk/tickets/4821/comments").json()
        assert com["items"][0]["body"] == "hi" and com["visibility_known"] is False


def test_links_are_many_to_many_unique_and_audited(tmp_path, env):
    with _client(_app(tmp_path), FakeFrontline()) as c:
        for rtype in ("problem", "issue", "change"):
            r = c.post("/api/helpdesk/links", json={"ticket": "#4821", "record_type": rtype,
                                                    "record_id": 1, "note": "same outage"})
            assert r.status_code == 201, r.text
            assert r.json()["record"]["type"] == rtype
        assert c.post("/api/helpdesk/links", json={"ticket": "004822", "record_type": "issue",
                                                   "record_id": 1}).status_code == 201
        dup = c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "issue",
                                                  "record_id": 1})
        assert dup.status_code == 409
        by_ticket = c.get("/api/helpdesk/links?ticket=4821").json()["links"]
        assert {l["record_type"] for l in by_ticket} == {"problem", "issue", "change"}
        by_issue = c.get("/api/helpdesk/links?record_type=issue&record_id=1").json()
        assert {l["ticket_ref"] for l in by_issue["links"]} == {"4821", "004822"}
        assert by_issue["links"][0]["ticket_summary"]["subject"]  # cached for display
        assert by_issue["events"][0]["action"] == "link"
        thread = c.get("/api/issues/1").json()["comments"]
        assert any("Linked help desk ticket #4821" in x["body"] for x in thread)


def test_link_validation(tmp_path, env):
    with _client(_app(tmp_path), FakeFrontline()) as c:
        r = c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "issue",
                                                "record_id": 999})
        assert r.status_code == 404                           # local record missing
        r = c.post("/api/helpdesk/links", json={"ticket": "777", "record_type": "issue",
                                                "record_id": 1})
        assert r.status_code == 404                           # ticket unknown to help desk
        r = c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "device",
                                                "record_id": 1})
        assert r.status_code == 422


def test_unlink_removes_only_the_relationship(tmp_path, env):
    fake = FakeFrontline()
    with _client(_app(tmp_path), fake) as c:
        lid = c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "change",
                                                  "record_id": 1}).json()["id"]
        before = len(fake.calls)
        assert c.delete(f"/api/helpdesk/links/{lid}").status_code == 200
        # No help desk call, nothing local deleted, the unlink is on the record.
        assert not [x for x in fake.calls[before:] if not x.startswith("GET Ticket/")]
        assert c.get("/api/changes/1").status_code == 200
        out = c.get("/api/helpdesk/links?record_type=change&record_id=1").json()
        assert out["links"] == [] and out["events"][0]["action"] == "unlink"
        assert out["events"][0]["actor"] == "devadmin"


def test_statuses_stay_independent(tmp_path, env):
    """Closing / resolving one side never writes the other."""
    fake = FakeFrontline()
    with _client(_app(tmp_path), fake) as c:
        c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "issue",
                                            "record_id": 1})
        n = len(fake.calls)
        r = c.patch("/api/issues/1", json={"status": "resolved"})
        assert r.status_code == 200
        assert all(x.startswith(("GET", "POST Ticket/GetExport", "POST Login")) or
                   "Get" in x for x in fake.calls[n:])
        TICKETS[0]["statusName"] = "Closed"
        try:
            c.get("/api/helpdesk/tickets?refresh=true")
            assert c.get("/api/issues/1").json()["status"] == "resolved"
        finally:
            TICKETS[0]["statusName"] = "Open"


def test_outage_keeps_links_and_local_records_readable(tmp_path, env):
    fake = FakeFrontline()
    with _client(_app(tmp_path), fake) as c:
        c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "issue",
                                            "record_id": 1})
        fake.down = True
        assert c.get("/api/issues/1").status_code == 200
        links = c.get("/api/helpdesk/links?record_type=issue&record_id=1").json()["links"]
        assert links[0]["ticket_summary"]["subject"] == "Projector dead in 204"
        r = c.post(f"/api/helpdesk/links/{links[0]['id']}/refresh")
        assert r.status_code == 200 and r.json()["error"]["kind"] == "unavailable"
        assert c.get("/api/helpdesk/links?ticket=4821").json()["links"]   # link survives
        assert c.get("/api/helpdesk/tickets").status_code == 503


def test_missing_ticket_is_marked_not_erased(tmp_path, env):
    fake = FakeFrontline()
    with _client(_app(tmp_path), fake) as c:
        lid = c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "issue",
                                                  "record_id": 1}).json()["id"]
        fake.detail_code = 404
        out = c.post(f"/api/helpdesk/links/{lid}/refresh").json()
        assert out["error"]["kind"] == "not_found"
        assert out["ticket_summary"]["state"] == "not_found"
        assert out["ticket_summary"]["subject"] == "Projector dead in 204"   # kept, marked
        fake.detail_code = 403
        out = c.post(f"/api/helpdesk/links/{lid}/refresh").json()
        assert out["ticket_summary"]["state"] == "inaccessible"


def test_disabled_integration_keeps_links_readable(tmp_path, env):
    with _client(_app(tmp_path, enabled=False), FakeFrontline()) as c:
        assert c.get("/api/helpdesk/status").json()["enabled"] is False
        assert c.get("/api/helpdesk/tickets").status_code == 404
        assert c.get("/api/helpdesk/links?record_type=issue&record_id=1").status_code == 200
        assert c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "issue",
                                                   "record_id": 1}).status_code == 404


def test_candidates_search_local_records(tmp_path, env):
    with _client(_app(tmp_path), FakeFrontline()) as c:
        assert c.get("/api/helpdesk/candidates?type=issue&q=library").json()[0]["id"] == 1
        assert c.get("/api/helpdesk/candidates?type=change&q=#1").json()[0]["title"] == "Raise TX power"
        p = c.get("/api/helpdesk/candidates?type=problem&q=CHS").json()[0]
        assert p["status"] == "open" and p["site"] == "Central High"


def test_config_refuses_credentials_in_the_conf_file(tmp_path):
    from netmon.config import ConfigError
    conf = write_config(tmp_path, extra_sections="[helpdesk]\napi_key = nope\n")
    with pytest.raises(ConfigError):
        load_config(conf)
    conf = write_config(tmp_path, extra_sections="[helpdesk]\nenabled = true\n")
    with pytest.raises(ConfigError):       # scope_user_id is never guessed
        load_config(conf)


def test_create_from_ticket_then_link_and_retry_without_duplicates(tmp_path, env):
    """The UI's create flow: create the record with the prefilled payload the
    page sends, then link. A failed link is retried by id — never by creating
    again — and a repeat link answers 409, not a second row."""
    fake = FakeFrontline()
    with _client(_app(tmp_path), fake) as c:
        issue = c.post("/api/issues", json={
            "title": "HD #4821: Projector dead in 204", "severity": "warn",
            "category": "other", "site": "Central High",
            "body": "Help desk ticket #4821 — Projector dead in 204\nSite: Central High"})
        assert issue.status_code == 201, issue.text
        iid = issue.json()["id"]
        change = c.post("/api/changes", json={
            "title": "HD #4821: Projector dead in 204", "what": "Swap lamp",
            "why": "Help desk ticket #4821", "expected": "Projector works", "site": None,
            "risk": "low"})
        assert change.status_code == 201, change.text

        fake.down = True                      # link fails: record must survive
        r = c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "issue",
                                                "record_id": iid})
        assert r.status_code == 503
        assert c.get(f"/api/issues/{iid}").status_code == 200

        fake.down = False
        c.app.state.helpdesk.client._blocked_until = 0      # backoff elapsed
        assert c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "issue",
                                                   "record_id": iid}).status_code == 201
        assert c.post("/api/helpdesk/links", json={"ticket": "4821", "record_type": "issue",
                                                   "record_id": iid}).status_code == 409
        n = db.fetch_one(db.make_engine(f"sqlite:///{tmp_path / 'hd.db'}"),
                         "SELECT COUNT(*) AS n FROM helpdesk_links")["n"]
        assert n == 1


def test_an_unknown_route_does_not_block_the_others():
    """HTTP 444 is Frontline's "no such route". It is a fact about one route —
    a missing lookup must not put the whole adapter into backoff."""
    fake = FakeFrontline()
    c = FrontlineClient(_cfg(), transport=httpx.MockTransport(fake))
    with pytest.raises(HelpdeskError) as e:
        c.categories()
    assert e.value.kind == "bad_response"
    assert c.status()["backoff_s"] == 0
    assert c.ticket_grid(0, None)[0] == len(TICKETS)



def test_plain_browsing_uses_validated_server_paging(tmp_path, env):
    fake = FakeFrontline()
    seen = []
    def spy(req):
        if "GetExportDataTickets" in req.url.path:
            seen.append(json.loads(req.content))
        return fake(req)
    with _client(_app(tmp_path), spy) as c:
        p0 = c.get("/api/helpdesk/tickets?view=active&limit=1&offset=0").json()
        p1 = c.get("/api/helpdesk/tickets?view=active&limit=1&offset=1&dir=asc").json()
        filtered = c.get("/api/helpdesk/tickets?view=active&q=wi-fi").json()
    assert seen[0]["pageNumber"] == 0 and seen[0]["pageCount"] == 1
    assert seen[0]["sort"] == [{"field": "createdDate", "dir": "desc"}]
    assert seen[1]["pageNumber"] == 1 and seen[1]["sort"][0]["dir"] == "asc"
    assert p0["paging"] == "server" and p0["total"] == len(TICKETS)
    assert p0["items"][0]["ticket"] == "004822" and p1["items"][0]["ticket"] == "4821"
    # Filtered queries never send an unvalidated vendor filter or sort.
    assert seen[2]["pageCount"] == 0 and seen[2]["sort"] is None
    assert filtered["paging"] == "netmon" and filtered["total"] == 1


def test_live_shapes_resolve_subject_site_and_nested_detail(tmp_path, env):
    with _client(_app(tmp_path), FakeFrontline()) as c:
        row = c.get("/api/helpdesk/tickets?q=projector").json()["items"][0]
        assert row["subject"] == "Projector dead in 204"
        assert (row["site"], row["room"], row["category"]) == ("Central High", "Room 204", "AV > Projector")
        assert row["due"] == "2026-10-09T14:00:00Z" and row["assigned_to"] == "Tech A"
        t = c.get("/api/helpdesk/tickets/4821").json()["ticket"]
        assert t["site"] == "Central High" and t["category"] == "AV > Projector"
        assert t["description"] == "Lamp out"


def test_refused_lookups_fall_back_and_are_not_retried_every_load(tmp_path, env):
    fake = FakeFrontline()
    with _client(_app(tmp_path), fake) as c:
        first = c.get("/api/helpdesk/lookups").json()
        assert first["priorities"]["items"] == [] and "403" in first["priorities"]["error"]
        assert first["statuses"]["items"]                       # the one that works
        n = len(fake.calls)
        c.get("/api/helpdesk/lookups")
        assert len(fake.calls) == n                              # all served from memory


def test_history_refused_by_the_help_desk_is_reported_as_such(tmp_path, env):
    with _client(_app(tmp_path), FakeFrontline()) as c:
        r = c.get("/api/helpdesk/tickets/4821/history")
        assert r.status_code == 403 and r.json()["detail"]["kind"] == "inaccessible"

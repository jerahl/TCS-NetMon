"""Helpdesk dashboard + triage board figures (docs/spec/25-helpdesk.md §12).

The stats are pure functions of (active list, window list, now, tz), so each
number is pinned against a small hand-built queue on a fixed clock.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from netmon import helpdesk_stats as hs
from netmon.config import ConfigError, load_config
from tests.conftest import write_config
from tests.test_helpdesk import KEY, PASS, FakeFrontline, _app, _client, env  # noqa: F401

UTC = timezone.utc
# Thursday 8 Oct 2026, 17:00 UTC. Week starts Monday 5 Oct.
NOW = datetime(2026, 10, 8, 17, 0, tzinfo=UTC)


def _t(n, *, created, prio="Low", status="Open", due=None, closed=None, cat="Misc",
       site="Central High", who="Tech A", wid="7", updated=None, req="Requester One"):
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S") if d else None   # naive = UTC
    return {"ticket": str(n), "subject": f"ticket {n}", "status": status, "priority": prio,
            "site": site, "category": cat, "assigned_to": who, "assigned_id": wid,
            "requester": req, "created": iso(created), "due": iso(due), "closed": iso(closed),
            "updated": iso(updated or created)}


def d(days, hours=0):
    return NOW - timedelta(days=days, hours=hours)


def sample_queue():
    """Five open tickets and three closed ones. Also feeds the render-check
    fixtures (scripts/helpdesk_fixtures.py)."""
    active = [
        _t(1, created=d(30), prio="High", due=d(20), cat="Security Cameras > Recorder",
           site="Northridge", who="Tech A"),
        _t(2, created=d(10), prio="High", due=d(2), cat="Security Cameras > Field", site="Northridge"),
        _t(3, created=d(3), prio="Medium", status="In Progress", due=NOW + timedelta(days=5),
           cat="Classlink", site="Central High", updated=d(1)),
        _t(4, created=d(40), prio="Low", status="On Hold", due=d(25), cat="Misc", who=None, wid=None,
           site="Westlawn"),
        _t(5, created=d(1), prio="Low", cat="Classlink", site="Northridge", who="Tech B", wid="8"),
    ]
    window = [t for t in active if t["ticket"] != "4"] + [   # #4 predates part of the window
        _t(10, created=d(2), closed=d(1), status="Closed", cat="Classlink"),
        _t(11, created=d(9), closed=d(8), status="Closed", cat="Misc"),
        _t(12, created=d(35), closed=d(3), status="Closed", cat="Security Cameras > Recorder"),
    ]
    return active, window


@pytest.fixture
def queue():
    return sample_queue()


def test_parse_ts_reads_z_offsets_naive_and_long_fractions():
    assert hs.parse_ts("2026-10-01T14:00:00Z") == datetime(2026, 10, 1, 14, tzinfo=UTC)
    assert hs.parse_ts("2026-10-01T14:00:00") == datetime(2026, 10, 1, 14, tzinfo=UTC)
    assert hs.parse_ts("2026-10-01T09:00:00-05:00") == datetime(2026, 10, 1, 14, tzinfo=UTC)
    assert hs.parse_ts("2026-10-01T14:00:00.1234567Z").second == 0
    assert hs.parse_ts("not a date") is None and hs.parse_ts(None) is None


def test_categories_priorities_and_status_buckets():
    assert hs.split_category("AV > Projector") == ("AV", "Projector")
    assert hs.split_category("A>B>C") == ("A", "B > C")
    assert hs.split_category(None) == ("Uncategorised", None)
    assert hs.prio_rank("High") < hs.prio_rank("medium") < hs.prio_rank("Low") < hs.prio_rank("?")
    assert [hs.status_kind(s) for s in ("Open", "In Progress", "On Hold", "Request Approval",
                                        "Closed")] == ["open", "prog", "hold", "hold", "other"]


def test_dashboard_scorecard_urgent_and_week(queue):
    active, window = queue
    out = hs.dashboard(active, window, now=NOW, tz=UTC, year_start_mm_dd="08-01")
    t = out["totals"]
    assert (t["open"], t["overdue"], t["urgent_overdue"]) == (5, 3, 2)
    assert [u["ticket"] for u in out["urgent"]] == ["1", "2"]          # most overdue first
    assert out["urgent"][0]["over_days"] == 20
    # Week = Mon 5 Oct → now: #3 (Oct 5), #5 (Oct 7), #10 (Oct 6); #10 closed.
    w = out["week"]
    assert (w["new"], w["closed_of_intake"], w["still_open"]) == (3, 1, 2)
    assert [x["count"] for x in w["by_day"]] == [1, 1, 1, 0] and w["by_day"][-1]["partial"]
    assert w["resolved"] == 2                                            # #10 and #12
    assert out["by_status"][0] == {"name": "Open", "count": 3}
    assert {r["name"]: r["overdue"] for r in out["by_priority"]} == {"High": 2, "Medium": 0, "Low": 1}
    assert out["by_site"][0] == {"name": "Northridge", "count": 3}
    assert out["overdue_by_assignee"][0] == {"name": "Tech A", "count": 2}


def test_dashboard_month_to_date_against_the_same_days_last_month(queue):
    active, window = queue
    out = hs.dashboard(active, window, now=NOW, tz=UTC)
    # October so far: #3, #5, #10 (#2 was created 28 Sep).
    assert out["mtd"]["new"] == 3 and out["mtd"]["closed"] == 1
    # The comparison span is 1 Sep → 8 Sep 17:00, the same elapsed time.
    assert out["prior"]["end"].startswith("2026-09-08T17:00")
    assert out["mtd_types"][0]["name"] == "Classlink"


def test_dashboard_trend_starts_at_the_school_year(queue):
    active, window = queue
    out = hs.dashboard(active, window, now=NOW, tz=UTC, year_start_mm_dd="08-01")
    assert out["school_year_start"] == "2026-08-01"
    assert out["weeks"][0]["start"] == "2026-08-01" and out["weeks"][-1]["partial"]
    assert out["ytd"]["new"] == len(window) and out["ytd"]["closed"] == 3
    # Before the start date in a calendar year, the previous year's start applies.
    assert hs.school_year_start(datetime(2026, 7, 1), "08-01").isoformat() == "2025-08-01"


def test_dashboard_actions_name_their_evidence(queue):
    active, window = queue
    out = hs.dashboard(active, window, now=NOW, tz=UTC)
    titles = [a["title"] for a in out["actions"]]
    assert titles[0].startswith("Escalate the oldest overdue High/Critical tickets")
    assert out["actions"][0]["refs"] == ["1", "2"]
    assert any("long tail" in x for x in titles)
    assert out["summary"][0].startswith("The help desk holds 5 open tickets")


def test_window_covers_school_year_and_last_month_and_is_capped():
    days, trunc = hs.window_days_needed(NOW, UTC, "08-01", 365)
    assert days == (NOW.date() - datetime(2026, 8, 1).date()).days + 2 and not trunc
    days, trunc = hs.window_days_needed(NOW, UTC, "08-01", 30)
    assert days == 30 and trunc


def test_board_groups_by_root_cause_hot_first(queue):
    active, window = queue
    out = hs.board(active, window, now=NOW, tz=UTC)
    names = [g["name"] for g in out["groups"]]
    assert names[0] == "Security Cameras"                                # hot: High past SLA
    cams = out["groups"][0]
    assert cams["hot"] and cams["count"] == 2 and cams["overdue"] == 2
    assert [s["name"] for s in cams["subgroups"]] in (["Recorder", "Field"], ["Field", "Recorder"])
    assert [t["ticket"] for t in cams["items"]] == ["1", "2"]           # most overdue first
    row = cams["items"][0]
    assert row["requester"] == "Requester One" and row["over_days"] == 20
    assert not any(k.startswith("_") for k in row)
    t = out["totals"]
    assert (t["active"], t["open"], t["prog"], t["hold"]) == (5, 3, 1, 1)
    assert t["max_over"] == 25 and t["urgent"] == 2


def test_board_delta_and_rebuilt_queue_trend(queue):
    active, window = queue
    out = hs.board(active, window, now=NOW, tz=UTC)
    dl = out["delta"]
    assert dl["closed_7d"] == 2 and dl["new_7d"] == 3                    # #10,#12 / #3,#5,#10
    # 7 days ago: #1, #2, #4 (still open) + #12 (resolved since); #11 was already closed.
    assert dl["queue_7d_ago"] == 4 and dl["net"] == 1
    assert len(out["trend"]) == hs.TREND_WEEKS and out["trend"][-1]["size"] == 5
    assert out["do_first"][0]["refs"] == ["1", "2"]


def test_board_scopes_to_one_assignee_or_unassigned(queue):
    active, window = queue
    assert hs.board(active, window, now=NOW, tz=UTC, assigned="8")["totals"]["active"] == 1
    assert hs.board(active, window, now=NOW, tz=UTC, assigned="Tech A")["totals"]["active"] == 3
    assert hs.board(active, window, now=NOW, tz=UTC, assigned="unassigned")["totals"]["active"] == 1
    people = hs.assignees(active)
    assert people[0] == {"value": "7", "name": "Tech A", "count": 3}
    assert people[-1]["value"] == "unassigned"


def test_school_year_start_is_validated(tmp_path):
    conf = write_config(tmp_path, extra_sections="[helpdesk]\nschool_year_start = 13-40\n")
    with pytest.raises(ConfigError):
        load_config(conf)


def test_dashboard_and_board_routes(tmp_path, env):  # noqa: F811
    fake = FakeFrontline()
    with _client(_app(tmp_path), fake) as c:
        r = c.get("/api/helpdesk/dashboard")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["totals"]["open"] == 2 and body["stale"] is False
        b = c.get("/api/helpdesk/board").json()
        assert b["totals"]["active"] == 2 and b["groups"]
        assert {a["name"] for a in b["assignees"]} >= {"Tech A"}
        # One active + one window pull, shared by both pages through the list cache.
        assert sum("GetExportDataTickets" in x for x in fake.calls) == 2
        for path in ("/api/helpdesk/dashboard", "/api/helpdesk/board"):
            assert KEY not in c.get(path).text and PASS not in c.get(path).text


def test_dashboard_needs_the_read_role(tmp_path, env):  # noqa: F811
    with _client(_app(tmp_path, role="viewer"), FakeFrontline()) as c:
        assert c.get("/api/helpdesk/dashboard").status_code == 403
        assert c.get("/api/helpdesk/board").status_code == 403

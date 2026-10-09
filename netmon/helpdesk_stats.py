"""Help desk dashboard and triage-board figures (docs/spec/25-helpdesk.md §12).

Pure functions over normalised tickets (``netmon.helpdesk.normalize_ticket``)
— no I/O, no clock reads except the ``now`` passed in — so every number on
the two pages can be pinned by a unit test.

Two inputs, both straight from the export grid:

* ``active`` — the live queue (grid state 0). "Open" means *in this list*;
  Frontline's status names are shown, never interpreted as open/closed.
* ``window`` — every ticket (state 2) created since a cut-off. Trend, intake
  and closure figures come from here. A ticket in ``window`` that is not in
  ``active`` is closed; its ``resolutionDate`` (when present) says when.

Known limit, stated on the pages: closures of tickets *created before* the
window are not in ``window``, so the earliest weeks under-count "resolved".
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any, Iterable

#: Frontline priority names → rank. Lower is more urgent; unknown sorts last.
_PRIORITY_RANK = {"critical": 0, "urgent": 0, "emergency": 0, "high": 1,
                  "medium": 2, "normal": 2, "moderate": 2, "low": 3}
UNKNOWN_RANK = 4

STALL_DAYS = 7          # "untouched" on the board: no update for this long
STALE_DAYS = 14         # "do these first": untouched long enough to chase
TREND_WEEKS = 8         # queue-size points on the board

_FRAC = re.compile(r"(\.\d{6})\d+")


def prio_rank(name: str | None) -> int:
    return _PRIORITY_RANK.get((name or "").strip().lower(), UNKNOWN_RANK)


def parse_ts(value: Any) -> datetime | None:
    """Frontline timestamp → aware UTC datetime. Naive values are UTC, the
    same reading the browser applies (helpdesk.jsx ``parseTs``)."""
    if not value:
        return None
    s = _FRAC.sub(r"\1", str(value).strip().replace(" ", "T"))
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def status_kind(status: str | None) -> str:
    """Bucket for the board's filters and pills. Display keeps the real name."""
    s = (status or "").strip().lower()
    if "progress" in s:
        return "prog"
    if "hold" in s or "approval" in s or "waiting" in s or "pending" in s:
        return "hold"
    if s in ("open", "new", "reopened", "re-opened", "assigned", "submitted"):
        return "open"
    return "other"


def split_category(cat: str | None) -> tuple[str, str | None]:
    """``"AV > Projector"`` → ``("AV", "Projector")``. Frontline joins the
    problem-type hierarchy with ``>``."""
    if not cat:
        return "Uncategorised", None
    parts = [p.strip() for p in re.split(r"\s*>\s*", cat) if p.strip()]
    if not parts:
        return "Uncategorised", None
    return parts[0], (" > ".join(parts[1:]) or None)


def _days(delta: timedelta) -> int:
    return int(delta.total_seconds() // 86400)


def enrich(t: dict, now: datetime, *, is_open: bool) -> dict:
    """A ticket plus the derived fields both pages use. Never mutates ``t``."""
    created, due = parse_ts(t.get("created")), parse_ts(t.get("due"))
    updated, closed = parse_ts(t.get("updated")), parse_ts(t.get("closed"))
    group, sub = split_category(t.get("category"))
    overdue = bool(is_open and due and due < now)
    return {
        **t,
        "is_open": is_open,
        "group": group,
        "sub": sub,
        "prio_rank": prio_rank(t.get("priority")),
        "status_kind": status_kind(t.get("status")),
        "age_days": _days(now - created) if created else None,
        "overdue": overdue,
        "over_days": _days(now - due) if overdue else None,
        "due_in_days": _days(due - now) if (is_open and due and not overdue) else None,
        "idle_days": _days(now - (updated or created)) if (updated or created) else None,
        "_created": created, "_due": due, "_closed": closed,
    }


def public(t: dict) -> dict:
    return {k: v for k, v in t.items() if not k.startswith("_")}


def _pct(n: int, d: int) -> float | None:
    return round(100.0 * n / d, 1) if d else None


def _change(cur: int, prev: int) -> float | None:
    return round(100.0 * (cur - prev) / prev, 1) if prev else None


def _counts(items: Iterable[dict], key: str, limit: int | None = None,
            missing: str = "Unknown") -> list[dict]:
    c = Counter((t.get(key) or missing) for t in items)
    rows = [{"name": k, "count": v} for k, v in c.most_common()]
    return rows[:limit] if limit else rows


def _local_midnight(d: date, tz: tzinfo) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=tz).astimezone(timezone.utc)


def school_year_start(now_local: datetime, mm_dd: str) -> date:
    """The most recent ``mm_dd`` on or before today."""
    m, d = (int(x) for x in mm_dd.split("-"))
    start = date(now_local.year, m, d)
    return start if start <= now_local.date() else date(now_local.year - 1, m, d)


def window_days_needed(now: datetime, tz: tzinfo, mm_dd: str, cap: int) -> tuple[int, bool]:
    """Days of history the dashboard needs: back to the school-year start and
    to the first of last month (for the month-over-month table), and at least
    the board's trend span. Capped by ``max_window_days``; (days, truncated)."""
    local = now.astimezone(tz)
    first = local.date().replace(day=1)
    prior_first = (first - timedelta(days=1)).replace(day=1)
    earliest = min(school_year_start(local, mm_dd), prior_first,
                   local.date() - timedelta(days=7 * TREND_WEEKS + 7))
    days = (local.date() - earliest).days + 2
    return min(days, cap), days > cap


def _prepare(active: list[dict], window: list[dict], now: datetime):
    open_refs = {t["ticket"] for t in active}
    opened = [enrich(t, now, is_open=True) for t in active]
    seen: dict[str, dict] = {}
    for t in window:
        if t["ticket"] not in seen:
            seen[t["ticket"]] = enrich(t, now, is_open=t["ticket"] in open_refs)
    # An open ticket is described by the live queue's row, which is fresher.
    for t in opened:
        if t["ticket"] in seen:
            seen[t["ticket"]] = t
    return opened, list(seen.values())


def _in(ts: datetime | None, start: datetime, end: datetime) -> bool:
    return ts is not None and start <= ts < end


# ── the dashboard ────────────────────────────────────────────────────────────

def dashboard(active: list[dict], window: list[dict], *, now: datetime, tz: tzinfo,
              year_start_mm_dd: str = "08-01", window_days: int | None = None,
              truncated: bool = False) -> dict:
    """Everything the Helpdesk dashboard shows, modelled on the IT Help-Desk
    Status Digest: scorecard, urgent flags, this week, backlog breakdowns,
    month-to-date vs the same days of last month, the school-year trend, and
    rule-based suggested actions."""
    opened, rows = _prepare(active, window, now)
    local = now.astimezone(tz)
    n_open = len(opened)
    overdue = [t for t in opened if t["overdue"]]
    urgent = sorted((t for t in overdue if t["prio_rank"] <= 1),
                    key=lambda t: (-(t["over_days"] or 0), t["prio_rank"]))

    # -- this week (Mon 00:00 local → now) --------------------------------
    monday = local.date() - timedelta(days=local.weekday())
    week_start = _local_midnight(monday, tz)
    week_new = [t for t in rows if _in(t["_created"], week_start, now + timedelta(seconds=1))]
    by_day = []
    for i in range((local.date() - monday).days + 1):
        d = monday + timedelta(days=i)
        s, e = _local_midnight(d, tz), _local_midnight(d + timedelta(days=1), tz)
        by_day.append({"date": d.isoformat(), "count": sum(_in(t["_created"], s, e) for t in rows),
                       "partial": d == local.date()})
    week_closed_intake = sum(not t["is_open"] for t in week_new)
    week_resolved = sum(_in(t["_closed"], week_start, now + timedelta(seconds=1)) for t in rows)

    # -- month to date vs the same span of last month ----------------------
    m_first = local.date().replace(day=1)
    m_start = _local_midnight(m_first, tz)
    p_first = (m_first - timedelta(days=1)).replace(day=1)
    p_start = _local_midnight(p_first, tz)
    p_end = min(p_start + (now - m_start), m_start)

    def period(start: datetime, end: datetime) -> dict:
        new = [t for t in rows if _in(t["_created"], start, end)]
        closed = sum(not t["is_open"] for t in new)
        prios = Counter(t.get("priority") or "Unknown" for t in new)
        return {"start": start.isoformat(), "end": end.isoformat(), "new": len(new),
                "closed": closed, "closed_pct": _pct(closed, len(new)),
                "still_open": len(new) - closed,
                "urgent": sum(t["prio_rank"] <= 1 for t in new),
                "priorities": [{"name": k, "count": v, "pct": _pct(v, len(new))}
                               for k, v in sorted(prios.items(), key=lambda kv: prio_rank(kv[0]))],
                "_items": new}

    mtd, prior = period(m_start, now + timedelta(seconds=1)), period(p_start, p_end)
    mtd_types = Counter(t.get("category") or "Uncategorised" for t in mtd["_items"])
    prior_types = Counter(t.get("category") or "Uncategorised" for t in prior["_items"])
    mtd_type_rows = [{"name": k, "count": v, "pct": _pct(v, mtd["new"]),
                      "prior": prior_types.get(k, 0), "change": v - prior_types.get(k, 0)}
                     for k, v in mtd_types.most_common(12)]
    for p in (mtd, prior):
        del p["_items"]
    mtd["new_change_pct"] = _change(mtd["new"], prior["new"])
    mtd["closed_change_pct"] = _change(mtd["closed"], prior["closed"])

    # -- school-year trend: 7-day buckets from the start date --------------
    ys = school_year_start(local, year_start_mm_dd)
    weeks = []
    d = ys
    while d <= local.date():
        s = _local_midnight(d, tz)
        e = _local_midnight(d + timedelta(days=7), tz)
        new = [t for t in rows if _in(t["_created"], s, e)]
        closed = sum(not t["is_open"] for t in new)
        weeks.append({"start": d.isoformat(), "new": len(new), "closed": closed,
                      "closed_pct": _pct(closed, len(new)), "still_open": len(new) - closed,
                      "resolved": sum(_in(t["_closed"], s, e) for t in rows),
                      "partial": e > now})
        d += timedelta(days=7)
    ytd_new = sum(w["new"] for w in weeks)
    ytd_closed = sum(w["closed"] for w in weeks)

    # -- backlog breakdowns -------------------------------------------------
    prio_names = sorted({t.get("priority") or "Unknown" for t in opened}, key=prio_rank)
    by_priority = [{"name": p, "open": sum((t.get("priority") or "Unknown") == p for t in opened),
                    "overdue": sum((t.get("priority") or "Unknown") == p for t in overdue)}
                   for p in prio_names]
    for r in by_priority:
        r["pct"] = _pct(r["open"], n_open)
    by_category = [dict(r, pct=_pct(r["count"], n_open))
                   for r in _counts(opened, "category", 10, "Uncategorised")]
    by_site = _counts(opened, "site", 15)
    top4 = sum(r["count"] for r in by_site[:4])

    out = {
        "now": now.isoformat(),
        "window_days": window_days,
        "window_truncated": truncated,
        "school_year_start": ys.isoformat(),
        "totals": {"open": n_open, "overdue": len(overdue), "overdue_pct": _pct(len(overdue), n_open),
                   "urgent_overdue": len(urgent), "in_window": len(rows)},
        "urgent": [public(t) for t in urgent],
        "overdue_by_priority": [{"name": r["name"], "count": r["overdue"]} for r in by_priority],
        "overdue_by_site": _counts(overdue, "site", 5),
        "overdue_by_assignee": _counts(overdue, "assigned_to", 5, "Unassigned"),
        "week": {"start": week_start.isoformat(), "new": len(week_new), "by_day": by_day,
                 "closed_of_intake": week_closed_intake,
                 "closed_pct": _pct(week_closed_intake, len(week_new)),
                 "still_open": len(week_new) - week_closed_intake,
                 "resolved": week_resolved},
        "by_status": _counts(opened, "status"),
        "by_priority": by_priority,
        "by_category": by_category,
        "by_site": by_site,
        "top4_sites": {"count": top4, "pct": _pct(top4, n_open)},
        "mtd": mtd, "prior": prior, "mtd_types": mtd_type_rows,
        "weeks": weeks,
        "ytd": {"new": ytd_new, "closed": ytd_closed, "closed_pct": _pct(ytd_closed, ytd_new),
                "still_open": ytd_new - ytd_closed},
    }
    out["summary"] = _summary(out, opened, overdue)
    out["actions"] = _actions(out, opened, overdue, urgent)
    return out


def _peak(weeks: list[dict]) -> dict | None:
    full = [w for w in weeks if not w["partial"]] or weeks
    return max(full, key=lambda w: w["new"]) if full else None


def _summary(d: dict, opened: list[dict], overdue: list[dict]) -> list[str]:
    """A few factual sentences. Every number is one shown elsewhere on the page."""
    t = d["totals"]
    out = []
    s = f"The help desk holds {t['open']} open tickets"
    if t["open"]:
        s += (f", and {t['overdue']} of them ({t['overdue_pct']}%) are past their SLA target"
              f" — {t['urgent_overdue']} High or Critical.")
    else:
        s += "."
    out.append(s)
    peak = _peak(d["weeks"])
    w = d["week"]
    if peak and peak["new"]:
        out.append(f"Intake this week is {w['new']} so far against a school-year peak of "
                   f"{peak['new']} in the week of {peak['start']}; "
                   f"{w['closed_of_intake']} of this week's tickets are already closed.")
    if d["by_site"] and t["open"]:
        top = d["by_site"][0]
        out.append(f"{top['name']} carries the most open work ({top['count']}); the top four sites "
                   f"hold {d['top4_sites']['count']} ({d['top4_sites']['pct']}%).")
    if d["overdue_by_assignee"] and overdue:
        a = d["overdue_by_assignee"][0]
        out.append(f"{a['name']} is assigned {a['count']} of the {len(overdue)} overdue tickets.")
    return out


def _actions(d: dict, opened: list[dict], overdue: list[dict], urgent: list[dict]) -> list[dict]:
    """Rule-based suggestions. Each names the tickets or numbers behind it so
    the reader can check it; none is shown unless its condition holds."""
    acts: list[dict] = []
    if urgent:
        top = urgent[:2]
        acts.append({
            "title": "Escalate the oldest overdue High/Critical ticket" + ("s" if len(top) > 1 else ""),
            "detail": "; ".join(f"#{t['ticket']} {t.get('site') or 'no site'}, {t['over_days']}d past "
                                f"target, {t.get('assigned_to') or 'unassigned'}" for t in top)
                      + " — confirm status or close out.",
            "refs": [t["ticket"] for t in top]})
    if overdue and d["overdue_by_assignee"]:
        a = d["overdue_by_assignee"][0]
        if a["name"] != "Unassigned" and a["count"] >= 5 and a["count"] >= 0.3 * len(overdue):
            u = sum((t.get("assigned_to") or "Unassigned") == a["name"] for t in urgent)
            acts.append({"title": f"Rebalance {a['name']}'s queue",
                         "detail": f"{a['count']} of {len(overdue)} overdue tickets sit with one person"
                                   + (f", including {u} of the {len(urgent)} overdue High/Critical."
                                      if u else "."),
                         "refs": []})
    if d["by_category"]:
        c = d["by_category"][0]
        u = sum((t.get("category") or "Uncategorised") == c["name"] for t in urgent)
        if u or (c["pct"] or 0) >= 10:
            acts.append({"title": f"Review {c['name']} as a category",
                         "detail": f"{c['count']} open (most of any category)"
                                   + (f"; {u} of the {len(urgent)} overdue High/Critical." if u else "."),
                         "refs": []})
    if len(d["by_site"]) >= 2 and (d["top4_sites"]["pct"] or 0) >= 25:
        a, b = d["by_site"][0], d["by_site"][1]
        acts.append({"title": f"Triage {a['name']} and {b['name']}",
                     "detail": f"{a['count']} and {b['count']} open; the top four sites hold "
                               f"{d['top4_sites']['pct']}% of the backlog — candidates for onsite visits.",
                     "refs": []})
    held = [t for t in opened if t["status_kind"] == "hold"]
    stale_low = [t for t in overdue if t["prio_rank"] >= 3]
    if held or stale_low:
        parts = []
        if held:
            parts.append(f"review the {len(held)} on-hold / awaiting-approval tickets for blockers")
        if stale_low:
            parts.append(f"sweep the {len(stale_low)} overdue Low tickets for ones that can close")
        acts.append({"title": "Clear the long tail", "detail": "; ".join(parts).capitalize() + ".",
                     "refs": []})
    return acts


# ── the triage board ─────────────────────────────────────────────────────────

def _scoped(t: dict, assigned: str | None) -> bool:
    if not assigned:
        return True
    if assigned == "unassigned":
        return not (t.get("assigned_to") or t.get("assigned_id"))
    return assigned in (t.get("assigned_id"), t.get("assigned_to"))


def assignees(active: list[dict]) -> list[dict]:
    """Who holds the queue, for the board's scope picker."""
    c: Counter = Counter()
    ids: dict[str, str | None] = {}
    for t in active:
        name = t.get("assigned_to")
        if name:
            c[name] += 1
            ids.setdefault(name, t.get("assigned_id"))
    out = [{"value": ids[n] or n, "name": n, "count": k} for n, k in c.most_common()]
    un = sum(1 for t in active if not (t.get("assigned_to") or t.get("assigned_id")))
    if un:
        out.append({"value": "unassigned", "name": "Unassigned", "count": un})
    return out


def queue_size_at(ts: datetime, opened: list[dict], rows: list[dict]) -> int:
    """Open-queue size at ``ts``, rebuilt from creation and resolution dates:
    still-open tickets created by then, plus closed ones created by then and
    resolved after."""
    n = sum(1 for t in opened if t["_created"] and t["_created"] <= ts)
    n += sum(1 for t in rows if not t["is_open"] and t["_created"] and t["_created"] <= ts
             and t["_closed"] and t["_closed"] > ts)
    return n


def board(active: list[dict], window: list[dict], *, now: datetime, tz: tzinfo,
          assigned: str | None = None) -> dict:
    """The Ticket Triage Board: the open queue grouped by root cause (problem
    type), with what moved in the last seven days and what to do first."""
    act = [t for t in active if _scoped(t, assigned)]
    win = [t for t in window if _scoped(t, assigned)]
    opened, rows = _prepare(act, win, now)
    wk = now - timedelta(days=7)
    wk2 = now - timedelta(days=14)

    new7 = [t for t in rows if _in(t["_created"], wk, now + timedelta(seconds=1))]
    closed7 = [t for t in rows if not t["is_open"] and _in(t["_closed"], wk, now + timedelta(seconds=1))]
    closed_prev = [t for t in rows if not t["is_open"] and _in(t["_closed"], wk2, wk)]
    q_then = queue_size_at(wk, opened, rows)

    overdue = [t for t in opened if t["overdue"]]
    urgent = [t for t in opened if t["prio_rank"] <= 1]
    urgent_over = sorted((t for t in overdue if t["prio_rank"] <= 1), key=lambda t: -(t["over_days"] or 0))
    stalled = [t for t in opened if (t["idle_days"] or 0) >= STALL_DAYS]
    stale = sorted((t for t in opened if (t["idle_days"] or 0) >= STALE_DAYS),
                   key=lambda t: -(t["idle_days"] or 0))

    groups: dict[str, list[dict]] = defaultdict(list)
    for t in opened:
        groups[t["group"]].append(t)
    g_new = Counter(t["group"] for t in new7)
    g_closed = Counter(t["group"] for t in closed7)
    sort_key = (lambda t: (not t["overdue"], -(t["over_days"] or 0), t["prio_rank"],
                           -(t["age_days"] or 0)))
    out_groups = []
    for name, items in groups.items():
        items.sort(key=sort_key)
        g_over = [t for t in items if t["overdue"]]
        subs = Counter(t["sub"] or "General" for t in items)
        out_groups.append({
            "name": name,
            "count": len(items),
            "overdue": len(g_over),
            "urgent": sum(t["prio_rank"] <= 1 for t in items),
            "urgent_overdue": sum(t["prio_rank"] <= 1 for t in g_over),
            "oldest_over": max((t["over_days"] for t in g_over), default=None),
            "stalled": sum((t["idle_days"] or 0) >= STALL_DAYS for t in items),
            "new_7d": g_new.get(name, 0),
            "closed_7d": g_closed.get(name, 0),
            "hot": any(t["prio_rank"] <= 1 for t in g_over),
            "subgroups": [{"name": k, "count": v} for k, v in subs.most_common()] if len(subs) > 1 else [],
            "items": [public(t) for t in items],
        })
    out_groups.sort(key=lambda g: (not g["hot"], -g["count"], g["name"]))

    trend = []
    for i in range(TREND_WEEKS - 1, -1, -1):
        ts = now - timedelta(days=7 * i)
        trend.append({"at": ts.isoformat(), "size": len(opened) if i == 0 else queue_size_at(ts, opened, rows)})

    by_status = Counter(t["status_kind"] for t in opened)
    rate = round(len(closed7) / 7, 1)
    rate_prev = round(len(closed_prev) / 7, 1)

    do_first = []
    if urgent_over:
        do_first.append({
            "title": f"{len(urgent_over)} High/Critical ticket{'s are' if len(urgent_over) != 1 else ' is'} past SLA",
            "detail": f"Oldest: #{urgent_over[0]['ticket']} ({urgent_over[0].get('subject') or 'no summary'}), "
                      f"{urgent_over[0]['over_days']}d past target at {urgent_over[0].get('site') or 'no site'}.",
            "refs": [t["ticket"] for t in urgent_over[:6]]})
    worst = max(out_groups, key=lambda g: g["overdue"], default=None)
    if worst and worst["overdue"] and overdue:
        do_first.append({
            "title": f"{worst['name']} holds {worst['overdue']} of the {len(overdue)} past-SLA tickets",
            "detail": f"{worst['count']} open in this group; {worst['stalled']} untouched for "
                      f"{STALL_DAYS}+ days" + (f"; the oldest is {worst['oldest_over']}d over."
                                               if worst["oldest_over"] else "."),
            "refs": [t["ticket"] for t in worst["items"] if t["overdue"]][:6]})
    if stale:
        do_first.append({
            "title": f"{len(stale)} ticket{'s have' if len(stale) != 1 else ' has'} not moved in {STALE_DAYS}+ days",
            "detail": f"Longest untouched: #{stale[0]['ticket']}, {stale[0]['idle_days']} days since its "
                      "last update. A status note or a close clears these fastest.",
            "refs": [t["ticket"] for t in stale[:6]]})
    growing = sorted((g for g in out_groups if g["new_7d"] > g["closed_7d"]),
                     key=lambda g: -(g["new_7d"] - g["closed_7d"]))
    if growing:
        g = growing[0]
        do_first.append({
            "title": f"{g['name']} grew this week",
            "detail": f"{g['new_7d']} new against {g['closed_7d']} closed in the last 7 days; "
                      f"{g['count']} open now. Growth here is cheapest to stop at intake.",
            "refs": []})

    return {
        "now": now.isoformat(),
        "assigned": assigned,
        "totals": {"active": len(opened), "open": by_status.get("open", 0),
                   "prog": by_status.get("prog", 0), "hold": by_status.get("hold", 0),
                   "other": by_status.get("other", 0), "overdue": len(overdue),
                   "max_over": max((t["over_days"] for t in overdue), default=None),
                   "urgent": len(urgent), "urgent_overdue": len(urgent_over),
                   "stalled": len(stalled)},
        "delta": {"closed_7d": len(closed7), "new_7d": len(new7), "rate_7d": rate,
                  "rate_prev_7d": rate_prev, "queue_7d_ago": q_then,
                  "net": len(opened) - q_then, "net_pct": _change(len(opened), q_then)},
        "trend": trend,
        "mix": [{"name": g["name"], "count": g["count"], "hot": g["hot"]}
                for g in sorted(out_groups, key=lambda g: -g["count"])],
        "do_first": do_first,
        "groups": out_groups,
        "stall_days": STALL_DAYS,
    }

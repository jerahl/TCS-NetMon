#!/usr/bin/env python3
"""Seed the September 2026 wireless investigation into the issue tracker.

A one-shot, written once and kept because it is the worked example spec 24 was
designed around: the findings, the plan and the open questions from that
investigation, entered the way the tracker expects them to be entered.

Shape: one parent issue carrying the narrative and the plan, and one child per
finding so each can be triaged on its own — the timeout change is urgent and
nearly free, the firewall consolidation is a phase-2 project, and a single
status on one row could not say both.

Deliberately does NOT link devices. The investigation named "two APs at NMS"
and confirmed the same at WMS without recording which ones; inventing device
ids to make the demo look complete would be putting false evidence into the
record system on its first day. Link them from the UI once they are known.

Idempotent: re-running finds the parent by title and does nothing.

    /opt/netmon/venv/bin/python scripts/seed_wireless_issue.py [--config PATH]
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone

from netmon import db
from netmon.config import load_config

REPORTER = "sappleby"

PARENT_TITLE = "District wireless instability — APs resetting under connection-table exhaustion"

PARENT_BODY = """\
Ongoing investigation into "wireless isn't working" reports. Five findings so
far, each tracked as its own issue and listed below. Confirmed at NMS and WMS;
the root cause is configuration shared by every AP, so other schools are
likely affected and have not yet been checked.

FINDINGS
  1. AP connection tables filling and resetting  (most serious)
  2. Devices reconnecting repeatedly at class change
  3. A few devices stuck in a constant reconnect loop
  4. Unnecessary broadcast traffic repeated to every AP
  5. Wireless firewall rules duplicated across AP and switch, with errors

PLAN

Immediate
  - Shorten how long APs hold DNS-lookup and idle connections. Should cut the
    connection table by well over half on its own and keep APs off the cap.
  - Check AP uptime and reset history district-wide to find how many other
    schools are affected.

Phase 1 — low risk
  - Turn on broadcast and multicast reduction.
  - Pull a few of the looping Chromebooks and fix the device-side cause.

Phase 2
  - Move the wireless firewall rules to one place — the core switch at each
    school — and remove them from the APs. This eliminates most of the
    connection tracking that causes the resets and leaves one rule set to
    maintain.
  - Correct the switch rule sets while doing it.

Phase 3
  - Adjust how the two radios on each AP share devices, and review how many
    wireless networks we broadcast.

Separate student and teacher wireless networks were considered and RULED OUT:
shared Chromebooks do not get a new address when the user changes, so the
split would not hold.

TESTING
Each change goes on one NMS access point first, with a neighbouring AP as the
baseline. Connection counts, reconnect rates and login volume compared over the
same school day before anything rolls wider. Connection tables tracked on
several APs at NMS and WMS through a full school day to confirm the timeout
change keeps them well below the cap. Also: a wireless capture during a class
change to confirm the cause of the reconnects, and controlled firewall tests
before any rule moves.

Every change is reversible from ExtremeCloud IQ or the switch configuration.

WHAT IS NEEDED
  - Approval for the timeout change, quickly. It addresses the resets and is
    low risk.
  - A decision on whether teachers need access to camera recorders from
    wireless. Current rules mostly block it already.
  - Help from the schools when problems happen: exact time, room, device asset
    tag, and what the user saw. This tracker is where those go.
"""

CHILDREN = [
    {
        "title": "AP connection tables filling to the ~16,000 cap and resetting",
        "severity": "crit",
        "status": "planned",
        "site": None,
        "body": """\
Each AP keeps a table of every active connection, capped at about 16,000
entries. Two APs at NMS were confirmed to have filled that table completely and
reset; the same condition was then verified at WMS. When it happens every
device on the AP is disconnected at once, which is exactly what the "wireless
isn't working" reports describe.

The cause is configuration shared by every AP, so this is likely happening at
other schools. Only NMS and WMS have been checked.

WHY THE TABLE FILLS
  - About 70% of entries are DNS lookups, and each is doubled because
    Chromebooks send every lookup to both DNS servers at once.
  - Lookups that complete in a fraction of a second are held for 60 seconds;
    idle web connections are held for 30 minutes.
  - The AP only tracks these connections at all because of the firewall rules
    applied on the AP itself — see the firewall consolidation issue.

FIX (immediate, pending approval)
Shorten the lookup and idle hold times. Expected to cut the table by well over
half and keep APs off the cap. Low risk and reversible from ExtremeCloud IQ.

STILL TO DO
  - District-wide AP uptime and reset-history check to size the blast radius.
  - Record which two NMS APs these were, and link them here.
""",
    },
    {
        "title": "Devices reconnecting repeatedly at class change",
        "severity": "warn",
        "status": "investigating",
        "site": "NMS",
        "body": """\
In one room, about half of all logins over a day were the same devices
reconnecting within five minutes, often bouncing between the AP's two radios.

Signal strength is excellent, so this is NOT a coverage problem. It looks like
a configuration issue in how the two radios share devices between them.

Every reconnect also adds a burst of new entries to the AP's connection table,
which makes the connection-table exhaustion worse.

NEXT
Wireless capture during a class change to confirm the cause before changing
anything. Radio band-steering settings are a phase-3 change.
""",
    },
    {
        "title": "2–8 devices per day stuck in a 10-second reconnect loop",
        "severity": "warn",
        "status": "open",
        "site": "NMS",
        "body": """\
On any given school day, between 2 and 8 devices at NMS reconnect every 10
seconds for hours at a time. That accounts for up to a third of all login
traffic at the school.

PacketFence approves them every time, and the same devices repeat day after
day. That points to a device-level fault rather than anything in the network.

NEXT (phase 1)
Pull a few of the looping Chromebooks and find the device-side cause. Record
asset tags here as they are identified.
""",
    },
    {
        "title": "Wireless broadcast traffic repeated over the air to every AP",
        "severity": "info",
        "status": "planned",
        "site": None,
        "body": """\
Traffic from the whole wireless network is being repeated over the air to every
AP, taking airtime away from classroom use.

FIX (phase 1, low risk)
Turn on broadcast and multicast reduction.
""",
    },
    {
        "title": "Wireless firewall rules duplicated across AP and switch, with errors",
        "severity": "warn",
        "status": "waiting",
        "site": None,
        "category": "switching",
        "body": """\
The same restrictions — for example blocking students from the camera and phone
systems — are enforced in two places: on the AP and on the switch. Two copies
that have already drifted.

PROBLEMS IN THE SWITCH COPY
  - Ordering mistakes and several typos.
  - The switch rules ALONE would let students reach three camera recorders.
    Today only the AP rules stop that for wireless traffic.
  - Wireless users are not blocked from network equipment management
    addresses.

FIX (phase 2)
Consolidate onto one place — the core switch at each school — and remove the
rules from the APs. This also eliminates most of the connection tracking behind
the AP resets, and leaves one rule set to maintain instead of two.

Correct and clean up the switch rule sets while doing it. Verify firewall
behaviour with controlled tests before moving anything.

BLOCKED ON A DECISION
Do teachers need access to the camera recorders from wireless? The current
rules mostly block it already. The answer changes what the consolidated rule
set looks like, so this is waiting.
""",
    },
]


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None, help="path to netmon.conf")
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)

    existing = db.fetch_one(engine, "SELECT id FROM issues WHERE title = :t",
                            {"t": PARENT_TITLE})
    if existing:
        print(f"already seeded as issue #{existing['id']} — nothing to do")
        return 0

    now = _now()

    def insert(title, body, severity, status, category, site) -> int:
        db.execute(engine, """
            INSERT INTO issues (title, body, status, severity, category, site,
                                reported_by, assigned_to, created_at, updated_at)
            VALUES (:title, :body, :status, :severity, :category, :site,
                    :who, :who, :at, :at)
        """, {"title": title, "body": body, "status": status, "severity": severity,
              "category": category, "site": site, "who": REPORTER, "at": now})
        return int(db.fetch_one(engine,
                                "SELECT id FROM issues WHERE title = :t ORDER BY id DESC LIMIT 1",
                                {"t": title})["id"])

    parent = insert(PARENT_TITLE, PARENT_BODY, "crit", "investigating",
                    "wireless", None)
    print(f"#{parent}  {PARENT_TITLE}")

    child_ids = []
    for spec in CHILDREN:
        cid = insert(spec["title"], spec["body"], spec["severity"], spec["status"],
                     spec.get("category", "wireless"), spec["site"])
        child_ids.append((cid, spec["title"]))
        print(f"#{cid}  {spec['title']}")

    # The tracker has no parent/child column — deliberately, spec 24 keeps the
    # model flat — so the relationship is stated in the thread, which is where a
    # reader looks anyway.
    listing = "\n".join(f"  #{cid} — {title}" for cid, title in child_ids)
    db.execute(engine, """
        INSERT INTO issue_comments (issue_id, kind, body, author, created_at)
        VALUES (:i, 'comment', :b, :a, :t)
    """, {"i": parent, "b": f"Findings are tracked separately:\n\n{listing}",
          "a": REPORTER, "t": now})
    for cid, _ in child_ids:
        db.execute(engine, """
            INSERT INTO issue_comments (issue_id, kind, body, author, created_at)
            VALUES (:i, 'comment', :b, :a, :t)
        """, {"i": cid, "b": f"Part of #{parent} — the district wireless investigation.",
              "a": REPORTER, "t": now})

    engine.dispose()
    print(f"\nseeded {1 + len(child_ids)} issues. Open /ui/#/issues")
    return 0


if __name__ == "__main__":
    sys.exit(main())

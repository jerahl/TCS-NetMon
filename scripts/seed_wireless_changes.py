#!/usr/bin/env python3
"""Seed the wireless remediation plan as change records (spec 24 §10).

The 2026-09-28 design review ends in a list of things to do. Each is a change
with a prediction attached, and several of those predictions are already
numeric — "DNS entries 4,620 → 1,087, about −76%" is exactly the shape this
table exists to check later.

So they go in now, as `proposed`, with `expected` written before anybody
touches anything. Written afterwards it would be a rationalisation; the whole
value of the record is that the number was committed to in advance.

Nothing here is applied. These are proposals, and two of them are explicitly
waiting on a decision that is not ours to make.

Device roles follow the standing method: change one AP, hold a neighbouring one
as a baseline, compare across the same school day. NMS-B111 is the target and
NMS-B108 the control for the AP-level work, because both have been measured and
the measurements are on the tickets.

Idempotent: changes are matched by title.

    /opt/netmon/venv/bin/python scripts/seed_wireless_changes.py \\
        --config /etc/netmon/netmon.conf
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from netmon import db  # noqa: E402
from netmon.config import load_config  # noqa: E402

AUTHOR = "sappleby"
SITE = "Northridge Middle"

CHANGES = [
    {
        "issue": 2,
        "title": "Shorten the DNS session timeout to 10s on the Students ip-policy",
        "risk": "low",
        "targets": ["NMS-B111"], "baselines": ["NMS-B108"],
        "what": """\
Create a short-timeout DNS service object in XIQ — UDP/53, timeout 60 s → 10 s —
and apply it to the Students user-profile ip-policy on NMS-B111 only.

NMS-B108 keeps the 60 s timeout as the control.

Per-service timeouts are already supported on this firmware; the config carries
`service NTP protocol udp port 123 timeout 60` as precedent.""",
        "why": """\
DNS is 73% of B111's session table and 45% of B108's. Each entry is a single
query/response exchange that completes in a fraction of a second and is then
held for a full 60 s. Only 17 of 4,633 queries went unanswered, so the
resolvers are healthy — this is pure hold time, not retries.

This is the cheapest change on the list and depends on nothing else.""",
        "expected": """\
DNS entries on B111: 4,620 → about 1,087, roughly **−76%**.
Total session count stays well under the 16,383 cap across a full school day —
expect a peak in the low thousands rather than the 9,680 measured on 9/22.

B108, unchanged, should show no improvement over the same day. If both move,
something other than this change caused it.

No client-visible effect: a 10 s timeout is far longer than any real DNS
exchange here.""",
        "rollback": "Restore the 60 s timeout on the DNS service object in XIQ and "
                    "push. Reversible in under a minute, no AP reboot.",
    },
    {
        "issue": 2,
        "title": "Shorten the TCP/HTTPS idle timeout to 300s on the Students ip-policy",
        "risk": "low",
        "targets": ["NMS-B111"], "baselines": ["NMS-B108"],
        "what": """\
Create an HTTPS/TCP service object in XIQ with a 300 s idle timeout, down from
the 30-minute default, and apply it to the Students ip-policy on NMS-B111 only.
B108 keeps the default.""",
        "why": """\
B108 carries 1,600 TCP/443 sessions, 34% of them idle for more than five
minutes but held by the 30-minute ageout. Much of that tail belongs to clients
that have already left the AP — a class change leaves half an hour of dead
entries behind it.""",
        "expected": """\
Roughly a third of TCP/443 entries clear within five minutes instead of thirty.
Smaller effect than the DNS change — TCP is the long tail, not the bulk — so
expect a reduction in the hundreds, not thousands.

Watch for the risk this one actually carries: a legitimately idle session being
torn down mid-lesson. If anything breaks it will be a long-poll or a persistent
connection, not ordinary browsing.""",
        "rollback": "Restore the 30-minute idle timeout in XIQ and push.",
    },
    {
        "issue": 2,
        "title": "Hand out a single resolver address to VLAN 228 instead of two",
        "risk": "medium",
        "targets": [], "baselines": [],
        "what": """\
On the DHCP server at 10.10.1.4, change the VLAN 228 scope option to offer one
resolver address — anycast or load-balanced — rather than the current pair.

**First establish what the scope actually hands out today**, and whether NMS has
more than one: B111's clients used 10.10.0.6/.7 on 9/22 and B108's used
.7/.10 on 9/28, which is unexplained.""",
        "why": """\
Every client queries both configured resolvers in the same second — on B111,
99% of queries to .6 had a twin to .7; on B108, 725 of 727 queries to .7 had a
twin to .10. This looks like ChromeOS querying all configured resolvers in
parallel. It doubles every DNS session outright, and the AP pays for both.

This halves the problem at its source rather than ageing the symptoms out
faster, which is why it is worth the higher risk.""",
        "expected": """\
DNS sessions roughly **halve** again on top of whatever the timeout change
achieves, because each lookup creates one session instead of two.

Resolution behaviour unchanged for clients.

The risk is resilience, not performance: a single advertised address removes the
client-side failover that the current pair provides by accident. It is only
acceptable if the address is genuinely anycast or load-balanced — if it resolves
to one box, this trades a session-table problem for an outage risk, and should
not be done.""",
        "rollback": "Restore the resolver pair in the VLAN 228 scope options and let "
                    "leases renew, or force renewal.",
    },
    {
        "issue": 3,
        "title": "Turn on load balancing between the two 5 GHz radios on NMS-B111",
        "risk": "medium",
        "targets": ["NMS-B111"], "baselines": ["NMS-B108"],
        "what": """\
Enable client load balancing between wifi0 and wifi1 on NMS-B111's radio
profile. B108 keeps it off as the control.

**Blocked on the capture.** Do not apply this until B108's wifi0 has been
captured during a 09:00 or 12:10 burst and the deauth reason codes say who is
sending them. If the client is deauthenticating itself, load balancing will not
help and this change should not be made.""",
        "why": """\
Both radios are 5 GHz on the same SSID, 20 MHz, with band steering and load
balancing both off, and no 2.4 GHz radio at all. Signal is −21 to −41 dBm, so
both radios look essentially equal to every client in the room and nothing
arbitrates between them.

48% of RADIUS requests on B108 were re-authentications within five minutes of
the same device's previous one, about half of them switching radios. Median
connection life is 59 s.""",
        "expected": """\
Radio-switching re-authentications on B111 fall materially — the measurable
target is the 48%-within-five-minutes figure dropping below about 20%, with the
median connection life rising well above 59 s.

B108, unchanged, should hold near 48%.

Each avoided bounce also removes a DNS/TLS burst from the session table, so
expect a second-order improvement there.

**Honest uncertainty:** the cause is a hypothesis, not a finding. If the deauths
turn out to be client-originated, this will show no effect, and `no_effect` is
then the correct verdict rather than a reason to tune further.""",
        "rollback": "Disable load balancing on the B111 radio profile and push.",
    },
    {
        "issue": 5,
        "title": "Enable broadcast/multicast suppression on VLAN 228 at NMS",
        "risk": "low",
        "targets": ["NMS-B111"], "baselines": ["NMS-B108"],
        "what": """\
On NMS-B111 only: enable proxy ARP, multicast-to-unicast conversion, and IPv6
NS/RA suppression on the TCS-Wireless SSID. B108 unchanged.

mDNS filtering, MLD snooping upstream and shrinking the /21 are deliberately
not in this change — they are separate decisions with wider blast radius.""",
        "why": """\
On a lightly loaded AP, 58% of all frames and 90% of data frames are
group-addressed: about 20/s on B111 and 36/s on B108, made up of ARP (~8/s),
mDNS, MLD reports, IPv6 all-routers traffic, and neighbour solicitations for
clients sitting on *other* APs. That is airtime spent on traffic with no reason
to be on this AP at all.""",
        "expected": """\
Group-addressed frames on B111 drop from about 20/s to single figures, and the
share of data frames that are group-addressed falls well below 90%.

Airtime freed should show as lower channel utilisation at the 08:40 peak, which
measured about 37% on wifi0.

Watch for the thing this breaks: anything relying on multicast discovery —
AirPlay, Chromecast, network printer discovery. If a classroom tool uses mDNS
to find a device, it will stop finding it.""",
        "rollback": "Disable the three suppression options on the B111 SSID profile "
                    "and push.",
    },
    {
        "issue": 6,
        "title": "Correct the 15 unreachable 'Allow DVR' rules in the switch policy",
        "risk": "medium",
        "targets": ["NMS-MDF", "NMS-IDF-A102"], "baselines": [],
        "what": """\
Reorder the DVR permit rules ahead of their own subnet denies, and fix the three
identified errors: CO ACE3 and MLK ACE15 matching source instead of destination,
and OKH ACE42's 10.64.18.10 which should be 10.84.18.10.

**Blocked on two prerequisites**, neither of which is optional:
  1. Confirm `access-list` rules are first-match — a wireless teacher tries the
     CES DVR at 10.28.18.100. If it is blocked, first-match is confirmed and so
     is every ordering bug.
  2. Decide whether teachers need DVR access from wireless at all. If they do
     not, the correct change is to remove these rules rather than fix them, and
     this record should be abandoned in favour of that one.""",
        "why": """\
15 of 21 "Allow DVR" rules sit after their own subnet deny and therefore never
match. Only the BHS (10.128.18.2), NMS (10.172.18.11) and TCT (10.88.18.101)
permits work today.

This has two consequences pointing in opposite directions, which is why it
needs the decision first: teachers mostly cannot reach DVRs and nobody has
complained, while teacher DVR permits were also copied into Students and
WirelessAP, so wired students and all AP-port traffic *can* reach those three
working DVRs as far as the switch is concerned.""",
        "expected": """\
If teachers do need the access: all 21 DVR permits become reachable, and a
wireless teacher can reach the CES DVR where they currently cannot.

Either way, the student-facing exposure to the three working DVRs closes.

**This change makes something newly reachable, so it is the one on this list
most able to do harm.** Verify by testing both directions — a teacher who should
now reach a DVR, and a student who should not.""",
        "rollback": "Restore the saved policy from the switch configuration backup. "
                    "Capture `show policy` before and after.",
    },
]


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def _ids(engine, names: list[str]) -> list[int]:
    if not names:
        return []
    rows = db.fetch_all(engine, "SELECT id, name FROM devices WHERE name IN ("
                        + ", ".join(f":n{i}" for i in range(len(names))) + ")",
                        {f"n{i}": n for i, n in enumerate(names)})
    found = {r["name"]: int(r["id"]) for r in rows}
    for n in names:
        if n not in found:
            print(f"  ! {n} not in the registry", file=sys.stderr)
    return [found[n] for n in names if n in found]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Seed the wireless plan as change records.")
    p.add_argument("--config", default=None)
    args = p.parse_args(argv)

    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)
    now = _now()
    made = 0

    for spec in CHANGES:
        if db.fetch_one(engine, "SELECT id FROM changes WHERE title = :t",
                        {"t": spec["title"]}):
            print(f"  = {spec['title'][:60]} (already recorded)")
            continue
        db.execute(engine, """
            INSERT INTO changes (issue_id, title, what, why, expected, status, verdict,
                                 risk, site, rollback, proposed_by, proposed_at,
                                 updated_at)
            VALUES (:i, :t, :what, :why, :exp, 'proposed', 'pending', :risk, :site,
                    :rb, :who, :at, :at)
        """, {"i": spec["issue"], "t": spec["title"], "what": spec["what"],
              "why": spec["why"], "exp": spec["expected"], "risk": spec["risk"],
              "site": SITE, "rb": spec["rollback"], "who": AUTHOR, "at": now})
        cid = int(db.fetch_one(engine, "SELECT id FROM changes WHERE title = :t "
                               "ORDER BY id DESC LIMIT 1", {"t": spec["title"]})["id"])

        for role, names in (("target", spec["targets"]), ("baseline", spec["baselines"])):
            for did in _ids(engine, names):
                db.execute(engine, "INSERT INTO change_devices (change_id, device_id, "
                           "role) VALUES (:c, :d, :r)",
                           {"c": cid, "d": did, "r": role})

        db.execute(engine, """
            INSERT INTO issue_comments (issue_id, kind, body, author, created_at)
            VALUES (:i, 'status_change', :b, :a, :t)
        """, {"i": spec["issue"],
              "b": f"change #{cid} proposed — {spec['title']}", "a": AUTHOR, "t": now})
        db.execute(engine, "UPDATE issues SET updated_at = :t WHERE id = :i",
                   {"t": now, "i": spec["issue"]})
        print(f"  #{cid}  [{spec['risk']:>6}] →#{spec['issue']}  {spec['title'][:58]}")
        made += 1

    engine.dispose()
    print(f"\n{made} change(s) recorded, all proposed. Nothing has been applied.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Record the 2026-10-01 TCSDNS1 recursion change, already performed.

Unlike `seed_wireless_changes.py`, which records proposals, this enters a change
that has already been made and verified. It therefore has to do one thing
carefully and say so loudly.

**`expected` IS RECONSTRUCTED, NOT COMMITTED IN ADVANCE.**

The whole design of the changes table rests on the prediction being written
before the result is known (spec 24 §10), and the API enforces that by refusing
edits to `expected` after a change is applied. Entering a completed change from
a write-up inverts it: the source document already contains the answer, so
anything written into `expected` is reconstruction, however carefully derived.

Rather than quietly launder that, the `expected` text opens by saying what it
is. A reader comparing expected against actual on this row needs to know the
comparison is weaker here than on a row where the number was committed first —
and every other row stays trustworthy precisely because this one is labelled.

The record goes in with its real timestamps (applied 15:15 UTC, verified 15:40
UTC) by direct write rather than through `/apply` and `/verify`, which would
stamp it with the time of entry and misdate the change by a day.

Also opens two issues the change ticket surfaces as standing problems rather
than finished work:

  * the FortiGate DNS proxy defect — the root cause, still live for anything
    else that forwards to it and validates DNSSEC
  * DuckDuckGo subdomains broken for every domain-joined client by the DC's
    whole-domain zone, which the ticket is explicit predates this change

No device links: TCSDNS1, the legacy resolvers, the domain controllers and the
FortiGate are none of them in NetMon's registry, because server monitoring stays
with Zabbix and FortiGate is deferred (CLAUDE.md §2). Linking nothing is the
honest answer; inventing registry entries to decorate the record is not.

Idempotent: matched by title.

    /opt/netmon/venv/bin/python scripts/record_dns_recursion_change.py \\
        --config /etc/netmon/netmon.conf [--ticket <path to the .md>]
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from netmon import db  # noqa: E402
from netmon.config import load_config  # noqa: E402

AUTHOR = "sappleby"

APPLIED_AT = datetime(2026, 10, 1, 15, 15)    # 10:15 CDT
VERIFIED_AT = datetime(2026, 10, 1, 15, 40)   # 10:40 CDT

TITLE = ("TCSDNS1: stop forwarding to the FortiGate, resolve recursively from "
         "root hints")

WHAT = """\
TCSDNS1 (10.10.0.10, Debian 13.6 / BIND 9.20.29) — three parts, applied with
`rndc reconfig` and `rndc flush`. **No service restart**; named has not
restarted since 2026-09-24 13:28 CDT.

1. **Removed forwarding.** Deleted `forwarders { 192.168.254.14; }` and
   `forward only` from `/etc/bind/named.conf.options`. Root hints were already
   present via `named.conf.root-hints`; no new zone added.

2. **Removed six negative trust anchors** applied earlier the same day as a
   stop-gap: office365.com, office.com, outlook.com, salesforce.com,
   cloud.microsoft, microsoft. DNSSEC validation is now unqualified.

3. **Added seven SafeSearch forward zones** to `/etc/bind/named.conf.local`,
   pointing at the domain controllers (10.10.1.177 / 10.10.1.178):
   www.google.com, www.youtube.com, m.youtube.com, youtubei.googleapis.com,
   youtube.googleapis.com, www.bing.com, www.duckduckgo.com. Declared
   `forward only` so they fail closed rather than returning unfiltered answers
   if both DCs are unreachable.

PREREQUISITE, provided by the network team: a FortiGate egress policy
permitting 10.10.0.10 outbound to UDP and TCP 53, any destination. Before this,
outbound DNS was entirely blocked and recursion was impossible.

NOT CHANGED: the nine Active Directory secondary zones, the nftables ruleset,
the Elastic Agent, query logging (remains off), and the events log path and
format.

Validated with `named-checkconf -z` (clean, exit 0) before every reload.
Backups: `named.conf.options.pre-recursive`,
`named.conf.local.pre-safesearch`. Version-controlled at `/root/dns-config`,
commit `8d25180`.
"""

WHY = """\
PRIMARY DRIVER — Microsoft 365 was failing to resolve.

Users reported `outlook.office365.com` would not resolve. TCSDNS1 returned
SERVFAIL while the legacy CentOS resolvers (10.10.0.6 / .7) answered normally.

Root cause is a defect in the FortiGate's DNS proxy: it returns **malformed
DNSSEC data for DS queries across a CNAME chain**. Two faults in one response —
a DS query returned a followed CNAME chain (DS queries are answered by the
parent zone and must return the DS RRset or an authenticated denial), and every
RRSIG owner name was shifted onto the following record's name.

The same signature, from the same forwarder, seconds apart:

    ; CNAME query — correct
    outlook.office365.com.   300 IN RRSIG CNAME ... 45827 office365.com. X6TRgJar...
    ; DS query — owner name shifted
    outlook.cloud.microsoft. 300 IN RRSIG CNAME ... 45827 office365.com. X6TRgJar...

The second is impossible on its face: a zone can only sign names within itself,
and `outlook.cloud.microsoft` is not inside `office365.com`. Reproducible over
UDP and TCP, consistently.

BIND 9.20 behaved correctly throughout. Because `office365.com` is signed, an
apparently unsigned CNAME beneath it triggers an insecurity proof requiring a DS
lookup at a name that is itself a CNAME. `delv` reported "fetch would not
advance the alias chain: aborting validation" and "deadlock found resolving
'outlook.office365.com/A/IN': 192.168.254.14#53".

Affected: outlook.office365.com, smtp.office365.com, teams.microsoft.com,
autodiscover-s.outlook.com, www.office.com, www.salesforce.com.

This is latent on the legacy CentOS resolvers only because BIND 9.11 does not
enforce it as strictly. It would have surfaced at full cutover regardless.

WHY FULL RECURSION RATHER THAN CONTINUING TO WORK AROUND IT

Negative trust anchors fix the symptom but disable DNSSEC validation for the
named domains and expire, requiring renewal. `validate-except` would make that
permanent and silent. Both leave the district trusting a DNS proxy that
demonstrably corrupts signatures, and both are whack-a-mole: any future signed
zone with a cross-zone CNAME hits the same bug.

Full recursion removes the defective component from the resolution path
entirely, restores genuine end-to-end DNSSEC validation, and eliminates a single
point of failure.

WHY THIS WAS SAFE FOR CONTENT FILTERING

Content filtering and CIPA obligations are met by Lightspeed Relay and the
FortiGate web filter, neither of which depends on DNS forwarding. The FortiGate
DNS category filter that the migration handoff had planned as the RPZ
replacement was never enabled and is not in this resolver's path.

SafeSearch *did* partly depend on the forwarder, which is why part 3 was needed.
"""

EXPECTED = """\
⚠ RECONSTRUCTED AFTER THE FACT, NOT COMMITTED IN ADVANCE.

This change was performed and written up before it was entered here, so the
text below is derived from the pre-change reasoning in the change ticket rather
than predicted beforehand. Every other row in this table carries a prediction
written before the result was known; this one does not, and a reader comparing
expected against actual here should weigh it accordingly.

What the change set out to achieve:

1. The six failing Microsoft 365 and Salesforce names resolve again, and do so
   with genuine DNSSEC validation (the `ad` flag) rather than by bypassing it.
2. Resolution goes directly to the root, gTLD and authoritative servers, with
   no traffic to 192.168.254.14.
3. No service impact — applied by `rndc reconfig`, no restart, no client-visible
   interruption.
4. DNSSEC enforcement preserved for the rest of the namespace: a deliberately
   broken zone still fails.
5. The nine AD secondary zones, internal forward and reverse resolution, and the
   district's key services unaffected.
6. SafeSearch enforcement preserved, by forwarding the seven search names to the
   domain controllers to replace what the FortiGate rewrite had been doing.

Not anticipated, and therefore not an expectation this change can be scored
against: that investigating item 6 would uncover a pre-existing SafeSearch
misconfiguration. See Actual.
"""

ACTUAL = """\
SUCCESSFUL. Outage resolved, and a pre-existing compliance gap closed.

1. MICROSOFT 365 RESTORED, WITH VALIDATION

   outlook.office365.com      SERVFAIL → NOERROR, `ad`
   smtp.office365.com         SERVFAIL → NOERROR, `ad`
   www.office.com             SERVFAIL → NOERROR, `ad`
   autodiscover-s.outlook.com SERVFAIL → NOERROR, `ad`
   teams.microsoft.com        SERVFAIL → NOERROR
   www.salesforce.com         SERVFAIL → NOERROR

   The `ad` flag is the point: this is genuine end-to-end validation, not a
   bypass.

2. RECURSION CONFIRMED. Outbound queries observed going directly to root
   servers (192.5.6.30, 192.203.230.10, 199.7.83.42), gTLD servers, and
   authoritative servers at Akamai, AWS Route 53 and Google. No traffic to
   192.168.254.14.

3. BEYOND THE EXPECTATION — a SafeSearch gap found and closed.

   The domain controllers host single-name zones redirecting the search
   domains, and TCSDNS1 was not using them. Enforcement had been coming from
   the FortiGate's in-path rewrite, which was incomplete:

   name                      DC (correct)      via FortiGate     now
   www.google.com            216.239.38.120    216.239.38.120    correct
   www.youtube.com           216.239.38.119    216.239.38.120    CORRECTED
   m.youtube.com             216.239.38.119    216.239.38.120    CORRECTED
   youtubei.googleapis.com   216.239.38.119    216.239.38.120    CORRECTED
   youtube.googleapis.com    216.239.38.119    216.239.38.120    CORRECTED
   www.bing.com              204.79.197.220    150.171.27.16     CORRECTED
   www.duckduckgo.com        46.137.218.113    52.149.247.1      CORRECTED

   216.239.38.119 is restrict.youtube.com (Restricted Mode); .120 is
   forcesafesearch.google.com. Pointing YouTube at .120 meant **Restricted Mode
   was not actually being applied**, and Bing and DuckDuckGo were not enforced
   at all.

   This condition existed while the server was still forwarding to the
   FortiGate. The change did not create it — it exposed it. All seven now match
   the domain controllers exactly.

4. NO REGRESSIONS

   - DNSSEC still enforced: dnssec-failed.org SERVFAIL; cloudflare.com and
     internetsociety.org return `ad`.
   - Nine AD secondary zones in sync; internal forward and reverse resolution
     unaffected.
   - ClassLink, PowerSchool, Clever, ChatGPT, Google and Microsoft 365 all
     resolve.
   - named, nftables and the Elastic Agent all active and enabled; five agent
     components healthy; query logging remains off.
   - No service restart.

VERDICT NOTE. Scored `as_expected` against the primary objective, which was met
in full and verified. Two residual items are open and tracked as their own
issues rather than counted against this change: the FortiGate defect itself,
which is untouched and still live for anything else forwarding to it, and the
DuckDuckGo subdomain breakage, which predates this change. One cost was accepted
knowingly — FortiGate DNS category filtering is no longer available to this
resolver as a future option, so filtering now rests entirely on Lightspeed Relay
and the FortiGate web filter.
"""

ROLLBACK = """\
Not required. If needed, restores the previous forwarding configuration in under
a minute, no restart:

    cp /etc/bind/named.conf.options.pre-recursive /etc/bind/named.conf.options
    cp /etc/bind/named.conf.local.pre-safesearch  /etc/bind/named.conf.local
    named-checkconf -z
    rndc reconfig

    # then re-apply the stop-gap, since the FortiGate defect would return:
    for z in office365.com office.com outlook.com salesforce.com \\
             cloud.microsoft microsoft; do
        rndc nta -l 168h "$z"
    done

Config is version-controlled at /root/dns-config (commit 8d25180), so
`git revert` is an equivalent path.

NOTE: rolling back restores the outage. The negative trust anchors are what make
the FortiGate path usable at all, and they expire after 168h.
"""

# ── issues this change leaves behind ─────────────────────────────────────────

ISSUES = [
    {
        "key": "fortigate",
        "title": "FortiGate DNS proxy returns malformed DNSSEC data for DS queries "
                 "across a CNAME chain",
        "severity": "warn", "status": "open", "category": "switching",
        "body": """\
The FortiGate's DNS proxy (192.168.254.14) corrupts DNSSEC responses. Two
distinct faults in a single answer:

  - A DS query returns a followed CNAME chain. DS queries are answered by the
    parent zone and must return the DS RRset or an authenticated denial.
  - Every RRSIG owner name is shifted onto the following record's name.

The same signature, from the same forwarder, seconds apart:

    ; CNAME query — correct
    outlook.office365.com.   300 IN RRSIG CNAME ... 45827 office365.com. X6TRgJar...
    ; DS query — owner name shifted
    outlook.cloud.microsoft. 300 IN RRSIG CNAME ... 45827 office365.com. X6TRgJar...

The second is impossible on its face: a zone can only sign names within itself,
and `outlook.cloud.microsoft` is not inside `office365.com`. Reproducible over
both UDP and TCP, consistently.

This caused a live Microsoft 365 outage on 2026-10-01 — outlook.office365.com,
smtp.office365.com, teams.microsoft.com, autodiscover-s.outlook.com,
www.office.com and www.salesforce.com all SERVFAIL on TCSDNS1 while BIND 9.20
correctly refused to validate the corrupted data.

STATUS: WORKED AROUND, NOT FIXED. TCSDNS1 no longer forwards to the FortiGate
(change #7), so this resolver is out of its path. **The defect itself is
untouched and still live.** It will affect anything else that forwards to the
FortiGate and validates DNSSEC, and it is latent on the legacy CentOS resolvers
(10.10.0.6 / .7) only because BIND 9.11 does not enforce it as strictly — it
would have surfaced at full cutover regardless.

Any future signed zone with a cross-zone CNAME hits the same bug, which is why
the negative trust anchors were abandoned as a strategy: they are whack-a-mole.

FOLLOW-UPS FROM THE CHANGE TICKET
  1. **Fortinet TAC case** (Network). Optional for TCSDNS1 now that it is out of
     the path, but the defect will affect anything else in the same position.
     Reproduction steps are in /root/dns-build-report.md.
  2. **Second resolver needs the same egress rule** (Network): outbound UDP and
     TCP 53 for the second server before it can use the recursive configuration.
  3. **One-week review** (Technology), due about 2026-10-08: review events.log
     and Kibana DNS data for resolution failures that forwarding previously
     masked, and for filtering gaps now that the FortiGate DNS proxy is out of
     the path.
  4. **Accepted cost**: FortiGate DNS category filtering is no longer available
     to this resolver as a future option. The migration handoff had planned it
     as the replacement for the retired RPZ/AdBlock scripts. Filtering now rests
     entirely on Lightspeed Relay and the FortiGate web filter.
""",
    },
    {
        "key": "ddg",
        "title": "DuckDuckGo subdomains fail to resolve for every domain-joined client",
        "severity": "warn", "status": "open", "category": "other",
        "body": """\
The domain controllers host `duckduckgo.com` as a **whole-domain** zone for
SafeSearch enforcement, and answer NXDOMAIN for every subdomain under it. So
`links.duckduckgo.com` and anything else beneath the apex fails to resolve for
every domain-joined client.

PRE-EXISTING AND INDEPENDENT of the 2026-10-01 TCSDNS1 recursion change
(change #7). That change deliberately **excluded** DuckDuckGo from the seven
SafeSearch forward zones it added, precisely to avoid propagating this breakage
to all clients of that resolver — forwarding `www.duckduckgo.com` would have
been fine, but the DC zone's shape means forwarding the domain would not.

So TCSDNS1 clients currently get working DuckDuckGo subdomains and **no**
SafeSearch enforcement for DuckDuckGo; domain-joined clients get enforcement
and broken subdomains. Neither is the intended end state.

RECOMMENDATION FROM THE CHANGE TICKET
Handle DuckDuckGo in Lightspeed Relay or the web filter rather than in DNS. A
whole-domain DNS zone is the wrong instrument for a single-name redirect, and
this is what it costs.

NEXT
  1. Confirm the DC zone shape and how many clients are affected.
  2. Decide: narrow the DC zone to the single name, or move DuckDuckGo
     enforcement out of DNS entirely.
  3. Until then, note that DuckDuckGo SafeSearch is unenforced for TCSDNS1
     clients — a known, deliberate gap, not an oversight.
""",
    },
]

ISSUE2_NOTE = """\
The 2026-10-01 TCSDNS1 change (change #7) answers the open question in this
issue about resolver pairs.

This issue recorded that B111's clients used 10.10.0.6/.7 on 9/22 while B108's
used .7/.10 on 9/28, and flagged it as unexplained — "unknown whether the DHCP
scope changed or NMS has more than one scope".

**10.10.0.10 is TCSDNS1**, the new BIND 9.20 resolver. 10.10.0.6 and .7 are the
legacy CentOS resolvers it is replacing. The pairs differ because a DNS server
migration is in progress and .10 is being rolled into the scopes.

Two consequences for the session-table work here:

  - The "hand out a single resolver address" change (change #3) now has to be
    sequenced against that migration rather than planned around a static pair.
    Worth confirming which resolvers VLAN 228's scope on 10.10.1.4 hands out
    *today* before touching it.
  - The dual-query behaviour is a client-side property (ChromeOS querying all
    configured resolvers in parallel), so it will follow the clients onto the
    new resolver set. Migrating resolvers does not fix it.
"""


def _ids(engine, names):
    return []  # none of the DNS hosts are in NetMon's registry — see docstring


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Record the TCSDNS1 recursion change.")
    p.add_argument("--config", default=None)
    p.add_argument("--ticket", default=None, help="the change ticket .md to attach")
    args = p.parse_args(argv)

    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)
    now = datetime.utcnow().replace(microsecond=0)

    if db.fetch_one(engine, "SELECT id FROM changes WHERE title = :t", {"t": TITLE}):
        print("already recorded — nothing to do")
        return 0

    # The issues first, so the change can be linked to the root cause.
    opened = []
    for spec in ISSUES:
        row = db.fetch_one(engine, "SELECT id FROM issues WHERE title = :t",
                           {"t": spec["title"]})
        if row:
            iid = int(row["id"])
        else:
            db.execute(engine, """
                INSERT INTO issues (title, body, status, severity, category, site,
                                    reported_by, assigned_to, created_at, updated_at)
                VALUES (:t, :b, :st, :sv, :c, NULL, :who, :who, :at, :at)
            """, {"t": spec["title"], "b": spec["body"], "st": spec["status"],
                  "sv": spec["severity"], "c": spec["category"],
                  "who": AUTHOR, "at": now})
            iid = int(db.fetch_one(engine, "SELECT id FROM issues WHERE title = :t "
                                   "ORDER BY id DESC LIMIT 1",
                                   {"t": spec["title"]})["id"])
        opened.append((spec["key"], iid, spec["title"]))
        print(f"#{iid}  {spec['title'][:66]}")

    root_cause_issue = next(i for k, i, _ in opened if k == "fortigate")

    # The change itself, with its real timestamps. Written directly rather than
    # through /apply and /verify, which would stamp it with the time of entry.
    db.execute(engine, """
        INSERT INTO changes (issue_id, title, what, why, expected, actual, status,
                             verdict, risk, site, rollback, proposed_by, proposed_at,
                             applied_by, applied_at, verified_by, verified_at,
                             updated_at)
        VALUES (:i, :t, :what, :why, :exp, :act, 'verified', 'as_expected', 'medium',
                NULL, :rb, :who, :applied, :who, :applied, :who, :verified, :now)
    """, {"i": root_cause_issue, "t": TITLE, "what": WHAT, "why": WHY,
          "exp": EXPECTED, "act": ACTUAL, "rb": ROLLBACK, "who": AUTHOR,
          "applied": APPLIED_AT, "verified": VERIFIED_AT, "now": now})
    cid = int(db.fetch_one(engine, "SELECT id FROM changes WHERE title = :t "
                           "ORDER BY id DESC LIMIT 1", {"t": TITLE})["id"])
    print(f"\nchange #{cid}  verified / as_expected  (applied {APPLIED_AT} UTC)")

    for _, iid, _ in opened:
        db.execute(engine, """
            INSERT INTO issue_comments (issue_id, kind, body, author, created_at)
            VALUES (:i, 'status_change', :b, :a, :t)
        """, {"i": iid,
              "b": f"change #{cid} applied {APPLIED_AT:%Y-%m-%d %H:%M} UTC and "
                   f"verified — {TITLE}.\n\nNote: `expected` on that record was "
                   "reconstructed from the change ticket after the fact, not "
                   "committed in advance.",
              "a": AUTHOR, "t": now})
        db.execute(engine, "UPDATE issues SET updated_at = :t WHERE id = :i",
                   {"t": now, "i": iid})

    # The resolver-pair question this change answers on the session-table issue.
    if db.fetch_one(engine, "SELECT id FROM issues WHERE id = 2"):
        db.execute(engine, """
            INSERT INTO issue_comments (issue_id, kind, body, author, created_at)
            VALUES (2, 'comment', :b, :a, :t)
        """, {"b": ISSUE2_NOTE, "a": AUTHOR, "t": now})
        db.execute(engine, "UPDATE issues SET updated_at = :t WHERE id = 2",
                   {"t": now})
        print("  noted on issue #2 — this answers its open resolver-pair question")

    if args.ticket:
        data = Path(args.ticket).read_bytes()
        name = "change-ticket-2026-10-01-dns-recursion.md"
        digest = hashlib.sha256(data).hexdigest()
        if not db.fetch_one(engine, "SELECT id FROM issue_attachments "
                            "WHERE issue_id = :i AND sha256 = :s",
                            {"i": root_cause_issue, "s": digest}):
            db.execute(engine, """
                INSERT INTO issue_attachments (issue_id, comment_id, filename,
                                               content_type, size_bytes, sha256,
                                               rel_path, uploaded_by, uploaded_at)
                VALUES (:i, NULL, :f, 'text/markdown', :sz, :sha, '', :u, :t)
            """, {"i": root_cause_issue, "f": name, "sz": len(data), "sha": digest,
                  "u": AUTHOR, "t": now})
            aid = int(db.fetch_one(engine, "SELECT id FROM issue_attachments "
                                   "WHERE issue_id = :i AND sha256 = :s",
                                   {"i": root_cause_issue, "s": digest})["id"])
            rel = f"{root_cause_issue}/{aid}-{name}"
            dest = Path(cfg.issues.attachment_dir) / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            db.execute(engine, "UPDATE issue_attachments SET rel_path = :p "
                       "WHERE id = :a", {"p": rel, "a": aid})
            print(f"  attached {name} ({len(data):,} bytes) to #{root_cause_issue}")

    engine.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(main())

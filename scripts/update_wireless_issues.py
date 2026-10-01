#!/usr/bin/env python3
"""Fold the two NMS wireless handoffs into the issue tracker.

Companion to `seed_wireless_issue.py`, which opened #1–#6 from a summary. This
applies the measured detail from:

  * `NMS-B111-handoff.md` (2026-09-22) — the session-table work, FortiAnalyzer
    querying, the Twilio block.
  * `TCS-wireless-design-handoff.md` (2026-09-28) — the whole-network design
    review, with B108 added as a second measured AP.

**The 2026-09-28 document is authoritative where the two disagree**, and it
disagrees in ways that matter. Three of them overturn conclusions already
written into the tickets:

  1. The 9/22 handoff treated the `NMS-TEST-AP305C` template and the firmware
     difference as a likely cause. 9/28 measured B108 — different template,
     different firmware (10.7r5b vs 10.9r1) — and found the same problems on
     both. Template and firmware are ruled out. The ticket said this finding
     "gates how far the others generalise"; it does not, and that sentence is
     removed rather than left to mislead.
  2. The 9/22 handoff put the looping Chromebooks on B111 and read the pattern
     as a NAC/role or CoA kick, with PacketFence as the next check. 9/28 shows
     the loopers are spread across many APs and *not* on B111 or B108 — the
     9/22 looper made 443 of its requests through NMS-B109 and only 18 through
     B111 — and that every request is accepted with the Students role. The
     reading is now client-side: 802.1X succeeds and the connection fails
     after, in the key exchange or because the client drops itself.
  3. The original summary said APs "filled the table completely and reset".
     Neither measured AP did. B111 reached 9,680 of 16,383 (59%) and B108
     3,321. "The cause is load, not failure."

Two things the 9/22 doc got right that 9/28 refines rather than reverses: the
dual-resolver DNS behaviour (now quantified on both APs) and the class-change
churn (now measured on B108 with RADIUS and AP-side numbers).

PII. Both handoffs record that AP `show tech` dumps and PacketFence records
carry student usernames, that org policy keeps them out of documents, and that
reading the AP auth logs has not been approved. No username appears here.
Client MAC addresses and internal management IPs are treated as acceptable by
both documents and are kept, because the follow-up work cannot be done without
them.

SITE NAMING. The seeded issues used "NMS"; `devices.site` spells this school
"Northridge Middle". These rows move to the device spelling so the site filter
and the device links agree. The underlying `sites.name` vs `devices.site`
divergence is a separate problem (docs/runbooks/netwm-profiles.md).

Idempotent: re-running detects the marker and does nothing.

    /opt/netmon/venv/bin/python scripts/update_wireless_issues.py \\
        --config /etc/netmon/netmon.conf \\
        --handoff-0922 NMS-B111-handoff.md \\
        --handoff-0928 TCS-wireless-design-handoff.md
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from netmon import db  # noqa: E402
from netmon.config import load_config  # noqa: E402

AUTHOR = "sappleby"
SITE = "Northridge Middle"
MARKER = "wireless design handoff 2026-09-28"

B111, B108, B109 = "NMS-B111", "NMS-B108", "NMS-B109"
MDF, IDF = "NMS-MDF", "NMS-IDF-A102"
LOOPER_APS = ["NMS-B201", "NMS-B210", "NMS-C210", "NMS-C208", "NMS-B200"]


# ══ #2 — session table ═══════════════════════════════════════════════════════

BODY_2 = """\
Each AP keeps a forwarding-engine IP-session table, limit **16,383** entries.

MEASURED ON TWO APs AT NMS
  - NMS-B111 (AP305C, IQ Engine 10.9r1, 172.16.172.13): 4,505 (27%) in one
    `show tech` dump on 9/22, then 492 → 9,680 (**59%**) within minutes in a
    second dump the same day.
  - NMS-B108 (AP305C, IQ Engine 10.7r5b, 172.16.172.35): 3,321 on 9/28.

THE CAUSE IS LOAD, NOT FAILURE. Neither AP was broken and neither reset; the
table simply grows faster than it ages out. (The original summary said APs
"filled the table completely and reset" — that is not what either measured AP
did. If it happened elsewhere it needs confirming against uptime and reset
history before being repeated.)

WHY IT GROWS

1. DNS dominates — 73% of B111's sessions, 45% of B108's.
2. **Every client queries both resolvers in the same second**, doubling the
   count outright. On B111, 99% of queries to 10.10.0.6 had a twin to
   10.10.0.7; on B108, 725 of 727 queries to .7 had a twin to .10. This looks
   like ChromeOS querying all configured resolvers in parallel — likely, not
   yet confirmed.
3. **The two APs' clients use different resolver pairs** — B111 had .6/.7 on
   9/22, B108 had .7/.10 on 9/28. Unknown whether the DHCP scope changed in
   between or NMS has more than one scope. DHCP relay on the MDF points at
   10.10.1.4, and the resolvers come from that server's scope options, not
   from the switch.
4. DNS sessions are single query/response exchanges held for **60 s**. Only 17
   of 4,633 queries went unanswered, so the resolvers are healthy — this is
   volume, not retries.
5. TCP/443 on B108: 1,600 sessions, 34% of them idle more than five minutes
   but held by the 30-minute ageout. B111's dump 1 showed the same long tail,
   much of it from clients that had already left the AP.
6. Reconnect bursts amplify all of it — each reassociation adds a fresh
   DNS/TLS burst. 20 disassociations at 13:13 on B111.
7. **The AP tracks sessions at all only because of the from-access ip-policies**
   on the user profiles (Students 46 rules, Teachers 57, Isolation 8,
   TCSGuest). Remove them and the tracking goes with them.

THE FIX, QUANTIFIED

Per-service timeouts are supported on this firmware — the config already
carries `service NTP protocol udp port 123 timeout 60`. Modelled effect of a
10 s DNS timeout:

  - B111: DNS entries 4,620 → 1,087, about **−76%**
  - B108: about **−83%**

So, cheapest first:
  1. Short-timeout DNS (~10 s) and HTTPS/TCP (~300 s) service objects in XIQ.
     Low risk, reversible, no dependency on anything else.
  2. Fix the dual-resolver behaviour — check the VLAN 228 DHCP scope(s) on
     10.10.1.4, and consider handing out a single anycast or load-balanced
     resolver address so each lookup is not sent twice. Roughly halves DNS
     sessions on its own.
  3. Remove the ip-policies from the AP entirely, which ends session tracking
     rather than trimming it. **Unconfirmed whether application visibility
     would still create sessions — test on one AP before assuming.**

TEST METHOD
B108 and B111 side by side: change one, leave the other as baseline, and trend
`show forwarding-engine ip-sessions | include Total` across a full school day.
"""

# ══ #3 — class-change churn ══════════════════════════════════════════════════

BODY_3 = """\
Clients reassociate repeatedly around class changes, each time as a fresh
association and full 802.1X rather than a fast roam.

MEASURED ON NMS-B108 OVER 24 HOURS (9/28)

RADIUS side, from PacketFence:
  - 322 requests from 52 devices; 320 accepted, all with the Students role.
  - **48% were full re-authentications within five minutes of the same
    device's previous one**, median gap 44 s.
  - About half of those switched between B108's two radios.

AP side, from Platform ONE:
  - 369 authentications against **487 deauthentications** across 73 clients.
  - 88% of the deauths fell in the 09:00, 10:00 and 12:00 hours.
  - **Median connection lasted 59 s**, authentication to deauthentication.
  - 145 clients rejoined within 5 s; 99 more within 30 s.
  - Bursts begin around 09:02, 09:54, 10:49 and 12:12.
  - No daytime radio events — ACSP changes happen only around 01:00, so this
    is not the AP changing channels underneath clients.

SIGNAL IS NOT THE PROBLEM
−21 to −41 dBm. The clients are close enough that **both radios look nearly
equal to them**, which is the point rather than a reassurance.

RADIO CONFIGURATION, both APs
  - Both radios 5 GHz, 20 MHz. wifi2 is off, so there is no 2.4 GHz at all.
  - B111: wifi0 ch56, wifi1 moved from 161 to **112 (DFS)** since 9/22.
  - B108: wifi0 ch36, wifi1 ch157.
  - **Load balancing and band steering are both OFF.**
  - 802.11r is on (the roaming cache shows FT8021X) and the AP caches PMKs —
    so fast roaming is available and is not being used for these transitions.
  - B108's radio profile has `weak-snr-suppress` enabled.

WORKING HYPOTHESIS, NOT CONFIRMED
Two same-SSID 5 GHz radios with nothing arbitrating between them, plus
Chromebooks waking at class change, make clients bounce. Each bounce is a full
reassociation.

WHY IT IS NOT YET CONFIRMED — and this is the blocker
  - **Deauth reason codes and the sender are missing.** Platform ONE shows no
    reason codes at all, so we cannot currently tell whether the AP or the
    client is sending the deauth. That distinction decides the whole fix.
  - The captures taken so far were between bursts, and **the two B108 pcap
    uploads turned out to be the same file**, so there is effectively one
    capture and it covers the wrong window.

NEXT
  1. Capture B108's wifi0 (ch36) **during** a burst — 09:00 or 12:10. Filter
     to management and EAPOL frames if the XIQ capture tool allows it, to get
     past the 100,000-frame / 80 s cap.
  2. Radio design decision: load balancing, per-radio power, or advertising
     TCS-Wireless on one radio only in high-density rooms. Revisit
     `weak-snr-suppress`.

DISCOUNT FROM THE COUNTS
One randomised-MAC device, 7A:77:67:AF:C0:39, was deauthenticated 55 times and
never authenticated. Separate from this issue and it inflates the deauth
figures above.
"""

# ══ #4 — the loopers ═════════════════════════════════════════════════════════

BODY_4 = """\
A small number of devices reauthenticate in a tight loop for hours, producing a
disproportionate share of all RADIUS traffic at the school.

SCALE, from Elastic since 9/14
  - **2–8 NMS devices loop on each school day**, and 1–2 even at weekends.
  - They produce **15–37% of all NMS RADIUS traffic**.

REPEAT OFFENDERS
  - `5c:fb:3a:0f:2f:6f` — looped on five separate days.
  - `5c:fb:3a:3e:70:d9` — 1,495 requests on 9/23.
  - `5c:61:99:8d:91:33` — looped 9/15, 9/18 and 9/28.
  - Today's pair, `5c:61:99:8d:3e:1d` and `5c:61:99:8d:91:33`, authenticated
    **every 10 s from 08:16 to 13:06**. Every request accepted, Students role,
    no VLAN attributes.

TWO CORRECTIONS TO THE EARLIER READING (9/28 supersedes 9/22)

1. **These are not on B111 or B108.** The loopers are spread across many APs —
   .87, .65, .37, .6, .3, .69, .14 and others. The 9/22 looper
   `900f:0cc2:731f` made 443 requests that day through **NMS-B109**
   (172.16.172.37) and only 18 through B111. The ticket previously linked this
   to B111; that link is wrong and has been replaced.
2. **It is not a NAC kick.** The earlier reading was a role/VLAN reassignment
   or a CoA/disconnect after each auth, with PacketFence as the next check.
   Every request is *accepted*, with a consistent role and no VLAN attributes.
   802.1X succeeds and the connection then fails — either in the WPA key
   exchange or because the client drops itself. The same devices do it day
   after day across different APs, which points at the client: ChromeOS
   network state, driver, or OS version. It does not look like PacketFence or
   AP configuration.

UNEXPLAINED
`900f:0cc2:731f` and two other 9/22 offenders are now `unreg` in PacketFence
and have not been seen since 9/25. **Did somebody deregister them?** If so,
that is a workaround nobody recorded; if not, it needs explaining.

NEXT
  1. Check whether the repeat-offender MACs share a Chromebook model or
     ChromeOS version, using `logs-google_workspace.device` in Elastic.
  2. Then one device hands-on: forget the network or powerwash, check
     `chrome://device-log`, note the ChromeOS version.
  3. Blocked on visibility for the key-exchange half — see the
     `packetfence.log` shipping issue. Without CoA/Disconnect events there is
     no way to rule the NAC out rather than merely doubt it.

SEPARATE THREAD — client 10.172.25.146
Lowest no-reply TCP rate on B111 (8% vs 22% average in dump 1; 1% vs 11% in
dump 2), which makes it an outlier worth understanding rather than a fault. Top
DNS names are Chrome and Heroku network-error reporting endpoints — not
confirmed as failures, and equally consistent with sampled success reports.
Check `chrome://net-export` on that device and read the error types.
"""

# ══ #5 — broadcast/multicast ═════════════════════════════════════════════════

BODY_5 = """\
Group-addressed traffic on VLAN 228 is repeated over the air to every AP,
taking airtime from classroom use. Now measured, and the proportion is the
finding.

MEASURED
  - B111: about **20 group-addressed frames per second**. B108: about **36**.
  - On a lightly loaded AP, **58% of all frames and 90% of data frames are
    group-addressed.**
  - Composition: ARP (~8/s), mDNS, MLD reports, IPv6 all-routers traffic, and
    neighbour solicitations for clients **on other APs** — traffic that has no
    reason to be on this AP's air at all.

The broadcast domain is a /21 (10.172.24.0/21), which is why a client on one AP
generates work for every other AP at the school.

PROBE RESPONSES — a second, separate cost
Three SSIDs mean roughly three probe responses per probe request. On B111 that
came to about **240 KB in two minutes, more than the actual client data.**

MITIGATIONS TO EVALUATE
  - Proxy ARP.
  - Multicast-to-unicast conversion, or dropping it.
  - IPv6 NS/RA suppression.
  - mDNS filtering or an mDNS gateway.
  - MLD snooping upstream.
  - A smaller broadcast domain than a /21.
  - Fewer SSIDs, and/or a probe-response RSSI threshold.

These are mostly independent of each other and of the other wireless issues, so
this does not have to wait on the design work.
"""

# ══ #6 — ACL layering ════════════════════════════════════════════════════════

BODY_6 = """\
Wireless traffic is filtered **twice**: by the AP ip-policy (stateful,
role-aware) and by the switch WirelessAP profile (stateless, identical for
everyone). Two copies that have drifted, and the switch copy is substantially
broken.

WHY THE FORTIGATE CANNOT COVER FOR EITHER
NMS-MDF (10.172.0.1, an Extreme 5420 stack) routes every NMS VLAN locally, plus
the school-to-school links (NMStoCO 1172, NMStoNHS 3172, VES-NMS 2172,
NMS-TODT 1173). The FortiGate only ever sees internet-bound traffic. Traffic to
cameras, to voice, and to other schools goes over the WAN mesh and never
reaches it.

SWITCH POLICY SHAPE (identical on MDF and IDF)
EXOS policy, `rule-model access-list`, 21 profiles, **exactly 500 rules**.
Students 106, Computers 82, WirelessAP 63, Teachers 53, isolation 50, Voice 43,
SecCameras 40, Guest_Access 27, Failsafe 18, Deny_Access 18. Ten profiles have
no rules at all: Administrator, Door Access, CNP, Printers, Projectors,
Registration, Unregistered, HVAC, ITAdmins, Permit Traffic.

**Exactly 500 rules plus ten empty profiles smells like a platform or push
limit**, not a coincidence. Worth establishing before anything is added.

ORDERING AND CORRECTNESS BUGS
Assuming `access-list` rules are first-match — which still needs testing:
  - **15 of the 21 "Allow DVR" rules come after their own subnet deny, so they
    never match.** Only three DVR permits actually work: BHS (10.128.18.2),
    NMS (10.172.18.11) and TCT (10.88.18.101).
  - CO ACE3 and MLK ACE15 match on **source** instead of destination.
  - OKH ACE42 uses 10.64.18.10; the AP's Teachers policy uses 10.84.18.10 —
    the switch rule is a typo.
  - **Teacher DVR permits were copied into Students and WirelessAP**, so wired
    students and all AP-port traffic can reach those three DVRs as far as the
    switch is concerned. Wireless students are protected only by the AP policy.
  - Profile numbering differs between the switches: Students is profile 10 on
    the MDF and 21 on the IDF, and the MDF defines SecCameras twice (19 and 21).

STUDENTS ACL RULES THAT DO NOT DO WHAT THEIR NAMES SAY
  - UDP ports 66 and 60 are **DHCP option numbers, not ports**.
  - UDP 68 to the DHCP server is the wrong port — the server listens on 67.
  - "Ping" matches **ICMP type 0**, which is echo *reply*.
  - Every forward rule after the denies does nothing under the default-forward
    behaviour. Either they are clutter, or a final deny-all is missing.

GAPS
  - **Nothing blocks wireless users from 172.16.0.0/16** — AP management and
    the WAN point-to-point links. Policy rules match only one field, so
    WirelessAP cannot add that deny without also blocking the APs themselves.
    This is the structural argument for a real ACL on the MDF.
  - AP policy duplicates: Students 1 and 21, 36 and 37; Teachers 22 and 38,
    53 and 54.
  - Students is missing denies for 10.24.18, 10.24.34, 10.21.34, 10.100.34.
  - Teachers has no deny for camera subnets 10.24, 10.28, 10.48 or 10.92.18,
    nor for 10.21.34, 10.24.34 or 10.100.34.
  - The rlogin rule is a Layer 7 application rule, not a port match.
  - WirelessAP ACE1–63 duplicates the camera and voice subnet denies already
    present in the AP's Students and Teachers policies.

WIRELESSAP PROFILE
pvid 172, egress VLANs 228, 229, 1010, 1232, `auth-override enable`. It appears
to be applied to AP ports through network-login MAC authentication — if so it
filters all wireless client traffic at the edge port. All IDF edge ports run
MAC and 802.1X authentication with MAC reauthentication on.

OPEN, BLOCKING THE REBUILD
  1. **Test rule-order behaviour**: a wireless teacher tries the CES DVR
     (10.28.18.100). Blocked confirms first-match, and confirms every ordering
     bug above.
  2. **Confirm WirelessAP applies to client traffic**: `show netlogin port 2:24`
     and `show policy` on NMS-IDF-A102.
  3. **Find where the switch policy is mastered** — Site Engine, ExtremeControl,
     or hand-edited — and why the count stops at exactly 500.
  4. **Do teachers actually need DVR access from wireless?** The ordering bugs
     suggest most of it has been broken all along, which makes this cheaper to
     answer than it looks.
"""

# ══ new issues ═══════════════════════════════════════════════════════════════

NEW_ISSUES = [
    {
        "key": "template",
        "title": "NMS-B111 runs a TEST device template with an unresolved "
                 "Configuration Audit Mismatch",
        "severity": "warn", "status": "open", "category": "wireless",
        "devices": [B111, B108],
        "body": """\
NMS-B111 — a production AP serving students and teachers — is assigned device
template **NMS-TEST-AP305C**, and Platform ONE reports its status as
**"Configuration Audit Mismatch."** Neither has been investigated.

NOT A CAUSE OF THE OTHER FINDINGS — this was initially suspected and has been
ruled out. NMS-B108 runs a different template and different firmware
(IQ Engine 10.7r5b against B111's 10.9r1) and **shows the same problems**: same
dual-5 GHz radio layout, same session growth, same class-change churn. So this
does not gate the other work and the other findings generalise without it.

It is still worth fixing on its own terms:
  - A test template on a production AP is a configuration-hygiene problem
    regardless of whether it is currently causing harm.
  - A Configuration Audit Mismatch means the AP is not running what its
    template says it should, so there are two sets of differences to
    understand: template vs. standard, and AP vs. template.
  - The firmware split (10.9r1 vs 10.7r5b) across two APs in the same building
    should be brought in line.

NEXT
  1. Diff NMS-TEST-AP305C against the standard AP305C template.
  2. Resolve the audit mismatch — establish what differs between the AP and its
     template.
  3. Determine how many other production APs carry a TEST template.
  4. Bring firmware in line across the pair.
""",
    },
    {
        "key": "elastic",
        "title": "Ship packetfence.log to Elastic — no CoA/Disconnect visibility today",
        "severity": "warn", "status": "open", "category": "nac",
        "devices": [],
        "body": """\
`packetfence.log` is **not** shipped to Elastic, so there is no visibility into
CoA or Disconnect events anywhere.

WHY THIS IS BLOCKING RATHER THAN HOUSEKEEPING
Two live investigations cannot be closed without it:

  - The 10-second loopers: every RADIUS request is accepted, so the failure is
    after authorisation. Without CoA/Disconnect events we can say the NAC
    *looks* uninvolved but cannot rule it out.
  - The class-change churn: Platform ONE shows no deauth reason codes and does
    not say who sent the deauth. PacketFence's own log is the other place that
    could answer it.

Both tickets currently carry a hypothesis that cannot be confirmed or killed,
and this is why.

WHAT EXISTS TODAY
  - PacketFence v15.0, 3-node cluster, admin at
    https://pfc.tusc.k12.al.us:1443/admin
  - **The RADIUS audit log inside PacketFence keeps only about 24 hours.**
  - Elastic/Kibana at https://kibana.tusc.k12.al.us:5601 holds
    `logs-packetfence.radius-default` — about two weeks of RADIUS authorize
    events, from 9/14. That is the only reason the looper scale could be
    measured at all.
  - Also available and useful: `logs-google_workspace.device` (for the
    Chromebook model/version check on the loopers),
    `logs-network_traffic.dns`, `logs-system.syslog-default`.
  - Wireless clients get `Filter-Id = "students"` and similar role names. There
    are no VLAN attributes.

NEXT
Ship `packetfence.log` into Elastic alongside the RADIUS stream, and confirm
CoA/Disconnect events are queryable for a window longer than 24 hours.
""",
    },
    {
        "key": "design",
        "title": "Target wireless design and district migration plan for VLAN 228",
        "severity": "warn", "status": "planned", "category": "wireless",
        "devices": [MDF, IDF, B111, B108],
        "body": """\
The deliverable the 2026-09-28 session set out to produce: stop troubleshooting
NMS-B111 and NMS-B108 individually and design the wireless network as a whole —
where filtering happens, how the two 5 GHz radios behave, broadcast/multicast
handling, AP session load, and reconnect loops — then a migration plan that
rolls out district-wide rather than only at NMS.

THE CONSTRAINT EVERYTHING ELSE SITS INSIDE
**Separate student and teacher VLANs are ruled out, and the reason is
specific.** On a shared Chromebook, switching from a teacher login to a student
login re-authenticates 802.1X and switches the user profile **without dropping
the association**, so ChromeOS keeps its old DHCP lease — now on the wrong
subnet. The design has to assume a single VLAN 228 shared by several roles.

Sharing VLAN 228 today: Students (attribute 4), Teachers (3), ITAdmins (26),
VIPGuest (25), VIP-GUest (30), LimitedInternet (13), NoInternet (14). Isolation
is VLAN 1010 (24); TCSGuest (9) and TCS-Guest-Registration are VLAN 229.
TCS-Wireless uses `action-for-upid-change switch`.

DIRECTION UNDER DISCUSSION — not yet decided
  1. **A role-agnostic ingress ACL on the MDF for VLAN 228**, denying camera
     and voice subnets, 172.16.0.0/16 and 10.10.252.0/24, with exceptions where
     needed. The argument for doing it here: a real ACL can match source and
     destination together, which an EXOS policy rule cannot — that single-field
     limit is why WirelessAP cannot block 172.16/16 without also blocking the
     APs.
  2. Reduce the AP's role-specific filtering to the student protocol blocks
     only (SSH, Telnet, FTP, TFTP, rlogin), or drop it entirely.
  3. Remove the AP ip-policies to end session tracking, or shorten DNS and TCP
     timeouts if a small Students policy stays.
  4. Rebuild the switch policy ACLs.

OPEN DESIGN QUESTIONS
  - **Do teachers need DVR access from wireless?** The switch ordering bugs
    suggest most of it is already broken, which makes this cheaper to settle
    than it looks.
  - A VLAN-wide ACL needs an exception or a separate path for **ITAdmins**.
  - **VIP guests sitting on the internal user VLAN deserves its own review** —
    that is a posture decision, not a side effect to inherit.
  - Addressing is district-uniform (10.<school>.18.0/24 cameras,
    10.<school>.34.0/24 voice), which is what makes a single ACL pattern
    portable to every school. Confirm before committing to it.

NMS REFERENCE TOPOLOGY
  - NMS-MDF 10.172.0.1, Extreme 5420 stack, routes every NMS VLAN locally.
  - NMS-IDF-A102 10.172.0.2, 3× 5420M-48W-4YE edge stack.
  - DHCP relay on the MDF points at 10.10.1.4; client DNS comes from that
    server's scope options.
  - VLAN 228 TCSWireless 10.172.24.0/21; 175 Cameras 10.172.18.0/24;
    252 Voice 10.172.34.0/24; 172 AccessPoints 172.16.172.0/24;
    229 GuestAccess; 232/1232 Registration; 1010 Isolation 10.172.8.0/22.

This issue tracks the design and the plan. The individual fixes stay on their
own tickets so the cheap ones are not held hostage to the design work.
""",
    },
    {
        "key": "twilio",
        "title": "Twilio STUN/TURN block for NMS students — application never confirmed",
        "severity": "info", "status": "waiting", "category": "switching",
        "devices": [],
        "body": """\
Twilio STUN/TURN (3478/443) is district-wide: about 12.7k sessions in ten
minutes across many schools. It is most likely a sanctioned classroom tool.

A decision was taken to block it for NMS students and a corrected multi-line
FortiOS script was prepared for the FortiGate 601F, covering:
  - address objects for Twilio's published ranges
    (source: twilio.com/docs/stun-turn/regions)
  - address group `Twilio-STUN-TURN`
  - service `Twilio-TURN` (TCP 443/3478/5349, UDP 3478) — already existed
  - deny policy "Block Twilio TURN - NMS Students": srcintf `ToTCS`, dstintf
    `virtual-wan-link`, srcaddr `NMS Wired Internal` + `NMS Wireless Internal`,
    groups `PF_Students` + `FSSO_Student`, ordered before policy 17

**STATUS UNKNOWN — it was never confirmed whether the corrected script was
applied.** That is the only thing this is waiting on, and it has been
outstanding since 9/22.

CAVEATS RECORDED AT THE TIME, all still standing
  - **The block will NOT reduce AP session counts.** It is not a fix for the
    session-table issue and must not be counted as one.
  - It may break a tool people are using deliberately.
  - Clients with no group identity bypass a group-based rule entirely.

NEXT
  1. Confirm whether the script was applied.
  2. If it was, verify hits in FortiAnalyzer with `policyid=<new-id>`.
  3. If it was not, decide whether it is still wanted given the first caveat.
""",
    },
]

# ══ reference comments ═══════════════════════════════════════════════════════

TOOLING_NOTE = """\
Query methods that work, recorded so the next session does not rediscover them.

**FortiAnalyzer** (https://10.10.1.228 — GUI shows US/Pacific, FortiGate logs
are CDT, so mind the offset). From the logged-in tab, POST to
`/p/logview/logsearch/run/` then `/fetch/`. Send the `XSRF-TOKEN` header using
the value of the `HTTP_CSRF_TOKEN` cookie. logtype 10 for traffic, 20 for DNS,
device `All_FortiGate`. Max 1,000 rows per fetch, so query in 10-minute slices.
Note there are NO per-client DNS-filter logs — clients query 10.10.0.6/.7
directly and the FortiGate only sees the resolvers, so per-client DNS analysis
has to come from the AP session table.

**PacketFence API**, from the logged-in admin tab: `Authorization: Bearer
<localStorage['user-token']>`. `GET /api/v1/node/<mac>` and
`POST /api/v1/radius_audit_logs/search` with a
`{query:{op:'and',values:[...]}, fields, sort, limit}` body. A 404 from the
search endpoint can simply mean no matching rows.

**Kibana ES|QL**, from the logged-in tab: `POST /internal/search/esql` with
`kbn-xsrf: true`, `elastic-api-version: 1`,
`x-elastic-internal-origin: kibana`, body `{params:{query}}`. The console proxy
is disabled. `first` is a reserved word. Filter by AP with
`TO_STRING(packetfence.switch.ip) LIKE "172.16.172.*"`.

**Platform ONE**: token from `sessionStorage['@xcloud-workspace/token']`, sent
as Bearer. Public XIQ API proxied at
`https://cloudapi.extremecloudiq.com/xiq/v0/xapi/...` (e.g.
`devices?hostnames=NMS-B108`; B108's device id is 70849780745353). For the
device events endpoint, capture it by hooking fetch/XHR and clicking the
device's Events tab; it pages with `page.page` and `page.size` (200 works).
Event descriptions carry no reason codes. Sessions expire quickly.

**Not carried over between sessions**: the B108/B111 `show tech` and session
dumps, both pcaps, and the NMS-MDF and NMS-IDF-A102 configs. Re-request them if
needed — and note the two B108 pcaps turned out to be the same file.

**PII**: AP `show tech` logs carry about 2,900 lines containing student
usernames; PacketFence node records and RADIUS events also carry them
(`stripped_user_name`, `event.original`). Usernames stay out of tickets. Reading
the AP auth logs has not yet been approved. IPs and MACs are treated as
acceptable.
"""

PARENT_NOTE = """\
Two investigation handoffs folded in — NMS-B111 (2026-09-22) and the
whole-network design review (2026-09-28). Both documents are attached.

**The 9/28 review overturns three things these tickets previously said.**

1. **Template and firmware are ruled out as a cause.** NMS-B108 runs a
   different template and different firmware (10.7r5b vs 10.9r1) and shows the
   same problems. The template issue is still worth fixing, but it gates
   nothing.
2. **The 10-second loopers are not a NAC kick, and are not on B111 or B108.**
   They are spread across many APs; every RADIUS request is accepted with a
   consistent role and no VLAN attributes. 802.1X succeeds and the connection
   fails afterwards — the evidence now points at the client (ChromeOS), not at
   PacketFence or AP config.
3. **No AP was observed filling the table and resetting.** B111 reached 59% of
   16,383 and B108 3,321. "The cause is load, not failure."

What the review adds: B108 as a second measured AP, a quantified timeout fix
(−76% to −83% of DNS entries at a 10 s timeout), real broadcast numbers (58% of
all frames group-addressed), the full switch-ACL bug list, and a target design
direction.

**What is now blocking, and it is a measurement gap rather than a decision:**
neither the class-change churn nor the loopers can be confirmed, because deauth
reason codes are absent from Platform ONE and `packetfence.log` is not shipped
to Elastic, so there is no CoA/Disconnect visibility at all. Two tickets carry
hypotheses that cannot be killed or confirmed until that is fixed.

ORDER OF WORK
  1. Ship `packetfence.log` to Elastic — unblocks two investigations.
  2. Short DNS/TCP timeouts on one AP, B108 vs B111 as a side-by-side test.
     Cheapest real win; independent of everything else.
  3. Capture B108 wifi0 during a 09:00 or 12:10 burst, for deauth reason codes.
  4. Check the VLAN 228 DHCP scope on 10.10.1.4 for the dual-resolver
     behaviour.
  5. Test switch rule-order (wireless teacher → CES DVR 10.28.18.100) and
     confirm WirelessAP applies to client traffic.
  6. Chromebook model/version check on the looper MACs.
  7. Broadcast/multicast suppression — independent, can run in parallel.
  8. The design work, once 1–5 have reported.

Still unanswered since 9/22: whether the Twilio block was applied, and whether
teachers actually need DVR access from wireless.
"""


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def _ids(engine, names: list[str]) -> list[int]:
    if not names:
        return []
    rows = db.fetch_all(engine,
                        "SELECT id, name FROM devices WHERE name IN ("
                        + ", ".join(f":n{i}" for i in range(len(names))) + ")",
                        {f"n{i}": n for i, n in enumerate(names)})
    found = {r["name"]: int(r["id"]) for r in rows}
    for n in names:
        if n not in found:
            print(f"  ! {n} not in the registry — link by hand", file=sys.stderr)
    return [found[n] for n in names if n in found]


def _link(engine, issue_id: int, device_ids: list[int], note: str | None = None) -> None:
    for did in device_ids:
        if db.fetch_one(engine, "SELECT device_id FROM issue_devices "
                        "WHERE issue_id = :i AND device_id = :d",
                        {"i": issue_id, "d": did}):
            continue
        db.execute(engine, "INSERT INTO issue_devices (issue_id, device_id, note) "
                   "VALUES (:i, :d, :n)", {"i": issue_id, "d": did, "n": note})


def _unlink(engine, issue_id: int, device_ids: list[int]) -> None:
    """Remove a link a later handoff showed to be wrong.

    Used once, for #4: the 9/22 handoff put the loopers on B111 and the 9/28
    data shows they are not there. A wrong device link is worse than none — it
    is what somebody searches by.
    """
    for did in device_ids:
        db.execute(engine, "DELETE FROM issue_devices WHERE issue_id = :i "
                   "AND device_id = :d", {"i": issue_id, "d": did})


def _comment(engine, issue_id: int, body: str, at: datetime) -> None:
    db.execute(engine, "INSERT INTO issue_comments (issue_id, kind, body, author, "
               "created_at) VALUES (:i, 'comment', :b, :a, :t)",
               {"i": issue_id, "b": body, "a": AUTHOR, "t": at})


def _attach(engine, cfg, issue_id: int, path: Path, name: str, at: datetime) -> None:
    """Store a handoff document as evidence, the way an upload would.

    Same shape the API writes — bytes at `<attachment_dir>/<issue>/<id>-<name>`,
    sha256 recorded, content type decided here rather than taken from the file
    name — so a row written by this script is indistinguishable from one
    written through the UI. The sha256 is also the idempotency check.
    """
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    dup = db.fetch_one(engine, "SELECT id FROM issue_attachments "
                       "WHERE issue_id = :i AND sha256 = :s",
                       {"i": issue_id, "s": digest})
    if dup:
        print(f"  {name} already attached as #{dup['id']}")
        return

    db.execute(engine, """
        INSERT INTO issue_attachments (issue_id, comment_id, filename, content_type,
                                       size_bytes, sha256, rel_path, uploaded_by,
                                       uploaded_at)
        VALUES (:i, NULL, :f, 'text/markdown', :sz, :sha, '', :u, :t)
    """, {"i": issue_id, "f": name, "sz": len(data), "sha": digest,
          "u": AUTHOR, "t": at})
    aid = int(db.fetch_one(engine, "SELECT id FROM issue_attachments "
                           "WHERE issue_id = :i AND sha256 = :s",
                           {"i": issue_id, "s": digest})["id"])
    rel = f"{issue_id}/{aid}-{name}"
    dest = Path(cfg.issues.attachment_dir) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    db.execute(engine, "UPDATE issue_attachments SET rel_path = :p WHERE id = :a",
               {"p": rel, "a": aid})
    print(f"  attached {name} ({len(data):,} bytes) as #{aid}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Apply the NMS wireless handoffs.")
    p.add_argument("--config", default=None)
    p.add_argument("--handoff-0922", default=None)
    p.add_argument("--handoff-0928", default=None)
    args = p.parse_args(argv)

    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)
    now = _now()

    if db.fetch_one(engine, "SELECT id FROM issue_comments WHERE body LIKE :m",
                    {"m": f"%{MARKER}%"}):
        print("handoffs already applied — nothing to do")
        return 0

    def update(issue_id, body, title=None, severity=None, status=None):
        sets = ["body = :body", "updated_at = :at", "site = :site"]
        params = {"body": body, "at": now, "site": SITE, "id": issue_id}
        for col, val in (("title", title), ("severity", severity), ("status", status)):
            if val:
                sets.append(f"{col} = :{col}")
                params[col] = val
        db.execute(engine, f"UPDATE issues SET {', '.join(sets)} WHERE id = :id", params)

    # ── #2 session table ──
    update(2, BODY_2,
           title="AP IP-session table growing toward the 16,383 cap under DNS load")
    _link(engine, 2, _ids(engine, [B111]), "9,680 of 16,383 (59%) on 9/22; 73% DNS")
    _link(engine, 2, _ids(engine, [B108]), "3,321 on 9/28; 45% DNS")
    _link(engine, 2, _ids(engine, [IDF]), "uplink for both measured APs")
    _comment(engine, 2, f"{MARKER}: B108 added as a second measured AP (3,321 "
             "sessions, 45% DNS). A 10 s DNS timeout is modelled at −76% of DNS "
             "entries on B111 and −83% on B108, and per-service timeouts are "
             "already supported on this firmware. Note the two APs' clients use "
             "DIFFERENT resolver pairs (.6/.7 vs .7/.10) — check whether VLAN 228 "
             "has more than one DHCP scope on 10.10.1.4.", now)

    # ── #3 class-change churn ──
    update(3, BODY_3,
           title="Class-change reassociation churn — two same-SSID 5 GHz radios, "
                 "no band steering or load balancing")
    _link(engine, 3, _ids(engine, [B108]), "487 deauths/369 auths, median connection 59s")
    _link(engine, 3, _ids(engine, [B111]), "same radio layout; wifi1 moved 161 → 112 DFS")
    _comment(engine, 3, f"{MARKER}: measured properly on B108 — 48% of RADIUS "
             "requests were re-auths within 5 min (median gap 44 s), half of them "
             "switching radios; 487 deauths against 369 auths; median connection "
             "59 s; 88% of deauths in the 09:00/10:00/12:00 hours. Signal is "
             "−21 to −41 dBm, so both radios look equal to clients. BLOCKED on "
             "deauth reason codes: Platform ONE shows none, and the two B108 pcaps "
             "turned out to be the same file, taken between bursts. Needs a "
             "capture during 09:00 or 12:10.", now)

    # ── #4 loopers — correcting a wrong device link and a wrong reading ──
    update(4, BODY_4,
           title="Devices in a 10-second reauthentication loop — 15–37% of NMS "
                 "RADIUS traffic")
    _unlink(engine, 4, _ids(engine, [B111]))
    _link(engine, 4, _ids(engine, [B109]), "9/22 looper: 443 requests here vs 18 on B111")
    _link(engine, 4, _ids(engine, LOOPER_APS), "loopers observed here")
    _comment(engine, 4, f"{MARKER}: TWO CORRECTIONS. (1) These are not on B111 — "
             "the link to it has been removed. The 9/22 looper made 443 requests "
             "through NMS-B109 and only 18 through B111, and the population is "
             "spread across many APs. (2) Not a NAC kick: every request is "
             "ACCEPTED with a consistent Students role and no VLAN attributes, so "
             "802.1X succeeds and the connection fails after — the evidence points "
             "at the client, not PacketFence. Elastic since 9/14 gives the real "
             "scale: 2–8 devices daily, 15–37% of all NMS RADIUS traffic. Also "
             "unexplained: three 9/22 offenders are now `unreg` in PacketFence and "
             "unseen since 9/25 — did somebody deregister them?", now)

    # ── #5 broadcast — upgraded from info ──
    update(5, BODY_5, severity="warn", status="open",
           title="Group-addressed traffic is 58% of all frames on VLAN 228")
    _link(engine, 5, _ids(engine, [B111]), "~20 group-addressed frames/s; 240 KB of "
          "probe responses in 2 min")
    _link(engine, 5, _ids(engine, [B108]), "~36 group-addressed frames/s")
    _comment(engine, 5, f"{MARKER}: measured, and the proportion is the finding — "
             "on a lightly loaded AP 58% of all frames and 90% of DATA frames are "
             "group-addressed, including neighbour solicitations for clients on "
             "other APs. Raised from info to warn. Three SSIDs also cost ~240 KB of "
             "probe responses in 2 minutes on B111, more than the actual client "
             "data.", now)

    # ── #6 ACLs ──
    update(6, BODY_6,
           title="Wireless filtered twice — AP ip-policy and switch WirelessAP "
                 "profile, with ordering bugs in the switch copy")
    _link(engine, 6, _ids(engine, [MDF]), "routes all NMS VLANs locally; FortiGate "
          "never sees camera/voice/inter-school traffic")
    _link(engine, 6, _ids(engine, [IDF]), "WirelessAP profile on AP ports")
    _comment(engine, 6, f"{MARKER}: the switch copy is worse than 'a few typos'. "
             "15 of 21 'Allow DVR' rules sit after their own subnet deny and never "
             "match — only the BHS, NMS and TCT permits work. Teacher DVR permits "
             "were copied into Students and WirelessAP. Students rules use DHCP "
             "option numbers as ports, the wrong DHCP port, and match ICMP echo "
             "REPLY for 'Ping'. Nothing blocks wireless from 172.16.0.0/16, and an "
             "EXOS policy rule matches only one field so WirelessAP cannot add that "
             "deny without blocking the APs — which is the structural case for a "
             "real ACL on the MDF. Exactly 500 rules plus 10 empty profiles looks "
             "like a platform limit worth confirming.", now)

    # ── new issues ──
    new = []
    for spec in NEW_ISSUES:
        existing = db.fetch_one(engine, "SELECT id FROM issues WHERE title = :t",
                                {"t": spec["title"]})
        if existing:
            nid = int(existing["id"])
        else:
            db.execute(engine, """
                INSERT INTO issues (title, body, status, severity, category, site,
                                    reported_by, assigned_to, created_at, updated_at)
                VALUES (:t, :b, :st, :sv, :c, :site, :who, :who, :at, :at)
            """, {"t": spec["title"], "b": spec["body"], "st": spec["status"],
                  "sv": spec["severity"], "c": spec["category"],
                  "site": SITE if spec["devices"] else None,
                  "who": AUTHOR, "at": now})
            nid = int(db.fetch_one(engine, "SELECT id FROM issues WHERE title = :t "
                                   "ORDER BY id DESC LIMIT 1",
                                   {"t": spec["title"]})["id"])
            _comment(engine, nid, f"Opened from the {MARKER}. Part of #1.", now)
        _link(engine, nid, _ids(engine, spec["devices"]))
        new.append((nid, spec["title"]))
        print(f"#{nid}  {spec['title']}")

    # ── parent ──
    db.execute(engine, "UPDATE issues SET site = :s, severity = 'crit', "
               "updated_at = :a WHERE id = 1", {"s": SITE, "a": now})
    _link(engine, 1, _ids(engine, [B111, B108]), "the two measured APs")
    _comment(engine, 1, PARENT_NOTE + "\nOpened from these handoffs:\n"
             + "\n".join(f"  #{i} — {t}" for i, t in new), now)
    _comment(engine, 1, TOOLING_NOTE, now)

    if args.handoff_0922:
        _attach(engine, cfg, 1, Path(args.handoff_0922),
                "NMS-B111-handoff-2026-09-22.md", now)
    if args.handoff_0928:
        _attach(engine, cfg, 1, Path(args.handoff_0928),
                "TCS-wireless-design-handoff-2026-09-28.md", now)

    engine.dispose()
    print("\nupdated #1–#6, opened " + ", ".join(f"#{i}" for i, _ in new))
    return 0


if __name__ == "__main__":
    sys.exit(main())

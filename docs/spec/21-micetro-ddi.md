# Spec 21 — Micetro DDI federation (DNS / DHCP / IPAM)

**Status:** built. **On-demand, not scheduled** (owner, 2026-09-09 — §7b).
`[micetro] enabled = true` on the deploy box, which now means "may query",
not "polls".
**Phase:** 11.x post-parity (a new federated source, not a v1 page-parity item)
**Owner decisions on this page:** scope = identity enrichment **+** DHCP scope
utilization (owner, 2026-09-09); sweep bound = all subnet ranges, non-empty
records only (owner, 2026-09-09).
**Source API:** Micetro REST API v2, `https://<micetro>/mmws/api/v2`
(spec mirrored from `https://api.menandmice.com/26.1.0/swagger.json`, OpenAPI
3.0.3, 264 paths; vendor docs at
`https://docs.bluecatnetworks.com/r/Micetro-User-Guide/Micetro-REST-API/26.1.0`)

---

## 1. Why NetMon needs this

NetMon can already say **where** a MAC is and, for NAC-managed endpoints,
**who** it is:

| Question | Answered by | Gap |
|---|---|---|
| Which switch port is this MAC on? | `fdb_entries` (SNMP sweep, spec 10 §4) | MAC only — no name, no IP |
| Who owns this MAC, what role, what VLAN? | `pf_nodes` (PacketFence, spec 10 §5) | **only endpoints PacketFence has seen** |
| What is this IP called? | *nothing* | — |

The gap is the middle column's caveat. `fdb_entries` learns every MAC that
forwards a frame — printers, cameras on non-NAC VLANs, UPSs, projectors, AV
gear, statically addressed servers, the switch uplinks themselves. PacketFence
only knows the ones that authenticated through it. So the FDB⋈PF port-detail
pane (spec 10 §3's marquee feature) shows an identity card for the Chromebooks
and a bare hex string for everything else — which is precisely the population
an operator is looking at the port pane to identify.

Micetro is the district's DDI system of record, and its IPAM records already
carry the join NetMon is missing: **IP ↔ MAC ↔ DNS name**, for statically
addressed devices as much as for DHCP clients.

> ⚠️ **Read §7a before believing this section.** The first live run measured
> the gap and it is much narrower than written above: PacketFence already names
> 95.5% of FDB MACs, and Micetro adds a hostname for only **16** it cannot.
> The real payoff turned out to be *address* resolution (an IP for 5,446
> otherwise-unnamed MACs) and DHCP capacity, not hostname enrichment. The
> framing here is the hypothesis; §7a is the evidence.

This is the same federate-don't-re-poll strategy as every other source
(CLAUDE.md §1): Micetro has the answer, NetMon reads it, NetMon never becomes a
second DDI database. Nothing here re-derives DNS or DHCP by querying servers
directly.

## 2. Read-only posture — no new gate needed

**This collector issues GET requests only.** That matters, because the obvious
reading of the API docs suggests otherwise: the Swagger `security` block lists a
single scheme, `Bearer token`, whose description says to obtain the token by
`POST /micetro/sessions` with `{loginName, password}`. A login POST is still a
POST, and the Milestone ESS precedent (spec 11 D5) shows those need their own
sign-off even when they mutate nothing.

NetMon does not use it. The Micetro Web Service also accepts **HTTP Basic
authentication** on every request, and the vendor documentation is explicit
that this replaces the session flow:

> "By using authorization headers for authentication, the Login command becomes
> unnecessary, and the session ID is not used."
> — *API Authentication methods*, Micetro documentation

So `micetro_client.py` sends `Authorization: Basic …` on each GET and never
creates a session. The client has **no non-GET method at all** — not a disabled
one, not a flagged one; `httpx` is only ever reached through `_get()`. Adding a
write would mean adding a method, which is a reviewable diff and needs owner
sign-off under §4.1.

Consequences the deployment must honour:

- **HTTPS is required** and enforced in the client constructor (same rule as
  `RConfigClient`), because Basic auth puts the credential on every request.
- The Micetro account should be a **read-only user**. NetMon cannot enforce
  that, and unlike `[camera_snapshot]` there is no privileged action it could
  reach even with an over-permissioned account — but least privilege is still
  the correct posture, and it is documented in `netmon.conf.example`.

## 3. What is collected

Two cycles, both replace-on-refresh into row-shaped inventory tables
(spec 10 §1). Neither writes `device_state`; see §6 for why.

### 3.1 IPAM records — the identity join

```
GET /ranges?filter=…&offset=&limit=            → enumerate ranges
GET /ranges/{rangeRef}/ipamRecords?offset=&limit=&includeRelatedDNSRecords=false
```

`IPAMRecord` fuses exactly what NetMon needs into one object:

| Field | Use |
|---|---|
| `address` | PK of `ddi_addresses` |
| `dhcpLeases[].mac` | MAC (DHCPv4 lease holder) — **first choice** |
| `dhcpReservations[].clientIdentifier` | MAC (reservation) — second choice |
| `lastKnownClientIdentifier` | MAC seen by IP discovery (ARP) — last choice |
| `dnsHosts[].dnsRecord.name` | the DNS name; extras counted, not stored |
| `state` | `Free` / `Assigned` / `Claimed` / `Pending` / `Held` |
| `discoveryType` | `None` / `Ping` / `ARP` / `Lease` / `API` / `Custom` |
| `lastSeenDate` | last IP-discovery sighting |
| `device`, `interface` | Micetro's own device/interface labels |

**MAC precedence is lease → reservation → discovery**, recorded in
`mac_origin` so the UI can say how the identity was established. A lease is the
strongest claim (the DHCP server handed that address to that MAC); ARP
discovery is the weakest and can be stale by a scan interval. Storing the
origin rather than silently collapsing the three keeps §4.5's "honest
staleness" property at the field level, not just the row level.

### 3.2 DHCP scopes — utilization

```
GET /dhcpScopes?offset=&limit=                 → scopes + utilizationPercentage
```

One row per scope in `ddi_scopes`, with `utilization_pct` classified to a
`severity` at write time against `[micetro] scope_warn_pct` / `scope_crit_pct`
(default 85 / 95). Classification at write time, not render time, is the same
"current rate is state, not history" rule the port counters follow (CLAUDE.md
§6) — and it means the Global page can count warning scopes with a
`GROUP BY severity`, no arithmetic in the API layer.

`superscope`, `range_cidr` and `server` are carried so a near-full scope can be
traced to the VLAN and the DHCP server that owns it without a second call.

### 3.3 What is deliberately *not* collected

- **DNS zones / resource records wholesale** (`/dnsZones/{ref}/dnsRecords`).
  The forward and reverse names NetMon needs already arrive attached to the
  IPAM records that have an address, which is the only DNS data an operator
  looking at a switch port can act on. Mirroring whole zones would make NetMon
  a second copy of DNS — a maintenance burden and a stale-data hazard for no
  page that needs it.
- **DNS/DHCP server health** (`/dnsServers`, `/dhcpServers` reachability as a
  `source_status` dimension). Offered and declined by the owner, 2026-09-09.
  Zabbix keeps server monitoring (CLAUDE.md §2), and DDI servers are servers.
- **`includeRelatedDNSRecords=true`.** It inflates every record with CNAMEs and
  related RRs; NetMon shows one primary name plus a count of extras.
- **Anything under `/ipamRecords/{addrRef}/ping`** — a POST, and NetMon has its
  own ICMP ground truth in the poller (CLAUDE.md §1.1).

## 4. Sweep bound and scale

The concern is that Micetro's address space is not NetMon's device count.
A single `/16` container holds 65,534 addresses; the district's registry holds
~3,600 devices. A naive full mirror would be the largest table in the schema
and almost entirely empty rows.

The owner chose **all subnet ranges, keep only non-empty records** (2026-09-09):

1. Enumerate `/ranges`, keep those with `subnet = true` — actual subnets, not
   the container/aggregate rows that exist to hold them.
2. Page `ipamRecords` per range (`limit` = `page_size`, default 500).
3. **Keep a record only if it carries something.** A row survives the filter if
   it has a MAC, a DNS name, a lease, a reservation, or a `state` other than
   `Free`. An address that is merely unallocated is dropped before it reaches
   the DB.

This makes the row count scale with *assignments*, not with address space —
the estate's real DDI footprint, expected to land in the low tens of thousands.

Two guards, because "expected" is not "measured" and this has never run here:

- **`max_records`** (default 60,000). On exceeding it the sweep **raises**,
  which lands loud in `collector_health` and leaves the previous rows visibly
  stale. It does not truncate: a half-mirror that looks complete is exactly the
  fabrication §4.5 forbids.
- **`max_ranges`** (default 2,000), same failure mode, to bound the per-range
  request fan-out.

Rate: one `/ranges` page-drain plus one `ipamRecords` drain per subnet, at
`interval_s` (default 900s). With ~200 subnets and 500-row pages that is a few
hundred GETs per quarter hour against an on-premises appliance — comparable to
the SNMP inventory sweep and far below the XIQ budget that spec 11 tracks as a
live question. **Unvalidated against the production Micetro**, see §8.

## 5. Schema (migration `031_micetro_ddi.sql`)

```
ddi_addresses           PK (ip)
  ip, mac, mac_origin, dns_name, dns_extra, state, discovery_type,
  last_seen, lease_state, lease_expires, reservation, device_name,
  interface_name, range_cidr, addr_ref, updated_at
  KEY (mac)          -- the fdb_entries / pf_nodes join key
  KEY (dns_name)     -- name lookups (/api/ddi/addresses?q=)
  KEY (range_cidr)

ddi_scopes              PK (scope_ref)
  scope_ref, name, range_cidr, from_addr, to_addr, server, superscope,
  enabled, utilization_pct, severity, updated_at
  KEY (severity)
```

`ddi_addresses.ip` is the primary key rather than a surrogate id: an IP is
unique in Micetro's address space, it is what the API returns, and it is what
every join and lookup starts from. `mac` is nullable and **not** unique — one
MAC legitimately holds several addresses (dual-stack, multi-homed, a device
re-leased before the old lease expired), and the port pane wants all of them.

Both tables are pure snapshot: replace-on-refresh, `updated_at` per row, no
history, consistent with every other inventory table (CLAUDE.md §6). Rollback
note in the migration is a plain `DROP TABLE` — every row is re-derivable from
one sweep.

Deliberately **no** `devices.micetro_ref` column. Micetro is keyed by IP and
NetMon devices already carry `mgmt_ip`; the join is `ddi_addresses.ip =
devices.mgmt_ip`, and adding a per-source key column would need backfilling
3,600 rows to express something already expressible.

## 6. Where it surfaces

- **`GET /api/ddi/addresses`** — filter by `mac`, `ip`, `q` (name prefix),
  `range`, paged. Carries `updated_at` per §4.5.
- **`GET /api/ddi/scopes`** — scopes with utilization + severity, worst first.
- **`GET /api/ddi/lookup/{mac}`** — every address a MAC holds. The endpoint the
  port pane and NAC pages call.
- **Switch port detail** (`/api/switches/{id}/ports/{ifindex}`) — the existing
  `fdb_entries ⋈ pf_nodes` join gains a second `LEFT JOIN ddi_addresses ON mac`,
  adding `ddi_ip` / `ddi_dns_name` / `ddi_mac_origin` / `ddi_updated_at` to each
  MAC card. **This is the point of the whole spec.** `LEFT JOIN` throughout: a
  MAC Micetro has never seen still renders, with nulls, exactly as today.
- **`GET /api/switches/{id}/fdb`** — same enrichment on the bulk FDB tab.
- **NAC** — `pf_nodes` rows gain the DNS name Micetro knows and PacketFence
  does not.

### Why no `device_state` dimension

`device_state.dimension` is a MariaDB `ENUM` and `device_state.device_id` is a
foreign key into `devices`. A DHCP scope is not a device and has no row there,
so scope utilization cannot be written as state without either (a) inventing
synthetic `devices` rows for scopes, which pollutes the registry every page and
export reads, or (b) widening the enum and relaxing the invariant that
`device_state` describes registered devices.

Both are design changes that outlive this collector, so **neither is in this
PR.** Scope severity is computed and stored on the `ddi_scopes` row, so the UI
badges an exhausted pool honestly and `/api/ddi/scopes` sorts worst-first — but
no email fires for it. Alerting on non-device entities is **open question Q3**
below; it needs an owner decision on the data model, not a workaround.

## 7. Configuration

```ini
[micetro]
enabled = false          ; §4.3 — independently reversible, off on merge
url = https://micetro.example.org
username = netmon-ro     ; read-only Micetro account
password =
verify_ssl = true
interval_s = 3600          ; measured, not guessed — see §7a
page_size = 500
max_records = 60000      ; sweep raises past this, never truncates
max_ranges = 2000
sweep_addresses = true
sweep_scopes = true
scope_warn_pct = 85
scope_crit_pct = 95
```

Registered in `config.py`'s source tuple, so `cfg.source_enabled("micetro")`
gates the supervised task and the settings overlay reaches it like any other
source. Standalone entry point: `python -m netmon.collectors.micetro --once`.

## 7a. First live run — measured 2026-09-09 (discharges Q1/Q2)

Ran `--once` against the production appliance. It works, and the numbers
**contradict §1's premise in one important respect**, recorded here rather
than quietly left as written.

| Measure | Value |
|---|---|
| Ranges / subnets swept | 263 / 261 (2 non-subnet skipped) |
| `ipamRecords` requests | 2,023 · ~4 min wall clock |
| Addresses kept | 19,656 (of ~1M fetched) |
| …with a MAC | 19,048 — **all from DHCP leases**; zero reservations, zero ARP discovery |
| …with a DNS name | 4,038 (21%) |
| DHCP scopes | 261 — 2 crit, 2 warn, 257 ok |

**The identity gap is far smaller than assumed.** PacketFence already knows
**95.5%** of the 14,468 distinct MACs in `fdb_entries` (13,818); Micetro knows
90.7% (13,124). MACs that Micetro can name and PacketFence cannot: **16.** The
motivating picture in §1 — "a card for the Chromebooks and a bare hex string
for everything else" — is not what this estate looks like. PF's coverage of the
FDB is near-total.

What the mirror *does* add, measured on FDB MACs:

- 6,694 MACs carry no PacketFence `computername`. Micetro supplies a DNS name
  for **73** of them, and an **IP** for **5,446**.
- 2,357 MACs have no IP in `pf_nodes` at all. Micetro fills **1,055**.
- **DHCP scope utilization is unique** — 261 scopes with fill levels, 4 of them
  already warn-or-worse. Nothing else in NetMon can produce this, and it does
  not depend on the identity story at all.

So the honest value is *address resolution and DHCP capacity*, not hostname
enrichment. §1's framing oversells the DNS-name benefit and should be read
against this table. Two consequences:

- **`interval_s` should be 3600, not 900.** A 4-minute, 2,000-request sweep
  every 15 minutes is a 27% duty cycle on the appliance to refresh data that is
  DHCP-lease- and capacity-shaped, not real-time. The value does not justify
  the cadence.
- **The fetch is ~98% waste** and cannot currently be fixed. See Q6.

## 7b. On-demand lookup replaces the schedule (owner, 2026-09-09)

§7a killed the case for mirroring: ~2,000 requests per sweep to pre-answer a
question that, for identity, PacketFence had already answered 95.5% of the
time. The owner's direction is to **look in Micetro when someone searches**,
and to drop scheduled polling entirely.

**There is no supervised Micetro task.** `netmon/app.py` deliberately does not
register one — it is the only source with no scheduled cycle. `[micetro]
enabled` consequently changes meaning: it no longer means "poll", it means
**"NetMon may query Micetro at all"**. With it false, `/api/ddi/resolve`
answers 503 and nothing reaches the appliance.

### Is this a charter breach?

No, and the distinction matters. CLAUDE.md §6 forbids **source-platform calls
at page render** — dashboards fanning out to sources on every page load. This
is a *user-initiated* lookup: someone types an address and asks. It sits with
the rConfig config-diff pane (spec 10 Q5, "on-click read-through") and the
camera JPEG proxy (spec 11 D7), both of which call a source when a human asks
and neither of which was treated as a breach. Nothing here runs on a render
loop, and the endpoint writes nothing to the DB.

It is deliberately **not** wired into `/api/search`. The ⌘K palette fires as
you type; a 9-second MAC scan behind a keystroke would be indefensible. The
lookup is its own endpoint, invoked by an explicit affordance.

### `GET /api/ddi/resolve?ip=<ip>` — one request, ~0.2s

`addrRef` accepts a **literal IP**, not only an objRef (`GET
/ipamRecords/192.0.2.31`). Measured 0.25s end-to-end through the app.

### `GET /api/ddi/resolve?mac=<mac>` — two speeds

Micetro has **no global MAC query**. It stores a MAC as a *client identifier*
(owner's correction, 2026-09-09), and a bare `filter=<mac>` free-text-matches
it — but `ipamRecords` is range-scoped, and this estate's account cannot read
`/devices` (HTTP 400, code 1028 "You do not have access"). So:

1. **Local hop (~0.05–0.07s).** Find an IP NetMon already knows for that MAC —
   `pf_nodes` first (refreshed every 5 minutes), then the `ddi_addresses`
   cache — and ask Micetro about *that address*. PacketFence covers **83.9%**
   of FDB MACs.
   The answer is accepted **only if Micetro confirms the MAC lives there.** A
   stale local IP may have been re-leased, and reporting the new tenant as this
   MAC's identity would be a fabrication, not a stale read.
2. **Range scan (~5s on a hit, ~10s to prove absence).** Fan `filter=<mac>`
   across all 261 subnet ranges at concurrency 8, reusing one connection, first
   match wins. `deep_scan = false` (or `?deep=false`) declines this and says
   *why* — "no locally-known IP for this MAC, and the range scan was declined"
   — rather than returning an empty result that reads as "not in DDI".

Guards: one deep scan process-wide at a time (`_SCAN_LOCK`) so three impatient
clicks cannot put ~800 requests on the appliance for one answer, and a 60s
result cache so a double-click is not a second scan.

`found: false` is a **200**, not a 404 — "Micetro does not know this" is an
answer. Only an unreachable or refusing source is a 502, so a blind source can
never be mistaken for an empty one (§4.5). Micetro reports both "no such
object" (code 2049) and "no access" (code 1028) as HTTP **400**, so the client
maps them to distinct exceptions; conflating them would make an unregistered
address read as an outage.

### What the `--once` collector is still for

`python -m netmon.collectors.micetro --once` survives, unscheduled, for the
**DHCP scope table** — 261 scopes in 2 requests. Fleet-wide capacity has no
search-time equivalent, because nobody searches for "which pools are full",
and it is where the uncontested value turned out to be (2 pools at 100%,
2 more near 90%). `sweep_addresses` now defaults **off**: that is the
expensive half, and on-demand lookup replaced it.

### The frozen mirror

`ddi_addresses` currently holds 19,864 rows from the last manual sweep and
**nothing refreshes them**. They stay useful in two bounded ways — as a
MAC→IP *hint* for step 1 above (always verified against Micetro before being
believed) and as the port-pane join, which returns `ddi_updated_at` so the UI
can badge age honestly. But it is a snapshot that will only get older. Either
run `--once` with `sweep_addresses = true` occasionally, or truncate it and
rely purely on on-demand; leaving it to age silently is the one option that
misleads. **Owner's call** — noted as Q8.

## 8. Open questions

- **Q1 — live payload shape.** ✅ **Discharged 2026-09-09** (§7a). Every field
  name from the 26.1.0 schema parsed correctly against the live appliance. Two
  corrections the schema did not tell us, both now in code: `ObjRef` values
  already carry their collection (`ranges/6`, not `6`), and `DHCPScope` has no
  utilization figure — it lives on `Range`.
- **Q2 — real record count.** ✅ **Discharged 2026-09-09**: 19,656 rows kept,
  comfortably under `max_records = 60000`. The guards were not tripped.
- **Q6 — ~~filtering is broken~~ WRONG, and withdrawn 2026-09-09.** An earlier
  revision of this spec asserted that every `filter` expression returned HTTP
  200 with `totalResults = 0` and concluded the parameter was unusable. That
  was a bad experiment, not a bad API: the probe range (`ranges/2`) genuinely
  contains **0 `Assigned` addresses out of 254**, so `state=Assigned` → 0 was
  the *correct answer*, misread as a broken parameter. Filtering works, and the
  grammar is the documented `field=value` with `^` for prefix
  (`filter=name=^192.168` → 40 ranges; `filter=subnet=true` → exactly 261
  subnets). A **bare value** is a free-text match across the record, which is
  how a MAC is found. The moral: verify a negative result against a case known
  to be positive before concluding a feature is broken. Moot for the sweep now
  that §7b replaced it, but the corrected grammar is what the on-demand
  lookups are built on.
- **Q8 — the frozen mirror** (§7b). `ddi_addresses` holds a snapshot nothing
  refreshes. Refresh it periodically by hand, or truncate it and rely purely on
  on-demand lookup. Letting it age unremarked is the only wrong answer.
- **Q7 — an empty sweep used to wipe the mirror.** Found while probing Q6:
  `db.replace_rows` prunes whatever it did not see, so a source that answers
  "no records" with HTTP 200 would have emptied `ddi_addresses` and reported
  success. Now guarded — refusing to replace a populated table with nothing,
  raising instead so prior rows stay visibly stale (§4.5). A genuinely empty
  Micetro requires truncating the table by hand, which is the right price for
  a state otherwise indistinguishable from a broken sweep.
- **Q3 — alerting on scope exhaustion** (see §6). Needs an owner decision:
  widen `device_state` to non-device entities, or give the engine a second
  evaluation path for inventory-table severities? Until then utilization is
  visible but silent.
- **Q4 — PII.** `ddi_addresses` stores DNS hostnames and MACs district-wide.
  Materially less sensitive than `wireless_clients` (spec 10 Q8: usernames), and
  hostnames are already visible in `pf_nodes.computername`, but the row count is
  larger than any existing table and worth an explicit acceptance alongside Q8.
- **Q5 — IPv6.** `DHCPLease` carries `duid`/`iaid` for DHCPv6 rather than a
  MAC, so v6-only addresses will land with `mac = NULL` and identify by DNS
  name alone. Correct but partial; revisit if the district deploys v6.

## 9. Next session

- [x] ~~Get a read-only Micetro account + URL into `/etc/netmon/netmon.conf`,
      run `--once`, record the counts against Q1/Q2.~~ Done 2026-09-09 — §7a.
- [ ] Ask BlueCat support for the `filter` grammar on
      `/ranges/{ref}/ipamRecords` (Q6). Cutting the ~98% fetch waste is worth
      more than anything else on this list, and cannot be guessed safely.
- [ ] Decide whether the identity half earns its keep at all now that §7a puts
      the hostname gain at 16 MACs. The DHCP-scope half clearly does; the
      address-fill half probably does; `sweep_addresses = false` is a supported
      configuration if the answer is no.
- [ ] Answer Q3 before promising anyone an exhaustion alert.
- [ ] Frontend: the port-detail MAC card currently renders the PF fields; add
      the DNS name line (API already returns it). Nothing in the committed
      bundle changed in this PR — the enrichment is present in the JSON and
      ignored by the current UI, which is why it was safe to ship first.
- [ ] Wire DDI into the ⌘K palette as a fourth group. Deliberately **not** in
      this PR: it needs a `SearchResults` contract change plus an esbuild
      rebuild of `netmon/web/`, which is a separate diff from a new collector.
      `/api/ddi/addresses?q=` already answers the same question by IP,
      hostname, or MAC in any separator style.

# Spec 25 — Helpdesk: Frontline tickets and NetMon links

**Status:** BUILT 2026-10-08; live contract probed the same day against
Frontline v10.2.0 (§10a). Comments and field history are refused by Frontline
for the integration account — a Frontline-side permission, not a NetMon gap.
**Source documents:** owner's Helpdesk brief (2026-10-08) and
`HelpDesk-API-Map.xlsx` (Frontline v10.2.0 endpoint map, mapped 2026-10-08).

## 1. What this is

A Helpdesk group in the existing NetMon shell — **Tickets**, **Problems**,
**Issues** — where Frontline Help Desk tickets are read through NetMon and
linked to NetMon's own records. No second header, rail or design system.

| Record | Authoritative system |
|---|---|
| Ticket, its fields, comments, attachments | Frontline Help Desk |
| Problem (`alerts`), Issue (`issues`), Change (`changes`) | NetMon |
| Ticket ↔ record relationship (`helpdesk_links`) | NetMon |

Ticket status/priority/assignment/category are Frontline's vocabulary; NetMon
status and severity are NetMon's. They are never mapped onto a common enum
and never synchronised (§8). Frontline "ProblemTypes" are ticket categories,
not NetMon Problems.

## 2. Navigation and routes

* Sidebar gains **Helpdesk**: Tickets (`#/tickets`), Problems (`#/problems`),
  Issues (`#/issues`). Problems and Issues moved into it; their routes, records
  and permissions are unchanged. Changes stays under "Access & events".
* Breadcrumb: `Tuscaloosa City Schools / Helpdesk / <page>` for those three;
  every other page keeps `Operations`.
* New: `#/tickets/{number}?view=&q=&status=&priority=&site=&assigned=&days=&sort=&dir=&page=`
  — filters ride in the URL so moving between tickets, reloading or sharing a
  link preserves the list; scroll position is kept per filter set
  (sessionStorage, convenience only).
* New: `#/problems/{id}` opens a problem drawer (alert summary + linked
  tickets). Works for closed alerts too.

## 3. Ticket workspace

List (320 px) · detail (flex) · properties (300 px), from NetMon's card, tab,
table and seg-toggle primitives. Below 1400 px properties become a drawer;
below 760 px list and detail are separate views with a "‹ Tickets" back action.

* **List:** Active / Inactive / All, text search (#, subject, site, room,
  category, assignee), status / priority / site / assignee filters populated
  from Frontline lookups (falling back to values present in the list if a
  lookup route fails), created-window for Inactive/All, NetMon-side sort,
  50-row pages, fetched-at and a refresh action.
* **Detail:** subject, status, priority, site/room, dates; tabs Description ·
  Comments · History · Attachments; fetched-at + Refresh; "Open in Helpdesk"
  when `ticket_url_template` is set.
* **Properties:** ticket fields, then Linked Problems / Issues / Changes, each
  with Link existing, plus Create issue / Create change.

## 4. Server-side adapter (`netmon/helpdesk.py`)

* All vendor knowledge lives here; the browser sees only `/api/helpdesk/*`.
* Credentials: `HD_API_KEY` / `HD_API_PASSPHRASE` from the environment
  (`/etc/netmon/netmon.env`, systemd `EnvironmentFile=` drop-in). Refused in
  netmon.conf. Excluded from the config `repr`. The access token is in-process
  memory only — never in the DB, a response, or a log.
* Token: `POST Login/AuthorizeAPI`; expiry from the JWT `exp` if present, else
  the documented 8 h; renewed 5 min early; one re-login on a 401, then the
  error is surfaced. No refresh-token endpoint is assumed (none is documented).
* Bounded: per-request timeout (`timeout_s`); exponential backoff 15 s → 10 min
  after **outages only** (`unavailable`, `auth`). A 404, a 403, or an unknown
  route (HTTP 444 / `bad_response`) is an answer about one ticket or one route
  and does not block other calls (found by the probe smoke test).
* No retries of anything except the single post-401 re-login. Reads only:
  the adapter has no method for any mutation route.
* Errors carry a kind — `unconfigured | unavailable | auth | inaccessible |
  not_found | bad_response` — and a message built from status code + route
  (identifiers masked), never from a response body.
* Helpdesk HTML (descriptions, comments) is reduced to plain text server-side
  (stdlib `HTMLParser`; script/style dropped). The browser renders text only.
* Ticket identifiers are strings matched against `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`
  before they reach a URL path; never converted to integers.

### Field mapping

The workbook documents routes, not response schemas. Each canonical field is
resolved through a short candidate list (`_FIELDS`, case-insensitive, one level
into `ticketDetails`); a field not found is `null` and renders "—". The probe
prints which candidate matched on the live instance so the table can be
corrected rather than guessed.

## 5. API mapping — what is used, and its evidence

| Capability | Route | Workbook | Used for |
|---|---|---|---|
| Build check | GET `Home` | Live | probe only |
| Auth | POST `Login/AuthorizeAPI` | Live | token |
| Ticket lists | POST `Ticket/GetExportDataTickets/{userID}` | Live | all three views |
| Ticket detail | GET `Ticket/{n}` | Source | detail; falls back to the list row on `bad_response` |
| Statuses | POST `Status/GetActiveStatuses` | Live | filter |
| Priorities | POST `TicketPriority/GetPriorities` | Source | filter |
| Sites | POST `Location/GetSites` | Source | filter |
| Categories | POST `ProblemTypes/GetProblemTypesHierarchy` | Source | (lookup, shown as category) |
| Technicians | GET `User/GetAllTechnicians` | Source | assignee filter |
| Comments | POST `Ticket/{n}/GetTicketComments` | Source | detail_role only |
| Attachments | POST `Ticket/{n}/GetAllAttachments` | Source | metadata only, detail_role |
| Field history | POST `Ticket/{n}/TicketFieldHistory/GetTicketHistory` | Source | detail_role only |

**Not used:** `GetActiveTickets` (paged variant — Source only; page base and
totals unvalidated), `Ticket/Search?s=` (method unknown), `HasTicketAccess`
(needs a per-NetMon-user Frontline identity that does not exist yet), the S3
presigned download route, and every mutation.

**Lists are bounded without unvalidated paging:** Active is `state 0` (the live
queue); Inactive (`1`) and All (`2`) carry the one grid filter the workbook
confirmed live — Kendo `createdDate gte <UTC ISO>` — over `window_days`
(default 90, max 365). The body is the documented `0/0` export body; the
result is reused for `list_cache_s` (default 120 s) and paged/filtered/sorted
by NetMon. So an open Tickets page costs one bounded call per two minutes, and
"All" is never the district's whole history. Server-side `pageNumber`/
`pageCount` and the Kendo `sort` descriptor stay off until the probe confirms
them (§10).

**POSTs that read.** CLAUDE.md §4.1 asks for owner approval of any non-GET to
a source. The owner's brief directs these specific read routes, several of
which Frontline exposes only as POST; that brief is the approval for the
routes in the table above and nothing else.

## 6. Permissions

The integration key is privileged; holding it does not grant NetMon users
anything. Per request, NetMon checks:

| Setting (default) | Gates |
|---|---|
| `min_role` (operator) | ticket lists, detail, lookups, ticket summaries on links |
| `detail_role` (admin) | comments, field history, attachment lists |
| `link_role` (operator; `viewer` refused at boot) | create / remove links |

A viewer still sees *that* an issue is linked to ticket #4821 — the link is
NetMon's fact — but not the subject or status.

**Private notes.** `privateNotesOnly=false` is sent, and the response's
visibility semantics are unvalidated, so every comment is treated as possibly
private: comments are admin-only by default, the UI shows a "treat as internal"
banner unless the response carries an explicit visibility flag, and there are
no public/private tabs.

## 7. Links (`helpdesk_links`, migration 038)

`(instance, ticket_ref)` ↔ `(record_type, record_id)`, unique per pair, many
to many both ways, with `created_at`, `created_by`, optional `note`. Ticket
refs are VARCHAR. No foreign key (polymorphic): the API validates the local
record exists and that the help desk knows the ticket (404 → refused; outage →
503, nothing written). A record deleted later leaves its link visible as
"no longer exists".

* **Audit:** every link/unlink → `helpdesk_link_events` (actor, time, note).
  Issues additionally get a `status_change` entry on their timeline. Problems
  and changes have no thread of their own, so the event table is their trail
  (shown as "link history" in the section).
* **Unlink** deletes the relationship row only. Nothing is sent to the help
  desk; nothing local is deleted.
* **Ticket summary cache** (`helpdesk_ticket_cache`): rows only for linked
  tickets; subject, status, priority, site, category, assignee, dates — no
  description, requester or comments. Refreshed on list/detail reads and on
  "Refresh". `state` distinguishes `ok`, `inaccessible` (403 — may still
  exist) and `not_found` (404 — deleted *or* outside the integration's scope;
  NetMon cannot tell which). An outage changes none of them. Removed when the
  last link to the ticket goes.

### Linking workflows

* **From a ticket:** Link existing (search dialog over local records: id,
  title, NetMon status, location, updated), Create issue, Create change.
  Create prefills only ticket number, subject, site and category — never the
  description, requester, comments or attachments — and the user reviews
  before saving. If the record is created but the link fails, the record is
  kept and the dialog offers **Retry link** against that id (no second
  create; the unique key makes a repeat link a 409). There is no "Create
  problem": Problems are raised by the alert engine.
* **From a record:** "Linked Helpdesk Tickets" on Issue detail, Change detail
  and the Problem drawer — link by number, search tickets, open in NetMon,
  open original (when the URL template is set), refresh, unlink, link history.

## 8. Independence

No code path writes one side because the other changed. Closing a ticket does
not resolve a Problem; completing a Change does not touch its tickets. Ticket
chips are neutral and carry Frontline's words; NetMon chips are prefixed
"NM ·". `test_statuses_stay_independent` covers both directions.

## 9. Unsupported operations

Edit, reply, status change, create ticket, upload, attachment download: not
wrapped. The detail pane says so and offers **Open in Helpdesk** — which needs
`ticket_url_template`; until the real URL format is verified that button is
hidden and the text tells the operator to use Frontline. `/api/helpdesk/status`
reports `supports: {edit, reply, create, upload}: false`.

## 10. Validation status and remaining dependencies

Built and tested against a fake Frontline (`tests/test_helpdesk.py`, 33 tests:
two-layer payload parsing, token reuse/renewal, backoff scope, credential
secrecy, role gates, link uniqueness, unlink, outage behaviour, not-found vs
inaccessible, create-then-link retry).

**Not yet validated against the live instance** — run
`scripts/helpdesk_probe.py` (read-only, prints key names and counts only):

1. `HD_API_KEY` / `HD_API_PASSPHRASE` in `/etc/netmon/netmon.env` (template
   installed 2026-10-08, empty).
2. `scope_user_id` — the Frontline user whose visibility NetMon should use.
3. Field names (probe §4/§6 "field resolution") → adjust `_FIELDS`.
4. Lookup shapes for priorities, sites, categories, technicians.
5. `GET Ticket/{n}` existence and shape on v10.2.0.
6. Comment visibility keys → decide whether public/private can be shown.
7. Page base / `totalCount` behaviour and Kendo sort (probe §5) → only then
   consider server-side paging.
8. Original-ticket URL format → `ticket_url_template`.
9. Per-user ticket access (`HasTicketAccess/{userID}/{n}`) would need a
   NetMon-user → Frontline-user mapping; not built.
10. ToS: the workbook asks to confirm with Frontline that API use against Help
    Desk is supported for the district's license.

## 10a. Live probe results (2026-10-08, `scope_user_id = 14`)

| Item | Result |
|---|---|
| Login | ✓ token issued; JWT exp ≈ 9 h (adapter renews 5 min early) |
| Export grid, state 0 / 1 / 2 | ✓ 180 active; 149 inactive and 227 all in a 14-day createdDate window |
| Two-layer payload | ✓ `result` is a JSON string, `totalCount` present |
| Paging | ✓ `pageNumber` **zero-based**; pages 0/1/2 of 5 disjoint, totalCount stable |
| Sort | ✓ Kendo `createdDate` asc and desc honoured → plain browsing is server-paged |
| Field names | subject = `ticketSummary`; `site`, `location`, `problemTypeHierarchy`, `assignedTo`, `slaTargetDate`, `resolutionDate`; detail nests site/location/category/description under `ticketDetails`; no active flag (derived from the view) |
| `GET Ticket/{n}` | ✓ |
| Attachments list | ✓ |
| Statuses / Priorities / Sites lookups | ✗ 403 — filters fall back to list values; refusal cached 10 min |
| Categories hierarchy | ✗ 404 — category comes from the ticket row instead |
| Technicians | ✓ 18 |
| Comments, CommentsBulk, private-only, +userID | ✗ 403 in every variant |
| Field history (+userID) | ✗ 403 |
| GetPossibleActions | ✗ 403 |
| `HasTicketAccess/{userID}/{n}` | ✓ `{hasAccess, ticketNumber, userID}` |

**Consequences.** Comments and history cannot be shown until the API account
is granted access in Frontline (Asset Management › Management › District
Settings › API and SSO Information, or Frontline support); the tabs say so and
point to the help desk. Comment visibility semantics therefore remain
unvalidated, and `detail_role = admin` stays. `HasTicketAccess` working means a
per-NetMon-user check is feasible once NetMon users are mapped to Frontline
user IDs (item 9 in §10) — not built.

## 11. Reversibility

`[helpdesk] enabled = false` removes ticket access without a deploy; links stay
readable. Migration 038 has a rollback note (drops three tables; nothing else
references them; Frontline is unaffected either way).

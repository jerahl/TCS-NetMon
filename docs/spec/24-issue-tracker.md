# Spec 24 — Issue tracker (problem documentation)

**Status:** built 2026-09-30.
**Phase:** 11.x post-parity. Default **on** — it holds no credentials, calls no
source platform, and writes to nothing outside its own tables and its own
attachment directory.
**Supersedes nothing.** Adds a new domain alongside `alerts` (spec 06) and
`state_events` (spec 01).

---

## 1. Why this exists

NetMon already records what the network *did*: `state_events` is the transition
log, `alerts` is the engine's open-fault list. Neither records what a **person**
found out.

The wireless investigation of September 2026 is the worked example. Five
findings — AP connection-table exhaustion at NMS and WMS, class-change
reconnect churn, a handful of devices in a 10-second reconnect loop, unnecessary
broadcast flooding, duplicated and divergent firewall rules — took days of
packet captures, AP-by-AP comparisons and PacketFence log reading to establish.
Today that work lives in one person's notes and one email thread. The evidence
(a capture, a screenshot of a connection-table count, an AP uptime table) has no
home at all.

An alert cannot hold it. An alert is one device against one rule, opened and
closed by the engine; it has no author, no narrative, no attachments, and it
closes the moment the symptom stops — which is exactly when the *finding* becomes
worth keeping. `state_events` is append-only machine truth and must stay that way
(CLAUDE.md §6).

So: a separate, human-authored record. One issue = one problem somebody is
working on, with a plan, a thread, evidence, and links to the devices and sites
it concerns.

## 2. Scope

**In:**

- Issues: title, body, status, severity, category, reporter, assignee, site,
  affected devices, timestamps.
- A comment thread per issue (append-only in effect; authors may edit their own
  comment body, which records `edited_at`).
- File and screenshot attachments on the issue and on individual comments.
- Paste-a-screenshot from the clipboard, because the reports this is for arrive
  as screenshots.
- Filtering by status / severity / site / category / assignee, and full-text-ish
  search over title and body.
- The issues for a device, surfaced on that device's detail page.

**Out (deliberately):**

- No SLA timers, no workflow states beyond the six below, no email
  notifications. NetMon's only notification channel is the alert engine's SMTP
  path (CLAUDE.md §2) and this does not borrow it. An issue is read in the UI.
- No coupling to OpenProject (owner decision, 2026-09-30). OpenProject stays
  for NetMon's *development* backlog (#92, #111, #117). Pushing work packages
  from NetMon would be a write path to an external system and would need its own
  sign-off under §4.1. Anyone spinning engineering work off an issue pastes the
  link by hand.
- No auto-creation of issues from alerts. An issue is something a person decided
  to open. (Pre-filling the *form* from an alert is a future nicety; the link
  column exists for it.)
- No attachment preview beyond images and PDFs — anything else downloads.

## 3. Data model — migration `036_issues.sql`

Four tables.

- **`issues`** — the record. `status` ∈ `open | investigating | waiting |
  planned | resolved | closed`; `severity` reuses the project's
  `ok|warn|crit|unknown` vocabulary minus `ok`, i.e. `crit | warn | info`;
  `category` is a short free string with a UI-suggested set
  (`wireless | switching | surveillance | voip | nac | facilities | other`).
  `site` is a plain string joined to `sites.name` / `devices.site` the same
  loose way the rest of the app joins it — no FK, because an issue may name a
  site before the site exists in the registry.
- **`issue_devices`** — many-to-many to `devices`. An issue about
  AP-NMS-2F-204 and AP-NMS-2F-206 names both. `ON DELETE CASCADE` from the
  issue side only; a device leaving the registry does not silently drop the
  evidence that it was involved, so the row is kept and the API renders an
  unresolvable device id as `(device 412, no longer registered)`.
- **`issue_comments`** — the thread. `body`, `author`, `created_at`,
  `edited_at`, plus `kind` ∈ `comment | status_change` so the timeline can
  render "Sam moved this to planned" inline without a second query.
- **`issue_attachments`** — one row per stored file. `issue_id` always; a
  nullable `comment_id` when the file came in with a comment. Carries the
  original filename, the content type **as NetMon decided it** (not as the
  browser claimed), `size_bytes`, `sha256`, and `rel_path` under
  `[issues] attachment_dir`.

`rel_path` is stored relative for the same reason `firmware_images.rel_path` is
(migration 029): moving the store must not invalidate every row.

Why `sha256` on an attachment: the same screenshot gets attached to three issues
by three people, and the hash is how the storage report says so. It is not a
dedupe key — each row keeps its own file, because deleting one issue must not
blank an image in another.

## 4. Attachment storage

Files live on disk under `[issues] attachment_dir`
(default `/var/lib/netmon/issue-attachments`), **not** in the database. A
24 MB packet capture in a MariaDB BLOB is a backup problem and a
`max_allowed_packet` problem; a file on disk is a file on disk.

Layout: `<attachment_dir>/<issue_id>/<attachment_id>-<safe-name>`. The
attachment id in the name means two uploads of `screenshot.png` to one issue
cannot collide, and the safe name means the file is still recognisable when a
human is looking at the directory during a restore.

**Upload is a raw-body `PUT`, not a multipart form** — the same decision
`netmon/api/camera_ops.py::upload_firmware` documents. Parsing multipart needs
`python-multipart`, a dependency this project has not taken (CLAUDE.md §3), and
it would buy nothing: there is one file per request and its name rides in the
path. The body streams to disk in chunks, so a capture larger than memory is a
non-event.

**The content type is decided by NetMon, not by the client.** The upload
sniffs the first bytes and cross-checks the extension. A mismatch is refused.
This matters because the file is served back to a browser: the attachment
download route sets `Content-Type` from the stored value, and
`Content-Disposition: attachment` for everything that is not on the inline
allow-list (`image/png`, `image/jpeg`, `image/gif`, `image/webp`,
`application/pdf`, `text/plain`). SVG is **not** inline-renderable here — an SVG
is a script host, NetMon does not sanitize it, and an inline-rendered SVG
uploaded by any signed-in viewer would be stored XSS. SVG uploads are accepted
and always download.

`X-Content-Type-Options: nosniff` is set on every attachment response so a
browser cannot second-guess that decision.

Caps: `max_attachment_mb` (default 32) per file, `max_attachments_per_issue`
(default 50). Both are config, both are enforced server-side, and the streaming
writer aborts and unlinks the moment the byte count crosses the cap rather than
after the whole body has landed.

## 5. Permissions (owner decision, 2026-09-30)

| Action | Minimum role |
|---|---|
| Read issues, comments, attachments | `viewer` |
| Open an issue, comment, attach a file | `viewer` |
| Change status, severity, assignee, category, site, device links | `operator` |
| Edit any title/body, delete a comment or attachment, delete an issue | `admin` |
| Edit **your own** comment body | author, any role |

The shape is "schools report, IT triages" — the third thing the wireless
investigation asked for was *help from the schools to gather specifics: exact
time, room, device asset tag, what the user saw*. That only arrives if the
person who saw it can type it in. Triage stays with operators, so a reporter
cannot close an investigation that is still live.

`viewer` being able to write here is a deliberate departure from the rest of the
API, where `viewer` is read-only. It is confined to these four tables and the
attachment directory, and `[issues] allow_viewer_reports = false` turns it off
without a deploy.

## 6. API — `netmon/api/issues.py`, prefix `/api/issues`

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/issues` | viewer | Filters: `status`, `severity`, `category`, `site`, `assigned_to`, `device_id`, `q`, `limit`. `status=open` is a pseudo-filter meaning "not resolved or closed". |
| GET | `/api/issues/{id}` | viewer | Issue + comments + attachments + resolved device names in one response — the detail page is one round-trip. |
| POST | `/api/issues` | viewer\* | Create. Returns the full detail shape. |
| PATCH | `/api/issues/{id}` | mixed | Field-by-field role check (§5). A status change also writes a `status_change` comment. |
| DELETE | `/api/issues/{id}` | admin | Removes rows and the issue's attachment directory. |
| POST | `/api/issues/{id}/comments` | viewer\* | |
| PATCH | `/api/issues/{id}/comments/{cid}` | author or admin | |
| DELETE | `/api/issues/{id}/comments/{cid}` | admin | |
| PUT | `/api/issues/{id}/attachments/{filename}` | viewer\* | Raw body. `?comment_id=` attaches to a comment. |
| GET | `/api/issues/{id}/attachments/{aid}` | viewer | Serves the file. |
| DELETE | `/api/issues/{id}/attachments/{aid}` | admin | Removes row and file. |
| GET | `/api/issues/meta` | viewer | Enum vocabularies + caps + what this viewer may do, so the UI does not guess. |

\* `viewer` when `allow_viewer_reports` is true (default), otherwise `operator`.

## 7. UI

- **`#/issues`** — list. Filter bar (status / severity / site / category),
  sortable table, "New issue" button. Default filter is "not resolved or
  closed", because the open list is what an operator wants at 7am.
- **`#/issues/:id`** — detail. Header with status/severity/assignee controls
  (disabled below `operator`, with the reason in the tooltip), body, linked
  devices and site, attachment gallery, then the timeline.
- **Compose** — title, body, severity, category, site, device picker, and a
  drop zone that takes dropped files *and* a pasted clipboard image. The device
  picker searches the registry through the existing `/api/search`.
- **On device pages** — `IssuesForDevice` renders the open issues for a device.
  Wired into AP Detail first (the wireless case), exported for the switch and
  camera detail pages.
- Nav: "Issues" under **Access & events**, next to Problems, with an open count.

## 8. Testing

`tests/test_issues_api.py` — SQLite-backed like every other API test, with the
migration asserted textually in `tests/test_migrations.py`:

- create → read → filter round-trip, including the `status=open` pseudo-filter
- role gating on every route, in both directions
- attachment upload: happy path, oversize abort-and-unlink, count cap,
  extension/magic-byte mismatch, path-traversal filename
- attachment download headers: inline allow-list, `nosniff`, SVG forced to
  download
- comment edit permitted for the author and refused for a non-author non-admin
- deleting an issue removes its files from disk

## 10. Change tracking — migration `037`

**Built 2026-10-01.** The other half of the tracker.

An issue records a problem. A change records a deliberate act taken against
one, with the prediction made beforehand and the outcome observed afterwards.
Everything else in this database records what the network did; `changes`
records what *we* did to it.

### Why it is not a notes field on the issue

Because the comparison is the artifact. The wireless work is the example again:
"shorten the DNS timeout — expect the table to drop about 76%" is worth
nothing on its own and worth a great deal once "actually dropped 75%, peak
total 3,980" sits beside it, written later by somebody who could not edit the
first half.

So `expected` and `actual` are separate columns, and **`expected` is refused
once the change is applied**. A single free-text field lets the prediction be
quietly revised when the answer arrives, which is exactly the failure the table
exists to prevent.

### Tables

- **`changes`** — `what`, `why`, `expected`, `actual`, plus `status`
  (`proposed | approved | applied | verified | reverted | abandoned`), `verdict`
  (`pending | as_expected | partial | no_effect | worse`), `risk`, `rollback`,
  `site`, and who/when for each transition. `issue_id` is nullable with
  `ON DELETE SET NULL` — routine work happens that nobody opened an issue for,
  and deleting an issue must not destroy the record that a device was
  reconfigured.
- **`change_devices`** — `role` ∈ `target | baseline`. The standing method here
  is to change one AP and hold a neighbouring one as a control across the same
  school day; a record listing both without saying which was which cannot be
  read afterwards. The API refuses a device listed as both.

### The three design decisions worth defending

1. **`expected` locks at apply.** See above. Enforced in `patch_change`, with
   the refusal pointing the author at `actual` instead.
2. **`no_effect` and `worse` are first-class verdicts.** A change log in which
   every entry reads as a success is one nobody learns from, and the two most
   useful rows a year later are "we were confident and wrong" and "this made it
   worse".
3. **Applied-but-unverified is surfaced, not filtered for.**
   `GET /api/changes/outstanding` is its own endpoint so the page can lead with
   the count and the nav can badge it. This is CLAUDE.md §4.5 (fail loud, never
   stale) turned on our own work rather than on a collector.

### Permissions

Operator and above for everything that writes; `viewer` reads only. **No
viewer carve-out**, deliberately unlike issues: filing a report is something a
teacher should be able to do, recording that the network was reconfigured is
not. Deleting is admin, and is refused outright while a change is live —
removing the record would leave the configuration with no explanation. Revert
or abandon it instead.

### No thread of its own

Proposing, applying, verifying and reverting each write a `status_change` entry
onto the linked issue's timeline, carrying both halves of the comparison. A
second comment system would split one problem's story across two places.

### API — `netmon/api/changes.py`, prefix `/api/changes`

| Method | Path | Role |
|---|---|---|
| GET | `/api/changes` | viewer — filters: `status` (plus pseudo `live`, `unverified`), `verdict`, `issue_id`, `device_id`, `site`, `q` |
| GET | `/api/changes/outstanding` | viewer |
| GET | `/api/changes/meta` | viewer |
| GET | `/api/changes/{id}` | viewer |
| POST | `/api/changes` | operator |
| PATCH | `/api/changes/{id}` | operator — refuses `expected` once applied |
| POST | `/api/changes/{id}/apply` | operator |
| POST | `/api/changes/{id}/verify` | operator — refuses an unapplied change and a `pending` verdict |
| POST | `/api/changes/{id}/revert` | operator |
| DELETE | `/api/changes/{id}` | admin — refused while live |

### UI

`#/changes` leads with the outstanding banner, then a filterable table.
`#/changes/:id` puts expected and actual side by side above everything else.
The compose form can be opened from an issue, which is where a prediction gets
written honestly because the problem is still on screen. Nav badge counts
outstanding, not total.

### Not built

No attachments of their own — evidence goes on the linked issue. A change with
no issue therefore has nowhere to put a before/after graph; revisit if that
turns out to matter.

## 9. Open threads

- **Retention.** Issues are kept forever today. The 24h rule (CLAUDE.md §6)
  governs *metric* history, not human records, so this is not a violation — but
  an attachment directory with no pruning policy grows. Revisit when the store
  passes a few GB; the storage report on the Settings page is the trigger.
- **Alert → issue pre-fill.** `issues.alert_id` is not in this migration. When
  it arrives it should pre-fill the compose form, not auto-create.
- **Full-text search.** `q` is `LIKE %…%` over title and body. Fine at the
  hundreds-of-issues scale this will live at; if it stops being fine, MariaDB
  FULLTEXT on `(title, body)` is the answer, not a dependency.

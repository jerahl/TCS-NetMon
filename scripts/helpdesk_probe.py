#!/usr/bin/env python3
"""Validate the Frontline Help Desk API contract NetMon relies on (spec 25 §5).

Read-only. Calls only the documented read routes, through NetMon's own adapter
(so it validates the adapter too), and prints **structure, never content**:
HTTP outcome, top-level key names, row counts, the key names of one row, which
candidate spelling each canonical field resolved to, and whether pagination and
sorting behave as the workbook suggests. No ticket subject, comment, requester
or technician name is printed — key names and counts only (the workbook's
privacy rule). Status and priority *names* are printed: they are the help
desk's vocabulary, not personal data, and NetMon's filters show them anyway.

Credentials come from the environment, exactly as netmon.service gets them:

    sudo bash -c 'set -a; . /etc/netmon/netmon.env; set +a; \\
      /opt/netmon/venv/bin/python scripts/helpdesk_probe.py --user-id <ID>'

``--user-id`` is the Frontline user whose visibility scopes the ticket lists
(it becomes ``[helpdesk] scope_user_id``). It is never defaulted.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from netmon.config import HelpdeskConfig  # noqa: E402
from netmon.helpdesk import (_FIELDS, FrontlineClient, HelpdeskError,  # noqa: E402
                             created_filter, grid_body, parse_grid, parse_rows,
                             normalize_ticket)

OK, BAD, WARN = "  ✓", "  ✗", "  ?"


def keys_of(x) -> str:
    if isinstance(x, dict):
        return ", ".join(sorted(x.keys())) or "(no keys)"
    if isinstance(x, list):
        return f"list[{len(x)}]" + (f" of {{{keys_of(x[0])}}}" if x and isinstance(x[0], dict) else "")
    return type(x).__name__


def step(name, fn):
    try:
        out = fn()
        return out, None
    except HelpdeskError as e:
        print(f"{BAD} {name}: {e.kind} — {e.message}")
        return None, e
    except Exception as e:  # a probe reports; it does not stop at the first surprise
        print(f"{BAD} {name}: {type(e).__name__}")
        return None, e


def field_map(row: dict) -> None:
    lower = {k.lower(): k for k in row}
    nested = next((row[k] for k in row if k.lower() == "ticketdetails"
                   and isinstance(row[k], dict)), {})
    nlower = {k.lower(): k for k in nested}
    for canon, cands in _FIELDS.items():
        hit = next((lower[c.lower()] for c in cands if c.lower() in lower), None)
        if hit is None:
            n = next((nlower[c.lower()] for c in cands if c.lower() in nlower), None)
            hit = f"ticketDetails.{n}" if n else None
        print(f"{OK if hit else WARN} {canon:<12} ← {hit or 'not found'}")
    known = {c.lower() for cands in _FIELDS.values() for c in cands}
    extra = sorted(k for k in row if k.lower() not in known)
    if extra:
        print(f"    unmapped keys ({len(extra)}): {', '.join(extra)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--user-id", required=True, help="Frontline user ID for list scope")
    ap.add_argument("--base-url", default=HelpdeskConfig.base_url)
    ap.add_argument("--days", type=int, default=14, help="window for the inactive/all probes")
    args = ap.parse_args()
    if not args.user_id.isdigit():
        print("--user-id must be numeric"); return 2

    cfg = HelpdeskConfig(enabled=True, base_url=args.base_url.rstrip("/") + "/",
                         scope_user_id=args.user_id,
                         api_key=os.environ.get("HD_API_KEY", "").strip(),
                         passphrase=os.environ.get("HD_API_PASSPHRASE", "").strip())
    print(f"Frontline probe · {cfg.base_url} · scope user {cfg.scope_user_id}")
    print(f"credentials present: {cfg.has_credentials}  (values not shown)\n")
    c = FrontlineClient(cfg)

    print("[1] product/build — GET api/Home (no auth)")
    home, _ = step("Home", c.home)
    if home is not None:
        print(f"{OK} keys: {keys_of(home)}")
        if isinstance(home, dict):
            for k, v in home.items():
                if isinstance(v, (str, int, float)) and len(str(v)) < 80:
                    print(f"    {k} = {v}")   # product name + build only
    if not cfg.has_credentials:
        print("\nHD_API_KEY / HD_API_PASSPHRASE not set — stopping before login."); return 1

    print("\n[2] auth — POST api/Login/AuthorizeAPI")
    tok, err = step("login", lambda: c._bearer(force=True))
    if err:
        return 1
    st = c.status()
    print(f"{OK} token issued; valid now: {st['token_valid']}; "
          f"expires in ~{int((c._token.expires_at - __import__('time').time()) / 3600)}h")

    print("\n[3] lookups")
    for name, fn in (("statuses (POST Status/GetActiveStatuses)", c.statuses),
                     ("priorities (POST TicketPriority/GetPriorities)", c.priorities),
                     ("sites (POST Location/GetSites)", c.sites),
                     ("categories (POST ProblemTypes/GetProblemTypesHierarchy)", c.categories),
                     ("technicians (GET User/GetAllTechnicians)", c.technicians)):
        items, err = step(name, fn)
        if items is not None:
            mark = OK if items else WARN
            print(f"{mark} {name}: {len(items)} normalised")
            if items and name.startswith(("statuses", "priorities")):
                print("    " + " · ".join(f"{i['id']}={i['name']}" for i in items[:20]))
            if not items:
                raw, _ = step(name, lambda n=name: c.request(
                    "POST" if "POST" in n else "GET", n.split(" ")[-1].rstrip(")"),
                    {} if "POST" in n else None))
                print(f"    raw shape: {keys_of(raw)}  ← adjust normalize_lookup id/name keys")

    print("\n[4] ticket grid — POST Ticket/GetExportDataTickets/{userID}")
    active, err = step("active (state 0, 0/0)", lambda: c.ticket_grid(0, None))
    first = None
    if active:
        total, rows = active
        print(f"{OK} active: totalCount={total}, rows={len(rows)}")
        if rows:
            first = rows[0]
            print("    field resolution on one row (names only):")
            field_map(first)
            norm = [normalize_ticket(r) for r in rows]
            print(f"    rows with a usable ticket id: {sum(1 for n in norm if n)}/{len(rows)}")
    win = created_filter(args.days)
    for state, label in ((1, "inactive"), (2, "all")):
        res, _ = step(label, lambda s=state: c.ticket_grid(s, win))
        if res:
            print(f"{OK} {label} (createdDate ≥ last {args.days}d): totalCount={res[0]}, rows={len(res[1])}")

    print("\n[5] pagination & sort (same body, pageNumber/pageCount varied)")
    def grid(page, count, sort=None):
        body = grid_body(2, win); body.update(pageNumber=page, pageCount=count, sort=sort)
        return parse_grid(c.request("POST", f"Ticket/GetExportDataTickets/{cfg.scope_user_id}", body))
    ids = {}
    for page in (0, 1, 2):
        res, _ = step(f"page {page} × 5", lambda p=page: grid(p, 5))
        if res:
            ids[page] = [n["ticket"] for n in (normalize_ticket(r) for r in res[1]) if n]
            print(f"{OK} pageNumber={page} pageCount=5 → rows={len(res[1])} totalCount={res[0]}")
    if len(ids) == 3:
        if ids[0] == ids[1]:
            print("    page 0 == page 1 → pageNumber is 1-based (0 treated as 1)")
        elif ids[1] and ids[1] != ids[2]:
            print("    pages 1 and 2 differ → paging honoured; compare with page 0 for base")
        print("    (ids withheld; overlap only)", {k: len(set(v) & set(ids[0])) for k, v in ids.items()})
    for d in ("asc", "desc"):
        res, _ = step(f"sort createdDate {d}", lambda d=d: grid(0, 0, [{"field": "createdDate", "dir": d}]))
        if res and res[1]:
            dates = [normalize_ticket(r) and normalize_ticket(r)["created"] for r in res[1]]
            dates = [x for x in dates if x]
            ordered = dates == sorted(dates, reverse=d == "desc")
            print(f"{OK if ordered else WARN} sort createdDate {d}: {'honoured' if ordered else 'NOT honoured'}")

    if first:
        ref = normalize_ticket(first)["ticket"] if normalize_ticket(first) else None
        if ref:
            print("\n[6] one ticket's detail routes (ticket number withheld)")
            for name, fn in (("GET Ticket/{n}", lambda: c.ticket(ref)),
                             ("POST Ticket/{n}/GetTicketComments", lambda: c.comments(ref)),
                             ("POST Ticket/{n}/GetAllAttachments", lambda: c.attachments(ref)),
                             ("POST Ticket/{n}/TicketFieldHistory/GetTicketHistory",
                              lambda: c.history(ref))):
                out, _ = step(name, fn)
                if out is not None:
                    print(f"{OK} {name}: {keys_of(out)}")
                    if name == "GET Ticket/{n}" and isinstance(out, dict):
                        print("    detail field resolution:"); field_map(out)
                    if "Comments" in name and isinstance(out, list) and out:
                        flags = [k for k in out[0] if "priv" in k.lower() or "intern" in k.lower()
                                 or "public" in k.lower() or "visib" in k.lower()]
                        print(f"    visibility-looking keys: {flags or 'none'} "
                              "(confirm semantics before showing public/private tabs)")
    print("\nDone. Nothing was written to the help desk.")
    c.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

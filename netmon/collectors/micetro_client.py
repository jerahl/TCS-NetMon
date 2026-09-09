"""Micetro (BlueCat / Men&Mice) DDI client — REST API v2, read-only.

Base path is ``/mmws/api/v2``; see docs/spec/21-micetro-ddi.md.

**Every request is a GET.** The Swagger `security` block advertises one scheme,
a Bearer token obtained by ``POST /micetro/sessions`` with the user's
credentials — but the Micetro Web Service also accepts HTTP Basic auth on each
request, and the vendor documentation states that with an authorization header
"the Login command becomes unnecessary, and the session ID is not used". So
this client never creates a session, and has no non-GET method at all: `httpx`
is reachable only through ``_get``. Adding a write means adding a method, which
is a reviewable diff needing owner sign-off (CLAUDE.md §4.1).

HTTPS is enforced in the constructor. Basic auth puts the credential on every
request, so plaintext HTTP would leak it on every poll — the same rule
``RConfigClient`` applies for the same reason.

Paged endpoints all share one shape: ``offset``/``limit`` query params and a
response of ``{<collection>: [...], "totalResults": N}``. ``_drain`` walks that
uniformly and refuses to loop forever on a server that ignores ``offset``.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger("netmon.collectors.micetro")

TIMEOUT = 60.0
API_BASE = "/mmws/api/v2"
PAGE_SIZE = 500
#: Hard stop on pages per collection. At the default page size that is 500k
#: rows — far past `max_records`, so the collector's own guard trips first;
#: this only catches a server that ignores `offset` and streams page 1 forever.
MAX_PAGES = 1000


class MicetroError(Exception):
    pass


class MicetroClient:
    def __init__(self, url: str, username: str, password: str,
                 verify_ssl: bool = True, timeout: float = TIMEOUT,
                 page_size: int = PAGE_SIZE) -> None:
        if not url:
            raise MicetroError("micetro url is required")
        if not url.lower().startswith("https://"):
            # Basic auth sends the credential on every request.
            raise MicetroError("micetro url must be https:// (Basic auth credential)")
        if not username or not password:
            raise MicetroError("micetro username and password are required")
        self._base = url.rstrip("/") + API_BASE
        self._auth = (username, password)
        self._verify = verify_ssl
        self._timeout = timeout
        self._page_size = max(1, int(page_size))

    # --- transport -----------------------------------------------------------

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict:
        """The only outbound call this module makes."""
        async with httpx.AsyncClient(base_url=self._base, timeout=self._timeout,
                                     verify=self._verify, auth=self._auth) as client:
            try:
                resp = await client.get(path, params=params or {},
                                        headers={"Accept": "application/json"})
            except httpx.HTTPError as exc:
                raise MicetroError(f"micetro transport error on {path}: {exc}") from exc
        if resp.status_code == 401:
            raise MicetroError(
                f"micetro HTTP 401 on {path} — check [micetro] username/password, "
                "and that the Web Service allows Basic authentication")
        if resp.status_code >= 400:
            raise MicetroError(f"micetro HTTP {resp.status_code} on {path}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise MicetroError(f"micetro returned non-JSON on {path}") from exc
        if not isinstance(data, dict):
            raise MicetroError(f"micetro returned {type(data).__name__}, expected object, on {path}")
        # v2 wraps everything in {"result": {...}}; older builds answer flat.
        result = data.get("result")
        return result if isinstance(result, dict) else data

    async def _drain(self, path: str, collection: str,
                     params: dict[str, Any] | None = None,
                     limit_total: int | None = None) -> list[dict]:
        """Page one collection to exhaustion.

        Stops on a short page, on `totalResults`, or on `limit_total` — and
        raises rather than truncating silently if the page count runs away, so
        a partial mirror never looks complete (§4.5).
        """
        rows: list[dict] = []
        offset = 0
        for _ in range(MAX_PAGES):
            page = await self._get(path, {**(params or {}),
                                          "offset": offset, "limit": self._page_size})
            items = page.get(collection)
            if not isinstance(items, list):
                # An empty collection may be omitted entirely; anything else is
                # a shape we do not understand and must not guess at.
                if collection in page:
                    raise MicetroError(
                        f"micetro {path}: expected list at '{collection}', "
                        f"got {type(items).__name__}")
                break
            rows.extend(r for r in items if isinstance(r, dict))
            if len(items) < self._page_size:
                break
            total = page.get("totalResults")
            if isinstance(total, int) and len(rows) >= total:
                break
            if limit_total is not None and len(rows) >= limit_total:
                break
            offset += len(items)
        else:
            raise MicetroError(f"micetro {path}: exceeded {MAX_PAGES} pages draining "
                               f"'{collection}' — server may be ignoring offset")
        return rows

    # --- reads ---------------------------------------------------------------

    async def ranges(self, limit_total: int | None = None) -> list[dict]:
        """``GET /ranges`` — every range, container rows included.

        The caller filters to ``subnet = true``; containers are returned so a
        misconfigured range that is neither can be logged rather than silently
        vanish.
        """
        return await self._drain("/ranges", "ranges", limit_total=limit_total)

    async def ipam_records(self, range_ref: str,
                           limit_total: int | None = None) -> list[dict]:
        """``GET /ranges/{rangeRef}/ipamRecords`` — addresses in one range.

        ``includeRelatedDNSRecords`` is left false on purpose: it inflates every
        record with CNAMEs and related RRs, and NetMon shows one primary name
        plus a count of extras (spec 21 §3.3).
        """
        if not range_ref:
            raise MicetroError("ipam_records needs a range ref")
        return await self._drain(f"/ranges/{range_ref}/ipamRecords", "ipamRecords",
                                 {"includeRelatedDNSRecords": "false"},
                                 limit_total=limit_total)

    async def dhcp_scopes(self, limit_total: int | None = None) -> list[dict]:
        """``GET /dhcpScopes`` — scopes with ``utilizationPercentage``."""
        return await self._drain("/dhcpScopes", "dhcpScopes", limit_total=limit_total)

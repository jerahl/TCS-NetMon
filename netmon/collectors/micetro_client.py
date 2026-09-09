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

**Filtering works** (verified live 2026-09-09): the grammar is ``field=value``
with ``^`` for prefix, per the vendor docs' one example
(``filter=name=^test.menandmice``). ``/ranges?filter=subnet=true`` returns
exactly the 261 subnets this estate has. A *bare* value is a free-text match
across the record's fields, which is how a MAC is found — Micetro carries it as
a **client identifier**, so ``filter=<mac>`` matches the address holding it.

An earlier revision of this file claimed filtering was broken. It is not; that
conclusion came from probing ``state=Assigned`` against a range which genuinely
contains no Assigned addresses, so the correct answer (0) was misread as a
broken parameter. Do not re-derive that.

Two lookup shapes matter, and neither needs a schedule:

  * ``GET /ipamRecords/<ip>`` — ``addrRef`` accepts a **literal IP**, not just
    an objRef, so resolving an address is one request.
  * ``filter=<mac>`` per range — there is no global MAC search (the
    ``ipamRecords`` path is range-scoped and ``/devices`` returns 403-in-400
    form, "You do not have access to perform that action"), so a MAC with no
    known IP requires a bounded fan-out across the subnet ranges. Measured at
    ~9s for 261 ranges at concurrency 8, reusing one connection.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
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


#: Micetro's "no such object" error code. Arrives as HTTP 400, not 404, so a
#: genuine miss must be told apart from a broken source (§4.5) — otherwise a
#: lookup for an unregistered address reads as "Micetro is down".
ERR_NOT_FOUND = 2049
#: "You do not have access to perform that action." Also HTTP 400.
ERR_NO_ACCESS = 1028


class MicetroError(Exception):
    pass


class MicetroNotFound(MicetroError):
    """The identifier is well-formed but Micetro holds no such object."""


class MicetroForbidden(MicetroError):
    """The account lacks rights for this call (e.g. /devices on this estate)."""


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
        #: Set only inside ``session()``; see ``_get``.
        self._session: httpx.AsyncClient | None = None

    # --- transport -----------------------------------------------------------

    def _new_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self._base, timeout=self._timeout,
                                 verify=self._verify, auth=self._auth)

    @asynccontextmanager
    async def session(self):
        """Reuse one connection across many requests.

        A MAC fan-out is 261 requests; opening a fresh TLS connection for each
        dominates the wall clock. Inside this block ``_get`` reuses one client
        (measured ~9s for the full fan-out); outside it, each call is
        self-contained as before, so nothing else has to change.
        """
        client = self._new_client()
        self._session = client
        try:
            async with client:
                yield self
        finally:
            self._session = None

    @staticmethod
    def _error_of(resp: httpx.Response) -> tuple[int | None, str]:
        """Micetro's ``{"error": {"code", "message"}}``, if present."""
        try:
            err = (resp.json() or {}).get("error") or {}
        except ValueError:
            return None, ""
        if not isinstance(err, dict):
            return None, ""
        code = err.get("code")
        return (code if isinstance(code, int) else None), str(err.get("message") or "")

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict:
        """The only outbound call this module makes."""
        client = self._session
        try:
            if client is not None:
                resp = await client.get(path, params=params or {},
                                        headers={"Accept": "application/json"})
            else:
                async with self._new_client() as c:
                    resp = await c.get(path, params=params or {},
                                       headers={"Accept": "application/json"})
        except httpx.HTTPError as exc:
            raise MicetroError(f"micetro transport error on {path}: {exc}") from exc
        if resp.status_code == 401:
            raise MicetroError(
                f"micetro HTTP 401 on {path} — check [micetro] username/password, "
                "and that the Web Service allows Basic authentication")
        if resp.status_code >= 400:
            # Micetro answers "no such object" and "not allowed" with 400 and a
            # numeric code, never 404/403. Mapping them to distinct exceptions is
            # what lets a lookup say "not in Micetro" instead of "Micetro broke".
            code, msg = self._error_of(resp)
            if code == ERR_NOT_FOUND:
                raise MicetroNotFound(f"micetro has no such object on {path}: {msg}")
            if code == ERR_NO_ACCESS:
                raise MicetroForbidden(
                    f"micetro denied {path} — the account lacks rights for this call: {msg}")
            raise MicetroError(
                f"micetro HTTP {resp.status_code} on {path}"
                + (f" (code {code}: {msg})" if code else ""))
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

        No ``filter`` is sent, deliberately. The parameter exists on this
        endpoint and would cut ~98% of the fetch volume (the sweep pulls every
        address, including Free ones, and discards most), but on this Micetro
        build every filter expression tried returned **HTTP 200 with
        totalResults=0** rather than an error — `state=Assigned`,
        `state!=Free`, `state == Assigned`, `state:Assigned`, and five more
        (probed live 2026-09-09). A filter that silently matches nothing is the
        worst possible failure here: it would look like a successful sweep of an
        estate that owns no addresses. Do not add one without proving it
        returns the same count as the unfiltered call on a known range.
        """
        if not range_ref:
            raise MicetroError("ipam_records needs a range ref")
        return await self._drain(f"/{self._ref_path(range_ref)}/ipamRecords",
                                 "ipamRecords",
                                 {"includeRelatedDNSRecords": "false"},
                                 limit_total=limit_total)

    @staticmethod
    def _ref_path(ref: str, collection: str = "ranges") -> str:
        """Path segment for a Micetro ``ObjRef``.

        Live refs already carry their collection: ``/ranges`` returns
        ``ref: "ranges/6"``, not ``"6"``. Prepending the collection again
        yields ``/ranges/ranges/6/ipamRecords``, which this appliance happily
        normalises (verified identical `totalResults` both ways, 2026-09-09) —
        but relying on a server to forgive a malformed path is not a plan.
        Accepts a bare id too, since the published schema types ObjRef as an
        opaque string and does not promise the prefix.
        """
        ref = (ref or "").strip().strip("/")
        return ref if "/" in ref else f"{collection}/{ref}"

    async def dhcp_scopes(self, limit_total: int | None = None) -> list[dict]:
        """``GET /dhcpScopes`` — scopes with ``utilizationPercentage``."""
        return await self._drain("/dhcpScopes", "dhcpScopes", limit_total=limit_total)

    # --- on-demand lookups (no schedule; spec 21 §7b) ------------------------

    async def ipam_record(self, ip: str) -> dict:
        """One address, by literal IP — ``GET /ipamRecords/<ip>``.

        ``addrRef`` accepts an IP as well as an objRef (verified live), which is
        what makes search-time resolution a single request instead of a sweep.

        Raises ``MicetroNotFound`` when Micetro holds no such address, so the
        caller can say "not in DDI" rather than implying the source failed.
        """
        ip = (ip or "").strip()
        if not ip:
            raise MicetroError("ipam_record needs an IP address")
        # Path-segment safety: the IP is caller-supplied and goes into the URL.
        # Only characters that appear in v4/v6 literals are allowed, so nothing
        # can escape the segment or reach another endpoint.
        if not all(ch.isalnum() or ch in ".:" for ch in ip):
            raise MicetroError(f"ipam_record: {ip!r} is not an IP address")
        body = await self._get(f"/ipamRecords/{ip}")
        rec = body.get("ipamRecord")
        if not isinstance(rec, dict):
            raise MicetroError(f"micetro returned no ipamRecord for {ip}")
        return rec

    async def subnet_range_refs(self) -> list[str]:
        """Refs of every range that is an actual subnet.

        ``filter=subnet=true`` is applied server-side — it returns exactly the
        261 subnets on this estate, so the container/aggregate rows never come
        back to be filtered out locally.
        """
        rows = await self._drain("/ranges", "ranges", {"filter": "subnet=true"})
        return [str(r["ref"]) for r in rows if r.get("ref")]

    async def find_by_client_identifier(
        self, mac: str, range_refs: list[str] | None = None,
        concurrency: int = 8,
    ) -> dict | None:
        """Find the address holding ``mac``, by scanning ranges.

        Micetro carries a MAC as a **client identifier** and a bare
        ``filter=<mac>`` free-text-matches it — but ``ipamRecords`` is
        range-scoped and this estate's account cannot read ``/devices``, so
        there is no single global MAC query. This fans the filter across the
        subnet ranges and returns the first match.

        Deliberately the *fallback* path: it is ~261 requests (~9s at
        concurrency 8), so callers should resolve the MAC to an IP from local
        data first and use ``ipam_record`` when they can.

        Returns ``None`` when no range holds the MAC — a real answer, not an
        error. A per-range failure aborts the scan rather than being swallowed,
        because "not found" after silently skipping ranges is a lie.
        """
        mac = (mac or "").strip()
        if not mac:
            raise MicetroError("find_by_client_identifier needs a MAC")
        async with self.session():
            refs = range_refs if range_refs is not None else await self.subnet_range_refs()
            sem = asyncio.Semaphore(max(1, concurrency))
            found: list[dict] = []

            async def probe(ref: str) -> None:
                if found:            # first match wins; stop paying for the rest
                    return
                async with sem:
                    if found:
                        return
                    body = await self._get(f"/{self._ref_path(ref)}/ipamRecords",
                                           {"filter": mac, "offset": 0, "limit": 2,
                                            "includeRelatedDNSRecords": "false"})
                    for rec in (body.get("ipamRecords") or []):
                        if isinstance(rec, dict) and not found:
                            found.append(rec)
                            return

            await asyncio.gather(*(probe(r) for r in refs))
        return found[0] if found else None

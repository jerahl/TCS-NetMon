"""ExtremeCloud IQ HTTP client — async httpx port of the reference
``XIQFleetClient.php``.

Read-only (GET). Permanent bearer token (``fromToken`` model — on 401 we
surface an error, we do not re-auth). Tracks the ``RateLimit-*`` headers and
maps 401/429/other-non-2xx to typed exceptions the collector classifies.

Only the fleet device-list path needed for Phase 3 is ported; richer per-device
endpoints (clients, wifi stats, alarms) are added when the UI live-reads them
(Phase 4).
"""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger("netmon.collectors.xiq")

BASE_URL = "https://api.extremecloudiq.com"
PAGE_LIMIT = 100
MAX_PAGES = 200  # runaway-pagination backstop
HTTP_TIMEOUT = 30.0


class XiqError(Exception):
    """Any XIQ call failure (transport or non-2xx other than the ones below)."""


class XiqAuthError(XiqError):
    """401 — token revoked or invalid. The source is effectively unreachable."""


class XiqRateLimitError(XiqError):
    """429 — reachable but throttled. NOT a blind condition."""


class XiqClient:
    def __init__(self, token: str, base_url: str = BASE_URL, timeout: float = HTTP_TIMEOUT) -> None:
        if not token:
            raise XiqError("XIQ api_token is empty")
        self._token = token
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self.rate_limit_remaining: int | None = None
        self.rate_limit_reset: int | None = None

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}

    def _track_rate_limit(self, resp: httpx.Response) -> None:
        rem = resp.headers.get("RateLimit-Remaining")
        rst = resp.headers.get("RateLimit-Reset")
        if rem and rem.isdigit():
            self.rate_limit_remaining = int(rem)
        if rst and rst.isdigit():
            self.rate_limit_reset = int(rst)

    async def _get(self, client: httpx.AsyncClient, path: str, params: dict) -> dict:
        try:
            resp = await client.get(path, params=params, headers=self._headers())
        except httpx.HTTPError as exc:
            raise XiqError(f"XIQ transport error on {path}: {exc}") from exc
        self._track_rate_limit(resp)
        if resp.status_code == 401:
            raise XiqAuthError("XIQ 401 — token revoked or invalid")
        if resp.status_code == 429:
            raise XiqRateLimitError("XIQ 429 — rate limit exceeded")
        if not (200 <= resp.status_code < 300):
            raise XiqError(f"XIQ HTTP {resp.status_code} on {path}: {resp.text[:240]}")
        data = resp.json()
        if isinstance(data, list):
            return {"data": data}
        if not isinstance(data, dict):
            raise XiqError("XIQ returned non-object JSON")
        return data

    async def _get_paged(self, path: str, params: dict) -> list[dict]:
        """Drain a paged list endpoint sequentially.

        Handles both the wrapped ``{data, total_pages}`` and bare-list shapes.
        Sequential is deliberate — the 7,500/hr quota absorbs it and we never
        hammer the tenant with parallel pages.
        """
        rows: list[dict] = []
        async with httpx.AsyncClient(base_url=self._base_url, timeout=self._timeout) as client:
            first = await self._get(client, path, {**params, "page": 1, "limit": PAGE_LIMIT})
            page_rows = first.get("data") if isinstance(first.get("data"), list) else []
            rows.extend(page_rows)
            total_pages = int(first.get("total_pages") or 0)

            if total_pages > 1:
                for page in range(2, min(total_pages, MAX_PAGES) + 1):
                    resp = await self._get(client, path, {**params, "page": page, "limit": PAGE_LIMIT})
                    more = resp.get("data") if isinstance(resp.get("data"), list) else []
                    if not more:
                        break
                    rows.extend(more)
            elif total_pages == 0 and len(page_rows) >= PAGE_LIMIT:
                # No pagination metadata — sequential drain until a short page.
                page = 2
                while page <= MAX_PAGES:
                    resp = await self._get(client, path, {**params, "page": page, "limit": PAGE_LIMIT})
                    more = resp.get("data") if isinstance(resp.get("data"), list) else []
                    if not more:
                        break
                    rows.extend(more)
                    if len(more) < PAGE_LIMIT:
                        break
                    page += 1
        return rows

    async def get_devices(self, view: str = "BASIC") -> list[dict]:
        """Paged fleet device list. ``view="FULL"`` adds the detail fields the
        10.2 cycles persist (heavier pages — 5 min cadence, not 180 s)."""
        return await self._get_paged("/devices", {"views": view})

    async def get_active_clients(self) -> list[dict]:
        """Paged fleet client list (`GET /clients/active?views=FULL`).

        FULL is required for rssi/snr/connection_duration (spec 00 G5); the
        filter param, when scoping, is ``deviceIds`` camelCase (G4) — we sweep
        the whole fleet, so no filter here.
        """
        return await self._get_paged("/clients/active", {"views": "FULL"})

    async def get_network_policies(self) -> list[dict]:
        return await self._get_paged("/network-policies", {})

    async def get_policy_ssids(self, policy_id: int) -> list[dict]:
        """SSIDs of one network policy (`GET /network-policies/{id}/ssids`) —
        the endpoint the reference live-validated (id, name, broadcast_name,
        access_security, enabled)."""
        return await self._get_paged(f"/network-policies/{policy_id}/ssids", {})

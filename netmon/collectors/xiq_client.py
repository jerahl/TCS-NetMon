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
from collections.abc import Sequence

import httpx

log = logging.getLogger("netmon.collectors.xiq")

BASE_URL = "https://api.extremecloudiq.com"
PAGE_LIMIT = 100
MAX_PAGES = 200  # runaway-pagination backstop
HTTP_TIMEOUT = 30.0
#: ``GET /devices/radio-information`` caps ``limit`` at 50 (published schema:
#: "Number of Records, min = 1, max = 50"), unlike the 100 the other list
#: endpoints accept. It is also the id-batch size, since ``deviceIds`` is a
#: required parameter and one page carries one entity per device.
RADIO_PAGE_LIMIT = 50


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

    async def reboot_device(self, xiq_device_id: int) -> tuple[str, int]:
        """POST /devices/:reboot — the ONLY non-GET this client makes.

        Spec 11 D4 (approved 2026-07-28). Kept deliberately narrow: it takes an
        integer device id and builds the path itself, so there is no way to turn
        it into a general-purpose POST. XIQ's endpoint is a bulk action taking a
        list; a single id is sent because the UI acts on one AP at a time.

        Never cached and never retried — a state-changing call that times out
        may well have landed, so a blind retry could reboot an AP twice.

        Returns (message, http_status). Raises XiqError on transport/HTTP error.
        """
        if not isinstance(xiq_device_id, int) or isinstance(xiq_device_id, bool) or xiq_device_id <= 0:
            raise XiqError(f"reboot_device needs a positive int device id, got {xiq_device_id!r}")
        body = {"ids": [xiq_device_id]}
        async with httpx.AsyncClient(base_url=self._base_url, timeout=self._timeout) as client:
            try:
                resp = await client.post("/devices/:reboot", json=body, headers=self._headers())
            except httpx.HTTPError as exc:
                raise XiqError(f"XIQ transport error on /devices/:reboot: {exc}") from exc
        self._track_rate_limit(resp)
        if resp.status_code == 401:
            raise XiqAuthError("XIQ 401 — token revoked or invalid")
        if resp.status_code == 429:
            raise XiqRateLimitError("XIQ 429 — rate limit exceeded")
        if not (200 <= resp.status_code < 300):
            raise XiqError(f"XIQ HTTP {resp.status_code} on /devices/:reboot: {resp.text[:240]}")
        msg = ""
        try:
            data = resp.json()
            if isinstance(data, dict):
                msg = str(data.get("message") or data.get("status") or "")
        except ValueError:
            pass
        return (msg or "reboot accepted", resp.status_code)


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

    async def get_radio_information(
        self, device_ids: Sequence[int], batch: int = RADIO_PAGE_LIMIT
    ) -> list[dict]:
        """Radios of the given devices (`GET /devices/radio-information`).

        Radios are **not** on the device payload — ``XiqDevice`` has no
        ``radios`` property in the published schema, and 0 of 1,364 live
        ``views=FULL`` rows carried one (2026-07-28). They come from here, as
        ``XiqRadioEntity`` rows: ``{"device_id": int, "radios": [XiqRadio…]}``.

        ``deviceIds`` is a **required** repeated query parameter — there is no
        fleet-wide form — and ``limit`` caps at 50, so the ids are batched 50 at
        a time and any pages within a batch are drained. Sequential on one
        connection, like :meth:`_get_paged`: the tenant quota is shared with
        every other integration, so we never fan out in parallel.

        Radios XIQ reports as *disabled* are omitted (``includeDisabledRadio``
        defaults to false and is left there deliberately): ``XiqRadio`` has no
        enabled flag, so a disabled radio would be indistinguishable from one on
        the air. On this fleet 2.4 GHz is disabled almost everywhere, and
        listing those radios with a channel and a power level would read as
        "broadcasting" — a fabrication (§4.5). Absent is the honest answer.
        """
        ids = [int(i) for i in device_ids]
        if not ids:
            return []
        batch = max(1, min(int(batch), RADIO_PAGE_LIMIT))
        rows: list[dict] = []
        async with httpx.AsyncClient(base_url=self._base_url, timeout=self._timeout) as client:
            for start in range(0, len(ids), batch):
                chunk = ids[start:start + batch]
                page = 1
                while page <= MAX_PAGES:
                    resp = await self._get(
                        client, "/devices/radio-information",
                        {"deviceIds": chunk, "page": page, "limit": batch},
                    )
                    more = resp.get("data") if isinstance(resp.get("data"), list) else []
                    rows.extend(more)
                    total_pages = int(resp.get("total_pages") or 1)
                    if not more or page >= total_pages:
                        break
                    page += 1
        return rows

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

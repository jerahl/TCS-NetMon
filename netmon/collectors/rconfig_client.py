"""rConfig client — async httpx port of the reference RConfigClient.php.

Read-only. HTTPS only. Auth header is `apitoken: <token>` (NOT Bearer).
Paginated device list; each row carries a last-backup timestamp used for the
freshness dimension.
"""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger("netmon.collectors.rconfig")

TIMEOUT = 30.0
PER_PAGE = 100
MAX_PAGES = 20  # 2000-device ceiling, per the reference


class RConfigError(Exception):
    pass


class RConfigClient:
    def __init__(self, url: str, token: str, verify_ssl: bool = True, timeout: float = TIMEOUT) -> None:
        if not url.lower().startswith("https://"):
            raise RConfigError("rConfig url must be https://")
        if not token:
            raise RConfigError("rConfig api_token is required")
        self._url = url.rstrip("/")
        self._token = token
        self._verify = verify_ssl
        self._timeout = timeout

    async def devices(self) -> list[dict]:
        """Drain the paged device list (`GET /api/v2/devices`)."""
        rows: list[dict] = []
        headers = {"apitoken": self._token, "Accept": "application/json"}
        async with httpx.AsyncClient(base_url=self._url, timeout=self._timeout, verify=self._verify) as client:
            for page in range(1, MAX_PAGES + 1):
                try:
                    resp = await client.get("/api/v2/devices",
                                            params={"per_page": PER_PAGE, "page": page},
                                            headers=headers)
                except httpx.HTTPError as exc:
                    raise RConfigError(f"rConfig transport error: {exc}") from exc
                if resp.status_code >= 400:
                    raise RConfigError(f"rConfig HTTP {resp.status_code} on /api/v2/devices")
                data = resp.json() or {}
                # rConfig v2 wraps the list under data / devices; accept a bare list too.
                page_rows = data.get("data") or data.get("devices") or (data if isinstance(data, list) else [])
                if not isinstance(page_rows, list) or not page_rows:
                    break
                rows.extend(page_rows)
                if len(page_rows) < PER_PAGE:
                    break
        return rows

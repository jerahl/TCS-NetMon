"""3CX v20 REST client — async httpx port of the reference ThreeCXClient.php.

Read-only. OAuth2 client-credentials token (cached to expiry, refreshed on 401),
then bearer to the `/xapi/v1` OData endpoints. REST, not ODBC (Phase 0 decision).
"""

from __future__ import annotations

import logging
import time

import httpx

log = logging.getLogger("netmon.collectors.threecx")

TIMEOUT = 30.0


class ThreeCxError(Exception):
    pass


class ThreeCxAuthError(ThreeCxError):
    pass


class ThreeCxClient:
    def __init__(self, url: str, client_id: str, client_secret: str,
                 verify_ssl: bool = True, timeout: float = TIMEOUT) -> None:
        if not url:
            raise ThreeCxError("3CX url is empty")
        self._url = url.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._verify = verify_ssl
        self._timeout = timeout
        self._token: str | None = None
        self._token_expiry = 0.0

    async def _get_token(self, client: httpx.AsyncClient, force: bool = False) -> str:
        if not force and self._token and time.monotonic() < self._token_expiry:
            return self._token
        form = {
            "grant_type": "client_credentials",
            "client_id": self._client_id,
            "client_secret": self._client_secret,
        }
        try:
            resp = await client.post("/connect/token", data=form)
        except httpx.HTTPError as exc:
            raise ThreeCxError(f"3CX token transport error: {exc}") from exc
        if resp.status_code >= 400:
            raise ThreeCxAuthError(f"3CX /connect/token HTTP {resp.status_code}")
        j = resp.json() or {}
        tok = j.get("access_token")
        if not tok:
            raise ThreeCxAuthError("3CX token response had no access_token")
        self._token = tok
        ttl = max(60, int(j.get("expires_in", 3600)) - 30)
        self._token_expiry = time.monotonic() + ttl
        return tok

    async def _get(self, client: httpx.AsyncClient, path: str) -> dict:
        for attempt in (1, 2):
            token = await self._get_token(client, force=(attempt == 2))
            try:
                resp = await client.get(path, headers={"Authorization": f"Bearer {token}",
                                                        "Accept": "application/json"})
            except httpx.HTTPError as exc:
                raise ThreeCxError(f"3CX transport error on {path}: {exc}") from exc
            if resp.status_code == 401 and attempt == 1:
                continue
            if resp.status_code >= 400:
                raise ThreeCxError(f"3CX HTTP {resp.status_code} on {path}")
            return resp.json() or {}
        raise ThreeCxAuthError("3CX auth failed after refresh")

    async def _mkclient(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self._url, timeout=self._timeout, verify=self._verify)

    async def trunks(self) -> list[dict]:
        async with await self._mkclient() as client:
            data = await self._get(client, "/xapi/v1/Trunks")
        rows = data.get("value")
        return rows if isinstance(rows, list) else []

    async def system_status(self) -> dict:
        async with await self._mkclient() as client:
            return await self._get(client, "/xapi/v1/SystemStatus")

    async def extensions(self) -> list[dict]:
        """3CX v20 users/extensions (`GET /xapi/v1/Users`). The OData surface
        wraps rows in ``value``. Field coverage varies by v20 build — spec 10
        §10 Q4 (verify on the live PBX); parsers are defensive."""
        async with await self._mkclient() as client:
            data = await self._get(client, "/xapi/v1/Users")
        rows = data.get("value")
        return rows if isinstance(rows, list) else []

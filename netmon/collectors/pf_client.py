"""PacketFence v1 REST client — async httpx port of the reference PFClient.php.

Read-only. Token login with one auto-refresh on 401. PF answers 404 (not
200+empty) when a /search matches nothing — treated as empty. Token is sent
RAW in the Authorization header (no "Bearer " prefix), per the reference.
"""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger("netmon.collectors.packetfence")

TIMEOUT = 30.0


class PfError(Exception):
    pass


class PfAuthError(PfError):
    pass


class PfClient:
    def __init__(self, url: str, user: str, password: str, verify_ssl: bool = True,
                 timeout: float = TIMEOUT) -> None:
        if not url:
            raise PfError("PacketFence url is empty")
        self._url = url.rstrip("/")
        self._user = user
        self._password = password
        self._verify = verify_ssl
        self._timeout = timeout
        self._token: str | None = None

    async def _login(self, client: httpx.AsyncClient) -> None:
        try:
            resp = await client.post("/api/v1/login", json={"username": self._user, "password": self._password})
        except httpx.HTTPError as exc:
            raise PfError(f"PF login transport error: {exc}") from exc
        if resp.status_code >= 400:
            raise PfAuthError(f"PF login failed (HTTP {resp.status_code})")
        token = (resp.json() or {}).get("token")
        if not token:
            raise PfAuthError("PF login returned no token")
        self._token = token

    async def _call(self, client: httpx.AsyncClient, method: str, path: str, body: dict | None) -> dict:
        if self._token is None:
            await self._login(client)
        for attempt in (1, 2):
            headers = {"Authorization": self._token or "", "Accept": "application/json"}
            try:
                resp = await client.request(method, path, json=body, headers=headers)
            except httpx.HTTPError as exc:
                raise PfError(f"PF transport error on {path}: {exc}") from exc
            if resp.status_code == 401 and attempt == 1:
                self._token = None
                await self._login(client)
                continue
            if resp.status_code == 404:
                return {}  # PF's empty-result sentinel
            if resp.status_code >= 400:
                raise PfError(f"PF HTTP {resp.status_code} on {path}")
            return resp.json() or {}
        raise PfAuthError("PF auth failed after refresh")

    async def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self._url, timeout=self._timeout, verify=self._verify)

    async def nodes(self, limit: int = 1000) -> list[dict]:
        """A page of nodes with the fields the NAC summary needs."""
        body = {
            "cursor": 0, "limit": max(1, limit), "sort": ["mac ASC"],
            "fields": ["mac", "computername", "status", "category_id", "device_class", "ip4log.ip", "last_seen"],
            "query": {"op": "not_equals", "field": "mac", "value": ""},
        }
        async with await self._client() as client:
            data = await self._call(client, "POST", "/api/v1/nodes/search", body)
        items = data.get("items")
        return items if isinstance(items, list) else []

    async def recent_auth_failures(self, limit: int = 25) -> list[dict]:
        body = {
            "cursor": 0, "limit": max(1, limit), "sort": ["created_at DESC"],
            "fields": ["mac", "user_name", "nas_ip_address", "nas_port_id", "reason", "created_at"],
            "query": {"op": "equals", "field": "auth_status", "value": "reject"},
        }
        async with await self._client() as client:
            data = await self._call(client, "POST", "/api/v1/radius_audit_logs/search", body)
        items = data.get("items")
        return items if isinstance(items, list) else []

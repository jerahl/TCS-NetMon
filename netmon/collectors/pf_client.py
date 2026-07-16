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

    MAX_PAGES = 50  # runaway-cursor backstop (50 × 1,000 rows)

    async def _search_all(self, client: httpx.AsyncClient, path: str, body: dict) -> list[dict]:
        """Drain a cursor-paged PF /search endpoint."""
        rows: list[dict] = []
        cursor: int | str = 0
        for _ in range(self.MAX_PAGES):
            data = await self._call(client, "POST", path, {**body, "cursor": cursor})
            items = data.get("items")
            if not isinstance(items, list) or not items:
                break
            rows.extend(items)
            nxt = data.get("nextCursor")
            if nxt in (None, "", cursor) or len(items) < int(body.get("limit") or 1000):
                break
            cursor = nxt
        return rows

    async def nodes(self, limit: int = 1000) -> list[dict]:
        """The whole node inventory (cursor-paged), with the identity fields
        the pf_nodes table persists (reference PFClient field list)."""
        body = {
            "limit": max(1, limit), "sort": ["mac ASC"],
            "fields": ["mac", "pid", "computername", "status", "category_id",
                       "device_class", "device_type", "device_manufacturer",
                       "dhcp_fingerprint", "ip4log.ip", "last_seen"],
            "query": {"op": "not_equals", "field": "mac", "value": ""},
        }
        async with await self._client() as client:
            return await self._search_all(client, "/api/v1/nodes/search", body)

    async def node_categories(self) -> dict[str, str]:
        """category_id → role name (nodes carry only the numeric id)."""
        async with await self._client() as client:
            data = await self._call(client, "GET", "/api/v1/node_categories?limit=500", None)
        out: dict[str, str] = {}
        for r in data.get("items") or []:
            cid = str(r.get("category_id") or r.get("id") or "")
            name = str(r.get("name") or "")
            if cid and name:
                out[cid] = name
        return out

    async def open_locationlogs(self, limit: int = 1000) -> list[dict]:
        """Open sessions (end_time sentinel) — the current switch/port/ssid/
        auth per MAC that /nodes doesn't carry (reference clientsForNode)."""
        body = {
            "limit": max(1, limit), "sort": ["start_time DESC"],
            "fields": ["mac", "switch", "switch_ip", "port", "vlan", "role",
                       "ssid", "connection_type", "connection_sub_type",
                       "dot1x_username", "ifDesc", "start_time"],
            "query": {"op": "equals", "field": "end_time", "value": "0000-00-00 00:00:00"},
        }
        async with await self._client() as client:
            return await self._search_all(client, "/api/v1/locationlogs/search", body)

    async def get_json(self, path: str) -> dict:
        """One read-only GET (snapshot_cache fetchers — cluster/services/
        queues/config). PF's 404-means-empty applies."""
        async with await self._client() as client:
            return await self._call(client, "GET", path, None)

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

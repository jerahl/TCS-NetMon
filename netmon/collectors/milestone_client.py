"""Milestone XProtect API Gateway client — async httpx port of the reference
`milestone_rs_state.py`.

Read-only Config/REST API. OAuth2 password grant → bearer token. Used by the
polling collector for recording-server + camera state; the live Events/State
WebSocket is a separate resilient task (collectors/ws.py).
"""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger("netmon.collectors.milestone")

TIMEOUT = 30.0


class MilestoneError(Exception):
    pass


class MilestoneAuthError(MilestoneError):
    pass


def _items(resp: dict) -> list[dict]:
    """Milestone collections wrap in {array:[...]} or {data:[...]}; be lenient."""
    for key in ("array", "data"):
        v = resp.get(key)
        if isinstance(v, list):
            return v
    return resp if isinstance(resp, list) else []


class MilestoneClient:
    def __init__(self, host: str, user: str, password: str, *, scheme: str = "https",
                 client_id: str = "GrantValidatorClient", verify_ssl: bool = True,
                 timeout: float = TIMEOUT) -> None:
        if not host:
            raise MilestoneError("Milestone host is empty")
        self._base = f"{scheme}://{host}"
        self._user = user
        self._password = password
        self._client_id = client_id
        self._verify = verify_ssl
        self._timeout = timeout
        self._token: str | None = None

    async def _get_token(self, client: httpx.AsyncClient) -> None:
        form = {
            "grant_type": "password",
            "username": self._user,
            "password": self._password,
            "client_id": self._client_id,
        }
        try:
            resp = await client.post("/IDP/connect/token", data=form)
        except httpx.HTTPError as exc:
            raise MilestoneError(f"Milestone IDP transport error: {exc}") from exc
        if resp.status_code >= 400:
            raise MilestoneAuthError(f"Milestone IDP failed (HTTP {resp.status_code})")
        tok = (resp.json() or {}).get("access_token")
        if not tok:
            raise MilestoneAuthError("Milestone IDP returned no access_token")
        self._token = tok

    async def _get(self, client: httpx.AsyncClient, path: str) -> dict:
        if self._token is None:
            await self._get_token(client)
        for attempt in (1, 2):
            headers = {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}
            try:
                resp = await client.get(path, headers=headers)
            except httpx.HTTPError as exc:
                raise MilestoneError(f"Milestone transport error on {path}: {exc}") from exc
            if resp.status_code == 401 and attempt == 1:
                self._token = None
                await self._get_token(client)
                continue
            if resp.status_code >= 400:
                raise MilestoneError(f"Milestone HTTP {resp.status_code} on {path}")
            return resp.json() or {}
        raise MilestoneAuthError("Milestone auth failed after refresh")

    async def _mkclient(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self._base, timeout=self._timeout, verify=self._verify)

    async def recording_servers(self) -> list[dict]:
        async with await self._mkclient() as client:
            data = await self._get(client, "/api/rest/v1/recordingServers")
        return _items(data)

    async def cameras(self) -> list[dict]:
        async with await self._mkclient() as client:
            data = await self._get(client, "/api/rest/v1/cameras")
        return _items(data)

    async def storage(self) -> list[dict]:
        """Storage volumes per recording server (Config API). 404/absent →
        empty (older XProtect versions lack this endpoint)."""
        async with await self._mkclient() as client:
            data = await self._get(client, "/api/rest/v1/storages")
        return _items(data)

    async def hardware(self) -> list[dict]:
        """Hardware (cameras' physical device) → model + network address that
        the /cameras entities reference by hardwareId."""
        async with await self._mkclient() as client:
            data = await self._get(client, "/api/rest/v1/hardware")
        return _items(data)

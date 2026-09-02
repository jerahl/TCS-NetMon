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
# The hardware tree is ~2,500 records on this deployment and the 30s default
# reliably timed out against the live gateway (measured 2026-07-28; 180s
# succeeded). Scoped to that one call so every other failure stays fast.
HARDWARE_TIMEOUT = 180.0


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

    async def bearer_token(self) -> str:
        """Fetch a bearer token for a caller that is not using ``_get``.

        The Events/State WebSocket authenticates with the same OAuth grant but
        cannot go through ``_get`` — it needs the raw token for a connection
        header. Kept here so the credential handling lives in exactly one place
        and ``ws_milestone`` never touches the password.
        """
        async with await self._mkclient() as client:
            await self._get_token(client)
        if not self._token:  # pragma: no cover — _get_token raises instead
            raise MilestoneAuthError("Milestone IDP returned no access_token")
        return self._token

    @property
    def base_url(self) -> str:
        """``scheme://host`` — the WebSocket URL is derived from this."""
        return self._base

    @property
    def verify_ssl(self) -> bool:
        return self._verify

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

    async def storage(self, recording_server_ids: list[str] | None = None) -> list[dict]:
        """Storage volumes per recording server, with their archives.

        **There is no ``GET /storages`` collection endpoint.** It answers HTTP
        400 on this deployment, and that is not a version quirk to fail soft
        around — the collection simply does not exist in the Config API. Only
        ``/storages/{id}``, ``/storages/{id}/archiveStorages`` and
        ``/recordingServers/{id}/storages`` do. NetMon called the collection for
        months, caught the 400, and reported a clean cycle over an empty storage
        roll-up (spec 14 D-5; found by scripts/validate_payloads.py 2026-07-28).

        So the walk is per recording server: one call each, plus one per live
        storage for its archives. On this estate that is 22 + 22 = 44 GETs.

        Each returned row is a live storage annotated with ``archives`` and the
        recording server it belongs to, so the caller can roll up without
        re-deriving the parentage.
        """
        ids = recording_server_ids
        async with await self._mkclient() as client:
            if ids is None:
                ids = [str(r.get("id")) for r in
                       _items(await self._get(client, "/api/rest/v1/recordingServers"))
                       if r.get("id")]
            out: list[dict] = []
            for rid in ids:
                stores = _items(await self._get(
                    client, f"/api/rest/v1/recordingServers/{rid}/storages"))
                for st in stores:
                    sid = str(st.get("id") or "")
                    st["recordingServerId"] = rid
                    st["archives"] = _items(await self._get(
                        client, f"/api/rest/v1/storages/{sid}/archiveStorages")) if sid else []
                    out.append(st)
        return out

    async def hardware(self) -> list[dict]:
        """Hardware (a camera's physical host) → model, MAC and network address.

        Cameras link to hardware through ``camera.relations.parent``, **not** a
        ``hardwareId`` field — ``/cameras`` does not return one (confirmed live
        2026-07-28; the previous docstring asserted otherwise and the collector's
        lookup was built on it, which is why ``cameras.ip`` was always NULL).

        Uses a longer timeout than the other calls: this is ~2,500 records and
        the default 30s reliably hit ``httpx.ReadTimeout`` on the live gateway.
        The short default stays everywhere else so an ordinary failure is still
        fast.
        """
        async with httpx.AsyncClient(base_url=self._base, timeout=HARDWARE_TIMEOUT,
                                     verify=self._verify) as client:
            data = await self._get(client, "/api/rest/v1/hardware")
        return _items(data)

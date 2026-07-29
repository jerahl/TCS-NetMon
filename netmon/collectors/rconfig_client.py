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

    async def resolve_device_id(self, *, mgmt_ip: str = "", name: str = "") -> int | None:
        """Find rConfig's device id for a switch, by IP first then name.

        NetMon's registry carries no ``rconfig_device_id`` for any device
        (verified 2026-07-29: 0 of 3,626), so the PoE-cycle action cannot look
        one up — it resolves at action time the way the ZCD reference did.
        IP is tried first because it is unambiguous; the name match is a
        case-insensitive exact compare, never a prefix, so "BHS-1" cannot
        accidentally resolve to "BHS-12".
        """
        ip = (mgmt_ip or "").strip()
        want = (name or "").strip().lower()
        rows = await self.devices()
        if ip:
            for d in rows:
                if str(d.get("device_ip") or "").strip() == ip:
                    did = d.get("id") or d.get("cm_device_id")
                    if did is not None:
                        return int(did)
        if want:
            for d in rows:
                if str(d.get("device_name") or d.get("name") or "").strip().lower() == want:
                    did = d.get("id") or d.get("cm_device_id")
                    if did is not None:
                        return int(did)
        return None

    async def deploy_snippet(self, device_id: int, snippet_id: int,
                             dynamic_vars: dict[str, str]) -> tuple[str, int]:
        """POST /api/v1/snippets/<id>/deploy — the only write this client makes.

        Spec 11 D4 (approved 2026-07-28). This runs a **stored** snippet that
        the operator authored in rConfig; NetMon never sends CLI text, only a
        snippet id and variable substitutions. That is the whole safety model:
        the commands live in rConfig where they are reviewable, and the blast
        radius is whatever that snippet does.

        Ids are validated as positive ints so neither can carry a path fragment.
        Never retried — a deploy that timed out may have run.
        """
        if not isinstance(device_id, int) or isinstance(device_id, bool) or device_id <= 0:
            raise RConfigError(f"deploy_snippet needs a positive device id, got {device_id!r}")
        if not isinstance(snippet_id, int) or isinstance(snippet_id, bool) or snippet_id <= 0:
            raise RConfigError(f"deploy_snippet needs a positive snippet id, got {snippet_id!r}")
        headers = {"apitoken": self._token, "Accept": "application/json"}
        body = {"devices": [device_id], "dynamicVariables": dynamic_vars or {}}
        async with httpx.AsyncClient(base_url=self._url, timeout=self._timeout,
                                     verify=self._verify) as client:
            try:
                resp = await client.post(f"/api/v1/snippets/{snippet_id}/deploy",
                                         json=body, headers=headers)
            except httpx.HTTPError as exc:
                raise RConfigError(f"rConfig transport error on snippet deploy: {exc}") from exc
        if resp.status_code >= 400:
            raise RConfigError(
                f"rConfig HTTP {resp.status_code} deploying snippet {snippet_id}: {resp.text[:240]}")
        msg = ""
        try:
            data = resp.json() or {}
            if isinstance(data, dict):
                msg = str(data.get("message") or data.get("status") or "")
        except ValueError:
            pass
        return (msg or "snippet deployed", resp.status_code)

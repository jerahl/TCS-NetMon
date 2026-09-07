#!/usr/bin/env python3
"""
milestone_ess_state.py
----------------------
One-shot fetcher for Milestone XProtect per-camera state via the
Events and State WebSocket API (ESS).

Protocol reference:
  https://doc.developer.milestonesys.com/mipvmsapi/api/events-ws/v1/

Flow:
  1. POST /API/IDP/connect/token -> bearer token
  2. WSS /api/ws/events/v1 with Authorization: Bearer ...
  3. startSession       (empty sessionId, eventId => creates a new session)
  4. addSubscription    (resourceTypes=["cameras"], sourceIds=["*"], eventTypes=["*"])
  5. getState           (snapshot of all current stateful events for the subscription)
  6. close

Output modes:
  (default)
      JSON keyed by camera GUID with per-camera state list:
        {"count": N,
         "cameras": {"<guid>": {"states": [...], "by_group": {"<group>": {...}}}}}

  --list-stategroups
      Diagnostic: unique (stategroupid, type) pairs with cameras-per-pair.
      Run once to figure out which GUIDs mean "Communication OK",
      "Recording Started", "Motion", etc. in your install.

Usage:
  milestone_ess_state.py <host> <username> <password>
                        [--scheme https] [--verify-tls]
                        [--timeout 60] [--client-id GrantValidatorClient]
                        [--idp-path /API/IDP/connect/token]
                        [--ws-path /api/ws/events/v1]
                        [--list-stategroups]

Exit codes:
  0  success (JSON on stdout)
  2  authentication failure
  3  websocket / protocol error
  4  timeout
  1  other error

Requires: python3.8+, websockets>=11, aiohttp>=3.8
Install:  pip3 install 'websockets>=11' 'aiohttp>=3.8'
"""

from __future__ import annotations

import argparse
import asyncio
import json
import ssl
import sys
from collections import defaultdict
from typing import Any

try:
    import aiohttp
    import websockets
except ImportError as e:
    print(json.dumps({"error": "missing_dependency", "detail": str(e),
                      "hint": "pip3 install 'websockets>=11' 'aiohttp>=3.8'"}),
          file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# OAuth token
# ---------------------------------------------------------------------------
async def get_access_token(
    session: aiohttp.ClientSession,
    base_url: str,
    idp_path: str,
    username: str,
    password: str,
    client_id: str,
) -> str:
    url = base_url + idp_path
    data = {
        "grant_type": "password",
        "client_id": client_id,
        "username": username,
        "password": password,
    }
    async with session.post(
        url, data=data, headers={"Accept": "application/json"},
    ) as resp:
        body = await resp.text()
        if resp.status != 200:
            raise RuntimeError(f"IDP HTTP {resp.status}: {body[:500]}")
        payload = json.loads(body)
        token = payload.get("access_token")
        if not token:
            raise RuntimeError(f"IDP response missing access_token: {body[:500]}")
        return token


# ---------------------------------------------------------------------------
# ESS WebSocket protocol helpers
# ---------------------------------------------------------------------------
class CommandIdGen:
    """Monotonically increasing commandId per the ESS spec."""
    def __init__(self) -> None:
        self._n = 0

    def next(self) -> int:
        self._n += 1
        return self._n


async def _send_command(ws, message: dict, timeout: float) -> dict:
    """Send a command and wait for the matching response by commandId.

    The server may push unsolicited event messages between request and
    response; we discard those and keep reading until we see our commandId.
    """
    await ws.send(json.dumps(message))
    want = message["commandId"]
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        try:
            reply = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if reply.get("commandId") == want:
            return reply


async def fetch_state(
    host: str,
    username: str,
    password: str,
    scheme: str,
    verify_tls: bool,
    timeout: float,
    client_id: str,
    idp_path: str,
    ws_path: str,
) -> dict:
    base_url = f"{scheme}://{host}"
    ws_scheme = "wss" if scheme == "https" else "ws"
    ws_url = f"{ws_scheme}://{host}{ws_path}"

    if scheme == "https":
        ssl_ctx: ssl.SSLContext | None = ssl.create_default_context()
        if not verify_tls:
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE
    else:
        ssl_ctx = None

    # Step 1: OAuth token.
    aio_connector = aiohttp.TCPConnector(ssl=ssl_ctx if scheme == "https" else None)
    async with aiohttp.ClientSession(connector=aio_connector) as http_sess:
        token = await asyncio.wait_for(
            get_access_token(http_sess, base_url, idp_path,
                             username, password, client_id),
            timeout=timeout,
        )

    # Step 2: WSS. websockets 11+ renamed extra_headers -> additional_headers.
    # Support both so either install works.
    #
    # ping_interval=None disables the built-in keepalive ping. We need this
    # because at 2500+ cameras, getState can take longer than the default
    # 20-second ping interval to produce its first byte, which would trigger
    # a "keepalive ping timeout" and kill the connection mid-operation.
    # This is a short-lived one-shot connection, so heartbeats serve no
    # purpose here.
    ws_kwargs: dict[str, Any] = {
        "ssl": ssl_ctx if scheme == "https" else None,
        "open_timeout": timeout,
        "close_timeout": 5,
        "ping_interval": None,
        "ping_timeout": None,
        "max_size": 128 * 1024 * 1024,  # 128 MB — plenty for 2500 cameras
    }
    headers = {"Authorization": f"Bearer {token}"}
    try:
        ctx = websockets.connect(ws_url, additional_headers=headers, **ws_kwargs)
    except TypeError:
        ctx = websockets.connect(ws_url, extra_headers=headers, **ws_kwargs)

    async with ctx as ws:
        cid = CommandIdGen()

        # Start a fresh session.
        start = await _send_command(ws, {
            "command": "startSession",
            "commandId": cid.next(),
            "sessionId": "",
            "eventId": "",
        }, timeout=timeout)
        if start.get("status") not in (200, 201):
            raise RuntimeError(f"startSession failed: {start}")

        # Subscribe to every event type on every camera.
        sub = await _send_command(ws, {
            "command": "addSubscription",
            "commandId": cid.next(),
            "filters": [{
                "modifier": "include",
                "resourceTypes": ["cameras"],
                "sourceIds": ["*"],
                "eventTypes": ["*"],
            }],
        }, timeout=timeout)
        if sub.get("status") != 200:
            raise RuntimeError(f"addSubscription failed: {sub}")

        # Snapshot.
        state_resp = await _send_command(ws, {
            "command": "getState",
            "commandId": cid.next(),
        }, timeout=timeout)
        if state_resp.get("status") != 200:
            raise RuntimeError(f"getState failed: {state_resp}")

        return state_resp


# ---------------------------------------------------------------------------
# Normalization
#
# getState response shape (per spec):
#   {
#     "commandId": 3, "status": 200,
#     "states": [
#       {
#         "specVersion": "1.0",
#         "type": "<event-type-guid>",
#         "source": "cameras/<camera-guid>",
#         "time": "2026-04-24T13:41:38.1234567Z",
#         "stategroupid": "<state-group-guid>"
#       },
#       ...
#     ]
#   }
# ---------------------------------------------------------------------------
def pivot_by_camera(state_resp: dict) -> dict[str, dict]:
    """Group raw states by camera GUID parsed from the 'source' field."""
    out: dict[str, dict] = {}
    for s in state_resp.get("states", []):
        source = s.get("source", "")
        if "/" not in source:
            continue
        resource_type, _, guid = source.partition("/")
        if resource_type.lower() != "cameras" or not guid:
            continue
        entry = out.setdefault(guid, {"states": [], "by_group": {}})
        entry["states"].append(s)
        grp = s.get("stategroupid")
        if grp:
            # If multiple states in the same group, last-write-wins.
            entry["by_group"][grp] = {
                "type": s.get("type"),
                "time": s.get("time"),
            }
    return out


def list_stategroups(state_resp: dict) -> dict:
    """Diagnostic: count cameras per (stategroupid, type) pair."""
    counter: dict[tuple[str, str], int] = defaultdict(int)
    for s in state_resp.get("states", []):
        grp = s.get("stategroupid") or ""
        typ = s.get("type") or ""
        counter[(grp, typ)] += 1
    rows = [
        {"stategroupid": grp, "type": typ, "cameras": n}
        for (grp, typ), n in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    return {
        "total_states": len(state_resp.get("states", [])),
        "unique_pairs": len(rows),
        "pairs": rows,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("host",
                    help="API Gateway host (no scheme), e.g. milestone.example.com")
    ap.add_argument("username")
    ap.add_argument("password")
    ap.add_argument("--scheme", default="https", choices=("http", "https"))
    ap.add_argument("--verify-tls", action="store_true",
                    help="Enforce TLS cert validation (default: off)")
    ap.add_argument("--timeout", type=float, default=180.0,
                    help="Per-operation timeout in seconds (default: 180). "
                         "getState on large installs (2000+ cameras) can "
                         "take 1-2 minutes to produce its response; raise "
                         "further if you still hit timeouts.")
    ap.add_argument("--client-id", default="GrantValidatorClient")
    ap.add_argument("--idp-path", default="/API/IDP/connect/token",
                    help="IDP token endpoint path. Default /API/IDP/connect/token; "
                         "older installs may use /IDP/connect/token")
    ap.add_argument("--ws-path", default="/api/ws/events/v1",
                    help="ESS WebSocket path (default: /api/ws/events/v1)")
    ap.add_argument("--list-stategroups", action="store_true",
                    help="Print unique (stategroupid,type) pairs for one-time "
                         "mapping of GUIDs to human meanings")
    args = ap.parse_args()

    try:
        state_resp = asyncio.run(fetch_state(
            host=args.host,
            username=args.username,
            password=args.password,
            scheme=args.scheme,
            verify_tls=args.verify_tls,
            timeout=args.timeout,
            client_id=args.client_id,
            idp_path=args.idp_path,
            ws_path=args.ws_path,
        ))
    except asyncio.TimeoutError:
        print(json.dumps({"error": "timeout"}), file=sys.stderr)
        return 4
    except aiohttp.ClientError as e:
        print(json.dumps({"error": "http_error", "detail": repr(e)}),
              file=sys.stderr)
        return 3
    except RuntimeError as e:
        msg = str(e)
        if "IDP HTTP 400" in msg or "invalid_username_or_password" in msg \
                or "LockedOut" in msg or "IDP HTTP 401" in msg:
            print(json.dumps({"error": "auth_failed", "detail": msg}),
                  file=sys.stderr)
            return 2
        print(json.dumps({"error": "protocol_error", "detail": msg}),
              file=sys.stderr)
        return 3
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "unexpected", "detail": repr(e)}),
              file=sys.stderr)
        return 1

    if args.list_stategroups:
        out = list_stategroups(state_resp)
    else:
        pivoted = pivot_by_camera(state_resp)
        out = {"count": len(pivoted), "cameras": pivoted}

    sys.stdout.write(json.dumps(out, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

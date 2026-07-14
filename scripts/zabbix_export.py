#!/usr/bin/env python3
"""Pull sites / host groups / hosts from Zabbix 7.4 via the JSON-RPC API.

This is a **Phase 0 reconnaissance** helper (CLAUDE.md §7): it reads the
retiring Zabbix server and writes a JSON export that ``netmon-seed --sites``
consumes to assign each device its ``site`` — the same source of truth the
retiring add-on uses (a host's membership of a ``Site/<name>`` host group, per
``reference/actions/ActionGlobalData.php::buildSites``).

Read-only (CLAUDE.md §4.1): the only API calls are ``apiinfo.version``,
``user.login``/``user.logout`` (when a username/password is used instead of a
token), ``hostgroup.get`` and ``host.get``. Nothing is written to Zabbix.

Stdlib only — no ``netmon`` import, no third-party dependency — so it runs on
the Zabbix box or a jump host without installing the app. Auth for Zabbix 7.4
is the ``Authorization: Bearer`` header (the request-body ``auth`` field was
removed in 7.2); an API token is used verbatim, a username/password is
exchanged for a short-lived session token via ``user.login``.

Usage::

    # API token (preferred — create one in Zabbix: Users > API tokens):
    export ZABBIX_URL=https://zabbix.tcs.k12.al.us
    export ZABBIX_TOKEN=xxxxxxxx...
    python scripts/zabbix_export.py --out zbx_sites.json

    # or username/password:
    python scripts/zabbix_export.py --url https://zabbix... \
        --user monitoring-ro --password - --out zbx_sites.json

    # host groups only (site/domain group inventory):
    python scripts/zabbix_export.py --format groups

Connection settings may also live in a ``[zabbix]`` section of the NetMon
config (``--config PATH`` or ``$NETMON_CONF``); CLI flags and env vars win.

The default ``sites`` output is a ``host.get`` + ``selectHostGroups`` dump —
``{"result": [{"host", "name", "mgmt_ip", "hostgroups": [...], ...}]}`` — which
feeds straight into ``netmon-seed --sites`` and mirrors
``tests/fixtures/zbx_sites.json``.

**Do not commit real output** (real hostnames / IPs are not fixtures —
CLAUDE.md §4.6). Sanitize before adding anything under ``tests/fixtures/``.
"""

from __future__ import annotations

import argparse
import configparser
import getpass
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Site group prefix — mirrors the reference add-on's {$TCS.SITE.GROUP.PREFIX}
# macro (ActionGlobalData::SITE_GROUP_PREFIX) and netmon.seed.SITE_GROUP_PREFIX.
DEFAULT_SITE_PREFIX = "Site/"

# Zabbix interface types (host.get selectInterfaces "type"). SNMP is the
# management interface for switches/APs; agent is next best.
_IFACE_PRIORITY = {"2": 0, "1": 1, "3": 2, "4": 3}  # SNMP, agent, IPMI, JMX


class ZabbixError(RuntimeError):
    """A Zabbix API call failed loud (CLAUDE.md §4.5) — never swallowed."""


# --------------------------------------------------------------------------- #
# Pure transforms (no network / no I/O) — unit-tested directly.
# --------------------------------------------------------------------------- #

def derive_site(hostgroups: list[dict[str, Any]], prefix: str = DEFAULT_SITE_PREFIX) -> str | None:
    """Return the site name for a host from its groups, or ``None``.

    The first group whose name starts with ``prefix`` wins; the site is that
    name minus the prefix. Matches ``netmon.seed.build_site_index`` and the
    reference ``buildSites`` behaviour.
    """
    for g in hostgroups or []:
        name = g.get("name") if isinstance(g, dict) else str(g)
        if name and name.startswith(prefix):
            site = name[len(prefix):].strip()
            if site:
                return site
    return None


def main_ip(interfaces: list[dict[str, Any]]) -> str | None:
    """Pick a host's management IP from its ``selectInterfaces`` list.

    Prefer a ``main`` interface, then by type (SNMP > agent > IPMI > JMX); fall
    back to the first interface carrying an IP. Returns ``None`` if none do.
    """
    candidates = [i for i in (interfaces or []) if str(i.get("ip") or "").strip()]
    if not candidates:
        return None

    def rank(iface: dict[str, Any]) -> tuple[int, int]:
        is_main = 0 if str(iface.get("main")) == "1" else 1
        type_rank = _IFACE_PRIORITY.get(str(iface.get("type")), 9)
        return (is_main, type_rank)

    return str(min(candidates, key=rank)["ip"]).strip()


def build_export(
    hosts: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    *,
    version: str,
    prefix: str = DEFAULT_SITE_PREFIX,
) -> dict[str, Any]:
    """Shape ``host.get`` / ``hostgroup.get`` results into the seed export.

    Top-level ``result`` is the host list (seed-compatible: each row keeps
    ``host`` + ``hostgroups``, plus derived ``site`` / ``mgmt_ip`` convenience
    fields). ``_meta`` carries counts and the discovered site list for humans;
    ``netmon.seed.load_site_index`` reads only ``result``, so ``_meta`` is
    ignored there.
    """
    rows: list[dict[str, Any]] = []
    site_names: set[str] = set()
    unassigned = 0
    for h in hosts:
        hostgroups = h.get("hostgroups") or h.get("groups") or []
        site = derive_site(hostgroups, prefix)
        if site:
            site_names.add(site)
        else:
            unassigned += 1
        rows.append(
            {
                "hostid": h.get("hostid"),
                "host": h.get("host"),
                "name": h.get("name"),
                "status": h.get("status"),
                "site": site,
                "mgmt_ip": main_ip(h.get("interfaces") or []),
                "hostgroups": [{"name": g.get("name")} for g in hostgroups],
            }
        )

    site_groups = sorted(
        g.get("name", "")[len(prefix):]
        for g in groups
        if str(g.get("name", "")).startswith(prefix)
    )
    return {
        "_meta": {
            "note": (
                "Zabbix host.get (+selectHostGroups) export for netmon-seed "
                "--sites. Generated by scripts/zabbix_export.py. Not a fixture "
                "— sanitize before committing (CLAUDE.md §4.6)."
            ),
            "zabbix_version": version,
            "site_prefix": prefix,
            "host_count": len(rows),
            "group_count": len(groups),
            "site_count": len(site_groups),
            "sites": site_groups,
            "hosts_without_site": unassigned,
        },
        "result": rows,
    }


def groups_export(groups: list[dict[str, Any]], *, version: str) -> dict[str, Any]:
    """Shape ``hostgroup.get`` into a plain ``{"result": [...]}`` dump."""
    return {
        "_meta": {
            "note": "Zabbix hostgroup.get export. Generated by scripts/zabbix_export.py.",
            "zabbix_version": version,
            "group_count": len(groups),
        },
        "result": [{"groupid": g.get("groupid"), "name": g.get("name")} for g in groups],
    }


# --------------------------------------------------------------------------- #
# Live JSON-RPC client (stdlib urllib).
# --------------------------------------------------------------------------- #

class ZabbixClient:
    """Minimal read-only Zabbix 7.4 JSON-RPC client.

    Auth is the ``Authorization: Bearer`` header (Zabbix >= 7.2). Pass either an
    API ``token`` or a ``session`` obtained from :meth:`login`.
    """

    def __init__(self, url: str, *, token: str | None = None, verify_ssl: bool = False,
                 timeout: float = 30.0) -> None:
        base = url.rstrip("/")
        if not base.endswith("api_jsonrpc.php"):
            base = base + "/api_jsonrpc.php"
        self.endpoint = base
        self._token = token
        self._timeout = timeout
        self._id = 0
        self._logged_in = False  # true only when a session came from user.login
        # TLS verification is OFF by default: the Zabbix server typically
        # carries an internal/self-signed cert. Pass --verify-ssl (verify_ssl=
        # True) to enforce the trust chain instead.
        self._ssl_ctx: ssl.SSLContext | None = None
        if not verify_ssl:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            self._ssl_ctx = ctx

    def _call(self, method: str, params: Any = None, *, authed: bool = True) -> Any:
        self._id += 1
        body = json.dumps(
            {"jsonrpc": "2.0", "method": method, "params": params or {}, "id": self._id}
        ).encode("utf-8")
        headers = {"Content-Type": "application/json-rpc"}
        # apiinfo.version and user.login are the only unauthenticated calls.
        if authed and self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        req = urllib.request.Request(self.endpoint, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self._timeout, context=self._ssl_ctx) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:  # 4xx/5xx
            raise ZabbixError(f"{method}: HTTP {e.code} {e.reason}") from e
        except urllib.error.URLError as e:
            raise ZabbixError(f"{method}: cannot reach {self.endpoint}: {e.reason}") from e
        except (ValueError, json.JSONDecodeError) as e:
            raise ZabbixError(f"{method}: invalid JSON response") from e

        if "error" in payload:
            err = payload["error"]
            raise ZabbixError(
                f"{method}: {err.get('message', 'error')} — {err.get('data', '')}".strip(" —")
            )
        return payload.get("result")

    def version(self) -> str:
        return str(self._call("apiinfo.version", authed=False))

    def login(self, user: str, password: str) -> None:
        """Exchange username/password for a session token (Zabbix 5.4+ field names)."""
        self._token = self._call("user.login", {"username": user, "password": password}, authed=False)
        if not self._token:
            raise ZabbixError("user.login returned no session token")
        self._logged_in = True

    def logout(self) -> None:
        if self._logged_in and self._token:
            try:
                self._call("user.logout", [])
            except ZabbixError:
                pass  # best-effort cleanup; the session expires on its own
            self._logged_in = False

    def hostgroups(self) -> list[dict[str, Any]]:
        return list(self._call("hostgroup.get", {"output": ["groupid", "name"], "sortfield": "name"}) or [])

    def hosts(self, *, monitored_only: bool = False) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "output": ["hostid", "host", "name", "status"],
            "selectHostGroups": ["groupid", "name"],
            "selectInterfaces": ["interfaceid", "ip", "dns", "type", "main"],
            "sortfield": "host",
        }
        if monitored_only:
            params["filter"] = {"status": 0}  # 0 = monitored
        return list(self._call("host.get", params) or [])


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _from_config(path: str | None) -> dict[str, str]:
    """Read a ``[zabbix]`` section from the NetMon config, if present."""
    conf_path = path or os.environ.get("NETMON_CONF")
    if not conf_path or not Path(conf_path).is_file():
        return {}
    parser = configparser.ConfigParser()
    parser.optionxform = str  # type: ignore[assignment]
    parser.read(conf_path)
    if not parser.has_section("zabbix"):
        return {}
    return {k: v.strip() for k, v in parser.items("zabbix")}


def _resolve_password(raw: str | None) -> str | None:
    """``-`` means prompt (never echo a password on the command line)."""
    if raw == "-":
        return getpass.getpass("Zabbix password: ")
    return raw


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Export Zabbix 7.4 sites/groups/hosts for netmon-seed.")
    p.add_argument("--url", help="Zabbix base URL (or $ZABBIX_URL / [zabbix] url).")
    p.add_argument("--token", help="API token (or $ZABBIX_TOKEN / [zabbix] token). Preferred.")
    p.add_argument("--user", help="Username (alternative to --token).")
    p.add_argument("--password", help="Password, or '-' to prompt (with --user).")
    p.add_argument("--config", help="NetMon config path to read [zabbix] from (default $NETMON_CONF).")
    p.add_argument("--format", choices=("sites", "groups"), default="sites",
                   help="sites: host.get dump for --sites (default). groups: hostgroup.get dump.")
    p.add_argument("--site-prefix", default=DEFAULT_SITE_PREFIX,
                   help=f"Site host-group prefix (default {DEFAULT_SITE_PREFIX!r}).")
    p.add_argument("--monitored-only", action="store_true",
                   help="Only monitored (status=0) hosts. Default: all hosts.")
    p.add_argument("--out", help="Write JSON here (default: stdout).")
    p.add_argument("--verify-ssl", action="store_true",
                   help="Verify the server TLS certificate. Default: OFF "
                        "(the Zabbix server usually has an internal/self-signed cert).")
    args = p.parse_args(argv)

    cfg = _from_config(args.config)
    url = args.url or os.environ.get("ZABBIX_URL") or cfg.get("url")
    token = args.token or os.environ.get("ZABBIX_TOKEN") or cfg.get("token")
    user = args.user or cfg.get("user")
    password = _resolve_password(args.password) or os.environ.get("ZABBIX_PASSWORD") or cfg.get("password")

    if not url:
        p.error("no Zabbix URL — pass --url, set $ZABBIX_URL, or add [zabbix] url to the config.")
    if not token and not user:
        p.error("no credentials — pass --token (preferred) or --user/--password.")

    client = ZabbixClient(url, token=token, verify_ssl=args.verify_ssl)
    try:
        version = client.version()
        print(f"Connected to Zabbix {version} at {client.endpoint}", file=sys.stderr)
        if not token:
            client.login(user, password or "")
            print(f"Authenticated as {user!r} (session token)", file=sys.stderr)

        groups = client.hostgroups()
        if args.format == "groups":
            payload = groups_export(groups, version=version)
        else:
            hosts = client.hosts(monitored_only=args.monitored_only)
            payload = build_export(hosts, groups, version=version, prefix=args.site_prefix)
            meta = payload["_meta"]
            print(
                f"Hosts: {meta['host_count']}  Groups: {meta['group_count']}  "
                f"Sites: {meta['site_count']}  Unassigned: {meta['hosts_without_site']}",
                file=sys.stderr,
            )
            if meta["sites"]:
                print("Sites: " + ", ".join(meta["sites"]), file=sys.stderr)
    except ZabbixError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    finally:
        client.logout()

    text = json.dumps(payload, indent=2, sort_keys=False)
    if args.out:
        Path(args.out).write_text(text + "\n")
        print(f"Wrote {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

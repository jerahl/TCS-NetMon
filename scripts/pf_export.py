#!/usr/bin/env python3
"""Export PacketFence nodes to a seed-ready JSON file.

Phase 0 reconnaissance helper (CLAUDE.md §7): dumps ``POST /api/v1/nodes/search``
into the ``{"items": [...]}`` shape that ``netmon-seed --pf`` consumes to build
the device registry. Mirrors ``tests/fixtures/pf_nodes.json``.

Read-only (§4.1): reuses the collector's :class:`PfClient` (token login, then a
single search POST — no writes to PF). Credentials come from the
``[packetfence]`` section of the NetMon config (``--config`` / ``$NETMON_CONF``);
the password is never printed or written into the output.

Usage::

    NETMON_CONF=/etc/netmon/netmon.conf python scripts/pf_export.py --out pf_nodes.json
    python -m netmon.seed --pf pf_nodes.json [--xiq ...] [--sites ...]

PF is slow (§0 rate notes): this is a one-shot bulk read, never a request path.
``--limit`` bounds the pull; if the result hits the limit the export is
truncated and the script says so loudly (§4.5) — raise ``--limit`` and re-run.

**Do not commit real output** — real hostnames/IPs are not fixtures (§4.6).
Sanitize before adding anything under ``tests/fixtures/``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from netmon.collectors.pf_client import PfClient, PfError  # noqa: E402
from netmon.config import ConfigError, load_config  # noqa: E402


def _as_bool(value: str) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Export PacketFence nodes for netmon-seed --pf.")
    p.add_argument("--config", default=None, help="NetMon config path (default $NETMON_CONF).")
    p.add_argument("--limit", type=int, default=5000, help="Max nodes to pull (default 5000).")
    p.add_argument("--out", help="Write JSON here (default: stdout).")
    args = p.parse_args(argv)

    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    src = cfg.sources.get("packetfence")
    s = src.settings if src else {}
    url = (s.get("url") or "").strip()
    if not url:
        print("ERROR: [packetfence] url is not set in the config.", file=sys.stderr)
        return 1

    try:
        client = PfClient(
            url=url,
            user=(s.get("user") or "").strip(),
            password=s.get("pass") or "",
            verify_ssl=_as_bool(s.get("verify_ssl", "true")),
        )
        nodes = asyncio.run(client.nodes(limit=args.limit))
    except PfError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    truncated = len(nodes) >= args.limit
    payload = {
        "_meta": {
            "note": (
                "PacketFence nodes/search export for netmon-seed --pf. Generated "
                "by scripts/pf_export.py. Not a fixture — sanitize before "
                "committing (CLAUDE.md §4.6)."
            ),
            "node_count": len(nodes),
            "limit": args.limit,
            "truncated": truncated,
        },
        "items": nodes,
    }
    print(f"PacketFence nodes: {len(nodes)}", file=sys.stderr)
    if truncated:
        print(f"WARNING: hit --limit ({args.limit}); result is TRUNCATED. "
              f"Re-run with a higher --limit to capture all nodes.", file=sys.stderr)

    text = json.dumps(payload, indent=2, sort_keys=False)
    if args.out:
        Path(args.out).write_text(text + "\n")
        print(f"Wrote {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

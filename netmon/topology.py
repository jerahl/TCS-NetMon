"""One-shot map-topology importer: curated sites + fiber links (spec 09).

Parses an owner-maintained JSON file (see ``topology.example.json``) into
``sites`` and ``fiber_links`` rows and upserts them. The parse/validate
functions are pure (no DB, no network) so they are unit-tested directly.

``sites[].name`` must equal ``devices.site`` (the Zabbix ``Site/<name>``
value) — that string joins the curated map onto the live device roll-up. The
importer warns about curated sites that match no device rather than guessing.

Runnable as ``python -m netmon.topology`` or via the ``netmon-topology``
entry point. Read-only against every source system; writes only NetMon's own
``sites``/``fiber_links`` tables.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

from netmon import db
from netmon.models.schemas import FiberLinkSpec, Site

log = logging.getLogger("netmon.topology")


class TopologyError(ValueError):
    """Invalid topology file — fail loud, import nothing."""


def _norm_pair(a: str, b: str) -> tuple[str, str]:
    """Store every link with its endpoints in sorted order so A↔B and B↔A
    collapse onto the same registry row."""
    return (a, b) if a <= b else (b, a)


def parse_topology(data: dict[str, Any]) -> tuple[list[Site], list[FiberLinkSpec]]:
    """Validate a topology document into (sites, links). Raises TopologyError."""
    if not isinstance(data, dict):
        raise TopologyError("topology document must be a JSON object")

    sites: list[Site] = []
    seen_sites: set[str] = set()
    for i, raw in enumerate(data.get("sites") or []):
        try:
            site = Site(**raw)
        except Exception as exc:
            raise TopologyError(f"sites[{i}]: {exc}") from exc
        if site.name in seen_sites:
            raise TopologyError(f"sites[{i}]: duplicate site name {site.name!r}")
        seen_sites.add(site.name)
        sites.append(site)
    if not sites:
        raise TopologyError("topology contains no sites")

    links: list[FiberLinkSpec] = []
    seen_pairs: set[tuple[str, str]] = set()
    for i, raw in enumerate(data.get("links") or []):
        if isinstance(raw, dict) and ("a" in raw or "b" in raw):
            # Accept the compact {"a": ..., "b": ...} form of the design handoff.
            raw = {**raw, "site_a": raw.pop("a", None), "site_b": raw.pop("b", None)}
        try:
            link = FiberLinkSpec(**raw)
        except Exception as exc:
            raise TopologyError(f"links[{i}]: {exc}") from exc
        for end in (link.site_a, link.site_b):
            if end not in seen_sites:
                raise TopologyError(f"links[{i}]: unknown site {end!r}")
        if link.site_a == link.site_b:
            raise TopologyError(f"links[{i}]: link endpoints are the same site")
        link.site_a, link.site_b = _norm_pair(link.site_a, link.site_b)
        pair = (link.site_a, link.site_b)
        if pair in seen_pairs:
            raise TopologyError(f"links[{i}]: duplicate link {pair[0]}—{pair[1]}")
        seen_pairs.add(pair)
        links.append(link)

    return sites, links


def load_topology(path: str | Path) -> tuple[list[Site], list[FiberLinkSpec]]:
    return parse_topology(json.loads(Path(path).read_text()))


def upsert_topology(engine, sites: list[Site], links: list[FiberLinkSpec]) -> tuple[int, int]:
    """Insert-or-update sites (by name) and links (by site pair).

    Uses the portable db.upsert helper (SELECT-then-UPDATE/INSERT) so the same
    code runs under SQLite (tests) and MariaDB (prod). Returns rows written.
    Removed topology is disabled by the owner in the JSON (enabled=false) and
    re-imported — the importer never deletes rows.
    """
    for s in sites:
        db.upsert(
            engine,
            "sites",
            {"name": s.name},
            {
                "display_name": s.display_name,
                "tier": s.tier.value,
                "lat": s.lat,
                "lon": s.lon,
                "enabled": int(s.enabled),
            },
        )

    ids = {
        r["name"]: r["id"]
        for r in db.fetch_all(engine, "SELECT id, name FROM sites")
    }
    for l in links:
        db.upsert(
            engine,
            "fiber_links",
            {"site_a_id": ids[l.site_a], "site_b_id": ids[l.site_b]},
            {
                "capacity_gbps": l.capacity_gbps,
                "path": json.dumps(l.path) if l.path is not None else None,
                "enabled": int(l.enabled),
            },
        )
    return len(sites), len(links)


def unmatched_sites(engine, sites: list[Site]) -> list[str]:
    """Curated site names with no matching devices.site — a naming mismatch
    the owner should fix (the roll-up would render such sites unknown)."""
    have = {
        r["site"]
        for r in db.fetch_all(
            engine, "SELECT DISTINCT site FROM devices WHERE site IS NOT NULL"
        )
    }
    return sorted(s.name for s in sites if s.name not in have)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Import curated map topology (sites + fiber links)."
    )
    parser.add_argument("file", help="path to topology JSON (see topology.example.json)")
    parser.add_argument("--config", default=None)
    parser.add_argument(
        "--dry-run", action="store_true", help="parse + print, write nothing"
    )
    args = parser.parse_args(argv)

    try:
        sites, links = load_topology(args.file)
    except (OSError, json.JSONDecodeError, TopologyError) as exc:
        print(f"error: invalid topology file: {exc}", file=sys.stderr)
        return 2

    print(f"parsed {len(sites)} site(s), {len(links)} link(s)")
    if args.dry_run:
        for s in sites:
            print(f"  site {s.name:12} {s.tier.value:10} ({s.lat:.4f}, {s.lon:.4f})  {s.display_name or ''}")
        for l in links:
            pts = len(l.path) if l.path else 0
            print(f"  link {l.site_a}—{l.site_b}  {l.capacity_gbps}G  path={pts} pt(s)")
        return 0

    from netmon.config import load_config

    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)
    ns, nl = upsert_topology(engine, sites, links)
    print(f"upserted {ns} site(s), {nl} link(s)")

    missing = unmatched_sites(engine, sites)
    if missing:
        print(
            "WARNING: no devices carry these site names (roll-up will show them "
            "as unknown): " + ", ".join(missing)
        )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

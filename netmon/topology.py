"""One-shot map-topology importer: curated sites + fiber links (spec 09).

Parses an owner-maintained topology file into ``sites`` and ``fiber_links``
rows and upserts them. Two input formats, one validation path:

* **JSON** — see ``topology.example.json``.
* **KML / KMZ** — drawn in Google My Maps / Google Earth and exported.
  Point placemark = site: ``<name>`` is the site name (an optional
  ``Site/`` prefix, the Zabbix group idiom, is stripped), ``<description>``
  is the display name (an optional ``tier: high`` line sets the tier).
  LineString placemark = fiber link: description lines ``a: <site>`` /
  ``b: <site>`` / ``capacity_gbps: 10`` name the endpoints and capacity
  (falling back to an ``A-B`` placemark name), and the drawn line itself
  becomes the link's ``path`` polyline. KML stores ``lon,lat`` — converted
  here to the ``lat,lon`` order the schema uses.

The parse/validate functions are pure (no DB, no network) so they are
unit-tested directly.

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
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
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


# ------------------------------------------------------------------ KML input

def _local(tag: str) -> str:
    """Element name without its XML namespace (KML files vary: 2.0/2.1/2.2)."""
    return tag.rsplit("}", 1)[-1]


def _strip_site_prefix(name: str) -> str:
    """'Site/BHS' → 'BHS' (the Zabbix group idiom); plain names pass through."""
    name = name.strip()
    return name[5:].strip() if name.lower().startswith("site/") else name


_KV_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_ ]*?)\s*:\s*(.+?)\s*$")
_NUM_RE = re.compile(r"[-+]?\d*\.?\d+")


def _desc_lines(desc: str) -> list[str]:
    """Description → plain text lines (Google exports use <br> inside CDATA)."""
    text = re.sub(r"(?i)<br\s*/?>", "\n", desc or "")
    text = re.sub(r"<[^>]+>", "", text)
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def _parse_desc(desc: str, known: set[str]) -> tuple[dict[str, str], list[str]]:
    """Split a description into recognized ``key: value`` lines + leftover text."""
    kv: dict[str, str] = {}
    rest: list[str] = []
    for ln in _desc_lines(desc):
        m = _KV_RE.match(ln)
        key = m.group(1).strip().lower().replace(" ", "_") if m else None
        if key in known:
            kv[key] = m.group(2).strip()
        else:
            rest.append(ln)
    return kv, rest


def _coords(geom: ET.Element, what: str) -> list[list[float]]:
    """<coordinates> 'lon,lat[,alt] …' → [[lat, lon], …] (order swapped)."""
    raw = ""
    for e in geom.iter():
        if _local(e.tag) == "coordinates":
            raw = e.text or ""
            break
    out: list[list[float]] = []
    for tok in raw.split():
        parts = tok.split(",")
        try:
            lon, lat = float(parts[0]), float(parts[1])
        except (IndexError, ValueError) as exc:
            raise TopologyError(f"{what}: bad KML coordinate {tok!r}") from exc
        out.append([lat, lon])
    return out


def parse_kml(text: str) -> dict[str, Any]:
    """KML → the same document shape parse_topology validates.

    Point placemarks become sites; LineString placemarks become links (their
    drawn geometry is the path). Other placemarks/folders are ignored.
    """
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise TopologyError(f"invalid KML: {exc}") from exc

    sites: list[dict[str, Any]] = []
    links: list[dict[str, Any]] = []
    for pm in (e for e in root.iter() if _local(e.tag) == "Placemark"):
        name = ""
        desc = ""
        for child in pm:
            if _local(child.tag) == "name":
                name = (child.text or "").strip()
            elif _local(child.tag) == "description":
                desc = child.text or ""
        point = next((e for e in pm.iter() if _local(e.tag) == "Point"), None)
        line = next((e for e in pm.iter() if _local(e.tag) == "LineString"), None)

        if point is not None:
            site_name = _strip_site_prefix(name)
            if not site_name:
                raise TopologyError("KML Point placemark has no name")
            coords = _coords(point, f"site {site_name!r}")
            if len(coords) != 1:
                raise TopologyError(f"site {site_name!r}: Point needs exactly one coordinate")
            site: dict[str, Any] = {"name": site_name, "lat": coords[0][0], "lon": coords[0][1]}
            kv, rest = _parse_desc(desc, {"display_name", "tier"})
            if "tier" in kv:
                site["tier"] = kv["tier"].lower()
            display = kv.get("display_name") or " ".join(rest)
            if display:
                site["display_name"] = display
            sites.append(site)

        elif line is not None:
            kv, _ = _parse_desc(desc, {"a", "b", "capacity_gbps", "capacity"})
            a, b = kv.get("a"), kv.get("b")
            if not (a and b):
                # Fall back to the 'A-B' placemark-name convention.
                parts = [p.strip() for p in name.split("-")]
                if len(parts) == 2 and all(parts):
                    a, b = a or parts[0], b or parts[1]
            if not (a and b):
                raise TopologyError(
                    f"KML path {name!r}: description must carry 'a: <site>' and 'b: <site>'"
                    " (or name the placemark 'A-B')"
                )
            link: dict[str, Any] = {
                "site_a": _strip_site_prefix(a),
                "site_b": _strip_site_prefix(b),
            }
            cap = kv.get("capacity_gbps") or kv.get("capacity")
            if cap:
                m = _NUM_RE.match(cap)
                if not m:
                    raise TopologyError(f"KML path {name!r}: bad capacity {cap!r}")
                link["capacity_gbps"] = float(m.group(0))
            path = _coords(line, f"path {name!r}")
            if len(path) >= 2:
                link["path"] = path
            links.append(link)
        # Placemarks with other geometry (polygons…) and folders are ignored.

    return {"sites": sites, "links": links}


def _read_topology_text(path: str | Path) -> str:
    p = Path(path)
    if p.suffix.lower() == ".kmz":  # zipped KML (Google Earth's default export)
        try:
            with zipfile.ZipFile(p) as z:
                kmls = [n for n in z.namelist() if n.lower().endswith(".kml")]
                if not kmls:
                    raise TopologyError("KMZ archive contains no .kml document")
                main = "doc.kml" if "doc.kml" in kmls else kmls[0]
                return z.read(main).decode("utf-8", "replace")
        except zipfile.BadZipFile as exc:
            raise TopologyError(f"not a valid KMZ archive: {exc}") from exc
    return p.read_text()


def load_topology(path: str | Path) -> tuple[list[Site], list[FiberLinkSpec]]:
    text = _read_topology_text(path)
    suffix = Path(path).suffix.lower()
    if suffix in (".kml", ".kmz") or text.lstrip().startswith("<"):
        return parse_topology(parse_kml(text))
    return parse_topology(json.loads(text))


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
    parser.add_argument(
        "file",
        help="topology file: JSON (see topology.example.json) or KML/KMZ "
        "(see docs/runbooks/site-map.md for the placemark conventions)",
    )
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

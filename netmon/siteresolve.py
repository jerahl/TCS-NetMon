"""Site attribution — fill ``devices.site`` for devices no ``Site/`` group covers.

96% of the registry (3,466 of 3,626 rows) carried a non-location value in
``devices.site``: 2,748 ``Unassigned`` and 718 ``Wireless APs``. That single
defect starves the Global site health map, the Problems site mosaic, the Events
site filter, the Site Map roll-up and both host navigators — the tiles and
filters are already written and simply have nothing true to render.

There were two separate causes, and this module addresses the second:

1. **A ranking bug in the seed** (fixed in :func:`netmon.seed.build_site_index`).
   Zabbix carries two parallel taxonomies under the same ``Site/`` prefix — real
   locations (``Site/Wireless/<school>/<floor>``, 725 hosts) and functional
   catch-alls (``Site/Wireless APs``, 788 hosts). 728 hosts are in both, the
   index took whichever came first, and the catch-all won for 717 APs. The
   authoritative location data was in the export the whole time.

2. **Cameras and recording servers were never in a ``Site/`` group at all.**
   Milestone federates by hardware id and Zabbix only ever tracked 15 of them
   under ``Site/Video/Milestone``, so no export can answer where a camera is.
   That is what this module infers.

Inference here is deliberately conservative, because a confidently wrong site is
worse than an honest ``Unassigned`` (§4.5): a camera filed under the wrong
school sends an operator to the wrong building. Three rules keep it honest:

* **Evidence, not opinion.** Both the name-prefix map and the subnet map are
  *learned* from devices whose site came from an authoritative source, never
  hardcoded from what a code looks like it should mean. ``ALB`` resolves to
  ``TASPA`` — not to an invented "Alberta" site — because nine ``ALB-*``
  switches are sited ``TASPA`` in the registry. No amount of reading the string
  would have produced that.
* **Learned only from authority.** The subnet map is built exclusively from
  Zabbix-group and pre-existing switch assignments. Feeding it this module's own
  inferences would make the evidence circular and let one bad guess propagate
  across a whole /16.
* **Purity thresholds with loud rejection.** A subnet must be ≥98% pure over
  ≥5 authoritative devices to be usable. This is what rejects ``172.16`` (9%
  pure) and ``192.168`` (18%) — the shared management ranges that produced the
  contested-IP bug in July. Rejected ranges are reported, not silently dropped.

Every resolution carries its :class:`Resolution.method` and ``evidence`` so a
wrong answer can be traced to the rule that produced it rather than argued about.

Pure functions only above the ``--- DB side ---`` marker; they are unit-tested
directly. Runnable as ``python -m netmon.siteresolve`` (``--dry-run`` default).
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

from netmon import db

log = logging.getLogger("netmon.siteresolve")

UNASSIGNED_SITE = "Unassigned"

# Values that mean "nobody has said where this is". Only these may be
# overwritten; a device carrying a real site name is never touched, so a manual
# assignment in the Registry UI always outranks anything inferred here.
NON_LOCATION_SITES = frozenset({
    "", UNASSIGNED_SITE, "Wireless APs", "Servers", "Video/Milestone", "Milestone",
})

# Under ``Site/`` Zabbix nests more than one taxonomy. Only these carry a
# physical location in the segment after the taxonomy name; ``Site/Video/...``
# is a functional grouping whose second segment is a system, not a building.
LOCATION_TAXONOMIES = frozenset({"wireless"})

# Trailing words that distinguish a school's full name from the site name the
# district actually uses ("Rock Quarry Elementary School" -> "Rock Quarry").
# Applied by progressive right-trim against the known site list, longest match
# wins, so "Bryant High School" -> "Bryant High" keeps the word "High".
_TRIMMABLE = re.compile(r"\s+\S+$")

# Site names Zabbix spells in a way no trimming rule reaches. Each is a
# district naming choice, not a pattern — kept explicit and short on purpose so
# the owner can audit the whole list at a glance.
NAME_ALIASES: dict[str, str] = {
    "tuscaloosa magnet schools": "TMS",
    "alberta performing arts": "TASPA",
    "shec": "New Heights",
}


@dataclass(frozen=True)
class Resolution:
    """One device's site, and why it has that site."""

    site: str | None
    method: str            # zbx-location | zbx-flat | registry | prefix | subnet | none
    evidence: str = ""

    @property
    def resolved(self) -> bool:
        return bool(self.site)


# --------------------------------------------------------------------------
# Zabbix Site/ group classification
# --------------------------------------------------------------------------

def classify_site_group(gname: str, prefix: str = "Site/") -> tuple[int, str]:
    """Rank a Zabbix ``Site/`` group and extract its location name.

    Returns ``(rank, raw_name)``; a higher rank is more specific and must win
    when a host belongs to several groups. ``rank == 0`` means the group names
    no location at all and must never be used as a site.

    * ``2`` — ``Site/Wireless/<school>/<floor>``: a real location, most specific.
    * ``1`` — ``Site/<name>``: the flat per-site group.
    * ``0`` — ``Site/Wireless APs``, ``Site/Servers``, ``Site/Video/Milestone``:
      functional groupings. This is the distinction the seed was missing.
    """
    if not gname or not gname.startswith(prefix):
        return (0, "")
    rest = gname[len(prefix):].strip()
    if not rest:
        return (0, "")
    parts = [p.strip() for p in rest.split("/") if p.strip()]
    if len(parts) >= 2:
        # Hierarchical: only a location taxonomy names a building.
        if parts[0].lower() in LOCATION_TAXONOMIES:
            return (2, parts[1])
        return (0, "")
    # Flat. "Wireless APs" and "Servers" are fleet-wide functional groups that
    # happen to sit at the same depth as a real site, so they are excluded by
    # name rather than by shape.
    if rest in NON_LOCATION_SITES:
        return (0, "")
    return (1, rest)


def site_from_groups(groups: Iterable[Any], prefix: str = "Site/") -> tuple[int, str]:
    """Best ``(rank, raw_name)`` across all of a host's groups.

    Ranking rather than first-wins is the entire fix for the 717 mis-sited APs:
    membership order in the export is not a statement about which group is the
    more truthful answer.
    """
    best = (0, "")
    for g in groups or []:
        gname = g.get("name") if isinstance(g, dict) else str(g)
        rank, raw = classify_site_group(str(gname or ""), prefix)
        if rank > best[0]:
            best = (rank, raw)
    return best


# --------------------------------------------------------------------------
# Canonical site naming
# --------------------------------------------------------------------------

def canonical_site(raw: str, known: Sequence[str]) -> str | None:
    """Map a source's spelling of a site onto the registry's canonical name.

    Matching is exact-then-progressively-trimmed against ``known`` (the sites
    already in the registry), so the registry stays the authority on what a site
    is called and this function never invents one. Returns ``None`` when nothing
    matches — the caller leaves the device unassigned rather than guessing.
    """
    if not raw:
        return None
    by_lower = {k.lower(): k for k in known if k}
    name = raw.strip()
    if not name:
        return None

    alias = NAME_ALIASES.get(name.lower())
    if alias:
        return by_lower.get(alias.lower(), alias)

    # Longest match wins: try the full string, then drop one trailing word at a
    # time. "Rock Quarry Elementary School" -> ... -> "Rock Quarry".
    cur = name
    while cur:
        hit = by_lower.get(cur.lower())
        if hit:
            return hit
        trimmed = _TRIMMABLE.sub("", cur)
        if trimmed == cur:
            break
        cur = trimmed
    return None


# --------------------------------------------------------------------------
# Learned maps
# --------------------------------------------------------------------------

def norm_name(name: str) -> str:
    """Fold a device name to a punctuation-insensitive key.

    The same AP is ``WMS-160/Band`` in the registry and ``WMS-160-Band`` in
    Zabbix; XIQ, Zabbix and PacketFence each normalise separators differently.
    Matching on the exact string silently drops 57 devices onto the inference
    path when an authoritative answer was available — and in two cases let a
    wrong registry site stand while Zabbix disagreed.
    """
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")


def name_prefix(name: str) -> str:
    """Leading alphabetic run of a device name, upper-cased ("CHS229" -> "CHS")."""
    m = re.match(r"[A-Za-z]+", (name or "").strip())
    return m.group(0).upper() if m else ""


def net16(ip: str | None) -> str | None:
    """First two octets of a dotted-quad, or ``None`` if it isn't one.

    A /16 is the unit the district's addressing actually varies by (10.128 =
    Bryant High, 10.32 = Central High). Hostnames and IPv6 return ``None``.
    """
    parts = (ip or "").strip().split(".")
    if len(parts) != 4 or not all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
        return None
    return ".".join(parts[:2])


def _learn(pairs: Iterable[tuple[str, str]], *, min_samples: int, min_purity: float
           ) -> tuple[dict[str, str], list[tuple[str, str, int, int]]]:
    """Fold ``(key, site)`` observations into a map, keeping only pure keys.

    Returns ``(accepted, rejected)`` where each rejected entry is
    ``(key, top_site, top_count, total)`` so the caller can report what was
    dropped and why — a silently discarded key looks identical to one that was
    never seen (§4.5).
    """
    seen: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for key, site in pairs:
        if key and site:
            seen[key][site] += 1
    accepted: dict[str, str] = {}
    rejected: list[tuple[str, str, int, int]] = []
    for key, counts in seen.items():
        top, n = counts.most_common(1)[0]
        total = sum(counts.values())
        if total >= min_samples and n / total >= min_purity:
            accepted[key] = top
        else:
            rejected.append((key, top, n, total))
    rejected.sort(key=lambda r: -r[3])
    return accepted, rejected


def learn_prefix_map(authoritative: Iterable[tuple[str, str]], *, min_purity: float = 0.95
                     ) -> tuple[dict[str, str], list[tuple[str, str, int, int]]]:
    """Learn ``name-prefix -> site`` from authoritatively-sited devices.

    One sample is enough — a site may own a single switch — so the guard is
    purity rather than volume. This is what discovers ALB -> TASPA and
    SHEC -> New Heights without anybody encoding local knowledge.

    Purity is 0.95, not 1.0, because a lone mis-assigned row should not be able
    to veto a prefix: ``WMS`` is 40/42 for Westlawn Middle, the two dissenters
    being registry errors, and at 1.0 those two would strand 76 cameras. The
    minority is never discarded quietly — :func:`dissenting` reports every
    accepted prefix that had one, so the outlier surfaces as the data-quality
    finding it is instead of being averaged away.
    """
    return _learn(((name_prefix(n), s) for n, s in authoritative),
                  min_samples=1, min_purity=min_purity)


def dissenting(pairs: Iterable[tuple[str, str]], accepted: dict[str, str]
               ) -> list[tuple[str, str, str, int]]:
    """``(key, accepted_site, dissenting_site, count)`` for every minority vote.

    An accepted map entry that outvoted a disagreement is exactly where a
    mis-assigned device hides, so the caller must be able to print them.
    """
    seen: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for key, site in pairs:
        if key and site:
            seen[key][site] += 1
    out = []
    for key, site in accepted.items():
        for other, n in seen.get(key, {}).items():
            if other != site:
                out.append((key, site, other, n))
    return sorted(out, key=lambda r: -r[3])


def learn_subnet_map(authoritative: Iterable[tuple[str | None, str]], *,
                     min_samples: int = 3, min_purity: float = 0.98
                     ) -> tuple[dict[str, str], list[tuple[str, str, int, int]]]:
    """Learn ``/16 -> site`` from authoritatively-sited devices.

    Thresholds exist to reject shared ranges. A site-specific /16 observes at
    100% across hundreds of devices; ``172.16`` and ``192.168`` carry management
    and inter-site addressing and land near 10–20%, so they are refused rather
    than resolved to whichever site happens to hold a plurality. ``10.172`` is
    the instructive one — 83% across two genuinely co-located sites, refused for
    impurity rather than for thinness.
    """
    return _learn(((net16(ip), s) for ip, s in authoritative),
                  min_samples=min_samples, min_purity=min_purity)


def learn_subnet_map_stage2(observations: Iterable[tuple[str | None, str]],
                            already: dict[str, str], *, min_samples: int = 5
                            ) -> tuple[dict[str, str], list[tuple[str, str, int, int]]]:
    """Extend the subnet map using prefix-resolved devices as well.

    Cameras carry the district's 10.x addressing, but almost nothing
    *authoritative* does — the sited switches mostly sit on 172.16/192.168 — so
    stage 1 learns only six subnets and the model-named cameras (FLEXIDOME,
    BOSCH, AXIS) have no evidence at all. Their neighbours in the same /16 do:
    76 ``WMS-*`` cameras resolved by prefix all agree that 10.104 is Westlawn
    Middle.

    Admitting inferred rows as evidence is the circularity this module warns
    about, so it is fenced: **100% purity required** (any disagreement, however
    small, rejects the subnet), a higher sample floor, and keys already decided
    by stage 1 are left alone. Resolutions from this map are labelled
    ``subnet-2`` so a wrong answer is traceable to the weaker evidence.
    """
    accepted, rejected = _learn(((net16(ip), s) for ip, s in observations),
                                min_samples=min_samples, min_purity=1.0)
    return ({k: v for k, v in accepted.items() if k not in already}, rejected)


# --------------------------------------------------------------------------
# Resolution
# --------------------------------------------------------------------------

def resolve(name: str, ip: str | None, *, prefix_map: dict[str, str],
            subnet_map: dict[str, str]) -> Resolution:
    """Resolve one device's site from the learned maps, most-trusted first.

    Name prefix outranks subnet because it is the district's own label for the
    device, and because a subnet can be re-used across buildings in a way a name
    prefix is not. Unresolved is a valid, honest answer.
    """
    pre = name_prefix(name)
    if pre and pre in prefix_map:
        return Resolution(prefix_map[pre], "prefix", f"name prefix {pre}")

    # Some cameras are named for their address ("10.108.18.31 - Camera 1") and
    # carry no address field of their own; the name is then the only evidence.
    net = net16(ip) or net16(_ip_in_name(name))
    if net and net in subnet_map:
        return Resolution(subnet_map[net], "subnet", f"{net}.0.0/16")

    return Resolution(None, "none", f"prefix={pre or '-'} net={net or '-'}")


def _ip_in_name(name: str) -> str | None:
    m = re.search(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b", name or "")
    return m.group(1) if m else None


# --------------------------------------------------------------------------
# --- DB side ---
# --------------------------------------------------------------------------

def load_devices(engine) -> list[dict[str, Any]]:
    """Registry rows plus the camera address, which lives in ``cameras.ip``.

    Cameras have no ``devices.mgmt_ip`` (Milestone federates by hardware id), so
    without this join every camera would be invisible to the subnet rule.
    """
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT d.id AS id, d.name AS name, d.device_type AS device_type, "
        "       d.site AS site, "
        "       COALESCE(NULLIF(d.mgmt_ip, ''), cam.ip) AS ip "
        "FROM devices d LEFT JOIN cameras cam ON cam.device_id = d.id",
        {},
    )]


def known_sites(engine) -> list[str]:
    """Canonical site names: ``group_key`` when set (migration 015), else name."""
    rows = db.fetch_all(engine, "SELECT name, group_key FROM sites", {})
    return [(r["group_key"] or r["name"]) for r in rows if (r["group_key"] or r["name"])]


def zabbix_locations(path: str | Path, sites: Sequence[str]) -> dict[str, str]:
    """``hostname -> canonical site`` from a Zabbix host-group export.

    Uses the ranked classification, so a host in both ``Site/Wireless APs`` and
    ``Site/Wireless/Bryant High School/1st Floor`` resolves to Bryant High.
    """
    data = json.loads(Path(path).read_text())
    rows = data.get("result") or data.get("data") or data if isinstance(data, dict) else data
    out: dict[str, str] = {}
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        host = str(r.get("host") or r.get("name") or "").strip()
        if not host:
            continue
        rank, raw = site_from_groups(r.get("hostgroups") or r.get("groups") or [])
        if rank:
            site = canonical_site(raw, sites)
            if site:
                out[host] = site
    return out


def plan(devices: list[dict[str, Any]], sites: Sequence[str],
         zbx: dict[str, str] | None = None) -> dict[str, Any]:
    """Work out every device's site without writing anything.

    Returns the per-device resolutions plus the learned maps and what they
    rejected, so ``--dry-run`` can show the whole basis for the change.
    """
    zbx = zbx or {}
    zbx_lower = {k.lower(): v for k, v in zbx.items()}
    # Punctuation-folded index, but only for keys that fold unambiguously — two
    # distinct hosts collapsing onto one key would make the lookup a coin toss.
    _folded: dict[str, set[str]] = collections.defaultdict(set)
    for k, v in zbx.items():
        _folded[norm_name(k)].add(v)
    zbx_norm = {k: next(iter(v)) for k, v in _folded.items() if len(v) == 1}

    def zbx_site(name: str) -> str | None:
        return (zbx.get(name) or zbx_lower.get(name.lower())
                or zbx_norm.get(norm_name(name)))

    def needs_site(d: dict[str, Any]) -> bool:
        return (d.get("site") or "") in NON_LOCATION_SITES

    # Authoritative = a Zabbix location group, or a site already in the registry
    # that nobody disputes. These, and only these, teach the maps.
    authoritative: list[tuple[str, str, str | None]] = []
    for d in devices:
        name = d.get("name") or ""
        site = zbx_site(name)
        if site:
            authoritative.append((name, site, d.get("ip")))
        elif not needs_site(d):
            authoritative.append((name, d["site"], d.get("ip")))

    prefix_pairs = [(n, s) for n, s, _ in authoritative]
    prefix_map, prefix_rej = learn_prefix_map(prefix_pairs)
    prefix_dissent = dissenting(((name_prefix(n), s) for n, s in prefix_pairs), prefix_map)
    subnet_map, subnet_rej = learn_subnet_map((ip, s) for _, s, ip in authoritative)
    # A site's own short code is a legitimate prefix even with no device to
    # learn it from; the registry, not this module, decides the code.
    for s in sites:
        prefix_map.setdefault(name_prefix(s), s)

    # A device with a real site that Zabbix places elsewhere. Not corrected
    # here — the never-overwrite rule protects manual Registry assignments, and
    # silently reversing one would be worse than a stale value. Reported so the
    # owner can settle it; two APs named WMS-* are sited Verner this way.
    conflicts = [
        {"id": d["id"], "name": d.get("name"), "registry": d.get("site"),
         "zabbix": zbx_site(d.get("name") or "")}
        for d in devices
        if not needs_site(d)
        and zbx_site(d.get("name") or "")
        and zbx_site(d.get("name") or "") != d.get("site")
    ]

    pending = [d for d in devices if needs_site(d)]

    # Pass 1 — everything the authoritative evidence can answer on its own.
    first: dict[int, Resolution] = {}
    for d in pending:
        name = d.get("name") or ""
        site = zbx_site(name)
        first[d["id"]] = (
            Resolution(site, "zbx-location", "Zabbix Site/ group") if site
            else resolve(name, d.get("ip"), prefix_map=prefix_map, subnet_map=subnet_map))

    # Pass 2 — let pass-1's name-resolved devices vouch for their own /16, under
    # the stricter rules in learn_subnet_map_stage2.
    stage2_obs = [(ip, s) for _, s, ip in authoritative]
    stage2_obs += [(d.get("ip"), first[d["id"]].site) for d in pending
                   if first[d["id"]].method in ("zbx-location", "prefix")]
    subnet2, subnet2_rej = learn_subnet_map_stage2(stage2_obs, subnet_map)

    changes: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    for d in pending:
        name = d.get("name") or ""
        res = first[d["id"]]
        if not res.resolved:
            net = net16(d.get("ip")) or net16(_ip_in_name(name))
            if net and net in subnet2:
                res = Resolution(subnet2[net], "subnet-2", f"{net}.0.0/16 (peer-inferred)")
        row = {"id": d["id"], "name": name, "device_type": d.get("device_type"),
               "ip": d.get("ip"), "from": d.get("site"), "to": res.site,
               "method": res.method, "evidence": res.evidence}
        if res.resolved:
            changes.append(row)
            continue
        unresolved.append(row)
        # An unplaceable device must land in the one honest bucket. Leaving it
        # as "Wireless APs" would keep rendering a site tile for a device class
        # — the original defect in miniature — so the label is normalised even
        # though the location is still unknown. This is not a guess: it is
        # replacing a wrong answer with no answer.
        if (d.get("site") or "") != UNASSIGNED_SITE:
            changes.append({**row, "to": UNASSIGNED_SITE, "method": "normalise",
                            "evidence": "unplaceable — cleared to Unassigned"})

    return {"changes": changes, "unresolved": unresolved,
            "prefix_map": prefix_map, "subnet_map": subnet_map, "subnet_map2": subnet2,
            "prefix_rejected": prefix_rej, "subnet_rejected": subnet_rej,
            "subnet2_rejected": subnet2_rej, "prefix_dissent": prefix_dissent,
            "conflicts": conflicts, "authoritative": len(authoritative)}


def apply_changes(engine, changes: list[dict[str, Any]]) -> int:
    """Write the resolved sites. Only ``devices.site`` is ever touched."""
    n = 0
    for c in changes:
        db.execute(engine, "UPDATE devices SET site = :site WHERE id = :id",
                   {"site": c["to"], "id": c["id"]})
        n += 1
    return n


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Resolve devices.site for unassigned devices (spec 17).")
    parser.add_argument("--config", default=None, help="path to netmon.conf")
    parser.add_argument("--sites", default=None,
                        help="Zabbix host-group export (authoritative AP locations)")
    parser.add_argument("--apply", action="store_true",
                        help="write the changes; without this nothing is written")
    parser.add_argument("--limit", type=int, default=25,
                        help="sample rows to print per group (0 = all)")
    args = parser.parse_args(argv)

    from netmon.config import load_config
    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)

    devices = load_devices(engine)
    sites = known_sites(engine)
    zbx = zabbix_locations(args.sites, sites) if args.sites else {}

    p = plan(devices, sites, zbx)
    print(f"registry {len(devices)} device(s); {p['authoritative']} authoritatively sited")
    if zbx:
        print(f"zabbix export resolved {len(zbx)} host(s) to a location group")
    print(f"learned {len(p['prefix_map'])} name prefix(es), "
          f"{len(p['subnet_map'])} subnet(s) + {len(p['subnet_map2'])} peer-inferred")
    for key, top, n, tot in p["subnet_rejected"]:
        if tot >= 3:
            print(f"  REJECTED subnet {key}: {top} only {n}/{tot} = {n/tot:.0%} "
                  f"(shared range — refusing to resolve)")
    if p["conflicts"]:
        print("\nCONFLICT — registry site disagrees with the Zabbix location group.")
        print("  Not changed (a manual assignment is never overwritten); resolve by hand:")
        for c in p["conflicts"]:
            print(f"    {str(c['name'])[:38]:<38} registry={c['registry']!r} zabbix={c['zabbix']!r}")
    if p["prefix_dissent"]:
        print("\nDISAGREEMENT — outvoted rows, each likely a mis-assigned device:")
        for key, won, lost, n in p["prefix_dissent"]:
            print(f"  prefix {key}: resolved to {won!r}, but {n} device(s) are sited {lost!r}")

    by_method = collections.Counter(c["method"] for c in p["changes"])
    print(f"\nresolved {len(p['changes'])}, unresolved {len(p['unresolved'])}")
    for m, n in by_method.most_common():
        print(f"  {m:<14} {n}")

    if p["unresolved"]:
        print("\nUNRESOLVED (left as-is — never guessed):")
        groups = collections.Counter(
            (u["device_type"], name_prefix(u["name"]) or "-", net16(u["ip"]) or "-")
            for u in p["unresolved"])
        for (dt, pre, net), n in groups.most_common(args.limit or None):
            print(f"  {dt:<17} prefix={pre:<12} net={net:<9} {n}")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        sample = p["changes"][: args.limit] if args.limit else p["changes"]
        for c in sample:
            print(f"  {c['name'][:38]:<38} {str(c['from']):<13} -> {c['to']:<20} "
                  f"[{c['method']}] {c['evidence']}")
        if args.limit and len(p["changes"]) > args.limit:
            print(f"  … {len(p['changes']) - args.limit} more")
        return 0

    n = apply_changes(engine, p["changes"])
    print(f"\nupdated {n} device(s)")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

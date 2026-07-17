"""One-shot device-registry seed from XIQ + PacketFence exports.

Parses fixture/export JSON into reconciled ``devices`` rows per the rules in
``docs/spec/00-sources.md`` and upserts them. ``site`` is assigned from either:

- ``--sites-from-db`` (spec 11 D9, the durable path): the site assignments
  already in NetMon's own ``devices`` table, so a re-seed never needs Zabbix;
- ``--sites``: a Zabbix ``Site/<name>`` host-group export — the bootstrap path
  used for the very first seed while Zabbix still exists.

Both may be given; the file overrides the DB for hosts present in both.
Devices in neither source become ``Unassigned`` — never guessed. The
reconciliation functions are pure (no DB, no network) so they are unit-tested
directly; ``upsert_devices`` and ``main`` handle the DB side.

Runnable as ``python -m netmon.seed`` or via the ``netmon-seed`` entry point.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any

from netmon import db
from netmon.models.schemas import Device, DeviceType

log = logging.getLogger("netmon.seed")

# Source device-type vocabularies -> registry vocabulary. Unknown -> other.
DEVICE_TYPE_MAP: dict[str, DeviceType] = {
    # XIQ device_function
    "AP": DeviceType.ap,
    "ACCESS_POINT": DeviceType.ap,
    "SWITCH": DeviceType.switch,
    "STACK": DeviceType.switch,
    # PF device_class / device_type (coarse)
    "SWITCH_HUB": DeviceType.switch,
    "NETWORK": DeviceType.switch,
    "VOIP": DeviceType.trunk,
    "IP_CAMERA": DeviceType.camera,
    "CAMERA": DeviceType.camera,
}

_HEX12 = re.compile(r"[^0-9a-fA-F]")


def canon_mac(mac: str) -> str:
    """Return ``aa:bb:cc:dd:ee:ff`` (lowercase) or '' if not 12 hex digits.

    Mirrors PFClient::canonMac so the PF join key is stable regardless of the
    source's formatting.
    """
    hexs = _HEX12.sub("", mac or "").lower()
    if len(hexs) != 12:
        return ""
    return ":".join(hexs[i : i + 2] for i in range(0, 12, 2))


# Site is assigned from a Zabbix host-group export, matching how the retiring
# system tracks sites (reference ActionGlobalData::buildSites): a host belongs
# to a site because it is a member of a group named "Site/<name>". Devices in
# no such group resolve to UNASSIGNED_SITE. The prefix mirrors the reference's
# {$TCS.SITE.GROUP.PREFIX} macro (default "Site/").
SITE_GROUP_PREFIX = "Site/"
UNASSIGNED_SITE = "Unassigned"


def build_site_index(
    rows: list[dict[str, Any]], prefix: str = SITE_GROUP_PREFIX
) -> dict[str, str]:
    """Map hostname → site from Zabbix ``host.get`` (``selectHostGroups``) rows.

    Each row has a ``host`` name and a ``hostgroups`` (or ``groups``) list of
    ``{"name": ...}``. The first group whose name starts with ``prefix`` wins;
    the site is that name minus the prefix (reference behaviour). Hosts with no
    ``Site/`` group are omitted — they resolve to ``UNASSIGNED_SITE`` at apply
    time.
    """
    index: dict[str, str] = {}
    for r in rows:
        name = str(r.get("host") or r.get("name") or "").strip()
        if not name:
            continue
        groups = r.get("hostgroups") or r.get("groups") or []
        for g in groups:
            gname = g.get("name") if isinstance(g, dict) else str(g)
            if gname and gname.startswith(prefix):
                site = gname[len(prefix):].strip()
                if site:
                    index[name] = site
                break
    return index


def load_site_index(path: str | Path, prefix: str = SITE_GROUP_PREFIX) -> dict[str, str]:
    """Load a site index from a Zabbix export or a plain ``{host: site}`` map."""
    data = json.loads(Path(path).read_text())
    if isinstance(data, dict):
        # A plain {hostname: site} map (ignore metadata keys like "_note").
        strvals = {k: v for k, v in data.items() if not k.startswith("_") and isinstance(v, str)}
        if strvals:
            return {str(k): v for k, v in strvals.items() if v}
        data = data.get("result") or data.get("data") or data.get("items") or []
    return build_site_index(list(data), prefix)


def site_index_from_db(engine) -> dict[str, str]:
    """Map device name → site from NetMon's own registry (spec 11 D9).

    Makes the ``devices``/``sites`` tables the durable source of truth for
    site membership: once seeded, re-running the seed with fresh XIQ/PF
    exports preserves the assignments without a Zabbix export. Unassigned
    rows are skipped so they can still pick a site up from ``--sites``.
    """
    rows = db.fetch_all(
        engine,
        "SELECT name, site FROM devices "
        "WHERE site IS NOT NULL AND site != '' AND site != :unassigned",
        {"unassigned": UNASSIGNED_SITE},
    )
    return {r["name"]: r["site"] for r in rows}


def assign_sites(devices: list[Device], index: dict[str, str]) -> list[Device]:
    """Set ``site`` on each device from the index (case-insensitive on name).

    Devices absent from the index become ``UNASSIGNED_SITE`` — never guessed.
    """
    lower = {k.lower(): v for k, v in index.items()}
    for d in devices:
        d.site = index.get(d.name) or lower.get(d.name.lower()) or UNASSIGNED_SITE
    return devices


def _map_type(raw: str | None) -> DeviceType:
    if not raw:
        return DeviceType.other
    return DEVICE_TYPE_MAP.get(str(raw).strip().upper(), DeviceType.other)


def normalize_xiq(rows: list[dict[str, Any]]) -> list[Device]:
    """XIQ ``/devices?views=BASIC`` rows → Device (unsaved)."""
    out: list[Device] = []
    for r in rows:
        xiq_id = r.get("id")
        hostname = str(r.get("hostname") or "").strip()
        name = hostname or (f"xiq-{xiq_id}" if xiq_id is not None else "")
        if not name:
            continue
        dtype = _map_type(r.get("device_function"))
        out.append(
            Device(
                name=name,
                # site is assigned later from the Zabbix Site/ group export.
                device_type=dtype,
                mgmt_ip=(str(r.get("ip_address")).strip() or None) if r.get("ip_address") else None,
                snmp_capable=dtype == DeviceType.switch,
                xiq_device_id=str(xiq_id) if xiq_id is not None else None,
            )
        )
    return out


def normalize_pf(rows: list[dict[str, Any]]) -> list[Device]:
    """PF node export rows → Device (unsaved)."""
    out: list[Device] = []
    for r in rows:
        mac = canon_mac(str(r.get("mac") or ""))
        host = str(r.get("computername") or "").strip()
        name = host or (f"pf-{mac}" if mac else "")
        if not name:
            continue
        dtype = _map_type(r.get("device_class") or r.get("device_type"))
        ip = r.get("ip4log.ip") or r.get("ip")
        out.append(
            Device(
                name=name,
                # site is assigned later from the Zabbix Site/ group export.
                device_type=dtype,
                mgmt_ip=(str(ip).strip() or None) if ip else None,
                snmp_capable=dtype == DeviceType.switch,
                pf_node_mac=mac or None,
            )
        )
    return out


def _ms_str(d: dict, *keys: str) -> str | None:
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return str(v).strip()
    return None


def normalize_milestone(servers: list[dict[str, Any]], cameras: list[dict[str, Any]]) -> list[Device]:
    """Milestone recording-server + camera entities → Device rows (unsaved),
    linked by ``milestone_hardware_id`` = the entity's GUID.

    This is what lets the Milestone collector do anything at all: it only writes
    state/inventory for registry devices whose ``milestone_hardware_id`` matches
    a fetched entity's ``id``. Names must be unique (``devices.name``), so a
    nameless entity falls back to a stable ``ms-rs-<id>`` / ``ms-cam-<id>``.
    Sites are assigned later from the existing registry (D9)."""
    out: list[Device] = []
    for srv in servers or []:
        sid = _ms_str(srv, "id")
        if not sid:
            continue
        name = _ms_str(srv, "name", "displayName", "hostName", "hostname") or f"ms-rs-{sid}"
        out.append(Device(
            name=name,
            device_type=DeviceType.recording_server,
            mgmt_ip=_ms_str(srv, "hostName", "hostname", "address"),
            snmp_capable=False,
            milestone_hardware_id=sid,
        ))
    for cam in cameras or []:
        cid = _ms_str(cam, "id")
        if not cid:
            continue
        name = _ms_str(cam, "name", "displayName", "shortName") or f"ms-cam-{cid}"
        out.append(Device(
            name=name,
            device_type=DeviceType.camera,
            mgmt_ip=_ms_str(cam, "address", "ip"),
            snmp_capable=False,
            milestone_hardware_id=cid,
        ))
    return out


def reconcile(xiq: list[Device], pf: list[Device]) -> list[Device]:
    """Merge XIQ + PF device lists into one row per real device.

    Match order (spec-00 rule 4): exact ``name``, then ``mgmt_ip``. XIQ wins on
    ``name``/``mgmt_ip``/``device_type``; the PF MAC is attached as
    ``pf_node_mac``.
    """
    merged: list[Device] = [d.model_copy(deep=True) for d in xiq]
    by_name = {d.name: d for d in merged}
    by_ip = {d.mgmt_ip: d for d in merged if d.mgmt_ip}

    for p in pf:
        match = by_name.get(p.name) or (by_ip.get(p.mgmt_ip) if p.mgmt_ip else None)
        if match is not None:
            # XIQ identity authoritative; enrich with PF-only fields.
            if p.pf_node_mac and not match.pf_node_mac:
                match.pf_node_mac = p.pf_node_mac
            if not match.mgmt_ip and p.mgmt_ip:
                match.mgmt_ip = p.mgmt_ip
            continue
        # PF-only device — keep it.
        merged.append(p)
        by_name[p.name] = p
        if p.mgmt_ip:
            by_ip.setdefault(p.mgmt_ip, p)

    return merged


def load_fixture(path: str | Path) -> list[dict[str, Any]]:
    """Load a JSON export; accepts a bare list or a ``{"data":[...]}`` envelope."""
    data = json.loads(Path(path).read_text())
    if isinstance(data, dict):
        data = data.get("data") or data.get("items") or []
    return list(data)


def upsert_devices(engine, devices: list[Device]) -> int:
    """Insert-or-update by unique ``name``. Returns rows written.

    Portable (runs on MariaDB and the SQLite test DB — spec 11 §8 debt item;
    was MariaDB-only ``ON DUPLICATE KEY UPDATE``). Update semantics: ``site``
    and ``mgmt_ip`` follow the fresh export; the per-source keys never regress
    to NULL when a source drops a device from one export; ``enabled``,
    ``device_type`` and ``snmp_capable`` are insert-only so an operator's
    web edits (a mis-classified switch corrected by hand — see
    ``api/registry.update_device``) survive a re-seed/re-import instead of
    being clobbered back to the source's guess. A genuinely new device still
    gets its type from the export on first insert.
    """
    # Existence is probed with a SELECT rather than trusting UPDATE's rowcount:
    # under PyMySQL's default "changed rows" semantics an idempotent re-seed
    # would report 0 and mis-route to INSERT. Single-writer CLI — no race.
    update_sql = (
        "UPDATE devices SET site=:site, "
        " mgmt_ip=:mgmt_ip, "
        " xiq_device_id=COALESCE(:xiq_device_id, xiq_device_id), "
        " pf_node_mac=COALESCE(:pf_node_mac, pf_node_mac), "
        " milestone_hardware_id=COALESCE(:milestone_hardware_id, milestone_hardware_id), "
        " rconfig_device_id=COALESCE(:rconfig_device_id, rconfig_device_id), "
        " threecx_ref=COALESCE(:threecx_ref, threecx_ref) "
        "WHERE name=:name"
    )
    insert_sql = (
        "INSERT INTO devices "
        "(name, site, device_type, mgmt_ip, snmp_capable, enabled, "
        " xiq_device_id, pf_node_mac, milestone_hardware_id, rconfig_device_id, threecx_ref) "
        "VALUES (:name, :site, :device_type, :mgmt_ip, :snmp_capable, :enabled, "
        " :xiq_device_id, :pf_node_mac, :milestone_hardware_id, :rconfig_device_id, :threecx_ref)"
    )
    count = 0
    for d in devices:
        params = {
            "name": d.name,
            "site": d.site,
            "device_type": d.device_type.value,
            "mgmt_ip": d.mgmt_ip,
            "snmp_capable": int(d.snmp_capable),
            "enabled": int(d.enabled),
            "xiq_device_id": d.xiq_device_id,
            "pf_node_mac": d.pf_node_mac,
            "milestone_hardware_id": d.milestone_hardware_id,
            "rconfig_device_id": d.rconfig_device_id,
            "threecx_ref": d.threecx_ref,
        }
        exists = db.fetch_one(
            engine, "SELECT 1 FROM devices WHERE name = :name", {"name": d.name}
        )
        db.execute(engine, update_sql if exists else insert_sql, params)
        count += 1
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed the device registry from source exports.")
    parser.add_argument("--config", default=None)
    parser.add_argument("--xiq", help="path to XIQ /devices export JSON")
    parser.add_argument("--pf", help="path to PacketFence nodes export JSON")
    parser.add_argument(
        "--sites", help="path to Zabbix Site/ host-group export JSON (host.get)"
    )
    parser.add_argument(
        "--sites-from-db", action="store_true",
        help="assign sites from the existing devices registry (re-seed without "
             "Zabbix — spec 11 D9); combinable with --sites, which overrides",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print reconciled devices, write nothing"
    )
    args = parser.parse_args(argv)

    xiq_rows = normalize_xiq(load_fixture(args.xiq)) if args.xiq else []
    pf_rows = normalize_pf(load_fixture(args.pf)) if args.pf else []
    devices = reconcile(xiq_rows, pf_rows)

    engine = None
    if args.sites_from_db or not args.dry_run:
        from netmon.config import load_config

        cfg = load_config(args.config)
        engine = db.make_engine(cfg.db.url)

    site_index: dict[str, str] = {}
    if args.sites_from_db:
        site_index.update(site_index_from_db(engine))
    if args.sites:
        site_index.update(load_site_index(args.sites))
    assign_sites(devices, site_index)

    unassigned = sum(1 for d in devices if d.site == UNASSIGNED_SITE)
    if not args.sites and not args.sites_from_db:
        print("NOTE: no --sites export or --sites-from-db given; "
              "every device is Unassigned.")
    print(f"reconciled {len(devices)} device(s) "
          f"({len(xiq_rows)} XIQ, {len(pf_rows)} PF; {unassigned} unassigned)")

    if args.dry_run:
        for d in devices:
            print(f"  {d.name:28} {d.site or '-':8} {d.device_type.value:16} "
                  f"{d.mgmt_ip or '-':15} xiq={d.xiq_device_id or '-'} pf={d.pf_node_mac or '-'}")
        return 0

    written = upsert_devices(engine, devices)
    print(f"upserted {written} device(s) into the registry")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

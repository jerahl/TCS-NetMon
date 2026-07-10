"""One-shot device-registry seed from XIQ + PacketFence exports.

Parses fixture/export JSON into reconciled ``devices`` rows per the rules in
``docs/spec/00-sources.md`` and upserts them. The reconciliation functions are
pure (no DB, no network) so they are unit-tested directly; ``upsert_devices``
and ``main`` handle the DB side.

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


def site_from_name(name: str) -> str | None:
    """Site = the hostname prefix before the first '-' (e.g. BHS-56-Hall→BHS).

    Returns None when the convention doesn't apply; the seed flags such rows
    (site='unknown') for owner review rather than guessing.
    """
    if not name or "-" not in name:
        return None
    prefix = name.split("-", 1)[0].strip()
    # A site code is short and alphanumeric; anything else is not a site.
    if prefix and re.fullmatch(r"[A-Za-z0-9]{2,8}", prefix):
        return prefix.upper()
    return None


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
                site=site_from_name(hostname) or "unknown",
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
                site=site_from_name(host) or "unknown",
                device_type=dtype,
                mgmt_ip=(str(ip).strip() or None) if ip else None,
                snmp_capable=dtype == DeviceType.switch,
                pf_node_mac=mac or None,
            )
        )
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
    """Insert-or-update by unique ``name``. Returns rows written."""
    sql = (
        "INSERT INTO devices "
        "(name, site, device_type, mgmt_ip, snmp_capable, enabled, "
        " xiq_device_id, pf_node_mac) "
        "VALUES (:name, :site, :device_type, :mgmt_ip, :snmp_capable, :enabled, "
        " :xiq_device_id, :pf_node_mac) "
        "ON DUPLICATE KEY UPDATE "
        " site=VALUES(site), device_type=VALUES(device_type), mgmt_ip=VALUES(mgmt_ip), "
        " snmp_capable=VALUES(snmp_capable), "
        " xiq_device_id=COALESCE(VALUES(xiq_device_id), xiq_device_id), "
        " pf_node_mac=COALESCE(VALUES(pf_node_mac), pf_node_mac)"
    )
    count = 0
    for d in devices:
        db.execute(
            engine,
            sql,
            {
                "name": d.name,
                "site": d.site,
                "device_type": d.device_type.value,
                "mgmt_ip": d.mgmt_ip,
                "snmp_capable": int(d.snmp_capable),
                "enabled": int(d.enabled),
                "xiq_device_id": d.xiq_device_id,
                "pf_node_mac": d.pf_node_mac,
            },
        )
        count += 1
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed the device registry from source exports.")
    parser.add_argument("--config", default=None)
    parser.add_argument("--xiq", help="path to XIQ /devices export JSON")
    parser.add_argument("--pf", help="path to PacketFence nodes export JSON")
    parser.add_argument(
        "--dry-run", action="store_true", help="print reconciled devices, write nothing"
    )
    args = parser.parse_args(argv)

    xiq_rows = normalize_xiq(load_fixture(args.xiq)) if args.xiq else []
    pf_rows = normalize_pf(load_fixture(args.pf)) if args.pf else []
    devices = reconcile(xiq_rows, pf_rows)

    unknown = sum(1 for d in devices if d.site == "unknown")
    print(f"reconciled {len(devices)} device(s) "
          f"({len(xiq_rows)} XIQ, {len(pf_rows)} PF; {unknown} with unknown site)")

    if args.dry_run:
        for d in devices:
            print(f"  {d.name:28} {d.site or '-':8} {d.device_type.value:16} "
                  f"{d.mgmt_ip or '-':15} xiq={d.xiq_device_id or '-'} pf={d.pf_node_mac or '-'}")
        return 0

    from netmon.config import load_config

    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)
    written = upsert_devices(engine, devices)
    print(f"upserted {written} device(s) into the registry")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

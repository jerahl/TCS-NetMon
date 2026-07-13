"""Subprocess probes: ICMP via fping, SNMP-alive via snmpget.

Read-only, no Python SNMP/ICMP library (CLAUDE.md §3). The output parser is a
pure function so it is unit-tested without the binaries installed.
"""

from __future__ import annotations

import asyncio
import re

from netmon.config import PollerConfig

# SNMPv2-MIB::sysUpTime.0 — cheap, universally present.
SYSUPTIME_OID = "1.3.6.1.2.1.1.3.0"

_FPING_LINE = re.compile(r"^(\S+)\s+is\s+(alive|unreachable)", re.MULTILINE)


def parse_fping_output(output: str) -> dict[str, bool]:
    """Parse fping stdout+stderr into {target: alive?}.

    fping prints one line per target: ``<ip> is alive`` / ``<ip> is
    unreachable``. Duplicate-target lines resolve to the last seen.
    """
    result: dict[str, bool] = {}
    for m in _FPING_LINE.finditer(output):
        result[m.group(1)] = m.group(2) == "alive"
    return result


async def fping_sweep(ips: list[str], cfg: PollerConfig) -> dict[str, bool]:
    """Run one fping over all targets (fed on stdin — no arg-length limit)."""
    if not ips:
        return {}
    cmd = [
        cfg.fping_path,
        "-r", str(cfg.fping_retries),
        "-t", str(cfg.fping_timeout_ms),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdin_data = ("\n".join(ips) + "\n").encode()
    out, err = await proc.communicate(stdin_data)
    # fping writes results to stdout; some builds put unreachable on stderr.
    return parse_fping_output(out.decode(errors="replace") + "\n" + err.decode(errors="replace"))


async def snmp_alive(ip: str, cfg: PollerConfig) -> bool:
    """True iff snmpget of sysUpTime.0 returns a value (exit 0, non-empty)."""
    cmd = [
        cfg.snmpget_path,
        f"-v{cfg.snmp_version}",
        "-c", cfg.snmp_community,
        "-t", str(cfg.snmp_timeout_s),
        "-r", str(cfg.snmp_retries),
        "-Oqv",  # quiet: value only
        ip,
        SYSUPTIME_OID,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
    except FileNotFoundError:
        raise
    return proc.returncode == 0 and out.strip() != b""


async def snmp_sweep(ips: list[str], cfg: PollerConfig) -> dict[str, bool]:
    """Probe many IPs with bounded concurrency."""
    if not ips:
        return {}
    sem = asyncio.Semaphore(max(1, cfg.snmp_concurrency))

    async def one(ip: str) -> tuple[str, bool]:
        async with sem:
            try:
                return ip, await snmp_alive(ip, cfg)
            except FileNotFoundError:
                raise
            except Exception:
                return ip, False

    pairs = await asyncio.gather(*(one(ip) for ip in ips))
    return dict(pairs)

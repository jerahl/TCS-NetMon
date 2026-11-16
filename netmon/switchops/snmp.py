"""SNMP subprocess wrappers for switch operations.

Same rule as the rest of NetMon (CLAUDE.md §3): net-snmp binaries as
subprocesses, no Python SNMP library.

**Writes** use a dedicated SNMPv3 authPriv user (``SwitchOpsConfig``). Its
passphrases never go on the command line, where any local user could read them
from ``/proc``: they are written once per process to a private ``snmp.conf``
(mode 0600, in a 0700 directory under the service's PrivateTmp) and the child
is pointed at it with ``SNMPCONFPATH``. The command NetMon logs and audits is
therefore exactly the command it runs — there is nothing to redact on it.

**Reads** (verification and the live view) use the poller's existing read
credential, the same one every inventory sweep already uses.

**No retries on a SET.** ``-r 0``: a SET that timed out may have landed, and
re-sending a PoE reset would cut power twice. Callers decide what an
unanswered SET means; the restore path, which is idempotent, retries itself.
"""

from __future__ import annotations

import asyncio
import atexit
import logging
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from typing import Awaitable, Callable

from netmon.config import PollerConfig, SwitchOpsConfig
from netmon.poller.snmp_inventory import _WALK_LINE, _clean_value

log = logging.getLogger("netmon.switchops.snmp")

#: (argv, extra_env) -> (returncode, stdout, stderr). Injectable for tests.
Runner = Callable[[list[str], dict[str, str]], Awaitable[tuple[int, str, str]]]

# --- OIDs -------------------------------------------------------------------
IF_ADMIN = "1.3.6.1.2.1.2.2.1.7"           # ifAdminStatus      up(1) down(2)
IF_OPER = "1.3.6.1.2.1.2.2.1.8"            # ifOperStatus
IF_IN_ERR = "1.3.6.1.2.1.2.2.1.14"
IF_OUT_ERR = "1.3.6.1.2.1.2.2.1.20"
IF_IN_DISC = "1.3.6.1.2.1.2.2.1.13"
IF_OUT_DISC = "1.3.6.1.2.1.2.2.1.19"
IF_HC_IN = "1.3.6.1.2.1.31.1.1.1.6"
IF_HC_OUT = "1.3.6.1.2.1.31.1.1.1.10"
IF_HIGHSPEED = "1.3.6.1.2.1.31.1.1.1.15"
PETH_ADMIN = "1.3.6.1.2.1.105.1.1.1.3"     # pethPsePortAdminEnable true(1) false(2)
PETH_DETECT = "1.3.6.1.2.1.105.1.1.1.6"    # pethPsePortDetectionStatus
EXT_POE_RESET = "1.3.6.1.4.1.1916.1.27.2.1.1.5"  # extremePethPortResetPower set(1) clear(2)
EXT_POE_MW = "1.3.6.1.4.1.1916.1.27.2.1.1.6"     # per-port measured power, mW
FDB_PORT = "1.3.6.1.2.1.17.4.3.1.2"        # dot1dTpFdbPort
BASE_PORT_IFINDEX = "1.3.6.1.2.1.17.1.4.1.2"     # dot1dBasePortIfIndex

#: pethPsePortDetectionStatus: disabled(1) searching(2) deliveringPower(3)
#: fault(4) test(5) otherFault(6)
PETH_DETECT_NAMES = {"1": "disabled", "2": "searching", "3": "delivering",
                     "4": "fault", "5": "test", "6": "other_fault"}

_MISSING = ("no such instance", "no such object", "no more variables")


def is_missing(value: str | None) -> bool:
    return value is None or any(m in value.lower() for m in _MISSING)


def enum_int(value: str | None) -> int | None:
    """Integer of an enum/INTEGER value, numeric or MIB-translated ("up(1)")."""
    if is_missing(value):
        return None
    m = re.search(r"\((\d+)\)", value) or re.match(r"\s*(-?\d+)", value)
    return int(m.group(1)) if m else None


def parse_get(output: str) -> dict[str, str]:
    """``-On`` output → {numeric oid without leading dot: cleaned value}."""
    out: dict[str, str] = {}
    for line in output.splitlines():
        m = _WALK_LINE.match(line)
        if m:
            out[m.group(1).lstrip(".")] = _clean_value(m.group(2))
    return out


async def _default_runner(argv: list[str], extra_env: dict[str, str],
                          timeout: float = 60.0) -> tuple[int, str, str]:
    env = dict(os.environ)
    env.update(extra_env)
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, "", f"{argv[0]} did not exit within {timeout:.0f}s"
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


# --- writes -----------------------------------------------------------------

@dataclass(frozen=True)
class SetResult:
    ok: bool
    command: str          # exactly what ran (no secrets are on it)
    detail: str           # switch's answer, or why it failed
    dry_run: bool = False
    #: True when the switch gave no answer: the SET may or may not have landed.
    unanswered: bool = False


class SnmpWriter:
    """snmpset with the SNMPv3 write user."""

    def __init__(self, cfg: SwitchOpsConfig, runner: Runner | None = None) -> None:
        self.cfg = cfg
        self._runner = runner or _default_runner
        self._confdir: str | None = None

    # The conf file is the only place the passphrases are written.
    def _conf_env(self) -> dict[str, str]:
        if not self.cfg.has_credentials:
            return {}
        for v in (self.cfg.v3_user, self.cfg.v3_auth_pass, self.cfg.v3_priv_pass):
            if any(c.isspace() for c in v):
                # snmp.conf values end at whitespace; a passphrase with a space
                # would be silently truncated into a different, wrong secret.
                raise ValueError("SNMPv3 user/passphrases may not contain whitespace")
        if self._confdir is None:
            d = tempfile.mkdtemp(prefix="netmon-snmpv3-")
            os.chmod(d, 0o700)
            path = os.path.join(d, "snmp.conf")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(
                    "defVersion 3\n"
                    f"defSecurityName {self.cfg.v3_user}\n"
                    "defSecurityLevel authPriv\n"
                    f"defAuthType {self.cfg.auth_protocol}\n"
                    f"defPrivType {self.cfg.priv_protocol}\n"
                    f"defAuthPassphrase {self.cfg.v3_auth_pass}\n"
                    f"defPrivPassphrase {self.cfg.v3_priv_pass}\n"
                )
            self._confdir = d
            atexit.register(shutil.rmtree, d, True)
        # SNMP_PERSISTENT_DIR: net-snmp caches engine boots/time there; the
        # default /var/lib/snmp is read-only under ProtectSystem=strict.
        return {"SNMPCONFPATH": self._confdir, "SNMP_PERSISTENT_DIR": self._confdir}

    def argv(self, ip: str, oid: str, value: int) -> list[str]:
        return [self.cfg.snmpset_path, "-v3", "-t", str(self.cfg.timeout_s), "-r", "0",
                "-On", ip, oid, "i", str(int(value))]

    def command(self, ip: str, oid: str, value: int) -> str:
        return " ".join(self.argv(ip, oid, value)) + (
            f"   # SNMPv3 user {self.cfg.v3_user or '<unset>'}, authPriv "
            f"{self.cfg.auth_protocol}/{self.cfg.priv_protocol}")

    async def set_int(self, ip: str, oid: str, value: int, *, dry_run: bool | None = None
                      ) -> SetResult:
        cmd = self.command(ip, oid, value)
        if self.cfg.dry_run if dry_run is None else dry_run:
            log.warning("DRY RUN — would run: %s", cmd)
            return SetResult(ok=True, command=cmd, detail="dry run: not sent", dry_run=True)
        if not self.cfg.has_credentials:
            return SetResult(ok=False, command=cmd,
                             detail="no SNMPv3 write credentials (NETMON_SNMP_RW_* unset)")
        rc, out, err = await self._runner(self.argv(ip, oid, value), self._conf_env())
        text = (out + "\n" + err).strip()
        if rc == 0 and not re.search(r"error|reason", text, re.IGNORECASE):
            log.warning("snmpset %s %s = %s -> ok", ip, oid, value)
            return SetResult(ok=True, command=cmd, detail=text.splitlines()[0] if text else "ok")
        unanswered = "timeout" in text.lower() or rc == 124
        log.error("snmpset %s %s = %s failed: %s", ip, oid, value, text[:300])
        return SetResult(ok=False, command=cmd, detail=text[:300] or f"exit {rc}",
                         unanswered=unanswered)


# --- reads ------------------------------------------------------------------

class SnmpReader:
    """snmpget / snmpbulkwalk with the poller's read credential."""

    def __init__(self, poller_cfg: PollerConfig, cfg: SwitchOpsConfig,
                 runner: Runner | None = None) -> None:
        self.pcfg = poller_cfg
        self.cfg = cfg
        self._runner = runner or _default_runner

    def _auth(self) -> list[str]:
        return [f"-v{self.pcfg.snmp_version}", "-c", self.pcfg.snmp_community]

    async def get(self, ip: str, oids: list[str]) -> dict[str, str]:
        argv = [self.cfg.snmpget_path, *self._auth(), "-t", str(self.cfg.timeout_s),
                "-r", "1", "-On", ip, *oids]
        rc, out, err = await self._runner(argv, {})
        if rc != 0 and not out.strip():
            raise SnmpReadError((err or f"snmpget exit {rc}").strip()[:200])
        return parse_get(out)

    async def walk(self, ip: str, root: str) -> dict[str, str]:
        """{suffix after root: value}."""
        argv = [self.cfg.snmpbulkwalk_path, *self._auth(), "-t", str(self.cfg.timeout_s),
                "-r", "1", "-On", ip, root]
        rc, out, err = await self._runner(argv, {})
        if rc != 0 and not out.strip():
            raise SnmpReadError((err or f"snmpbulkwalk exit {rc}").strip()[:200])
        res: dict[str, str] = {}
        prefix = root + "."
        for oid, val in parse_get(out).items():
            if oid.startswith(prefix):
                res[oid[len(prefix):]] = val
        return res


class SnmpReadError(RuntimeError):
    pass

#!/usr/bin/env python3
"""WinRM readiness check for the Milestone recording servers (OpenProject #111).

#111 needs WinRM/CIM against the 22 recorders to read `Win32_LogicalDisk` —
the physical volume size that neither the Milestone Config API nor the MIP SDK
exposes, and the missing third input for real retention (spec 19 §8, OP #93).

**This script does not query anything.** It cannot: the NetMon host has no WinRM
client, no Kerberos (`/etc/krb5.conf` absent) and no `pywinrm`. What it does is
answer the questions you need answered *before* an account is provisioned:

  1. Is a WinRM listener up, and on which port?
  2. Which authentication mechanisms does it offer?
  3. On 5986, what certificate does it present — and would a Linux client trust it?

All of that is available unauthenticated, because WinRM answers an anonymous
POST to /wsman with `401` plus a `WWW-Authenticate` header listing what it
accepts. One TCP connect and one unauthenticated POST per host is exactly what
any monitoring probe does.

**Deliberately not used: impacket, or WMI over DCOM.** Cortex XDR is in this
estate, and a Linux host reaching 22 Windows servers over DCOM looks like
lateral movement. WinRM is ordinary administrative traffic and should stay that
way (spec 19 §3).

Read-only. Sends no credentials, stores nothing.

Usage:
    python scripts/winrm_check.py                 # all recorders in the registry
    python scripts/winrm_check.py HOST [HOST...]  # specific hosts
    python scripts/winrm_check.py --json
"""

from __future__ import annotations

import argparse
import json
import socket
import ssl
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

HTTP_PORT = 5985           # WinRM over HTTP
HTTPS_PORT = 5986          # WinRM over HTTPS — what #111 specifies
CONNECT_TIMEOUT = 4.0

# Minimal SOAP envelope. The listener rejects an anonymous request with 401
# before it parses a body, so the content only has to be well-formed enough to
# be a POST. Nothing here asks the server to do anything.
_PROBE_BODY = (
    b'<?xml version="1.0" encoding="utf-8"?>'
    b'<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"/>'
)


def _tcp_open(host: str, port: int, timeout: float = CONNECT_TIMEOUT) -> tuple[bool, str]:
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True, "open"
    except socket.timeout:
        return False, "timeout"
    except ConnectionRefusedError:
        return False, "refused"
    except OSError as exc:
        return False, exc.__class__.__name__.replace("Error", "").lower()[:7]
    finally:
        s.close()


def _cert_info(host: str, port: int = HTTPS_PORT) -> dict:
    """Certificate the listener presents, fetched without verifying it.

    Verification is off on purpose: the point is to *see* what is there. A
    self-signed or hostname-mismatched certificate is the normal state for a
    default WinRM HTTPS listener and is exactly what a Linux client has to be
    told about, so reporting it beats failing on it.
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with socket.create_connection((host, port), CONNECT_TIMEOUT) as raw:
            with ctx.wrap_socket(raw, server_hostname=host) as tls:
                info = tls.getpeercert()
                out = {"tls": tls.version(), "cipher": (tls.cipher() or ["?"])[0]}
    except Exception as exc:                       # noqa: BLE001 - diagnostic
        return {"error": f"{exc.__class__.__name__}: {exc}"}

    # getpeercert() is empty when verification is off, so report what we can
    # get without it and note the cert is unverified.
    out["verified"] = False
    if info:
        subj = dict(x[0] for x in info.get("subject", ()) if x)
        issuer = dict(x[0] for x in info.get("issuer", ()) if x)
        out["subject"] = subj.get("commonName")
        out["issuer"] = issuer.get("commonName")
        out["notAfter"] = info.get("notAfter")
    return out


def _winrm_probe(host: str, port: int) -> dict:
    """POST /wsman anonymously and read the auth challenge from the 401."""
    import http.client

    scheme_https = port == HTTPS_PORT
    try:
        if scheme_https:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            conn = http.client.HTTPSConnection(host, port, timeout=CONNECT_TIMEOUT, context=ctx)
        else:
            conn = http.client.HTTPConnection(host, port, timeout=CONNECT_TIMEOUT)
        conn.request("POST", "/wsman", body=_PROBE_BODY,
                     headers={"Content-Type": "application/soap+xml;charset=UTF-8"})
        resp = conn.getresponse()
        # A 401 is the expected, healthy answer to an anonymous request.
        auth = [v for k, v in resp.getheaders() if k.lower() == "www-authenticate"]
        server = resp.getheader("Server") or ""
        resp.read()
        conn.close()
        return {"status": resp.status, "auth": auth, "server": server}
    except Exception as exc:                       # noqa: BLE001 - diagnostic
        return {"error": f"{exc.__class__.__name__}: {exc}"}


def check_host(host: str) -> dict:
    out: dict = {"host": host}
    for port, key in ((HTTPS_PORT, "https"), (HTTP_PORT, "http")):
        ok, why = _tcp_open(host, port)
        entry: dict = {"port": port, "reachable": ok, "detail": why}
        if ok:
            entry.update(_winrm_probe(host, port))
        out[key] = entry
    if out["https"]["reachable"]:
        out["cert"] = _cert_info(host)
    return out


def _mechs(entry: dict) -> list[str]:
    """Auth mechanisms named in the WWW-Authenticate headers."""
    names = []
    for h in entry.get("auth") or []:
        for tok in h.replace(",", " ").split():
            t = tok.strip().rstrip(",")
            if t and not t.startswith(("realm", "qop", "nonce")) and "=" not in t:
                names.append(t)
    seen, out = set(), []
    for n in names:
        if n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out


def registry_hosts() -> list[str]:
    from netmon import db
    from netmon.config import load_config

    eng = db.make_engine(load_config().db.url)
    rows = db.fetch_all(
        eng,
        "SELECT d.name, COALESCE(NULLIF(d.mgmt_ip, ''), rs.hostname) AS addr "
        "FROM devices d LEFT JOIN recording_servers rs ON rs.device_id = d.id "
        "WHERE d.device_type = 'recording_server' AND d.enabled = 1 ORDER BY d.name",
    )
    return [r["addr"] for r in rows if r["addr"]]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("hosts", nargs="*", help="hosts to check (default: recorders in the registry)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)

    hosts = args.hosts or registry_hosts()
    if not hosts:
        print("no recording servers in the registry and none given on the command line")
        return 2

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(check_host, hosts))

    if args.json:
        print(json.dumps({"generated_at": datetime.now(timezone.utc).isoformat(),
                          "results": results}, indent=2))
        return 0

    print(f"WinRM readiness — {len(results)} recorder(s), "
          f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC")
    print("Read-only. No credentials sent; an anonymous POST to /wsman is expected "
          "to return 401.\n")
    print(f"{'recorder':<24} {'5986':>8} {'5985':>8}  {'status':<11} auth offered")
    print("-" * 84)

    ready = blocked = 0
    for r in sorted(results, key=lambda x: x["host"]):
        h = r["host"].split(".")[0][:23]
        https, http = r["https"], r["http"]
        s6 = "open" if https["reachable"] else https["detail"][:7]
        s5 = "open" if http["reachable"] else http["detail"][:7]
        best = https if https.get("status") else http
        code = best.get("status")
        mechs = ", ".join(_mechs(best)) or "—"
        if code == 401:
            state, note = "listening", mechs
            ready += 1
        elif code:
            state, note = f"HTTP {code}", mechs
            ready += 1
        else:
            state = "no listener"
            note = (https.get("error") or http.get("error") or "")[:44]
            blocked += 1
        print(f"{h:<24} {s6:>8} {s5:>8}  {state:<11} {note}")

    print(f"\n{ready} listening, {blocked} not reachable.")

    # The failure mode is the actionable part, and the two look identical in a
    # bare "unreachable" count. Refused means the host answered and nothing is
    # listening — enable WinRM there. Timeout means the packet was dropped —
    # a firewall between here and the host, not a host configuration.
    refused, filtered = [], []
    for r in results:
        if r["https"].get("status") or r["http"].get("status"):
            continue
        det = {r["https"]["detail"], r["http"]["detail"]}
        (filtered if "timeout" in det else refused).append(r["host"].split(".")[0])
    if refused:
        print(f"\n  REFUSED on both ports — host is up, no WinRM listener; enable it:"
              f"\n    {', '.join(sorted(refused))}")
    if filtered:
        print(f"\n  TIMEOUT on both ports — packets dropped, so a firewall between this"
              f"\n  host and the recorder rather than a recorder setting:"
              f"\n    {', '.join(sorted(filtered))}")
    only_http = [r["host"].split(".")[0] for r in results
                 if r["http"].get("status") and not r["https"].get("status")]
    if only_http:
        print(f"\n  5985 only, 5986 refused ({len(only_http)} of {len(results)}) — #111 specifies"
              f"\n  5986/tcp, but HTTPS is not listening on most of the estate. Negotiate/Kerberos"
              f"\n  still encrypts the payload at the message layer over 5985, so this is usable;"
              f"\n  it is a deviation from the ticket worth deciding rather than discovering.")

    certs = [r for r in results if r.get("cert", {}).get("subject")]
    if certs:
        c = certs[0]["cert"]
        print(f"\nHTTPS certificate (sample): subject={c.get('subject')} "
              f"issuer={c.get('issuer')} expires={c.get('notAfter')}")
        if c.get("subject") and c.get("subject") == c.get("issuer"):
            print("  Self-signed — a Linux client must be given the CA or told to skip "
                  "verification explicitly.")

    print("""
What this cannot tell you, and what #111 needs next:

  * Whether an account can actually authenticate. This host has no WinRM client,
    no Kerberos (/etc/krb5.conf is absent) and no pywinrm, so nothing here sends
    credentials. A listening port and an offered mechanism are necessary, not
    sufficient.
  * To go further you need, in order:
      1. an account — a JEA constrained endpoint, or one scoped to the
         root/cimv2 WMI namespace, which is all Win32_LogicalDisk requires;
      2. a client on this host. `pywinrm` is the ordinary choice and is a new
         dependency, so it needs sign-off (CLAUDE.md §3);
      3. for Kerberos rather than NTLM, /etc/krb5.conf pointing at the domain
         and a keytab or ticket for the service account.

  Not impacket, and not WMI over DCOM: Cortex XDR is in this estate and a Linux
  host reaching 22 Windows servers that way looks like lateral movement. WinRM
  is ordinary admin traffic.""")
    return 0


if __name__ == "__main__":       # pragma: no cover
    sys.exit(main())

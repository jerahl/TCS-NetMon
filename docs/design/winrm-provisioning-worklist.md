# WinRM provisioning worklist — 22 Milestone recorders

**Measured 2026-09-04** by `scripts/winrm_check.py` (read-only, no credentials sent).
For OpenProject **#111** — `Win32_LogicalDisk`, the physical volume size that
neither the Milestone Config API nor the MIP SDK exposes.

## Headline

| | |
|---|---|
| Ready for an account today | **19** |
| Need WinRM enabled | **2** |
| Need a firewall rule | **1** |

**Use port 5985, not 5986.** #111 specifies 5986/tcp, but no recorder serves
WinRM there: 18 refuse the port outright and the four that accept a TCP
connection (`arc`, `nms`, `okd`, `sky`) reset during the TLS handshake, so
nothing is listening behind it. All 19 working listeners are plain 5985
offering `Negotiate, Kerberos` — no Basic, no NTLM-only. Negotiate/Kerberos
encrypts the payload at the message layer, so 5985 is not cleartext.

## Per recorder

| Recorder | Site | 5985 | 5986 | Needs |
|---|---|---|---|---|
| `ALB-BCD-DVR` | TASPA | listening | refused | Account only |
| `ARC-DVR-MILESTONE` | Arcadia | listening | open, TLS reset | Account only |
| `CES-BCD-DVR` | Central Elementary | listening | refused | Account only |
| `CHS-BCD-DVR` | Central High | listening | refused | Account only |
| `EMS-BCD-DVR` | Eastwood Middle | listening | refused | Account only |
| `MLK-DVR1-MS` | MLK | listening | refused | Account only |
| `NHS-BCD-DVR` | Northridge High | listening | refused | Account only |
| `NMS-DVR1-Milestone` | Northridge Middle | listening | open, TLS reset | Account only |
| `OKD-DVR-MS` | Oakdale | listening | open, TLS reset | Account only |
| `OKH-BCD-DVR` | New Heights | listening | refused | Account only |
| `RQS-BCD-DVR` | Rock Quarry | listening | refused | Account only |
| `SKY-MS-DVR` | Skyland | listening | open, TLS reset | Account only |
| `TCT-BCD-DVR` | TCTA | listening | refused | Account only |
| `TMS-BCD-DVR` | TMS | listening | refused | Account only |
| `UP-BCD-DVR` | University Place | listening | refused | Account only |
| `VES-BCD-DVR` | Verner | listening | refused | Account only |
| `WFS-BCD-DVR` | Woodland Forrest | listening | refused | Account only |
| `WMS-BCD-DVR` | Westlawn Middle | listening | refused | Account only |
| `bhs-bcddvr-ms` | Bryant High | listening | refused | Account only |
| `SVE-BCD-DVR` | Southview | refused | refused | Enable WinRM, then account |
| `TRAN-BCD-MS` | Unassigned | refused | refused | Enable WinRM, then account |
| `CO-BCD-DVR` | Central Office | timeout | timeout | Firewall rule to 5985, then account |

## The three exceptions, in detail

- **`SVE-BCD-DVR`** (Southview, `sve-bcd-dvr.tcs.tusc.k12.al.us`) — **WinRM not enabled.** The host answers and refuses both ports, so there is no listener to talk to. Enable the service and create a 5985 listener.
- **`TRAN-BCD-MS`** (Unassigned, `tran-bcd-ms.tcs.tusc.k12.al.us`) — **WinRM not enabled.** The host answers and refuses both ports, so there is no listener to talk to. Enable the service and create a 5985 listener.
- **`CO-BCD-DVR`** (Central Office, `co-bcd-dvr.tcs.tusc.k12.al.us`) — **Filtered.** Both ports time out rather than refusing, which means packets are dropped in transit — a firewall between the NetMon host and this recorder, not a setting on the recorder itself.

All three are otherwise healthy: ICMP up and Milestone reporting them up, so
this is specifically a WinRM gap rather than a dead host.

## What an account needs

Least privilege that still answers the question:

- a **JEA constrained endpoint**, or an account scoped to the **`root/cimv2`**
  WMI namespace — that namespace is all `Win32_LogicalDisk` requires;
- read-only is sufficient; nothing in #111 writes;
- domain account, since all 19 listeners offer Kerberos and the recorders are
  domain-joined.

Then on the NetMon host, two things that are not yet present:

- a WinRM client — `pywinrm` is the ordinary choice and is **a new dependency
  requiring sign-off** (CLAUDE.md §3);
- `/etc/krb5.conf` for the domain plus a keytab or ticket, if Kerberos rather
  than NTLM-via-Negotiate.

Deliberately **not** impacket or WMI over DCOM: Cortex XDR is in this estate and
a Linux host reaching 22 Windows servers that way looks like lateral movement.

"""Bosch camera profile (spec 20 S8 / D11) — 2,528 of 2,651 cameras here.

**Nothing in this module has been executed against a camera.** The transport
below was proven read-only against a live FLEXIDOME IP 5000i IR on 2026-09-08;
the write path is written from the mechanism spec 20 names and stays unreachable
until `[camera_ops]` is armed and the owner's lab camera has proved it.

What the live probe established:

* RCP+ over HTTPS with the same Digest auth the snapshot proxy uses:
  ``GET /rcp.xml?command=0x0600&type=P_OCTET&direction=READ`` → **200**,
  ``text/xml``, a well-formed ``<rcp>`` envelope echoing command, type,
  direction and carrying a ``<payload>``. So the interface exists, answers, and
  authenticates with the account NetMon already holds.
* The plain info paths a profile might have preferred do not: ``/info.xml``,
  ``/version.xml``, ``/device.xml`` and ``/deviceinfo.xml`` all answer 400.
* The command **code** for firmware version is not derivable from the device
  itself: ``/js/rcp.js`` is a generic transport library with no command
  constants (0 occurrences of "firmware"), and the reference bundle carries no
  Bosch RCP+ material. Guessing a code and sending it to 2,528 cameras is
  exactly the class of invention this project forbids, so
  :func:`read_firmware_version` refuses instead — and the batch runner falls
  back to Milestone's value, which is the arrangement the owner chose
  (vendor read preferred, Milestone fallback, 2026-09-08).

Filling that gap needs one line from Bosch's RCP+ command documentation, not
more code.
"""

from __future__ import annotations

import re
from typing import Any

VENDOR = "bosch"

#: Bosch's compact firmware form (`783`) is what many of these cameras report;
#: comparison is `netmon.cameras.firmware`'s job, not this module's.
_PAYLOAD = re.compile(r"<payload>(.*?)</payload>", re.S)


class VendorReadUnavailable(Exception):
    """This profile cannot read the value, and will not guess at it."""


class VendorWriteUnavailable(Exception):
    """This profile cannot perform the write on this device."""


def rcp_read_url(base_url: str, command: str, *, type_: str = "P_OCTET") -> str:
    """One RCP+ **read**. `direction=READ` is what keeps it a read.

    The command is a caller-supplied hex string only in the sense that *this
    module* supplies it — callers outside pass a named operation, never a raw
    code, so no request path can be steered from an API body.
    """
    if not re.fullmatch(r"0x[0-9a-fA-F]{4}", command):
        raise ValueError(f"not an RCP+ command code: {command!r}")
    return f"{base_url.rstrip('/')}/rcp.xml?command={command}&type={type_}&direction=READ"


def parse_rcp_payload(xml: str) -> str | None:
    """The `<payload>` of an RCP+ reply, or None when there is not one."""
    m = _PAYLOAD.search(xml or "")
    if not m:
        return None
    return m.group(1).strip() or None


def read_firmware_version(*_args: Any, **_kwargs: Any) -> str:
    """Not implemented, on purpose — see this module's docstring.

    The RCP+ transport works; the command code for firmware version is not
    documented in anything this repository can see, and the camera's own UI does
    not name it. The runner treats this as "ask Milestone instead" rather than
    as a failure, so verification still happens — with `verified_by = milestone`
    recorded on the item so nobody mistakes the weaker evidence for the stronger.
    """
    raise VendorReadUnavailable(
        "Bosch firmware version needs the RCP+ command code from Bosch's own "
        "documentation; NetMon will not guess one. Falling back to Milestone.")


def firmware_upload_request(base_url: str, filename: str, blob: bytes) -> dict:
    """The multipart POST that spec 20 names as the Bosch firmware mechanism.

    Returned as a description rather than sent, so it can be asserted against in
    tests and reviewed by eye before it ever reaches hardware. The caller adds
    auth and timeouts.

    **Unverified against a device.** `/upload.htm` is what the spec records;
    nothing here has confirmed it on this fleet, and confirming it is precisely
    what the lab camera is for.
    """
    if not filename or "/" in filename or "\\" in filename:
        raise ValueError("firmware filename must be a bare name from the image store")
    if not blob:
        raise ValueError("refusing to upload an empty firmware image")
    return {
        "method": "POST",
        "url": f"{base_url.rstrip('/')}/upload.htm",
        "files": {"file": (filename, blob, "application/octet-stream")},
        # A firmware upload is not a request to retry: a second attempt landing
        # mid-flash is how a camera stops coming back.
        "retries": 0,
    }

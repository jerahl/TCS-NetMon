"""Bosch camera profile (spec 20 S8 / D11) — 2,528 of 2,651 cameras here.

The read path is **proven against live hardware**; the write path is not, and
stays unreachable until `[camera_ops]` is armed on the nominated test camera.

**Reading the firmware version.** From *Bosch RCP+ Reference, Firmware 9.80*
(`docs/RCP_doc_9_80_0106.pdf`, owner-supplied 2026-09-08):

    2.612  CONF_SOFTWARE_VERSION_FORMATTED   [API: system.settings]
           code 0x0cd4 · Read p_string · access level "minimal"
           "Read the software version in the form <major>.<minor>.<build>"
           available on CPP6/CPP7/CPP7.3, CPP13, CPP14/CPP15/CPP16

    2.611  CONF_SOFTWARE_VERSION             code 0x002f · Read p_string · "always"

The *formatted* command is the one used, because `<major>.<minor>.<build>` is
precisely the precision `netmon.cameras.firmware.verify` needs to answer
`VERIFIED` rather than `INDETERMINATE` — the compact `783` form that 888 cameras
report through Milestone can never prove a build number.

**Where the answer actually lives.** Not in `<payload>`: that element echoes the
*request*, and is empty on every reply. The value is in `<result><str>`.
Verified live on two cameras 2026-09-08 — both returned `7.83.0027`, matching
Milestone exactly, which is the first independent confirmation that the two
sources agree:

    GET /rcp.xml?command=0x0cd4&type=P_STRING&direction=READ
    → 200 text/xml
      <rcp><command><hex>0x0cd4</hex>…</command><type>P_STRING</type>
           <direction>READ</direction><payload></payload>
           <result><str>7.83.0027</str></result></rcp>

**What the doc says about uploads**, recorded because it changes how a failed
push will be diagnosed once the write path is live:

* `CONF_UPLOAD_PROGRESS` (0x0701) is a *message*, not a readable value — it is
  pushed on a subscribed session and carries 1-100 % plus a precise error
  taxonomy (:data:`UPLOAD_ERRORS`), including "wrong or no signature" and "flash
  type incompatible". Far better evidence than inferring failure from a version
  that did not change.
* `CONF_UPLOAD_HISTORY` (0x0b44, Read p_octet) keeps the last ten uploads and
  *is* readable over this interface. It is the natural second source for
  verification, and is not parsed yet: the payload is a binary ring buffer whose
  layout cannot be checked against anything until a real upload has happened.
* `CONF_DEVICE_CAPABILITIES` tag 30 `FW_UPLOAD_SIGNATURE_TAG` says whether a
  device *requires signed firmware* — a pre-flight check worth adding before the
  first ring, since an unsigned image on such a device fails at error 118.

The doc covers RCP+ commands only; it contains no upload endpoint, so
`/upload.htm` remains what spec 20 records and what the test camera will confirm
or refute. That is precisely what the proving ground is for.
"""

from __future__ import annotations

import re
from typing import Any

VENDOR = "bosch"

#: CONF_SOFTWARE_VERSION_FORMATTED — `<major>.<minor>.<build>`, access level
#: "minimal", available on every CPP platform this estate runs.
CMD_SOFTWARE_VERSION_FORMATTED = "0x0cd4"
#: CONF_SOFTWARE_VERSION — the unformatted sibling, kept as a documented
#: fallback for a device that ever refuses the formatted one.
CMD_SOFTWARE_VERSION = "0x002f"
#: CONF_UPLOAD_HISTORY / CONF_UPLOAD_PROGRESS. Neither is parsed yet; see the
#: module docstring for why, and for what they will be worth when the write path
#: is live.
CMD_UPLOAD_HISTORY = "0x0b44"
CMD_UPLOAD_PROGRESS = "0x0701"

#: CONF_UPLOAD_PROGRESS values above 100, verbatim from the RCP+ reference.
#: Recorded now because these are the words a failed firmware push will need to
#: be explained in, and "the version did not change" is not one of them.
UPLOAD_ERRORS = {
    101: "header error", 102: "write error", 103: "read back error",
    104: "verify error", 105: "checksum mismatch: written data",
    106: "checksum mismatch: received data", 110: "magic error",
    111: "version too low", 112: "flash type incompatible",
    113: "device check failed", 114: "file entry marker failed",
    115: "chunk size error", 116: "area already written",
    117: "black/white list check", 118: "wrong or no signature",
    119: "signature invalid", 130: "invalid file name", 131: "ROM init error",
}

#: `<payload>` echoes the request and is empty on every reply; the answer is in
#: `<result><str>`. Both are matched so the difference stays visible in code
#: rather than being rediscovered by whoever reads an empty string next.
_PAYLOAD = re.compile(r"<payload>(.*?)</payload>", re.S)
_RESULT_STR = re.compile(r"<result>\s*<str>(.*?)</str>", re.S)


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
    """The `<payload>` element — which echoes the *request* and is empty in
    practice. Kept so the distinction from `<result><str>` is documented in code
    rather than rediscovered by whoever next reads an empty string."""
    m = _PAYLOAD.search(xml or "")
    if not m:
        return None
    return m.group(1).strip() or None


def parse_version(xml: str) -> str | None:
    """The version string out of an RCP+ reply, or None if it carries none."""
    m = _RESULT_STR.search(xml or "")
    if not m:
        return None
    return m.group(1).strip() or None


def version_read_request(base_url: str) -> dict:
    """The GET that asks a Bosch camera its own firmware version.

    Described rather than sent, like :func:`firmware_upload_request`, so the I/O
    stays in the runner where it can be driven by a fake transport.
    """
    return {
        "method": "GET",
        "url": rcp_read_url(base_url, CMD_SOFTWARE_VERSION_FORMATTED, type_="P_STRING"),
        "parse": parse_version,
    }


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

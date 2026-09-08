"""Camera snapshot URL construction (spec 11 D7, spec 20 S4).

Pure functions over a stored camera row: no I/O, no config, no HTTP. The
endpoint in ``api/surveillance.py`` does the fetching; everything that can be
got *wrong* lives here, where it can be tested against the estate's real shapes
rather than against a hand-built fixture that would contain none of the
oddities.

Four things this module exists to get right, each of which was a live finding
rather than a guess:

1. **The scheme is neither in the address nor reliably in a field.** Milestone
   stores every hardware address as ``http://<ip>/`` — 100% of 2,489 records —
   while ``hardwareDriverSettings.httpSEnabled`` claims whether the camera
   speaks TLS: **1,695 of 2,651 cameras (64%) say yes and 956 say no**. Trusting
   that field as the single answer was wrong in the field (owner, 2026-09-08:
   "some cameras are http and some are https, it will need to try both"), so
   this module returns an ordered *list* of candidates — **https first, then
   http** — and the caller tries the next one when the transport fails. The
   field still shapes the ports, and the endpoint remembers per camera which
   scheme answered so the extra attempt is paid once, not per tile refresh.
2. **``httpSEnabled`` is the string ``'Yes'``**, not a boolean (handled at
   collection time, migration 027; the column here is already 1/0/NULL).
3. **A camera can be one imager of several on a shared device.** 178 cameras
   here have ``channel > 0``, and a bare ``/snap.jpg`` on such a device returns
   the *wrong imager* — silently, with a plausible picture. That is worse than
   an error, so an unverified channel parameter is refused rather than guessed.
4. **Six cameras carry an explicit port**, five of them ``:443`` on an ``http``
   scheme. Dropping the port sends the request to the wrong socket, so each
   candidate scheme carries the port that belongs to it (see :func:`_hostport`).

The vendor string is Milestone's *driver* name, not a tidy vendor: this estate
reports ``Bosch1ch`` (2,019), ``Bosch`` (509), ``ONVIF`` (91) and four Axis
variants (32). So profiles match on a lowercase prefix.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

# ZCD's whitelist (`ActionCameraSnapshot::normSize`), kept verbatim so a size
# that worked there works here.
_NAMED_SIZES = ("S", "M", "L", "XL")
_WXH = re.compile(r"^\d{2,4}x\d{2,4}$")

# Axis has no S/M/L vocabulary; map the named sizes onto resolutions that exist
# on every VAPIX camera.
_AXIS_RESOLUTION = {"S": "320x240", "M": "352x288", "L": "640x480", "XL": "1280x720"}


class SnapshotUnavailable(Exception):
    """No snapshot URL can be built, with a reason fit to show an operator.

    ``status`` is the HTTP status the endpoint should answer with: 404 when the
    camera cannot be addressed at all, 501 when NetMon does not know how to ask
    this particular camera.
    """

    def __init__(self, reason: str, status: int = 501) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


@dataclass(frozen=True)
class SnapshotTarget:
    url: str
    #: ``https`` or ``http``. Named rather than re-parsed out of the URL because
    #: the endpoint remembers it: whichever scheme a camera answers on is worth
    #: trying first next time.
    scheme: str
    #: Whether TLS verification should be attempted. Cameras on the VMS network
    #: carry self-signed certificates, so this is False in practice — but it is
    #: returned rather than assumed so the caller cannot forget it is a choice.
    verify: bool


def normalise_size(size: Any) -> str:
    """Whitelist the requested size. Anything unrecognised becomes ``M``.

    A whitelist rather than escaping, because this value is interpolated into a
    query string: ZCD does the same, and the failure mode of getting it wrong
    is a caller steering the request.
    """
    s = str(size or "").strip()
    if s.upper() in _NAMED_SIZES:
        return s.upper()
    if _WXH.match(s):
        return s
    return "M"


def vendor_profile(vendor: Any) -> str:
    """Map Milestone's driver name to a snapshot profile.

    Prefix matching, because the driver name encodes the channel count
    (``Bosch1ch``, ``Axis11ChDevice``) and new variants appear with firmware.
    """
    v = str(vendor or "").strip().lower()
    if v.startswith("bosch"):
        return "bosch"
    if v.startswith("axis"):
        return "axis"
    if v.startswith("onvif"):
        return "onvif"
    return ""


def build_candidates(cam: dict, *, size: str = "M",
                     channel_param: str = "") -> list[SnapshotTarget]:
    """Snapshot URLs to try for one stored camera row, best first.

    ``cam`` is a row from the ``cameras`` table: ``ip``, ``http_port``,
    ``https_enabled``, ``https_port``, ``vendor``, ``channel``. Nothing is taken
    from a caller except the size, which is whitelisted.

    Two candidates, **https then http**, because the stored scheme is not
    trustworthy (see this module's docstring) and a camera that answers on the
    other one is a working camera showing an empty tile. Trying https first
    costs almost nothing when it is wrong: a camera with 443 closed refuses the
    connection immediately rather than timing out, and the endpoint remembers
    the scheme that answered.

    The two differ only in scheme and port, so everything that can be refused —
    no address, unknown driver, ONVIF, an unconfigured multi-imager — is refused
    once, for both, by raising :class:`SnapshotUnavailable`.

    ``channel_param`` enables multi-imager support once someone has confirmed
    the parameter name against a real device — see :func:`_channel_query`.
    """
    ip = str(cam.get("ip") or "").strip()
    if not ip:
        raise SnapshotUnavailable("no address registered for this camera", 404)

    profile = vendor_profile(cam.get("vendor"))
    if not profile:
        raise SnapshotUnavailable(
            f"no snapshot profile for driver {cam.get('vendor') or 'unknown'!r}", 501)
    if profile == "onvif":
        # ONVIF does not define a fixed snapshot path: the URI is discovered
        # through the Media service over SOAP. Guessing a path would 404 on
        # every one of the 91 cameras that report this driver.
        raise SnapshotUnavailable(
            "ONVIF cameras publish their snapshot URI through the Media service, "
            "which NetMon does not speak", 501)

    size = normalise_size(size)
    chan = _channel_query(cam, profile, channel_param)

    if profile == "bosch":
        # Verified in ZCD production against this estate.
        path = f"/snap.jpg?JpegSize={size}"
    else:  # axis
        path = f"/axis-cgi/jpg/image.cgi?resolution={_AXIS_RESOLUTION.get(size, size)}"

    return [SnapshotTarget(url=f"{scheme}://{_hostport(cam, scheme)}{path}{chan}",
                           scheme=scheme, verify=False)
            for scheme in ("https", "http")]


def _hostport(cam: dict, scheme: str) -> str:
    """``ip`` or ``ip:port`` for one scheme.

    Six cameras carry an explicit port, five of them ``:443`` on an ``http``
    scheme — dropping it sends the request to the wrong socket. So each scheme
    prefers the port recorded for it (``https_port`` from
    hardwareDriverSettings, ``http_port`` from the stored address), and will
    borrow the other's only when that port is this scheme's own default: the
    ``http://ip:443`` cameras therefore get ``https://ip`` and ``http://ip:443``
    as their two candidates, both pointing at the socket that exists. A port
    recorded for the other scheme and meaning nothing here (``:8080`` under
    https) is not carried over, and a default port is omitted.
    """
    ip = str(cam.get("ip") or "").strip()
    own, other, default = (
        ("https_port", "http_port", 443) if scheme == "https"
        else ("http_port", "https_port", 80))
    port = _port(cam.get(own))
    if port is None and _port(cam.get(other)) == default:
        port = default
    return f"{ip}:{port}" if port and port != default else ip


def _port(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _channel_query(cam: dict, profile: str, channel_param: str) -> str:
    """The channel selector for a camera that is one imager of several.

    Refused rather than guessed. 178 cameras here sit on a shared device, and a
    bare snapshot path on such a device returns a *different imager's* picture —
    a plausible image of the wrong place, which is worse than an error because
    nobody notices. The parameter name differs by vendor and firmware, so it
    stays a config value: set ``[camera_snapshot] channel_param`` once it has
    been confirmed against a real multi-imager camera, and these cameras start
    working with no deploy.

    Channel 0 needs no selector, which is 2,473 of the 2,651 cameras.
    """
    channel = cam.get("channel")
    if channel in (None, 0):
        return ""
    if not channel_param:
        raise SnapshotUnavailable(
            f"camera is imager {channel} on a shared device and the vendor's channel "
            f"parameter is not configured — a bare snapshot path would return a "
            f"different imager's picture. Set [camera_snapshot] channel_param once "
            f"confirmed against a {profile} multi-imager camera", 501)
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,31}", channel_param):
        raise SnapshotUnavailable("configured channel_param is not a valid "
                                  "query-parameter name", 501)
    # Bosch and Axis both count imagers from 1 in their CGI while Milestone
    # counts from 0, so the stored channel is offset. Recorded here because it
    # is the kind of off-by-one that produces a working image of the wrong lens.
    return f"&{channel_param}={int(channel) + 1}"

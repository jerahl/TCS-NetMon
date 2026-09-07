"""Camera snapshot URL construction + the proxy endpoint (spec 20 S4 / D7).

Every case here is a shape that exists on the live estate. The point of the
module is that a hand-built fixture would contain none of them: 100% of stored
addresses are `http://` while 64% of cameras speak TLS, six carry an explicit
port, 178 are one imager of several, and the vendor field is a driver name.
"""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.snapshot import (
    SnapshotUnavailable, build_url, normalise_size, vendor_profile,
)
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config


def _cam(**over):
    base = {"ip": "10.32.18.4", "http_port": None, "https_enabled": 0,
            "https_port": None, "vendor": "Bosch1ch", "channel": 0}
    base.update(over)
    return base


# ───────────────────────────── the URL builder ─────────────────────────────

def test_scheme_comes_from_httpsenabled_not_from_the_address():
    """The single most consequential field.

    Milestone stores every hardware address as `http://<ip>/` — 100% of 2,489
    records — while hardwareDriverSettings says whether the camera actually
    speaks TLS. 1,695 of 2,651 cameras here do and 956 do not, so assuming
    either scheme fails on hundreds.
    """
    assert build_url(_cam(https_enabled=0)).url.startswith("http://10.32.18.4/snap.jpg")
    assert build_url(_cam(https_enabled=1)).url.startswith("https://10.32.18.4/snap.jpg")
    # Not yet collected → treated as plain http rather than guessed as TLS.
    assert build_url(_cam(https_enabled=None)).url.startswith("http://")


def test_default_ports_are_omitted_and_explicit_ones_kept():
    """Six cameras carry an explicit port, five of them `:443` on an http
    scheme. Dropping it sends the request to the wrong socket; inferring the
    scheme from it would contradict what the field says."""
    # 443 with TLS on is the default — no need to spell it out.
    assert build_url(_cam(https_enabled=1, https_port=443)).url == \
        "https://10.32.18.4/snap.jpg?JpegSize=M"
    # A non-default TLS port must survive.
    assert "10.32.18.4:8443" in build_url(_cam(https_enabled=1, https_port=8443)).url
    # The live oddity: http scheme, port 443.
    u = build_url(_cam(https_enabled=0, http_port=443)).url
    assert u.startswith("http://10.32.18.4:443/"), u
    # Port 80 on http is the default and is dropped.
    assert build_url(_cam(https_enabled=0, http_port=80)).url.startswith("http://10.32.18.4/")


def test_vendor_profile_matches_the_driver_name_by_prefix():
    """`vendor` is Milestone's *driver* name, not a tidy vendor: this estate
    reports Bosch1ch (2,019), Bosch (509), ONVIF (91) and four Axis variants."""
    for v in ("Bosch", "Bosch1ch", "bosch1ch"):
        assert vendor_profile(v) == "bosch"
    for v in ("Axis", "Axis1ChDevice", "Axis11ChDevice", "Axis2ChDevice"):
        assert vendor_profile(v) == "axis"
    assert vendor_profile("ONVIF") == "onvif"
    assert vendor_profile(None) == "" and vendor_profile("Hanwha") == ""


def test_bosch_and_axis_paths():
    assert build_url(_cam(vendor="Bosch1ch"), size="XL").url.endswith("/snap.jpg?JpegSize=XL")
    axis = build_url(_cam(vendor="Axis1ChDevice"), size="L").url
    assert "/axis-cgi/jpg/image.cgi?resolution=640x480" in axis


def test_onvif_is_refused_with_a_reason_rather_than_a_guessed_path():
    """ONVIF publishes its snapshot URI through the Media service over SOAP.
    A guessed path would 404 on all 91 cameras reporting this driver."""
    with pytest.raises(SnapshotUnavailable) as err:
        build_url(_cam(vendor="ONVIF"))
    assert err.value.status == 501
    assert "Media service" in err.value.reason


def test_unknown_driver_and_missing_address():
    with pytest.raises(SnapshotUnavailable) as err:
        build_url(_cam(vendor="Hanwha"))
    assert err.value.status == 501
    with pytest.raises(SnapshotUnavailable) as err:
        build_url(_cam(ip=None))
    assert err.value.status == 404          # cannot be addressed at all


def test_multi_imager_is_refused_until_the_parameter_is_confirmed():
    """178 cameras are one imager of several on a shared device.

    A bare snapshot path on such a device returns a *different imager's*
    picture — a plausible image of the wrong place, which nobody notices. That
    is worse than an error, so it is refused until the parameter is configured.
    """
    with pytest.raises(SnapshotUnavailable) as err:
        build_url(_cam(channel=2))
    assert err.value.status == 501
    assert "different imager" in err.value.reason

    # Configured → used, with the off-by-one both vendors' CGIs need (Milestone
    # counts imagers from 0, the cameras from 1).
    u = build_url(_cam(channel=2), channel_param="channel").url
    assert u.endswith("&channel=3"), u
    # Channel 0 needs no selector at all — 2,473 of 2,651 cameras.
    assert "&channel" not in build_url(_cam(channel=0), channel_param="channel").url


def test_channel_param_is_validated_not_interpolated_blindly():
    """It comes from config, but config is not a licence to build a query
    string out of arbitrary text."""
    with pytest.raises(SnapshotUnavailable):
        build_url(_cam(channel=1), channel_param="chan&JpegSize=XL&x")
    with pytest.raises(SnapshotUnavailable):
        build_url(_cam(channel=1), channel_param="../../etc")


def test_size_is_whitelisted():
    """Interpolated into a query string, so a whitelist rather than escaping —
    the same list ZCD used, so a size that worked there works here."""
    assert normalise_size("xl") == "XL"
    assert normalise_size("352x288") == "352x288"
    for bad in ("M&camera=9", "'; DROP", "../x", "", None, "99999x1"):
        assert normalise_size(bad) == "M"


def test_tls_verification_is_off_and_says_so():
    """Cameras on the VMS network carry self-signed certificates. Returned
    rather than assumed, so the caller cannot forget it is a choice."""
    assert build_url(_cam(https_enabled=1)).verify is False


# ───────────────────────────── the endpoint ─────────────────────────────

def _seed(url):
    engine = db.make_engine(url)
    create_core_tables(engine)
    now = datetime.now(timezone.utc)
    with engine.begin() as c:
        c.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled) VALUES "
            "('CAM-Hall','BHS','camera',1),"          # id 1
            "('BHS-Core-1','BHS','switch',1),"        # id 2 — not a camera
            "('CAM-Multi','BHS','camera',1)"))        # id 3 — imager 2 of N
        c.execute(text(
            "INSERT INTO cameras (device_id, ip, https_enabled, vendor, channel, updated_at) "
            "VALUES (1,'10.32.18.4',0,'Bosch1ch',0,:t),"
            "       (3,'10.32.18.9',1,'Bosch1ch',2,:t)"), {"t": now})
    engine.dispose()


def _snap_section(**kv):
    body = "\n".join(f"{k} = {v}" for k, v in kv.items())
    return f"[camera_snapshot]\n{body}"


def _client(tmp_path, url, **snap):
    conf = write_config(tmp_path, db_url=url,
                        extra_sections=_snap_section(**snap) if snap else "")
    return TestClient(create_app(config=load_config(conf), supervisor=Supervisor()))


def test_snapshot_disabled_by_default(tmp_path):
    """Default off, and it says so — an empty tile that might mean "camera
    down" and might mean "proxy off" is what the reason header exists for."""
    url = f"sqlite:///{tmp_path / 'sn.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        r = client.get("/api/surveillance/cameras/1/snapshot")
        assert r.status_code == 503
        assert "disabled" in r.headers["X-NetMon-Reason"]


def test_snapshot_refuses_a_device_that_is_not_a_camera(tmp_path):
    """The SSRF guard. A caller passes a device_id and nothing else, and the
    join — not a separate check — is what makes a switch impossible to target."""
    url = f"sqlite:///{tmp_path / 'sn2.db'}"
    _seed(url)
    with _client(tmp_path, url, enabled="true", user="ro", **{"pass": "x"}) as client:
        assert client.get("/api/surveillance/cameras/2/snapshot").status_code == 404
        assert client.get("/api/surveillance/cameras/999/snapshot").status_code == 404


def test_snapshot_reports_the_multi_imager_gap_rather_than_the_wrong_lens(tmp_path):
    url = f"sqlite:///{tmp_path / 'sn3.db'}"
    _seed(url)
    with _client(tmp_path, url, enabled="true", user="ro", **{"pass": "x"}) as client:
        r = client.get("/api/surveillance/cameras/3/snapshot")
        assert r.status_code == 501
        assert "different imager" in r.headers["X-NetMon-Reason"]


def test_snapshot_enabled_without_an_account_is_refused_at_load(tmp_path):
    """A config that switches the proxy on with no account would serve nothing
    but 503s. Fail at boot where it is visible."""
    from netmon.config import ConfigError
    url = f"sqlite:///{tmp_path / 'sn4.db'}"
    conf = write_config(tmp_path, db_url=url,
                        extra_sections="[camera_snapshot]\nenabled = true")
    with pytest.raises(ConfigError) as err:
        load_config(conf)
    assert "camera_snapshot" in str(err.value)

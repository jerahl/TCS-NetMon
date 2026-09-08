"""Camera snapshot URL construction + the proxy endpoint (spec 20 S4 / D7).

Every case here is a shape that exists on the live estate. The point of the
module is that a hand-built fixture would contain none of them: 100% of stored
addresses are `http://` while 64% of cameras speak TLS, six carry an explicit
port, 178 are one imager of several, and the vendor field is a driver name.
"""

from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.api import surveillance
from netmon.app import create_app
from netmon.config import load_config
from netmon.snapshot import (
    SnapshotUnavailable, build_candidates, normalise_size, vendor_profile,
)
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config


def _first(cam, **kw):
    """The candidate that gets tried first — https, always."""
    return build_candidates(cam, **kw)[0]


def _cam(**over):
    base = {"ip": "10.32.18.4", "http_port": None, "https_enabled": 0,
            "https_port": None, "vendor": "Bosch1ch", "channel": 0}
    base.update(over)
    return base


# ───────────────────────────── the URL builder ─────────────────────────────

def test_both_schemes_are_offered_https_first():
    """The stored scheme is not the answer, so it is not the only attempt.

    Milestone stores every hardware address as `http://<ip>/` — 100% of 2,489
    records — while hardwareDriverSettings claims whether the camera speaks TLS:
    1,695 of 2,651 say yes, 956 say no, and the claim was wrong in the field
    (owner, 2026-09-08). So both are built, https first, whatever the field
    says — including when it was never collected.
    """
    for https_enabled in (0, 1, None):
        got = [t.scheme for t in build_candidates(_cam(https_enabled=https_enabled))]
        assert got == ["https", "http"], https_enabled
    urls = [t.url for t in build_candidates(_cam(https_enabled=0))]
    assert urls == ["https://10.32.18.4/snap.jpg?JpegSize=M",
                    "http://10.32.18.4/snap.jpg?JpegSize=M"]


def test_each_scheme_carries_the_port_that_belongs_to_it():
    """Six cameras carry an explicit port, five of them `:443` on an http
    scheme. Dropping it sends the request to the wrong socket, and carrying it
    onto the other scheme invents a socket that is not there."""
    # 443 under https and 80 under http are defaults — not spelled out.
    assert build_candidates(_cam(https_enabled=1, https_port=443))[0].url == \
        "https://10.32.18.4/snap.jpg?JpegSize=M"
    assert build_candidates(_cam(http_port=80))[1].url.startswith("http://10.32.18.4/")
    # A non-default TLS port must survive — and must not leak into the http
    # candidate, where 8443 means nothing.
    tls, plain = build_candidates(_cam(https_enabled=1, https_port=8443))
    assert "10.32.18.4:8443" in tls.url
    assert plain.url.startswith("http://10.32.18.4/")
    # The live oddity — http scheme, port 443 — is the one case where the port
    # does carry over, because there it is the other scheme's own default: the
    # camera answers on 443 either way, so both candidates point at it.
    tls, plain = build_candidates(_cam(http_port=443))
    assert tls.url.startswith("https://10.32.18.4/"), tls.url
    assert plain.url.startswith("http://10.32.18.4:443/"), plain.url


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
    assert _first(_cam(vendor="Bosch1ch"), size="XL").url.endswith("/snap.jpg?JpegSize=XL")
    axis = _first(_cam(vendor="Axis1ChDevice"), size="L").url
    assert "/axis-cgi/jpg/image.cgi?resolution=640x480" in axis


def test_onvif_is_refused_with_a_reason_rather_than_a_guessed_path():
    """ONVIF publishes its snapshot URI through the Media service over SOAP.
    A guessed path would 404 on all 91 cameras reporting this driver."""
    with pytest.raises(SnapshotUnavailable) as err:
        build_candidates(_cam(vendor="ONVIF"))
    assert err.value.status == 501
    assert "Media service" in err.value.reason


def test_unknown_driver_and_missing_address():
    with pytest.raises(SnapshotUnavailable) as err:
        build_candidates(_cam(vendor="Hanwha"))
    assert err.value.status == 501
    with pytest.raises(SnapshotUnavailable) as err:
        build_candidates(_cam(ip=None))
    assert err.value.status == 404          # cannot be addressed at all


def test_multi_imager_is_refused_until_the_parameter_is_confirmed():
    """178 cameras are one imager of several on a shared device.

    A bare snapshot path on such a device returns a *different imager's*
    picture — a plausible image of the wrong place, which nobody notices. That
    is worse than an error, so it is refused until the parameter is configured.
    """
    with pytest.raises(SnapshotUnavailable) as err:
        build_candidates(_cam(channel=2))
    assert err.value.status == 501
    assert "different imager" in err.value.reason

    # Configured → used, with the off-by-one both vendors' CGIs need (Milestone
    # counts imagers from 0, the cameras from 1).
    u = _first(_cam(channel=2), channel_param="channel").url
    assert u.endswith("&channel=3"), u
    # Channel 0 needs no selector at all — 2,473 of 2,651 cameras.
    assert "&channel" not in _first(_cam(channel=0), channel_param="channel").url


def test_channel_param_is_validated_not_interpolated_blindly():
    """It comes from config, but config is not a licence to build a query
    string out of arbitrary text."""
    with pytest.raises(SnapshotUnavailable):
        build_candidates(_cam(channel=1), channel_param="chan&JpegSize=XL&x")
    with pytest.raises(SnapshotUnavailable):
        build_candidates(_cam(channel=1), channel_param="../../etc")


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
    assert all(t.verify is False for t in build_candidates(_cam(https_enabled=1)))


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


# ─────────────── what the proxy tries: schemes and passwords ───────────────

class _FakeCamera:
    """Stands in for httpx.AsyncClient: one camera, on one scheme, with one
    password.

    The two things being tested are what the proxy *tries* and in what order,
    so the fake records every attempt as `(scheme, password)` and refuses the
    wrong scheme the way a closed port does — with a transport error, not a
    status code. That distinction is the whole mechanism: a transport failure
    means try the other scheme, a 401 means try the other password.
    """

    calls: list[tuple[str, str]] = []

    def __init__(self, camera, **_kw):
        self._camera = camera

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def get(self, url, *, auth=None, headers=None):
        scheme = url.split("://", 1)[0]
        password = auth._password
        if isinstance(password, bytes):
            password = password.decode()
        type(self).calls.append((scheme, password))
        request = httpx.Request("GET", url)
        if scheme != self._camera.get("scheme"):
            raise httpx.ConnectError("connection refused", request=request)
        if password != self._camera.get("password"):
            return httpx.Response(401, request=request)
        return httpx.Response(200, content=b"\xff\xd8jpeg",
                              headers={"content-type": "image/jpeg"},
                              request=request)


@pytest.fixture
def fake_camera(monkeypatch):
    """Patch the endpoint's HTTP client. Mutate the returned dict to say which
    scheme and password the camera on the other end actually answers to."""
    camera: dict = {"scheme": "https", "password": "new-pw"}
    monkeypatch.setattr(surveillance.httpx, "AsyncClient",
                        lambda **kw: _FakeCamera(camera, **kw))
    _FakeCamera.calls = []
    surveillance._snap_scheme.clear()
    surveillance._snap_cred.clear()
    return camera


def test_https_is_tried_first(tmp_path, fake_camera):
    url = f"sqlite:///{tmp_path / 'sn5.db'}"
    _seed(url)
    with _client(tmp_path, url, enabled="true", user="ro",
                 **{"pass": "new-pw"}) as client:
        r = client.get("/api/surveillance/cameras/1/snapshot")
        assert r.status_code == 200
        assert r.headers["content-type"] == "image/jpeg"
    assert _FakeCamera.calls == [("https", "new-pw")]


def test_http_is_tried_when_https_will_not_connect(tmp_path, fake_camera):
    """956 of 2,651 cameras do not speak TLS, and the stored flag saying which
    is which was wrong in the field — so a refused https is not the answer."""
    url = f"sqlite:///{tmp_path / 'sn6.db'}"
    _seed(url)
    fake_camera["scheme"] = "http"
    with _client(tmp_path, url, enabled="true", user="ro",
                 **{"pass": "new-pw"}) as client:
        assert client.get("/api/surveillance/cameras/1/snapshot").status_code == 200
    assert _FakeCamera.calls == [("https", "new-pw"), ("http", "new-pw")]


def test_backup_password_is_tried_after_a_401(tmp_path, fake_camera):
    """A camera that missed the password rotation still answers to the old one.

    Without this the tile reads "camera rejected the configured account" and
    someone has to work out, per camera, which password it is on.
    """
    url = f"sqlite:///{tmp_path / 'sn7.db'}"
    _seed(url)
    fake_camera["password"] = "old-pw"
    with _client(tmp_path, url, enabled="true", user="ro",
                 **{"pass": "new-pw", "pass_backup": "old-pw"}) as client:
        assert client.get("/api/surveillance/cameras/1/snapshot").status_code == 200
    assert _FakeCamera.calls == [("https", "new-pw"), ("https", "old-pw")]


def test_a_401_does_not_send_the_password_to_the_other_scheme(tmp_path, fake_camera):
    """A camera that answered 401 speaks this scheme. Retrying the same
    rejected passwords over http would double every failure for nothing."""
    url = f"sqlite:///{tmp_path / 'sn8.db'}"
    _seed(url)
    fake_camera["password"] = "neither"
    with _client(tmp_path, url, enabled="true", user="ro",
                 **{"pass": "new-pw", "pass_backup": "old-pw"}) as client:
        r = client.get("/api/surveillance/cameras/1/snapshot")
        assert r.status_code == 502
        assert "both configured passwords" in r.headers["X-NetMon-Reason"]
    assert _FakeCamera.calls == [("https", "new-pw"), ("https", "old-pw")]


def test_what_worked_is_remembered_per_camera(tmp_path, fake_camera):
    """The fallbacks must not multiply the request count.

    A camera wall asks for up to 48 stills at once and refreshes; rediscovering
    the same dead socket and the same 401 on every fetch would mean four
    attempts per tile forever.
    """
    url = f"sqlite:///{tmp_path / 'sn9.db'}"
    _seed(url)
    fake_camera.update(scheme="http", password="old-pw")
    with _client(tmp_path, url, enabled="true", user="ro",
                 **{"pass": "new-pw", "pass_backup": "old-pw"}) as client:
        assert client.get("/api/surveillance/cameras/1/snapshot").status_code == 200
        assert len(_FakeCamera.calls) == 3      # https×2 refused, then http/old
        _FakeCamera.calls = []
        assert client.get("/api/surveillance/cameras/1/snapshot").status_code == 200
    assert _FakeCamera.calls == [("http", "old-pw")]


def test_neither_scheme_answering_names_both(tmp_path, fake_camera):
    """The reason has to separate a wrong scheme from an unreachable camera,
    now that both were tried."""
    url = f"sqlite:///{tmp_path / 'sn10.db'}"
    _seed(url)
    fake_camera["scheme"] = "none"
    with _client(tmp_path, url, enabled="true", user="ro",
                 **{"pass": "new-pw"}) as client:
        r = client.get("/api/surveillance/cameras/1/snapshot")
        assert r.status_code == 504
        reason = r.headers["X-NetMon-Reason"]
        assert "ConnectError" in reason and "https and http" in reason
    assert _FakeCamera.calls == [("https", "new-pw"), ("http", "new-pw")]


def test_one_password_configured_is_tried_once_per_scheme(tmp_path, fake_camera):
    """No backup configured behaves as before: one password, one reason."""
    url = f"sqlite:///{tmp_path / 'sn11.db'}"
    _seed(url)
    fake_camera["password"] = "neither"
    with _client(tmp_path, url, enabled="true", user="ro",
                 **{"pass": "new-pw"}) as client:
        r = client.get("/api/surveillance/cameras/1/snapshot")
        assert r.status_code == 502
        assert "the configured account" in r.headers["X-NetMon-Reason"]
    assert _FakeCamera.calls == [("https", "new-pw")]

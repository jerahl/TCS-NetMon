"""Bulk camera operations API (spec 20 S8 / D11) — admin only, nothing sent.

The endpoints are thin; what is tested is the set of rules restated at the edge,
because an endpoint that trusts its caller is how a closed registry stops being
closed.
"""

import hashlib
import json

from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config

BLOB = b"BOSCH-FIRMWARE-7.93.0024" * 64
SHA = hashlib.sha256(BLOB).hexdigest()
MODEL = "FLEXIDOME IP 5000i IR"


def _store(tmp_path, *, place=True):
    d = tmp_path / "fw" / "bosch"
    d.mkdir(parents=True)
    if place:
        (d / "b793.fw").write_bytes(BLOB)
    return str(tmp_path / "fw")


def _seed(url):
    engine = db.make_engine(url)
    create_core_tables(engine)
    with engine.begin() as c:
        c.execute(text("INSERT INTO devices (id,name,site,device_type,enabled) VALUES "
                       "(1,'cam-a','BHS','camera',1),(2,'cam-b','BHS','camera',1)"))
        for device_id in (1, 2):
            c.execute(text(
                "INSERT INTO cameras (device_id, model, firmware, platform, vendor, ip, "
                "https_enabled, https_port, updated_at) VALUES "
                "(:i,:m,'7.83.0027','CPP6/7/7.3','Bosch1ch',:ip,1,443,'2026-09-08')"),
                {"i": device_id, "m": MODEL, "ip": f"10.1.1.{device_id}"})
            c.execute(text(
                "INSERT INTO device_state (device_id,dimension,value,severity,source,updated_at) "
                "VALUES (:i,'reachability','up','ok','derived','2026-09-08'),"
                "       (:i,'source_status','up','ok','milestone','2026-09-08')"),
                {"i": device_id})
    engine.dispose()
    return db.make_engine(url)


def _client(tmp_path, *, role="admin", **ops_kw):
    url = f"sqlite:///{tmp_path/'api.db'}"
    _seed(url)
    base = {"user": "svc-cam", "pass": "x", "firmware_dir": ops_kw.pop("store", None)
            or _store(tmp_path)}
    base.update(ops_kw)
    body = "\n".join(f"{k} = {v}" for k, v in base.items())
    conf = write_config(tmp_path, db_url=url,
                        extra_sections=f"[camera_ops]\n{body}")
    if role != "admin":
        # write_config hardcodes dev_bypass_role = admin; rewrite it rather than
        # add a duplicate option, which configparser refuses.
        conf.write_text(conf.read_text().replace("dev_bypass_role = admin",
                                                 f"dev_bypass_role = {role}"))
    return TestClient(create_app(config=load_config(conf), supervisor=Supervisor())), url


def _register(client, **over):
    body = {"vendor": "bosch", "version": "7.93.0024", "filename": "b793.fw",
            "models": [MODEL], "platform": "CPP6/7/7.3"}
    body.update(over)
    return client.post("/api/surveillance/firmware", json=body)


# ── the role floor ────────────────────────────────────────────────────────

def test_every_endpoint_is_admin_only(tmp_path):
    """D4's actions are operator; this goes straight to hardware, so the floor
    is higher. An operator must not be able to see the store, let alone push."""
    client, _ = _client(tmp_path, role="operator")
    with client:
        for path in ("/api/surveillance/firmware", "/api/surveillance/batches",
                     "/api/surveillance/camera-ops"):
            assert client.get(path).status_code == 403, f"{path} let an operator through"
        assert client.post("/api/surveillance/batches",
                           json={"device_ids": [1], "firmware_id": 1}).status_code == 403
        assert client.put("/api/surveillance/firmware/bosch/x.fw",
                          content=b"x").status_code == 403


# ── the store ─────────────────────────────────────────────────────────────

def test_registering_hashes_the_file_that_is_actually_there(tmp_path):
    client, url = _client(tmp_path)
    with client:
        r = _register(client)
        assert r.status_code == 200, r.text
        assert r.json()["sha256"] == SHA
        assert r.json()["size_bytes"] == len(BLOB)

        rows = client.get("/api/surveillance/firmware").json()
        assert rows[0]["models"] == [MODEL]
        assert rows[0]["platform"] == "CPP6/7/7.3"


def test_an_image_with_no_model_allow_list_is_refused(tmp_path):
    """There is no "all models" value: a wrong image is a truck roll."""
    client, _ = _client(tmp_path)
    with client:
        r = _register(client, models=[])
        assert r.status_code == 422 or r.status_code == 409


def test_a_filename_that_is_a_path_never_reaches_the_filesystem(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        for name in ("../../etc/passwd", "bosch/b793.fw", "..", "/abs.fw"):
            r = _register(client, filename=name)
            assert r.status_code in (409, 422), name


def test_an_unplaced_image_cannot_be_registered(tmp_path):
    client, _ = _client(tmp_path, store=_store(tmp_path, place=False))
    with client:
        r = _register(client)
        assert r.status_code == 409
        assert "not in the firmware store" in r.json()["detail"]


def test_the_same_image_cannot_be_registered_twice(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        assert _register(client).status_code == 200
        again = _register(client, version="7.93.0025")
        assert again.status_code == 409
        assert "SHA-256 is already registered" in again.json()["detail"]


def test_streaming_an_image_into_the_store_then_registering_it(tmp_path):
    """The browser path: PUT the bytes, then register them deliberately.

    Two calls on purpose — placing a file decides nothing, while registering it
    is what says which cameras may ever receive it.
    """
    client, _ = _client(tmp_path, store=_store(tmp_path, place=False))
    with client:
        r = client.put("/api/surveillance/firmware/bosch/b793.fw", content=BLOB)
        assert r.status_code == 200, r.text
        assert r.json()["sha256"] == SHA and r.json()["registered"] is False
        # Nothing is usable yet.
        assert client.get("/api/surveillance/firmware").json() == []
        assert _register(client).status_code == 200

        # And the same name cannot be quietly overwritten afterwards.
        again = client.put("/api/surveillance/firmware/bosch/b793.fw", content=BLOB)
        assert again.status_code == 409


def test_an_empty_upload_leaves_nothing_behind(tmp_path):
    store = _store(tmp_path, place=False)
    client, _ = _client(tmp_path, store=store)
    with client:
        r = client.put("/api/surveillance/firmware/bosch/empty.fw", content=b"")
        assert r.status_code == 409
    from pathlib import Path
    assert not (Path(store) / "bosch" / "empty.fw").exists()


# ── batches ───────────────────────────────────────────────────────────────

def test_a_batch_is_created_dry_and_previews_its_refusals(tmp_path):
    client, url = _client(tmp_path)
    with client:
        image_id = _register(client).json()["id"]
        r = client.post("/api/surveillance/batches",
                        json={"device_ids": [1, 2], "firmware_id": image_id})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["dry_run"] is True
        assert body["preflight"]["allowed_count"] == 2

        detail = client.get(f"/api/surveillance/batches/{body['batch_id']}").json()
        assert detail["status"] == "previewed"
        assert {i["status"] for i in detail["items"]} == {"would_run"}
        assert detail["firmware_version"] == "7.93.0024"


def test_a_caller_cannot_arm_a_live_batch_while_config_says_dry_run(tmp_path):
    """Two locks, not one: arming takes an edit to netmon.conf as well, so no
    single request and no single mistake can put firmware on a camera."""
    client, url = _client(tmp_path)          # dry_run defaults true
    with client:
        image_id = _register(client).json()["id"]
        r = client.post("/api/surveillance/batches",
                        json={"device_ids": [1], "firmware_id": image_id,
                              "dry_run": False})
        assert r.json()["dry_run"] is True


def test_a_firmware_batch_without_an_image_is_refused(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        r = client.post("/api/surveillance/batches", json={"device_ids": [1]})
        assert r.status_code == 409
        assert "needs a firmware_id" in r.json()["detail"]

        r = client.post("/api/surveillance/batches",
                        json={"device_ids": [1], "firmware_id": 999})
        assert r.status_code == 409
        assert "not registered" in r.json()["detail"]


def test_starting_a_live_batch_is_refused_while_the_flags_are_off(tmp_path):
    """The guard runs before the task is created, so the caller is told now
    rather than discovering a failed batch later."""
    client, url = _client(tmp_path, dry_run="false")
    with client:
        image_id = _register(client).json()["id"]
        batch_id = client.post("/api/surveillance/batches",
                               json={"device_ids": [1], "firmware_id": image_id,
                                     "dry_run": False}).json()["batch_id"]
        r = client.post(f"/api/surveillance/batches/{batch_id}/start")
        assert r.status_code == 409
        assert "enabled = false" in r.json()["detail"]


def test_aborting_a_batch_that_never_started_still_records_it(tmp_path):
    client, url = _client(tmp_path)
    with client:
        image_id = _register(client).json()["id"]
        batch_id = client.post("/api/surveillance/batches",
                               json={"device_ids": [1, 2], "firmware_id": image_id}
                               ).json()["batch_id"]
        assert client.post(f"/api/surveillance/batches/{batch_id}/abort").status_code == 200
        detail = client.get(f"/api/surveillance/batches/{batch_id}").json()
        assert detail["status"] == "aborted"
        assert {i["status"] for i in detail["items"]} == {"skipped"}
        # Aborting twice is refused rather than silently re-aborting.
        assert client.post(f"/api/surveillance/batches/{batch_id}/abort").status_code == 409


def test_the_status_endpoint_tells_the_ui_which_gates_are_closed(tmp_path):
    client, _ = _client(tmp_path, proving_device_id="1592")
    with client:
        s = client.get("/api/surveillance/camera-ops").json()
        assert s["enabled"] is False and s["dry_run"] is True
        assert s["firmware_update"] is False
        assert s["proving_device_id"] == 1592
        assert s["account_configured"] is True
        # The setting catalogue is deferred, so the UI must not offer a
        # config-change button that would only ever be refused.
        assert s["config_catalogue"] == []


def test_an_unknown_batch_is_a_404_not_a_500(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        assert client.get("/api/surveillance/batches/999").status_code == 404
        assert client.post("/api/surveillance/batches/999/abort").status_code == 404

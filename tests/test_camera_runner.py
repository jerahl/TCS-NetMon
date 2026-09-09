"""The batch executor (spec 20 S8 / D11) — canary, rings, abort, verification.

Every camera here is a fake transport. That is the spec's own condition: a
vendor path is fixture-tested before it ever sees a device, and this is the only
module in NetMon where an untested branch means somebody driving to a school.

The cases worth reading are the ones where the runner *stops*.
"""

import asyncio
import hashlib
import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from netmon import db
from netmon.cameras import ops
from netmon.cameras.runner import BatchRefused, BatchRunner, load_image
from netmon.config import load_config
from tests.conftest import create_core_tables, write_config

NOW = datetime(2026, 9, 8, 22, 0, tzinfo=timezone.utc)
BLOB = b"BOSCH-FIRMWARE-7.90.0123"
SHA = hashlib.sha256(BLOB).hexdigest()
MODEL = "FLEXIDOME IP 5000i IR"


# ── fakes ─────────────────────────────────────────────────────────────────

class FakeResponse:
    def __init__(self, status_code=200, text=""):
        self.status_code = status_code
        self.text = text


class FakeCameraFleet:
    """Every camera in one object: what each answers, and what it reports after.

    `after` maps device_id → the firmware string the camera reports once it has
    "rebooted". A camera missing from it never comes back, which is the failure
    the reboot timeout exists for.
    """

    def __init__(self, *, upload_status=200, after=None, upload_status_by_ip=None,
                 vendor_reads=None):
        self.upload_status = upload_status
        self.upload_status_by_ip = upload_status_by_ip or {}
        self.after = after or {}
        self.vendor_reads = vendor_reads or {}
        self.uploads: list[str] = []
        self.version_reads: list[str] = []
        #: Every call in order, so a test can assert what happened *before* the
        #: image was sent — not merely that both happened.
        self.calls: list[tuple[str, str]] = []

    def client(self):
        fleet = self

        class _Client:
            async def __aenter__(self_inner):
                return self_inner

            async def __aexit__(self_inner, *exc):
                return False

            async def post(self_inner, url, files=None, auth=None):
                fleet.uploads.append(url)
                fleet.calls.append(("POST", url))
                ip = url.split("//", 1)[1].split("/")[0].split(":")[0]
                return FakeResponse(fleet.upload_status_by_ip.get(ip, fleet.upload_status))

            async def get(self_inner, url, auth=None):
                # The camera's own RCP+ version read. `vendor_reads` is what a
                # test sets when it wants the camera to answer for itself; an
                # empty reply is a camera that will not, which is what sends the
                # runner to Milestone.
                ip = url.split("//", 1)[1].split("/")[0].split(":")[0]
                fleet.version_reads.append(url)
                fleet.calls.append(("GET", url))
                version = fleet.vendor_reads.get(ip)
                body = ("<rcp><payload></payload><result><str>"
                        f"{version}</str></result></rcp>" if version
                        else "<rcp><payload></payload></rcp>")
                return FakeResponse(200, text=body)

        return _Client()


def _seed(url, *, cameras=None):
    engine = db.make_engine(url)
    create_core_tables(engine)
    cameras = cameras or [(1, "cam-a", "10.1.1.1"), (2, "cam-b", "10.1.1.2"),
                          (3, "cam-c", "10.1.1.3")]
    with engine.begin() as c:
        for device_id, name, ip in cameras:
            c.execute(text("INSERT INTO devices (id,name,site,device_type,enabled) "
                           "VALUES (:i,:n,'BHS','camera',1)"),
                      {"i": device_id, "n": name})
            c.execute(text(
                "INSERT INTO cameras (device_id, model, firmware, vendor, ip, "
                "https_enabled, https_port, updated_at) "
                "VALUES (:i,:m,'7.83.0027','Bosch1ch',:ip,1,443,:t)"),
                {"i": device_id, "m": MODEL, "ip": ip, "t": NOW})
            c.execute(text(
                "INSERT INTO device_state (device_id,dimension,value,severity,source,updated_at) "
                "VALUES (:i,'reachability','up','ok','derived',:t),"
                "       (:i,'source_status','up','ok','milestone',:t)"),
                {"i": device_id, "t": NOW})
        c.execute(text(
            "INSERT INTO firmware_images (id,vendor,version,filename,rel_path,size_bytes,"
            "sha256,models,uploaded_by,uploaded_at) VALUES "
            "(1,'bosch','7.90.0123','b790.fw','bosch/b790.fw',:sz,:sha,:models,'sappleby',:t)"),
            {"sz": len(BLOB), "sha": SHA, "models": json.dumps([MODEL]), "t": NOW})
    engine.dispose()
    return db.make_engine(url)


def _store(tmp_path):
    d = tmp_path / "fw" / "bosch"
    d.mkdir(parents=True)
    (d / "b790.fw").write_bytes(BLOB)
    return str(tmp_path / "fw")


def _cfg(tmp_path, **ops_kw):
    base = {"enabled": "true", "dry_run": "false", "firmware_update": "true",
            "user": "svc-cam", "pass": "x", "firmware_dir": _store(tmp_path),
            "reboot_timeout_s": "60"}
    base.update(ops_kw)
    body = "\n".join(f"{k} = {v}" for k, v in base.items())
    return load_config(write_config(tmp_path, extra_sections=f"[camera_ops]\n{body}"))


def _batch(engine, *, device_ids, dry=False, canary=1, ring=10, abort_pct=10,
           max_concurrent=3):
    db.execute(engine, """
        INSERT INTO camera_batches (op, firmware_id, status, dry_run, canary_count,
            ring_size, max_concurrent, abort_pct, reboot_timeout_s, created_by, created_at)
        VALUES ('firmware_update', 1, 'previewed', :dry, :canary, :ring, :conc, :abort,
                60, 'sappleby', :t)""",
        {"dry": 1 if dry else 0, "canary": canary, "ring": ring, "conc": max_concurrent,
         "abort": abort_pct, "t": NOW})
    batch_id = int(db.fetch_one(engine, "SELECT MAX(id) AS id FROM camera_batches")["id"])
    rings = ops.plan_rings(device_ids, canary_count=canary, ring_size=ring)
    rows = [{"b": batch_id, "d": device_id, "r": ring_index,
             "s": "would_run" if dry else "pending"}
            for ring_index, group in enumerate(rings) for device_id in group]
    db.execute(engine, "INSERT INTO camera_batch_items (batch_id, device_id, ring, status, "
                       "before_value) VALUES (:b, :d, :r, :s, '7.83.0027')", rows)
    return batch_id


def _run(engine, cfg, batch_id, fleet, *, after=None, upload_field="net.bin"):
    """Run to completion with sleeps stubbed out."""
    _set_upload_field(upload_field)
    async def no_sleep(_s):
        return None

    runner = BatchRunner(engine, cfg, batch_id, actor="sappleby", role="admin",
                         client_factory=fleet.client, sleep=no_sleep,
                         milestone_firmware=lambda device_id: (after or {}).get(device_id))
    return asyncio.run(runner.run()), runner


def _items(engine, batch_id):
    return {int(r["device_id"]): dict(r) for r in db.fetch_all(
        engine, "SELECT * FROM camera_batch_items WHERE batch_id = :b", {"b": batch_id})}


# ── the guards ────────────────────────────────────────────────────────────

def _set_upload_field(value):
    """Override the profile's multipart part name, for the refusal case only.

    The real value is `net.bin`, read off the camera's own service-page markup.
    A test that empties it is exercising what happens when a profile cannot
    build a request at all.
    """
    from netmon.cameras.vendors import bosch
    bosch.UPLOAD_FIELD = value


def test_the_profile_refusing_to_build_a_request_fails_the_item_cleanly(tmp_path):
    """The state the fleet is actually in today: endpoint known, field name not.

    That must read as a refused item with the reason on it — not a crash, and
    not a socket opened to a camera on a guess.
    """
    engine = _seed(f"sqlite:///{tmp_path/'r24.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1])
    fleet = FakeCameraFleet()
    try:
        _run(engine, cfg, batch_id, fleet, upload_field="")
    finally:
        _set_upload_field("net.bin")
    assert fleet.uploads == []
    items = _items(engine, batch_id)
    assert items[1]["status"] == "failed"
    assert "field name for the file is not known" in items[1]["message"]


def test_a_live_batch_is_refused_while_the_flags_are_off(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r1.db'}")
    cfg = _cfg(tmp_path, enabled="false")
    batch_id = _batch(engine, device_ids=[1])
    with pytest.raises(BatchRefused, match="enabled = false"):
        _run(engine, cfg, batch_id, FakeCameraFleet())


def test_the_per_operation_flag_is_separate_from_enabled(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r2.db'}")
    cfg = _cfg(tmp_path, firmware_update="false")
    batch_id = _batch(engine, device_ids=[1])
    with pytest.raises(BatchRefused, match="firmware_update = false"):
        _run(engine, cfg, batch_id, FakeCameraFleet())


def test_a_dry_run_needs_no_arming_and_sends_nothing(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r3.db'}")
    cfg = _cfg(tmp_path, enabled="false", firmware_update="false")
    batch_id = _batch(engine, device_ids=[1, 2, 3], dry=True)
    fleet = FakeCameraFleet()

    result, _ = _run(engine, cfg, batch_id, fleet)

    assert fleet.uploads == []
    assert result["would_run"] == 3
    items = _items(engine, batch_id)
    assert {i["status"] for i in items.values()} == {"would_run"}
    assert "would upload b790.fw" in items[1]["message"]


def test_an_image_that_changed_on_disk_is_refused(tmp_path):
    """The SHA-256 is re-checked at run time, not trusted from upload: an image
    that changed between vetting and roll is not the image that was vetted."""
    engine = _seed(f"sqlite:///{tmp_path/'r4.db'}")
    cfg = _cfg(tmp_path)
    store = tmp_path / "fw" / "bosch" / "b790.fw"
    store.write_bytes(b"TAMPERED")
    batch_id = _batch(engine, device_ids=[1])
    with pytest.raises(BatchRefused, match="changed on disk"):
        _run(engine, cfg, batch_id, FakeCameraFleet())


def test_a_missing_image_is_refused_before_anything_runs(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r5.db'}")
    cfg = _cfg(tmp_path)
    (tmp_path / "fw" / "bosch" / "b790.fw").unlink()
    batch_id = _batch(engine, device_ids=[1])
    with pytest.raises(BatchRefused, match="missing from the store"):
        _run(engine, cfg, batch_id, FakeCameraFleet())


def test_a_scheduled_batch_will_not_start_early(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r6.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1])
    db.execute(engine, "UPDATE camera_batches SET not_before = :t WHERE id = :i",
               {"t": datetime.now(timezone.utc) + timedelta(hours=6), "i": batch_id})
    with pytest.raises(BatchRefused, match="scheduled for"):
        _run(engine, cfg, batch_id, FakeCameraFleet())


# ── the canary gate ───────────────────────────────────────────────────────

def test_the_canary_gates_the_whole_batch(tmp_path):
    """One camera goes first and the rest wait. This is the single mechanism
    standing between a bad image and the second camera."""
    engine = _seed(f"sqlite:///{tmp_path/'r7.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2, 3])
    # The canary never comes back on the new version.
    fleet = FakeCameraFleet()
    result, _ = _run(engine, cfg, batch_id, fleet, after={1: "7.83.0027"})

    assert result["aborted"] is True
    assert len(fleet.uploads) == 1           # cameras 2 and 3 were never touched
    items = _items(engine, batch_id)
    assert items[1]["status"] == "failed"
    assert items[2]["status"] == "skipped" and "canary" in items[2]["message"]
    batch = db.fetch_one(engine, "SELECT status, message FROM camera_batches WHERE id = :i",
                         {"i": batch_id})
    assert batch["status"] == "aborted" and "before the second camera" in batch["message"]


def test_an_indeterminate_canary_also_stops_the_batch(tmp_path):
    """888 cameras report firmware as `783`, which cannot prove `7.90.0123`.

    The upgrade may well have worked. A fleet-wide roll should not proceed on
    "probably" — so indeterminate halts exactly like a failure, and the item
    says which it was.
    """
    engine = _seed(f"sqlite:///{tmp_path/'r8.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2, 3])
    fleet = FakeCameraFleet()
    result, _ = _run(engine, cfg, batch_id, fleet, after={1: "790"})

    assert result["aborted"] is True
    items = _items(engine, batch_id)
    assert items[1]["status"] == "indeterminate"
    assert "cannot prove" in items[1]["message"]
    assert len(fleet.uploads) == 1


def test_a_verified_canary_lets_the_rings_proceed(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r9.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2, 3])
    fleet = FakeCameraFleet()
    after = {1: "7.90.0123", 2: "7.90.0123", 3: "7.90.0123"}

    result, _ = _run(engine, cfg, batch_id, fleet, after=after)

    assert result["aborted"] is False and result["verified"] == 3
    assert len(fleet.uploads) == 3
    items = _items(engine, batch_id)
    assert items[3]["after_value"] == "7.90.0123"
    # Which read answered is recorded: a Milestone-sourced confirmation is
    # weaker evidence than the camera's own and must not read as the same.
    assert items[3]["verified_by"] == "milestone"
    batch = db.fetch_one(engine, "SELECT status FROM camera_batches WHERE id = :i",
                         {"i": batch_id})
    assert batch["status"] == "done"


# ── the abort threshold ───────────────────────────────────────────────────

def test_a_ring_over_the_abort_threshold_halts_the_batch(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r10.db'}",
                   cameras=[(i, f"cam-{i}", f"10.1.1.{i}") for i in range(1, 8)])
    cfg = _cfg(tmp_path)
    # canary + two rings of three.
    batch_id = _batch(engine, device_ids=[1, 2, 3, 4, 5, 6, 7], ring=3, abort_pct=10)
    fleet = FakeCameraFleet()
    after = {1: "7.90.0123", 2: "7.90.0123", 3: "7.83.0027", 4: "7.90.0123"}

    result, _ = _run(engine, cfg, batch_id, fleet, after=after)

    assert result["aborted"] is True
    items = _items(engine, batch_id)
    assert items[3]["status"] == "failed"
    # Ring 2 never ran: 5, 6 and 7 are skipped with the halt reason.
    for device_id in (5, 6, 7):
        assert items[device_id]["status"] == "skipped"
        assert "halted" in items[device_id]["message"]
    assert len(fleet.uploads) == 4


def test_an_upload_that_is_rejected_is_a_failure_not_a_wait(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r11.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2, 3])
    fleet = FakeCameraFleet(upload_status=401)

    result, _ = _run(engine, cfg, batch_id, fleet)

    assert result["aborted"] is True
    items = _items(engine, batch_id)
    assert items[1]["status"] == "failed" and "HTTP 401" in items[1]["message"]


# ── the audit trail ───────────────────────────────────────────────────────

def test_every_upload_is_audited_before_it_leaves(tmp_path):
    """Same chokepoint as D4's four actions: the record of what NetMon sent to a
    device lives in one table, whatever asked for it."""
    engine = _seed(f"sqlite:///{tmp_path/'r12.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2, 3])
    _run(engine, cfg, batch_id, FakeCameraFleet(),
         after={1: "7.90.0123", 2: "7.90.0123", 3: "7.90.0123"})

    rows = db.fetch_all(engine, "SELECT * FROM action_audit ORDER BY id")
    assert len(rows) == 3
    assert {r["action"] for r in rows} == {"camera_firmware_update"}
    assert {r["source"] for r in rows} == {"camera"}
    assert {r["outcome"] for r in rows} == {"ok"}
    assert rows[0]["actor"] == "sappleby" and rows[0]["actor_role"] == "admin"
    # The image is named in the audit params; no credential ever is.
    params = json.loads(rows[0]["params"])
    assert params["image"] == "b790.fw" and params["version"] == "7.90.0123"
    assert not any("pass" in k.lower() for k in params)
    # And the item points back at its audit row, so the two can be read together.
    assert _items(engine, batch_id)[1]["audit_id"] == rows[0]["id"]


def test_a_dry_run_writes_no_audit_rows_because_nothing_was_sent(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r13.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2, 3], dry=True)
    _run(engine, cfg, batch_id, FakeCameraFleet())
    assert db.fetch_all(engine, "SELECT * FROM action_audit") == []


# ── addressing ────────────────────────────────────────────────────────────

def test_the_upload_url_is_rebuilt_from_the_registry(tmp_path):
    """Same rule as the snapshot proxy: a batch can only ever reach an address
    Milestone registered for a camera."""
    engine = _seed(f"sqlite:///{tmp_path/'r14.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1])
    fleet = FakeCameraFleet()
    _run(engine, cfg, batch_id, fleet, after={1: "7.90.0123"})
    # /upload.htm, per the camera's own service-page form. The first live
    # attempt failed on the part *name*, not on this path.
    assert fleet.uploads == ["https://10.1.1.1/upload.htm"]


def test_an_aborted_batch_can_be_stopped_by_an_operator(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r15.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2, 3])
    runner = BatchRunner(engine, cfg, batch_id, actor="sappleby", role="admin")
    runner.abort("stopped from the batch page")

    batch = db.fetch_one(engine, "SELECT status, message FROM camera_batches WHERE id = :i",
                         {"i": batch_id})
    assert batch["status"] == "aborted" and "operator" not in (batch["message"] or "")
    assert {i["status"] for i in _items(engine, batch_id).values()} == {"skipped"}


def test_load_image_rejects_an_unregistered_id(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r16.db'}")
    cfg = _cfg(tmp_path)
    with pytest.raises(BatchRefused, match="not registered"):
        load_image(engine, cfg, 99)


# ── the vendor read (RCP+ CONF_SOFTWARE_VERSION_FORMATTED) ────────────────

def test_the_camera_is_asked_first_and_milestone_only_as_a_fallback(tmp_path):
    """`verified_by` is the point: the two answers are not worth the same.

    The camera's own RCP+ reply is immediate and carries <major>.<minor>.<build>.
    Milestone's value is at most one identity-backfill cycle old and is often the
    compact `783` form, which can confirm a release but not a build.
    """
    engine = _seed(f"sqlite:///{tmp_path/'r17.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2])
    # Camera 1 answers for itself; camera 2 does not, so it falls back.
    fleet = FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123"})

    result, _ = _run(engine, cfg, batch_id, fleet, after={2: "7.90.0123"})

    assert result["verified"] == 2
    items = _items(engine, batch_id)
    assert items[1]["verified_by"] == "vendor"
    assert items[2]["verified_by"] == "milestone"
    # The documented command, asked over the read direction only.
    assert fleet.version_reads[0].endswith(
        "/rcp.xml?command=0x0cd4&type=P_STRING&direction=READ")


def test_the_vendor_read_turns_an_indeterminate_into_a_verified(tmp_path):
    """The 888-camera problem, solved by asking the camera instead.

    Milestone reports this camera as `790`, which cannot prove `7.90.0123` and
    would halt the batch at the canary. The camera's own formatted answer can.
    """
    engine = _seed(f"sqlite:///{tmp_path/'r18.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2, 3])
    fleet = FakeCameraFleet(vendor_reads={f"10.1.1.{i}": "7.90.0123" for i in (1, 2, 3)})

    result, _ = _run(engine, cfg, batch_id, fleet, after={1: "790", 2: "790", 3: "790"})

    assert result["verified"] == 3 and result["aborted"] is False
    assert all(i["verified_by"] == "vendor" for i in _items(engine, batch_id).values())


def test_a_camera_that_answers_the_old_version_still_fails(tmp_path):
    """The vendor read must not become a way to pass: a camera that answers
    promptly with the version it already had did not upgrade."""
    engine = _seed(f"sqlite:///{tmp_path/'r19.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2])
    fleet = FakeCameraFleet(vendor_reads={"10.1.1.1": "7.83.0027"})

    result, _ = _run(engine, cfg, batch_id, fleet)

    assert result["aborted"] is True
    assert _items(engine, batch_id)[1]["status"] == "failed"


# ── the platform gate ─────────────────────────────────────────────────────

def _platform_fleet(platform_by_ip, **kw):
    """A fleet whose cameras answer the RCP+ platform markers honestly."""
    fleet = FakeCameraFleet(**kw)
    markers = {"0x0d26": "CPP14/15/16", "0x0d1b": "CPP13", "0x0a08": "CPP6/7/7.3"}

    def get_body(url):
        ip = url.split("//", 1)[1].split("/")[0].split(":")[0]
        cmd = url.split("command=", 1)[1].split("&")[0]
        if cmd in markers:
            # A camera answers only its own generation's marker; anything else
            # comes back as the vendor's "unknown command" error, at HTTP 200.
            if markers[cmd] == platform_by_ip.get(ip):
                return "<rcp><result><str>ok</str></result></rcp>"
            return "<rcp><result><err>0x40</err></result></rcp>"
        version = fleet.vendor_reads.get(ip)
        return ("<rcp><result><str>" + version + "</str></result></rcp>" if version
                else "<rcp><payload></payload></rcp>")

    fleet._get_body = get_body
    return fleet


def _patch_fleet_get(fleet):
    """Route the fake client's GET through the platform-aware body builder."""
    original = fleet.client

    def client():
        c = original()

        async def get(url, auth=None):
            fleet.version_reads.append(url)
            return FakeResponse(200, text=fleet._get_body(url))

        c.get = get
        return c

    fleet.client = client
    return fleet


def test_an_image_for_another_platform_is_refused_at_the_last_moment(tmp_path):
    """The check that would have saved alb-cam-44.

    A CPP14 image against a CPP7.3 camera meets "flash type incompatible" at
    best. The model allow-list cannot catch it — allow-lists are typed by
    people, and this is the mistake a person makes.
    """
    engine = _seed(f"sqlite:///{tmp_path/'r20.db'}")
    db.execute(engine, "UPDATE firmware_images SET platform = 'CPP14/15/16' WHERE id = 1")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2])
    fleet = _patch_fleet_get(_platform_fleet({"10.1.1.1": "CPP6/7/7.3",
                                              "10.1.1.2": "CPP6/7/7.3"}))

    result, _ = _run(engine, cfg, batch_id, fleet)

    assert fleet.uploads == []               # nothing was sent, to anything
    assert result["aborted"] is True         # the canary failed, so the batch stopped
    items = _items(engine, batch_id)
    assert items[1]["status"] == "failed"
    assert "built for CPP14/15/16" in items[1]["message"]


def test_a_matching_platform_proceeds_and_is_remembered(tmp_path):
    """A real CPP14 model, a CPP14 image, and a camera that answers as CPP14."""
    engine = _seed(f"sqlite:///{tmp_path/'r21.db'}")
    db.execute(engine, "UPDATE firmware_images SET platform = 'CPP14.2', "
                       "models = :m WHERE id = 1",
               {"m": json.dumps(["FLEXIDOME outdoor 5100i IR"])})
    db.execute(engine, "UPDATE cameras SET model = 'FLEXIDOME outdoor 5100i IR' "
                       "WHERE device_id = 1")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1])
    fleet = _patch_fleet_get(_platform_fleet({"10.1.1.1": "CPP14/15/16"},
                                             vendor_reads={"10.1.1.1": "7.90.0123"}))

    result, _ = _run(engine, cfg, batch_id, fleet)

    assert result["verified"] == 1
    assert len(fleet.uploads) == 1
    # The vendor table's exact generation is what gets stored, not the probe's
    # band — a band is not a fact about this camera.
    row = db.fetch_one(engine, "SELECT platform FROM cameras WHERE device_id = 1")
    assert row["platform"] == "CPP14.2"


def test_a_probe_that_contradicts_the_vendor_table_stops_the_item(tmp_path):
    """Two sources disagreeing about silicon is not something to average.

    If a camera the table calls CPP7.3 answers as CPP14, either the table is
    wrong for this device or the device is not what the registry says. Either
    way, a firmware push is the wrong thing to do next.
    """
    engine = _seed(f"sqlite:///{tmp_path/'r26.db'}")
    db.execute(engine, "UPDATE firmware_images SET platform = 'CPP7.3' WHERE id = 1")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1])
    fleet = _patch_fleet_get(_platform_fleet({"10.1.1.1": "CPP14/15/16"}))

    _run(engine, cfg, batch_id, fleet)

    assert fleet.uploads == []
    item = _items(engine, batch_id)[1]
    assert item["status"] == "failed"
    assert "vendor table calls" in item["message"]


def test_an_image_that_names_no_platform_leaves_the_gate_open(tmp_path):
    """Only a contradiction is fatal. An image with no platform recorded falls
    back to the model allow-list, which is where it was before."""
    engine = _seed(f"sqlite:///{tmp_path/'r22.db'}")
    cfg = _cfg(tmp_path)                      # image.platform stays NULL
    batch_id = _batch(engine, device_ids=[1])
    fleet = _patch_fleet_get(_platform_fleet({"10.1.1.1": "CPP6/7/7.3"},
                                             vendor_reads={"10.1.1.1": "7.90.0123"}))

    result, _ = _run(engine, cfg, batch_id, fleet)
    assert result["verified"] == 1
    assert len(fleet.uploads) == 1


# ── what a dead socket during an upload must do ───────────────────────────

class _ExplodingFleet(FakeCameraFleet):
    """A camera that accepts the connection and then drops it mid-upload.

    Exactly what alb-cam-44 did on the first live attempt: the POST died with
    httpx.ReadError after 0.8s, which propagated out of the runner, killed the
    batch, and left the rows saying "running" forever.
    """

    def client(self):
        import httpx as _httpx

        class _Client:
            async def __aenter__(self_inner):
                return self_inner

            async def __aexit__(self_inner, *exc):
                return False

            async def post(self_inner, url, files=None, auth=None):
                raise _httpx.ReadError("")

            async def get(self_inner, url, auth=None):
                return FakeResponse(200, text="<rcp><payload></payload></rcp>")

        return _Client()


def test_a_dropped_upload_fails_the_item_not_the_batch(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r23.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2, 3])

    result, _ = _run(engine, cfg, batch_id, _ExplodingFleet())

    # The canary failed, so the batch stopped — but it *stopped*, it did not
    # crash, and every row says what happened to it.
    assert result["aborted"] is True
    items = _items(engine, batch_id)
    assert items[1]["status"] == "failed"
    assert "ReadError" in items[1]["message"]
    # str(ReadError("")) is empty, so the class name is what makes the row
    # readable at all.
    assert "no detail from the transport" in items[1]["message"]
    assert {items[2]["status"], items[3]["status"]} == {"skipped"}
    assert not [i for i in items.values() if i["status"] == "running"]

    batch = db.fetch_one(engine, "SELECT status FROM camera_batches WHERE id = :i",
                         {"i": batch_id})
    assert batch["status"] == "aborted"

    # The attempt is still audited: something was sent to a device, or tried to be.
    audit = db.fetch_all(engine, "SELECT outcome, message FROM action_audit")
    assert len(audit) == 1 and audit[0]["outcome"] == "failed"
    assert "ReadError" in audit[0]["message"]


def test_the_upload_is_authenticated_before_the_image_is_sent(tmp_path):
    """Digest costs a round trip, and the image must not pay it.

    Digest sends the request once unauthenticated to collect the 401, then
    repeats it — which for a 91 MiB image means shipping the whole file to be
    told "authenticate first". alb-cam-44 drops the connection instead of
    reading it, and that is what killed both live attempts at 0.8s. So a cheap
    GET collects the challenge first, and the upload goes out authenticated on
    its only send.
    """
    engine = _seed(f"sqlite:///{tmp_path/'r25.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1])
    fleet = FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123"})

    _run(engine, cfg, batch_id, fleet)

    # Ordering is the whole point: a GET must precede the POST, or the image
    # pays for the challenge. Asserting only that both happened would pass
    # against the bug, because verification reads afterwards anyway.
    methods = [m for m, _ in fleet.calls]
    assert methods[0] == "GET", f"the image was sent before authenticating: {fleet.calls}"
    assert methods[1] == "POST"
    assert fleet.calls[0][1].endswith("direction=READ")
    assert fleet.uploads == ["https://10.1.1.1/upload.htm"]


def test_an_unreadable_image_says_what_to_fix(tmp_path, monkeypatch):
    """A 500 tells an operator nothing.

    Found live 2026-09-09: the images were placed as root 0640 while
    netmon.service runs as `netmon`, so the deploy button answered HTTP 500 with
    a stack trace in the journal and nothing on the page. An unreadable store is
    a configuration problem with a one-line fix and must be reported as one.

    The permission is simulated rather than set: this suite runs as root, and
    root reads a 0000 file quite happily.
    """
    import pathlib as _pathlib

    engine = _seed(f"sqlite:///{tmp_path/'r27.db'}")
    cfg = _cfg(tmp_path)
    real_open = _pathlib.Path.open

    def refuse(self, *a, **kw):
        if self.name.endswith(".fw"):
            raise PermissionError(13, "Permission denied")
        return real_open(self, *a, **kw)

    monkeypatch.setattr(_pathlib.Path, "open", refuse)
    with pytest.raises(BatchRefused) as err:
        load_image(engine, cfg, 1)

    assert "cannot read b790.fw" in str(err.value)
    assert "Permission denied" in str(err.value)
    # And it names the fix, because the operator is the one who can apply it.
    assert "readable by the user the service runs as" in str(err.value)
    assert "chown" in str(err.value)


# ── the registry learns the new version ───────────────────────────────────
#
# Missing this write kept 50 already-updated cameras on the "needs updating"
# list on 2026-09-09. Their batch items said `after_value = 7.93.0024`,
# verified by the camera's own API; `cameras.firmware` still read `7.10.0074`,
# and both pre-flight and the UI key on `cameras.firmware`.

def _fw(engine, device_id):
    return db.fetch_one(engine, "SELECT firmware FROM cameras WHERE device_id = :d",
                        {"d": device_id})["firmware"]


def test_a_verified_flash_records_the_new_version_in_the_registry(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2, 3])
    # `vendor_reads` is keyed by IP: the camera answering for itself.
    fleet = FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123",
                                          "10.1.1.2": "7.90.0123",
                                          "10.1.1.3": "7.90.0123"})
    _run(engine, cfg, batch_id, fleet)

    items = _items(engine, batch_id)
    assert all(i["status"] == ops.VERIFIED for i in items.values())
    # The point: the registry, not just the batch item.
    for device_id in (1, 2, 3):
        assert _fw(engine, device_id) == "7.90.0123"


def test_the_registry_write_is_what_stops_a_re_offer(tmp_path):
    """After a verified flash, pre-flight must refuse the same image."""
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    cfg = _cfg(tmp_path)
    image = db.fetch_one(engine, "SELECT * FROM firmware_images WHERE id = 1")

    before = ops.preflight_firmware(engine, cfg, [1], dict(image), now=NOW)
    assert [r["device_id"] for r in before.allowed] == [1]

    batch_id = _batch(engine, device_ids=[1])
    _run(engine, cfg, batch_id,
         FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123"}))

    after = ops.preflight_firmware(engine, cfg, [1], dict(image), now=NOW)
    assert after.allowed == []
    assert "already on" in " ".join(r.reason for r in after.refused).lower()


def test_a_dry_run_never_touches_the_registry(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1, 2, 3], dry=True)
    _run(engine, cfg, batch_id,
         FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123"}))
    for device_id in (1, 2, 3):
        assert _fw(engine, device_id) == "7.83.0027"


def test_an_unprovable_version_is_not_recorded_so_the_retry_stays_possible(tmp_path):
    """A bare Bosch `790` must NOT reach the registry.

    `same_release` cannot read it, and pre-flight refuses an unreadable version
    outright — so storing it would convert a camera that needs retrying into a
    blocked one. 888 cameras here report versions in that form. The reading is
    still kept where the evidence belongs: on the batch item.
    """
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1])
    _run(engine, cfg, batch_id, FakeCameraFleet(vendor_reads={"10.1.1.1": "790"}))

    item = _items(engine, batch_id)[1]
    assert item["status"] == ops.INDETERMINATE
    assert item["after_value"] == "790"          # evidence retained
    assert _fw(engine, 1) == "7.83.0027"         # registry untouched
    image = db.fetch_one(engine, "SELECT * FROM firmware_images WHERE id = 1")
    still = ops.preflight_firmware(engine, cfg, [1], dict(image), now=NOW)
    assert [r["device_id"] for r in still.allowed] == [1]


def test_a_failed_flash_does_not_claim_the_new_version(tmp_path):
    """A camera that never came back must not be recorded as updated."""
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    cfg = _cfg(tmp_path)
    batch_id = _batch(engine, device_ids=[1])
    _run(engine, cfg, batch_id, FakeCameraFleet())     # answers nothing

    assert _items(engine, batch_id)[1]["status"] == ops.FAILED
    assert _fw(engine, 1) == "7.83.0027"


def test_record_observed_firmware_ignores_an_empty_reading(tmp_path):
    from netmon.cameras.runner import record_observed_firmware
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    assert record_observed_firmware(engine, 1, None) is False
    assert record_observed_firmware(engine, 1, "   ") is False
    assert _fw(engine, 1) == "7.83.0027"
    assert record_observed_firmware(engine, 1, "7.90.0123") is True
    # Idempotent: no change means no write.
    assert record_observed_firmware(engine, 1, "7.90.0123") is False


# ── the repair for drift that already happened ────────────────────────────

def _verified_item(engine, device_id, after, *, finished, status=ops.VERIFIED):
    db.execute(engine, """
        INSERT INTO camera_batches (op, firmware_id, status, dry_run, canary_count,
            ring_size, max_concurrent, abort_pct, reboot_timeout_s, created_by, created_at)
        VALUES ('firmware_update', 1, 'done', 0, 1, 10, 3, 10, 60, 'sappleby', :t)""",
        {"t": NOW})
    batch_id = int(db.fetch_one(engine, "SELECT MAX(id) AS id FROM camera_batches")["id"])
    db.execute(engine, """
        INSERT INTO camera_batch_items (batch_id, device_id, ring, status, after_value,
            finished_at) VALUES (:b,:d,0,:s,:a,:f)""",
        {"b": batch_id, "d": device_id, "s": status, "a": after, "f": finished})


def test_reconcile_reports_drift_without_writing(tmp_path):
    from netmon.cameras.runner import reconcile_observed_firmware
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _verified_item(engine, 1, "7.93.0024", finished=NOW)

    drift = reconcile_observed_firmware(engine)
    assert [(d["device_id"], d["registry"], d["after_value"]) for d in drift] == [
        (1, "7.83.0027", "7.93.0024")]
    assert _fw(engine, 1) == "7.83.0027"          # report only


def test_reconcile_apply_corrects_the_registry(tmp_path):
    from netmon.cameras.runner import reconcile_observed_firmware
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _verified_item(engine, 1, "7.93.0024", finished=NOW)
    _verified_item(engine, 2, "7.93.0024", finished=NOW)

    drift = reconcile_observed_firmware(engine, apply=True)
    assert len(drift) == 2 and all(d["fixed"] for d in drift)
    assert _fw(engine, 1) == "7.93.0024" and _fw(engine, 2) == "7.93.0024"
    # Nothing left to do the second time.
    assert reconcile_observed_firmware(engine, apply=True) == []


def test_reconcile_ignores_dry_run_items(tmp_path):
    """A `would_run` never touched the camera."""
    from netmon.cameras.runner import reconcile_observed_firmware
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _verified_item(engine, 1, None, finished=NOW, status=ops.WOULD_RUN)
    assert reconcile_observed_firmware(engine, apply=True) == []
    assert _fw(engine, 1) == "7.83.0027"


def test_reconcile_ignores_a_failed_item(tmp_path):
    from netmon.cameras.runner import reconcile_observed_firmware
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _verified_item(engine, 1, "7.83.0027", finished=NOW, status=ops.FAILED)
    assert reconcile_observed_firmware(engine, apply=True) == []


def test_reconcile_takes_the_newest_verified_flash(tmp_path):
    """Two rolls; the later one is the truth."""
    from netmon.cameras.runner import reconcile_observed_firmware
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _verified_item(engine, 1, "7.90.0123", finished=NOW - timedelta(days=2))
    _verified_item(engine, 1, "7.93.0024", finished=NOW)

    drift = reconcile_observed_firmware(engine, apply=True)
    assert len(drift) == 1
    assert _fw(engine, 1) == "7.93.0024"


# ── the Milestone hardware refresh (owner sign-off 2026-09-09) ─────────────
#
# NetMon's only write to Milestone. Fixture-tested only — it has never been
# executed against a live VMS, which is why the config flag defaults off.

class FakeMilestone:
    """Records UpdateHardware calls; can fail on demand."""

    def __init__(self, *, status=200, raise_with=None):
        self.status = status
        self.raise_with = raise_with
        self.calls: list[str] = []

    async def update_hardware(self, hardware_id):
        self.calls.append(hardware_id)
        if self.raise_with:
            raise self.raise_with
        return self.status, "{}"


def _seed_hw(engine, device_id=1, hardware_id="d6b460a4-2f7e-46f1-a3e8-e29110c679cd"):
    db.execute(engine, "UPDATE cameras SET hardware_id = :h WHERE device_id = :d",
               {"h": hardware_id, "d": device_id})


def _run_ms(engine, cfg, batch_id, fleet, ms):
    _set_upload_field("net.bin")

    async def no_sleep(_s):
        return None

    runner = BatchRunner(engine, cfg, batch_id, actor="sappleby", role="admin",
                         client_factory=fleet.client, sleep=no_sleep,
                         milestone_firmware=lambda d: None,
                         milestone_client=lambda: ms)
    return asyncio.run(runner.run()), runner


def _audit(engine, key="milestone_update_hardware"):
    return db.fetch_all(engine, "SELECT * FROM action_audit WHERE action = :k",
                        {"k": key})


def test_a_verified_flash_asks_milestone_to_re_detect(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _seed_hw(engine)
    cfg = _cfg(tmp_path, milestone_refresh="true")
    batch_id = _batch(engine, device_ids=[1])
    ms = FakeMilestone()
    _run_ms(engine, cfg, batch_id, FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123"}), ms)

    assert ms.calls == ["d6b460a4-2f7e-46f1-a3e8-e29110c679cd"]
    rows = _audit(engine)
    assert len(rows) == 1 and rows[0]["outcome"] == "ok"


def test_the_refresh_is_off_by_default(tmp_path):
    """§4.2: it is a brand-new write to a VMS and has never run live."""
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _seed_hw(engine)
    cfg = _cfg(tmp_path)                       # no milestone_refresh
    assert cfg.camera_ops.milestone_refresh is False
    batch_id = _batch(engine, device_ids=[1])
    ms = FakeMilestone()
    _run_ms(engine, cfg, batch_id, FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123"}), ms)
    assert ms.calls == []
    assert _audit(engine) == []


def test_a_dry_run_never_touches_milestone(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _seed_hw(engine)
    cfg = _cfg(tmp_path, milestone_refresh="true")
    batch_id = _batch(engine, device_ids=[1], dry=True)
    ms = FakeMilestone()
    _run_ms(engine, cfg, batch_id, FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123"}), ms)
    assert ms.calls == []


def test_an_unverified_flash_does_not_refresh(tmp_path):
    """Nothing to tell Milestone about if the camera never confirmed."""
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _seed_hw(engine)
    cfg = _cfg(tmp_path, milestone_refresh="true")
    batch_id = _batch(engine, device_ids=[1])
    ms = FakeMilestone()
    _run_ms(engine, cfg, batch_id, FakeCameraFleet(), ms)      # answers nothing
    assert _items(engine, batch_id)[1]["status"] == ops.FAILED
    assert ms.calls == []


def test_a_failed_refresh_does_not_fail_the_flash(tmp_path):
    """The camera is demonstrably running the new firmware.

    A VMS that will not re-detect must produce a loud audit row, not a batch
    that reports failure for a camera which verified.
    """
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _seed_hw(engine)
    cfg = _cfg(tmp_path, milestone_refresh="true")
    batch_id = _batch(engine, device_ids=[1])
    ms = FakeMilestone(raise_with=RuntimeError("VMS said no"))
    result, _ = _run_ms(engine, cfg, batch_id,
                        FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123"}), ms)

    assert _items(engine, batch_id)[1]["status"] == ops.VERIFIED
    assert result["aborted"] is False
    rows = _audit(engine)
    assert len(rows) == 1 and rows[0]["outcome"] == "failed"
    assert "VMS said no" in (rows[0]["message"] or "")


def test_an_http_error_from_the_refresh_is_audited_as_failed(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _seed_hw(engine)
    cfg = _cfg(tmp_path, milestone_refresh="true")
    batch_id = _batch(engine, device_ids=[1])
    ms = FakeMilestone(status=500)
    _run_ms(engine, cfg, batch_id, FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123"}), ms)

    assert _items(engine, batch_id)[1]["status"] == ops.VERIFIED
    rows = _audit(engine)
    assert rows[0]["outcome"] == "failed" and "500" in (rows[0]["message"] or "")


def test_a_camera_with_no_hardware_id_is_skipped_not_fatal(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")   # hardware_id left NULL
    cfg = _cfg(tmp_path, milestone_refresh="true")
    batch_id = _batch(engine, device_ids=[1])
    ms = FakeMilestone()
    _run_ms(engine, cfg, batch_id, FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123"}), ms)
    assert ms.calls == []
    assert _items(engine, batch_id)[1]["status"] == ops.VERIFIED


def test_refresh_enabled_but_no_client_is_not_fatal(tmp_path):
    """The flag can be on while Milestone is unconfigured."""
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _seed_hw(engine)
    cfg = _cfg(tmp_path, milestone_refresh="true")
    batch_id = _batch(engine, device_ids=[1])
    _set_upload_field("net.bin")

    async def no_sleep(_s):
        return None

    fleet = FakeCameraFleet(vendor_reads={"10.1.1.1": "7.90.0123"})
    runner = BatchRunner(engine, cfg, batch_id, actor="sappleby", role="admin",
                         client_factory=fleet.client, sleep=no_sleep,
                         milestone_firmware=lambda d: None,
                         milestone_client=None)
    asyncio.run(runner.run())
    assert _items(engine, batch_id)[1]["status"] == ops.VERIFIED
    assert _audit(engine) == []


def test_milestone_stale_cameras_is_scoped_to_verified_flashes(tmp_path):
    """A bulk refresh must not become 2,651 re-detects."""
    from netmon.cameras.runner import milestone_stale_cameras
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _seed_hw(engine, 1)
    _seed_hw(engine, 2, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    _verified_item(engine, 1, "7.93.0024", finished=NOW)
    _verified_item(engine, 2, None, finished=NOW, status=ops.WOULD_RUN)

    rows = milestone_stale_cameras(engine)
    assert [r["device_id"] for r in rows] == [1]


def test_milestone_stale_cameras_skips_cameras_with_no_hardware_id(tmp_path):
    from netmon.cameras.runner import milestone_stale_cameras
    engine = _seed(f"sqlite:///{tmp_path/'r.db'}")
    _verified_item(engine, 1, "7.93.0024", finished=NOW)   # hardware_id NULL
    assert milestone_stale_cameras(engine) == []

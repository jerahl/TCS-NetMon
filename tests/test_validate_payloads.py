"""Tests for the live-source payload validation harness (scripts/validate_payloads.py).

The subject is the **diff logic** and the honesty rules around it — no network,
no credentials, no live source. Synthetic rows (and the clearly-fake
``tests/fixtures/payload_drift.json``) stand in for the payloads:

  * MISSING / EXTRA / RETYPED / NULL / ALWAYS-NULL / PARTIAL / ALIAS-ONLY
  * the Pydantic-derived contract (``netmon/models/xiq.py``)
  * sanitization — no payload value, secret or identifier reaches the report
  * degrade-honestly: disabled/unreachable/empty is reported, never a silent pass
  * exit codes, so a cutover checklist can gate on the run
"""

from __future__ import annotations

import io
import json

import pytest

import scripts.validate_payloads as vp
from netmon.config import load_config
from tests.conftest import FIXTURES, write_config


# --------------------------------------------------------------- helpers

def kinds(findings, kind):
    return [f for f in findings if f.kind == kind]


def one(findings, kind, field):
    hits = [f for f in findings if f.kind == kind and f.field == field]
    assert len(hits) == 1, f"expected one {kind} on {field}, got {findings}"
    return hits[0]


SPECS = (
    vp.FieldSpec("id", ("int",), required=True, nullable=False, consumer="the registry join"),
    vp.FieldSpec("name", ("str",), consumer="devices.name"),
    vp.FieldSpec("watts", ("float",), consumer="ports.poe_watts"),
)


# --------------------------------------------------------------- MISSING

def test_missing_field_is_a_blocker_when_required():
    findings, extras = vp.diff_rows([{"name": "x", "watts": 1.0}], SPECS)
    f = one(findings, "missing", "id")
    assert f.level == "blocker"
    assert "the registry join" in f.detail
    assert extras == []


def test_missing_optional_field_is_a_warning_not_a_blocker():
    findings, _ = vp.diff_rows([{"id": 1, "watts": 1.0}], SPECS)
    assert one(findings, "missing", "name").level == "warn"
    assert not [f for f in findings if f.level == "blocker"]


def test_missing_alias_group_lists_every_accepted_key():
    spec = vp.FieldSpec("last_backup", ("str",), aliases=("lastBackup", "last_run"),
                        required=True, nullable=False, consumer="config_backup freshness")
    findings, _ = vp.diff_rows([{"id": 1}], (spec,))
    detail = one(findings, "missing", "last_backup").detail
    for key in ("last_backup", "lastBackup", "last_run"):
        assert key in detail


def test_present_and_typed_payload_yields_no_findings():
    findings, extras = vp.diff_rows([{"id": 1, "name": "x", "watts": 2.5}], SPECS)
    assert findings == []
    assert extras == []


# --------------------------------------------------------------- EXTRA

def test_extra_fields_are_reported_with_types_and_counts_only():
    rows = [{"id": 1, "name": "a", "watts": 1.0, "vendor": "Acme", "tags": [1, 2]},
            {"id": 2, "name": "b", "watts": 2.0, "vendor": "Acme"}]
    findings, extras = vp.diff_rows(rows, SPECS)
    assert findings == []
    by_field = {e["field"]: e for e in extras}
    assert by_field["vendor"] == {"field": "vendor", "rows": 2, "types": ["str"],
                                  "shape": "str(len=4)"}
    assert by_field["tags"]["types"] == ["list"]
    assert by_field["tags"]["shape"] == "list[int](n=2)"
    # No value ever appears in an extras entry.
    assert "Acme" not in json.dumps(extras)


def test_extra_keys_that_are_really_identifiers_are_redacted():
    rows = [{"id": 1, "00:00:5e:00:53:01": {"seen": 1},
             "192.0.2.7": 1, "user@example.invalid": 1}]
    _, extras = vp.diff_rows(rows, SPECS[:1])
    fields = {e["field"] for e in extras}
    assert fields == {"<dynamic-key>"} or fields == {"<dynamic-key>", "<dynamic-key>"}
    blob = json.dumps(extras)
    for leak in ("00:00:5e", "192.0.2.7", "example.invalid"):
        assert leak not in blob


# --------------------------------------------------------------- RETYPED

def test_retyped_field_reports_declared_and_live_types():
    findings, _ = vp.diff_rows([{"id": "1", "name": "a", "watts": 1.0}], SPECS)
    f = one(findings, "retyped", "id")
    assert f.level == "blocker"          # required field → parsing breaks
    assert "declared int" in f.detail and "live str" in f.detail


def test_int_satisfies_a_declared_float():
    # JSON has one number type: 3 and 3.0 are the same declaration.
    findings, _ = vp.diff_rows([{"id": 1, "name": "a", "watts": 3}], SPECS)
    assert findings == []


def test_bool_is_not_an_int():
    spec = (vp.FieldSpec("clients", ("int",)),)
    findings, _ = vp.diff_rows([{"clients": True}], spec)
    assert one(findings, "retyped", "clients").detail.endswith("live bool")


def test_list_where_dict_declared_is_retyped():
    spec = (vp.FieldSpec("access_security", ("dict",)),)
    findings, _ = vp.diff_rows([{"access_security": []}], spec)
    assert kinds(findings, "retyped")


def test_unknown_declared_types_are_not_type_policed():
    spec = (vp.FieldSpec("anything"),)      # no declared types
    findings, _ = vp.diff_rows([{"anything": {"a": 1}}], spec)
    assert findings == []


# --------------------------------------------------------------- NULL

def test_null_on_a_required_field_is_a_blocker():
    findings, _ = vp.diff_rows([{"id": None, "name": "a", "watts": 1.0}], SPECS)
    f = one(findings, "null", "id")
    assert f.level == "blocker" and "required" in f.detail


def test_null_where_the_contract_is_non_nullable_is_flagged():
    spec = (vp.FieldSpec("hostname", ("str",), nullable=False),)
    findings, _ = vp.diff_rows([{"hostname": None}, {"hostname": "a"}], spec)
    f = one(findings, "null", "hostname")
    assert f.level == "warn" and "non-nullable" in f.detail


def test_always_null_optional_field_is_flagged_as_never_populated():
    spec = (vp.FieldSpec("resolution", ("str",), consumer="cameras.resolution"),)
    findings, _ = vp.diff_rows([{"resolution": None}, {"resolution": None}], spec)
    f = one(findings, "always_null", "resolution")
    assert f.level == "warn"
    assert f.kind in vp.GATING_KINDS         # same practical outcome as missing


def test_some_nulls_on_a_nullable_optional_field_are_tolerated():
    spec = (vp.FieldSpec("ssid", ("str",)),)
    findings, _ = vp.diff_rows([{"ssid": None}, {"ssid": "x"}], spec)
    assert findings == []


# --------------------------------------------------------------- PARTIAL / ALIAS

def test_partial_presence_reports_the_row_ratio():
    rows = [{"id": 1, "name": "a", "watts": 1.0}, {"id": 2, "watts": 2.0}]
    findings, _ = vp.diff_rows(rows, SPECS)
    assert "1/2" in one(findings, "partial", "name").detail


def test_alias_only_names_the_key_the_source_actually_uses():
    spec = (vp.FieldSpec("mac_address", ("str",), aliases=("mac",), required=True,
                         nullable=False),)
    findings, _ = vp.diff_rows([{"mac": "00:00:5e:00:53:01"}], spec)
    f = one(findings, "alias_only", "mac_address")
    assert f.level == "info" and "mac" in f.detail
    assert not kinds(findings, "missing")     # the alias satisfied the group


# --------------------------------------------------------------- nested children

def test_children_are_diffed_inside_a_list_of_objects():
    spec = (vp.FieldSpec("radios", ("list",), children=(
        vp.FieldSpec("name", ("str",), required=True, nullable=False),
        vp.FieldSpec("frequency", ("str",)),
    )),)
    rows = [{"radios": [{"name": "wifi0", "frequency": "2.4G"}, {"name": "wifi1"}]}]
    findings, _ = vp.diff_rows(rows, spec)
    assert "1/2" in one(findings, "partial", "radios[].frequency").detail


def test_children_are_diffed_inside_a_nested_object():
    spec = (vp.FieldSpec("access_security", ("dict",), children=(
        vp.FieldSpec("security_type", ("str",), required=True, nullable=False),
    )),)
    findings, _ = vp.diff_rows([{"access_security": {"other": 1}}], spec)
    assert one(findings, "missing", "access_security[].security_type").level == "blocker"


def test_scalar_where_an_object_was_expected_is_retyped():
    spec = (vp.FieldSpec("access_security", children=(vp.FieldSpec("security_type"),)),)
    findings, _ = vp.diff_rows([{"access_security": "wpa2"}], spec)
    assert kinds(findings, "retyped")


def test_empty_row_list_yields_nothing():
    assert vp.diff_rows([], SPECS) == ([], [])


# ------------------------------------------------- the model-derived contract

def test_specs_from_model_matches_the_xiq_device_declaration():
    specs = {s.name: s for s in vp.xiq_basic_specs()}
    assert specs["id"].required and not specs["id"].nullable and specs["id"].types == ("int",)
    assert specs["ip_address"].nullable          # str | None
    assert not specs["hostname"].nullable        # str = "" — a live null fails validation
    assert specs["connected"].types == ("bool",)


def test_xiq_basic_contract_flags_a_null_hostname_and_a_string_id():
    rows = [{"id": "900000000000001", "hostname": None, "connected": True,
             "mac_address": "00:00:5E:00:53:01"}]
    findings, _ = vp.diff_rows(rows, vp.xiq_basic_specs())
    assert one(findings, "retyped", "id").level == "blocker"
    assert one(findings, "null", "hostname").level == "warn"
    # device_admin_state absent → the MANAGED gate silently treats it as managed.
    assert one(findings, "missing", "device_admin_state").level == "warn"


def test_rconfig_contract_carries_every_timestamp_alias_the_collector_probes():
    from netmon.collectors.rconfig import _TS_KEYS

    spec = {s.name: s for s in vp.rconfig_device_specs()}[_TS_KEYS[0]]
    assert set(spec.keys) == set(_TS_KEYS)
    assert spec.required and "config_backup" in spec.consumer


# ---------------------------------------------------- fixture-based drift cases

@pytest.fixture(scope="module")
def drift() -> dict:
    return json.loads((FIXTURES / "payload_drift.json").read_text())


def test_fixture_xiq_full_drift(drift):
    findings, extras = vp.diff_rows(drift["xiq_devices_full"], vp.XIQ_FULL_SPECS)
    assert one(findings, "missing", "network_policy_name").level == "warn"
    assert "ap_details.network_policy" in one(findings, "missing", "network_policy_name").detail
    assert one(findings, "retyped", "active_clients").detail == "declared int, live str"
    assert kinds(findings, "partial")          # radios[].frequency on one radio
    assert "locations" in {e["field"] for e in extras}


def test_fixture_pf_node_drift(drift):
    findings, _ = vp.diff_rows(drift["pf_nodes"], vp.PF_NODE_SPECS)
    assert one(findings, "missing", "device_manufacturer").level == "warn"
    assert one(findings, "alias_only", "ip4log.ip").detail.endswith("ip")
    assert kinds(findings, "always_null")      # computername null on every row
    assert not [f for f in findings if f.level == "blocker"]


def test_fixture_milestone_camera_drift_loses_the_fdb_join(drift):
    findings, _ = vp.diff_rows(drift["milestone_cameras"], vp.MILESTONE_CAMERA_SPECS)
    mac = one(findings, "missing", "mac")
    assert "FDB" in mac.detail                 # the switch-port payoff goes dark
    assert one(findings, "alias_only", "recordingEnabled").detail.endswith("enabled")


def test_fixture_threecx_trunk_drift(drift):
    findings, _ = vp.diff_rows(drift["threecx_trunks"], vp.THREECX_TRUNK_SPECS)
    # Registration only arrives via the RegistrationStatus alias — the parser
    # copes, but the report must say so rather than pretend the key was there.
    assert one(findings, "alias_only", "Registered").detail.endswith("RegistrationStatus")
    assert one(findings, "missing", "ActiveCalls").level == "warn"


# --------------------------------------------------------------- sanitization

def test_scrub_text_redacts_credentials_urls_and_identifiers():
    msg = ("XIQ HTTP 401 on https://api.example.invalid/devices: "
            "{\"api_token\": \"abc123DEFghi456JKLmno789\", \"user\": \"jane@example.invalid\", "
            "\"mac\": \"00:00:5E:00:53:01\", \"host\": \"192.0.2.4\", "
            "\"sid\": \"deadbeefdeadbeefdeadbeef\"}")
    out = vp.scrub_text(msg, limit=500)
    for leak in ("abc123DEFghi456JKLmno789", "jane@example.invalid", "00:00:5E:00:53:01",
                 "192.0.2.4", "deadbeefdeadbeefdeadbeef", "api.example.invalid"):
        assert leak not in out
    assert "401" in out                        # the diagnostic part survives


def test_scrub_text_truncates():
    assert len(vp.scrub_text("word " * 200, limit=40)) == 40


def test_scrub_key_keeps_schema_names_and_drops_identifiers():
    for safe in ("mac_address", "ip4log.ip", "radios[].name", "device-type"):
        assert vp.scrub_key(safe) == safe
    for unsafe in ("00:00:5e:00:53:01", "192.0.2.4", "jane@example.invalid",
                   "0123456789abcdef0123", "x" * 80,
                   "00000000-0000-0000-0000-000000000001"):
        assert vp.scrub_key(unsafe) == "<dynamic-key>"


def test_shape_summary_never_contains_the_value():
    assert vp.shape("00:00:5E:00:53:01") == "str(len=17)"
    assert vp.shape([{"a": 1}, {"a": 2}]) == "list[dict](n=2)"
    assert vp.shape({"a": 1}) == "dict(keys=1)"
    assert vp.shape(None) == "null"


def test_shape_of_a_credential_field_hides_even_the_length():
    # A password's length is a hint; the bare type is all the report may say.
    for name in ("device_password", "api_token", "snmp_community", "secret_key",
                 "password_hash", "cookie"):
        assert vp.shape("hunter2", name) == "str"


def test_extras_do_not_leak_a_credential_length():
    rows = [{"id": 1, "device_password": "hunter2", "device_ip": "192.0.2.9"}]
    _, extras = vp.diff_rows(rows, SPECS[:1])
    by_field = {e["field"]: e for e in extras}
    assert by_field["device_password"]["shape"] == "str"
    assert by_field["device_ip"]["shape"] == "str(len=9)"   # not a credential


def test_rendered_report_leaks_no_payload_values():
    rows = [{"id": 1, "hostname": "SECRET-SWITCH-01", "mac": "00:00:5E:00:53:09",
             "api_token": "abc123DEFghi456JKLmno789", "watts": "hot"}]
    findings, extras = vp.diff_rows(rows, SPECS)
    report = vp.SourceReport("xiq", endpoints=[
        vp.EndpointReport("GET /devices", "contract", rows_sampled=1,
                          findings=findings, extras=extras)])
    buf = io.StringIO()
    vp.render_text([report], cfg_path="/etc/netmon/netmon.conf",
                   overlay="none", limit=1, out=buf)
    text = buf.getvalue()
    for leak in ("SECRET-SWITCH-01", "00:00:5E:00:53:09", "abc123DEFghi456JKLmno789", "hot"):
        assert leak not in text
    assert "RETYPED watts" in text and "api_token" in text   # names are fine


# --------------------------------------------------------------- row envelopes

@pytest.mark.parametrize("payload,container,expected", [
    ({"items": [{"a": 1}]}, "list", 1),
    ({"data": [{"a": 1}, {"a": 2}]}, "list", 2),
    ({"array": [{"a": 1}]}, "list", 1),
    ({"value": [{"a": 1}]}, "list", 1),
    ([{"a": 1}, "junk"], "list", 1),
    ({"CallsActive": 0}, "object", 1),
    ({}, "object", 0),          # PF's 404-means-empty sentinel
    (None, "list", 0),
    ("nonsense", "list", 0),
])
def test_as_rows_normalizes_the_known_envelopes(payload, container, expected):
    assert len(vp._as_rows(payload, container)) == expected


# --------------------------------------------------------------- source status

def _cfg(tmp_path, sections: str):
    return load_config(write_config(tmp_path, extra_sections=sections))


def _fake_endpoint(fetch, specs=SPECS, **kw):
    return vp.Endpoint("GET /fake", "test contract", fetch, specs=specs, **kw)


def _run(cfg, name="xiq", **kw):
    import asyncio
    return asyncio.run(vp.validate_source(cfg, name, limit=5, **kw))


def test_disabled_source_is_skipped_never_validated(tmp_path):
    cfg = _cfg(tmp_path, "[xiq]\nenabled = false\napi_token = FAKE\n")
    r = _run(cfg, include_disabled=False)
    assert r.status == "skipped" and not r.validated
    assert "enabled = false" in r.reason
    assert vp.exit_code_for([r], "any") == 0     # honest skip does not fail the run


def test_missing_credentials_report_unconfigured(tmp_path):
    cfg = _cfg(tmp_path, "[xiq]\nenabled = true\n")
    r = _run(cfg, include_disabled=False)
    assert r.status == "unconfigured" and not r.validated
    assert "api_token" in r.reason


def test_include_disabled_attempts_a_disabled_source(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, "[xiq]\nenabled = false\napi_token = FAKE\n")

    async def fetch():
        return [{"id": 1, "name": "a", "watts": 1.0}]

    monkeypatch.setitem(vp.BUILDERS, "xiq", lambda c, limit: [_fake_endpoint(fetch)])
    r = _run(cfg, include_disabled=True)
    assert r.status == "validated" and r.validated
    assert vp.exit_code_for([r], "any") == 0


def test_unreachable_source_is_not_validated_and_exits_two(tmp_path, monkeypatch):
    from netmon.collectors.xiq_client import XiqError

    cfg = _cfg(tmp_path, "[xiq]\nenabled = true\napi_token = FAKE\n")

    async def boom():
        raise XiqError("XIQ transport error on /devices: connect refused")

    monkeypatch.setitem(vp.BUILDERS, "xiq",
                        lambda c, limit: [_fake_endpoint(boom), _fake_endpoint(boom)])
    r = _run(cfg)
    assert r.status == "unreachable" and not r.validated
    assert r.endpoints[1].status == "not_attempted"
    assert vp.exit_code_for([r], "any") == 2


def test_auth_failure_is_reported_as_unauthenticated(tmp_path, monkeypatch):
    from netmon.collectors.pf_client import PfAuthError

    cfg = _cfg(tmp_path, "[packetfence]\nenabled = true\nurl = https://pf.invalid\n"
                         "user = ro\npass = FAKE\n")

    async def boom():
        raise PfAuthError("PF login failed (HTTP 401)")

    monkeypatch.setitem(vp.BUILDERS, "packetfence", lambda c, limit: [_fake_endpoint(boom)])
    r = _run(cfg, name="packetfence")
    assert r.status == "unauthenticated" and not r.validated


def test_rate_limit_is_throttled_not_blind():
    from netmon.collectors.xiq_client import XiqError, XiqRateLimitError

    assert vp.classify(XiqRateLimitError("429")) == "throttled"
    assert vp.classify(XiqError("boom")) == "unreachable"


def test_empty_endpoint_is_not_a_pass(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, "[xiq]\nenabled = true\napi_token = FAKE\n")

    async def empty():
        return []

    async def ok():
        return [{"id": 1, "name": "a", "watts": 1.0}]

    monkeypatch.setitem(vp.BUILDERS, "xiq",
                        lambda c, limit: [_fake_endpoint(ok), _fake_endpoint(empty)])
    r = _run(cfg)
    assert r.endpoints[1].status == "empty"
    assert "could not be checked" in r.endpoints[1].reason
    assert vp.exit_code_for([r], "any") == 2


def test_one_odd_endpoint_does_not_condemn_a_reachable_source(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, "[xiq]\nenabled = true\napi_token = FAKE\n")

    async def ok():
        return [{"id": 1, "name": "a", "watts": 1.0}]

    async def boom():
        raise RuntimeError("HTTP 404 on /storages")

    monkeypatch.setitem(vp.BUILDERS, "xiq",
                        lambda c, limit: [_fake_endpoint(ok), _fake_endpoint(boom)])
    r = _run(cfg)
    assert r.status == "validated" and r.validated
    assert r.endpoints[1].status == "error"


def test_configured_pii_toggle_skips_the_client_sweep(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, "[xiq]\nenabled = true\napi_token = FAKE\n")

    async def ok():
        return [{"id": 1, "name": "a", "watts": 1.0}]

    monkeypatch.setitem(vp.BUILDERS, "xiq", lambda c, limit: [
        _fake_endpoint(ok),
        _fake_endpoint(ok, skip_reason="[xiq] clients_enabled = false"),
    ])
    r = _run(cfg)
    assert r.endpoints[1].status == "skipped"
    assert not r.endpoints[1].validated


def test_shape_only_endpoint_lists_keys_without_findings(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path, "[packetfence]\nenabled = true\nurl = https://pf.invalid\n"
                         "user = ro\npass = FAKE\n")

    async def blob():
        return {"items": [{"host": "FAKE-PF-1", "status": "ok"}]}

    monkeypatch.setitem(vp.BUILDERS, "packetfence", lambda c, limit: [
        vp.Endpoint("GET /api/v1/cluster/servers", "snapshot_cache['pf.cluster']",
                    blob, container="list")])
    r = _run(cfg, name="packetfence")
    e = r.endpoints[0]
    assert e.shape_only and e.status == "ok" and e.findings == []
    assert {x["field"] for x in e.extras} == {"host", "status"}


# --------------------------------------------------------------- exit codes

def _report_with(kind: str, level: str) -> vp.SourceReport:
    return vp.SourceReport("xiq", endpoints=[vp.EndpointReport(
        "GET /fake", "c", rows_sampled=1,
        findings=[vp.Finding(kind, "f", level, "detail")])])


def test_exit_one_on_any_missing_field():
    assert vp.exit_code_for([_report_with("missing", "warn")], "any") == 1


def test_fail_on_required_narrows_the_gate_to_blockers():
    warn_only = [_report_with("missing", "warn")]
    assert vp.exit_code_for(warn_only, "required") == 0
    blocking = [_report_with("missing", "blocker")]
    assert vp.exit_code_for(blocking, "required") == 1


def test_informational_findings_do_not_gate():
    for kind in ("retyped", "partial", "alias_only"):
        assert vp.exit_code_for([_report_with(kind, "warn")], "any") == 0


def test_clean_run_exits_zero():
    clean = vp.SourceReport("xiq", endpoints=[
        vp.EndpointReport("GET /fake", "c", rows_sampled=3)])
    assert vp.exit_code_for([clean], "any") == 0


# --------------------------------------------------------------- CLI surface

def test_cli_reports_a_disabled_source_and_exits_zero(tmp_path, capsys):
    conf = write_config(tmp_path, extra_sections="[threecx]\nenabled = false\n")
    code = vp.main(["--source", "threecx", "--config", str(conf)])
    out = capsys.readouterr().out
    assert code == 0
    assert "threecx" in out and "SKIPPED" in out and "not validated" in out


def test_cli_json_report_is_machine_readable(tmp_path, capsys):
    conf = write_config(tmp_path, extra_sections="[milestone]\nenabled = false\n")
    code = vp.main(["--source", "milestone", "--config", str(conf), "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert payload["sanitized"] is True and payload["read_only"] is True
    assert payload["sources"][0]["source"] == "milestone"
    assert payload["sources"][0]["validated"] is False
    assert payload["totals"]["sources_validated"] == 0


def test_cli_refuses_a_missing_config_loudly(tmp_path, capsys):
    code = vp.main(["--source", "xiq", "--config", str(tmp_path / "nope.conf")])
    assert code == 2
    assert "ERROR" in capsys.readouterr().err


def test_every_source_has_a_builder():
    assert set(vp.BUILDERS) == set(vp.SOURCES)

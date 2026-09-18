"""Settings engine unit tests (spec 12): secretbox, registry, overlay."""

from __future__ import annotations

import pytest

from netmon import secretbox, settings as reg
from netmon.collectors.milestone import MilestoneCollector
from netmon.config import load_config
from tests.conftest import write_config

KEY = "a" * 64


# --- secretbox -------------------------------------------------------------

def test_secretbox_roundtrip():
    token = secretbox.seal(KEY, "s3cret-community")
    assert token.startswith("nmsb1:")
    assert "s3cret-community" not in token
    assert secretbox.open_token(KEY, token) == "s3cret-community"


def test_secretbox_wrong_key_and_tamper_fail():
    token = secretbox.seal(KEY, "hunter2")
    with pytest.raises(secretbox.SecretBoxError):
        secretbox.open_token("b" * 64, token)
    parts = token.split(":")
    parts[2] = ("00" + parts[2][2:]) if not parts[2].startswith("00") else ("ff" + parts[2][2:])
    with pytest.raises(secretbox.SecretBoxError):
        secretbox.open_token(KEY, ":".join(parts))
    with pytest.raises(secretbox.SecretBoxError):
        secretbox.open_token(KEY, "garbage")
    with pytest.raises(secretbox.SecretBoxError):
        secretbox.seal("", "x")


def test_secretbox_distinct_nonces():
    assert secretbox.seal(KEY, "same") != secretbox.seal(KEY, "same")


# --- registry invariants -----------------------------------------------------

def test_registry_keys_unique_and_sectioned():
    keys = [d.key for d in reg.REGISTRY]
    assert len(keys) == len(set(keys))
    for d in reg.REGISTRY:
        assert d.section in reg.SECTION_LABELS, d.key


def test_registry_excludes_bootstrap_and_recovery_keys():
    """S2: a web edit must never brick boot or lock the owner out."""
    keys = set(reg.BY_KEY)
    for forbidden in ("db.url", "db.auto_migrate", "web.host", "web.port",
                      "web.secure_cookies", "auth.local_user",
                      "auth.local_password_hash", "auth.dev_bypass_user",
                      "security.settings_key", "security.allow_web_edit",
                      "poller.fping_path", "poller.snmpget_path",
                      "snmp_inventory.snmpbulkwalk_path"):
        assert forbidden not in keys, forbidden


def test_registry_credentials_are_secrets():
    for key in ("poller.snmp_community", "auth.saml_sp_key", "xiq.api_token",
                "packetfence.pass", "milestone.pass", "threecx.client_secret",
                "rconfig.api_token"):
        assert reg.BY_KEY[key].kind == "secret", key


# --- validation --------------------------------------------------------------

def test_canonicalize_bounds_and_kinds():
    d = reg.BY_KEY["poller.ping_interval_s"]
    assert reg.canonicalize(d, 60) == "60"
    assert reg.canonicalize(d, "90") == "90"
    with pytest.raises(reg.SettingValueError):
        reg.canonicalize(d, 5)  # below min=10
    with pytest.raises(reg.SettingValueError):
        reg.canonicalize(d, "not-a-number")
    with pytest.raises(reg.SettingValueError):
        reg.canonicalize(d, None)

    b = reg.BY_KEY["engine.shadow"]
    assert reg.canonicalize(b, False) == "false"
    assert reg.canonicalize(b, "Yes") == "true"
    with pytest.raises(reg.SettingValueError):
        reg.canonicalize(b, "maybe")

    s = reg.BY_KEY["xiq.api_token"]
    with pytest.raises(reg.SettingValueError):
        reg.canonicalize(s, "   ")  # empty secret


# --- overlay -----------------------------------------------------------------

def _base_cfg(tmp_path):
    conf = write_config(tmp_path, extra_sections="[security]\nsettings_key = " + KEY)
    return load_config(conf)


def test_overlay_typed_sections_and_role_maps(tmp_path):
    base = _base_cfg(tmp_path)
    values, errors = reg.resolve_overrides(
        {
            "poller.enabled": "true",
            "poller.ping_interval_s": "30",
            "engine.shadow": "false",
            "auth.saml_role_admin": "District Admin, Netadmin",
        },
        base.security.settings_key,
    )
    assert not errors
    cfg = reg.apply_overrides(base, values)
    assert cfg.poller.enabled is True
    assert cfg.poller.ping_interval_s == 30
    assert cfg.engine.shadow is False
    assert cfg.auth.role_values["admin"] == {"District Admin", "Netadmin"}
    # Untouched sections/values ride through from the file config.
    assert cfg.poller.snmp_interval_s == base.poller.snmp_interval_s
    assert cfg.db == base.db


def test_overlay_source_settings_and_secret_injection(tmp_path):
    base = _base_cfg(tmp_path)
    sealed = secretbox.seal(base.security.settings_key, "tok-123")
    values, errors = reg.resolve_overrides(
        {"xiq.enabled": "true", "xiq.api_token": sealed,
         "rconfig.interval_s": "900"},
        base.security.settings_key,
    )
    assert not errors
    cfg = reg.apply_overrides(base, values)
    assert cfg.source_enabled("xiq") is True
    assert cfg.sources["xiq"].settings["api_token"] == "tok-123"  # in-memory only
    assert cfg.sources["rconfig"].settings["interval_s"] == "900"
    assert cfg.source_enabled("rconfig") is False  # not overridden


def test_overlay_is_fail_soft_on_bad_rows(tmp_path):
    """S8: unusable rows are reported + skipped, never applied or fatal."""
    base = _base_cfg(tmp_path)
    values, errors = reg.resolve_overrides(
        {
            "poller.ping_interval_s": "banana",     # unparseable
            "xiq.api_token": "nmsb1:00:00:00",      # undecryptable
            "no.such_key": "1",                     # stale row
            "engine.interval_s": "60",              # fine
        },
        base.security.settings_key,
    )
    assert set(errors) == {"poller.ping_interval_s", "xiq.api_token", "no.such_key"}
    cfg = reg.apply_overrides(base, values)
    assert cfg.poller.ping_interval_s == base.poller.ping_interval_s
    assert cfg.engine.interval_s == 60


def test_file_value_reads_conf_then_default(tmp_path):
    conf = write_config(
        tmp_path,
        extra_sections="[poller]\nenabled = true\nping_interval_s = 45\n\n"
                       "[xiq]\nenabled = true\nbase_url = https://xiq.example\n",
    )
    base = load_config(conf)
    assert reg.file_value(base, reg.BY_KEY["poller.ping_interval_s"]) == 45
    assert reg.file_value(base, reg.BY_KEY["poller.enabled"]) is True
    assert reg.file_value(base, reg.BY_KEY["xiq.base_url"]) == "https://xiq.example"
    # Absent from the file → registry default.
    assert reg.file_value(base, reg.BY_KEY["xiq.status_interval_s"]) == 180
    assert reg.file_value(base, reg.BY_KEY["engine.smtp_port"]) == 25


def test_ess_open_timeout_is_overlay_editable_and_reaches_the_collector(tmp_path):
    """The handshake ceiling has to be reachable from the Settings page.

    The registry, not the database, decides what is editable: an app_settings
    row for an unregistered key is skipped as a stale override and the API
    answers 404. Without this entry the setting would exist in the file only,
    on a box where the file is not how config is changed.
    """
    d = reg.BY_KEY["milestone.ess_open_timeout"]
    assert d.kind == "int" and d.default == 30
    assert not d.restart, "picked up by Apply; a restart must not be required"

    base = _base_cfg(tmp_path)
    values, errors = reg.resolve_overrides(
        {"milestone.ess_open_timeout": "75",
         "milestone.host": "vms.example.invalid"}, base.security.settings_key)
    assert not errors
    cfg = reg.apply_overrides(base, values)
    # Source sections carry raw strings; the collector parses them.
    assert cfg.sources["milestone"].settings["ess_open_timeout"] == "75"
    assert MilestoneCollector.from_config(None, cfg).ess_open_timeout == 75.0


def test_both_ess_switches_are_reachable_from_the_settings_page(tmp_path):
    """Enabling the live stream meant hand-editing netmon.conf on the box.

    That is the wrong place on this deployment: the file still reads
    `enabled = false` with the host commented out while the collector runs, so
    the file is documentation of an earlier state, not configuration. Both
    switches belong in the overlay.
    """
    live = reg.BY_KEY["milestone.ess_live"]
    snap = reg.BY_KEY["milestone.ess_enabled"]
    assert live.kind == "bool" and snap.kind == "bool"
    # The live task is registered in the app lifespan, so Apply cannot add it.
    # Saying otherwise on the page would be a lie the operator acts on.
    assert live.restart is True
    assert snap.restart is False

    base = _base_cfg(tmp_path)
    values, errors = reg.resolve_overrides(
        {"milestone.ess_live": "true", "milestone.ess_enabled": "false",
         "milestone.host": "vms.example.invalid"}, base.security.settings_key)
    assert not errors
    cfg = reg.apply_overrides(base, values)
    s = cfg.sources["milestone"].settings
    assert s["ess_live"] == "true"
    assert MilestoneCollector.from_config(None, cfg).ess_enabled is False

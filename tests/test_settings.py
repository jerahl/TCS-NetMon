"""Settings engine unit tests (spec 12): secretbox, registry, overlay."""

from __future__ import annotations

import pytest

from netmon import secretbox, settings as reg
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

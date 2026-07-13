import pytest

from netmon.config import ConfigError, load_config
from tests.conftest import write_config


def test_missing_file_raises(tmp_path):
    with pytest.raises(ConfigError, match="not found"):
        load_config(tmp_path / "nope.conf")


def test_valid_dev_config_loads(tmp_path):
    cfg = load_config(write_config(tmp_path))
    assert cfg.db.url.startswith("sqlite")
    assert cfg.auth.dev_bypass_user == "devadmin"
    assert cfg.auth.dev_bypass_role == "admin"
    assert cfg.web.secure_cookies is False


def test_missing_db_url_raises(tmp_path):
    conf = tmp_path / "netmon.conf"
    conf.write_text("[web]\nsecure_cookies = false\n[auth]\nldap_server = x\n")
    with pytest.raises(ConfigError, match="db"):
        load_config(conf)


def test_dev_bypass_refused_in_production(tmp_path):
    with pytest.raises(ConfigError, match="refused in production"):
        load_config(write_config(tmp_path, dev_bypass=True, secure_cookies=True))


def test_saml_required_without_bypass(tmp_path):
    conf = tmp_path / "netmon.conf"
    conf.write_text(
        f"[db]\nurl = sqlite:///{tmp_path/'x.db'}\n[web]\nsecure_cookies = false\n[auth]\n"
    )
    with pytest.raises(ConfigError, match="SAML IdP"):
        load_config(conf)


def test_invalid_dev_role_raises(tmp_path):
    conf = tmp_path / "netmon.conf"
    conf.write_text(
        f"[db]\nurl = sqlite:///{tmp_path/'x.db'}\n[web]\nsecure_cookies = false\n"
        f"[auth]\ndev_bypass_user = d\ndev_bypass_role = superuser\n"
    )
    with pytest.raises(ConfigError, match="dev_bypass_role"):
        load_config(conf)


def test_saml_role_maps_and_source_toggles(tmp_path):
    conf = tmp_path / "netmon.conf"
    conf.write_text(
        f"[db]\nurl = sqlite:///{tmp_path/'x.db'}\n"
        f"[web]\nsecure_cookies = false\n"
        f"[auth]\n"
        f"saml_idp_entity_id = https://idp/e\nsaml_idp_sso_url = https://idp/sso\n"
        f"saml_idp_x509cert = CERT\nsaml_sp_entity_id = https://sp\n"
        f"saml_sp_acs_url = https://sp/acs\n"
        f"saml_role_admin = Administrator, SuperAdmin\n"
        f"saml_group_operator = 42\n"
        f"[xiq]\nenabled = true\napi_token = TESTTOKEN\n"
        f"[packetfence]\nenabled = false\n"
    )
    cfg = load_config(conf)
    assert cfg.auth.role_values["admin"] == {"Administrator", "SuperAdmin"}
    assert cfg.auth.group_values["operator"] == {"42"}
    assert cfg.source_enabled("xiq") is True
    assert cfg.source_enabled("packetfence") is False

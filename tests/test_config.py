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


def test_ldap_required_without_bypass(tmp_path):
    conf = tmp_path / "netmon.conf"
    conf.write_text(
        f"[db]\nurl = sqlite:///{tmp_path/'x.db'}\n[web]\nsecure_cookies = false\n[auth]\n"
    )
    with pytest.raises(ConfigError, match="ldap_server"):
        load_config(conf)


def test_invalid_dev_role_raises(tmp_path):
    conf = tmp_path / "netmon.conf"
    conf.write_text(
        f"[db]\nurl = sqlite:///{tmp_path/'x.db'}\n[web]\nsecure_cookies = false\n"
        f"[auth]\ndev_bypass_user = d\ndev_bypass_role = superuser\n"
    )
    with pytest.raises(ConfigError, match="dev_bypass_role"):
        load_config(conf)


def test_group_map_and_source_toggles(tmp_path):
    conf = tmp_path / "netmon.conf"
    conf.write_text(
        f"[db]\nurl = sqlite:///{tmp_path/'x.db'}\n"
        f"[web]\nsecure_cookies = false\n"
        f"[auth]\nldap_server = ldaps://dc\n"
        f"group_admin = CN=NetMon-Admins,DC=x\n"
        f"[xiq]\nenabled = true\napi_token = TESTTOKEN\n"
        f"[packetfence]\nenabled = false\n"
    )
    cfg = load_config(conf)
    assert cfg.auth.group_map["admin"] == "CN=NetMon-Admins,DC=x"
    assert cfg.source_enabled("xiq") is True
    assert cfg.source_enabled("packetfence") is False

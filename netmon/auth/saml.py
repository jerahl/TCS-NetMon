"""SAML 2.0 Service Provider glue (ClassLink IdP).

Wraps python3-saml (`onelogin.saml2`), imported lazily so the pure logic
(role mapping, session issuance) is testable without the xmlsec stack and so a
dev-bypass deployment needn't load it. NetMon validates the signed assertion,
maps the `role` / `group_ids` claims to a NetMon role, and issues its own
server-side session cookie — no passwords, no directory bind.
"""

from __future__ import annotations

from typing import Any

from netmon.config import ROLES, AuthConfig
from netmon.models.schemas import Role


class SamlError(Exception):
    """Assertion invalid, or the authenticated user maps to no NetMon role."""


def build_settings(cfg: AuthConfig) -> dict[str, Any]:
    """OneLogin settings dict from config. `strict` is always on."""
    settings: dict[str, Any] = {
        "strict": True,
        "sp": {
            "entityId": cfg.sp_entity_id,
            "assertionConsumerService": {
                "url": cfg.sp_acs_url,
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
            },
            "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
            "x509cert": cfg.sp_cert,
            "privateKey": cfg.sp_key,
        },
        "idp": {
            "entityId": cfg.idp_entity_id,
            "singleSignOnService": {
                "url": cfg.idp_sso_url,
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            },
            "x509cert": cfg.idp_x509cert,
        },
    }
    if cfg.sp_slo_url:
        settings["sp"]["singleLogoutService"] = {
            "url": cfg.sp_slo_url,
            "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
        }
    return settings


def role_from_attributes(attributes: dict[str, list], cfg: AuthConfig) -> Role | None:
    """Highest NetMon role granted by the assertion's role/group_ids claims.

    Pure — no I/O. ``attributes`` is the OneLogin ``get_attributes()`` shape:
    ``{attr_name: [values]}``.
    """
    role_vals = {str(v) for v in attributes.get(cfg.role_attr, []) if v is not None}
    group_vals = {str(v) for v in attributes.get(cfg.group_attr, []) if v is not None}

    best: Role | None = None
    for role_name in ROLES:  # low → high; last match wins
        grants = cfg.role_values.get(role_name, set())
        ggrants = cfg.group_values.get(role_name, set())
        if (role_vals & grants) or (group_vals & ggrants):
            best = Role(role_name)
    return best


def build_auth(request_data: dict[str, Any], cfg: AuthConfig):
    """Construct a OneLogin auth object (lazy import of python3-saml)."""
    try:
        from onelogin.saml2.auth import OneLogin_Saml2_Auth
    except ImportError as exc:  # pragma: no cover
        raise SamlError(
            "python3-saml is not installed — required for SSO. "
            "Install it (and the xmlsec1 system library)."
        ) from exc
    return OneLogin_Saml2_Auth(request_data, build_settings(cfg))


def sp_metadata(cfg: AuthConfig) -> str:
    """Return SP metadata XML for registering NetMon in the ClassLink console."""
    try:
        from onelogin.saml2.settings import OneLogin_Saml2_Settings
    except ImportError as exc:  # pragma: no cover
        raise SamlError("python3-saml is not installed") from exc
    settings = OneLogin_Saml2_Settings(build_settings(cfg), sp_validation_only=True)
    metadata = settings.get_sp_metadata()
    errors = settings.validate_metadata(metadata)
    if errors:
        raise SamlError(f"invalid SP metadata: {errors}")
    return metadata.decode() if isinstance(metadata, bytes) else metadata

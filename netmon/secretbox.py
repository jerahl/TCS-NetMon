"""Sealing for write-only secrets stored in ``app_settings`` (spec 12 S4).

Stdlib-only authenticated encryption. The dependency policy (CLAUDE.md §3)
forbids adding ``cryptography``/``pynacl``, and storing source credentials in
plaintext would leak them through every DB dump and backup — so this module
implements a small, standard construction from ``hmac``/``hashlib``:

  * keystream: HMAC-SHA256 in counter mode (a PRF used as a stream cipher),
    keyed with a derived encryption key and a random 16-byte nonce;
  * integrity: encrypt-then-MAC over ``nonce || ciphertext`` with a separately
    derived MAC key, verified with ``hmac.compare_digest``.

Token format: ``nmsb1:<nonce hex>:<ciphertext hex>:<tag hex>``.

The master key is ``[security] settings_key`` from netmon.conf — root-protected
and outside the repo — so a copy of the database alone reveals nothing. Scope
is deliberately narrow: seal/open for ``app_settings`` values only. Do not
grow this into a general crypto facility; if a broader need appears, that is a
dependency conversation with the owner.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

TOKEN_PREFIX = "nmsb1"
_NONCE_LEN = 16
_BLOCK = hashlib.sha256().digest_size  # 32-byte keystream blocks


class SecretBoxError(Exception):
    """Malformed token, wrong key, or tampered ciphertext."""


def _keys(master: str) -> tuple[bytes, bytes]:
    """Derive independent encryption/MAC keys from the configured master."""
    base = hashlib.sha256(("netmon-settings:" + master).encode()).digest()
    enc = hmac.new(base, b"enc", hashlib.sha256).digest()
    mac = hmac.new(base, b"mac", hashlib.sha256).digest()
    return enc, mac


def _keystream(enc_key: bytes, nonce: bytes, length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hmac.new(enc_key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        counter += 1
    return bytes(out[:length])


def seal(master: str, plaintext: str) -> str:
    """Encrypt + authenticate ``plaintext``; returns an ``nmsb1:`` token."""
    if not master:
        raise SecretBoxError("no settings_key configured")
    enc_key, mac_key = _keys(master)
    nonce = secrets.token_bytes(_NONCE_LEN)
    data = plaintext.encode()
    ct = bytes(a ^ b for a, b in zip(data, _keystream(enc_key, nonce, len(data))))
    tag = hmac.new(mac_key, nonce + ct, hashlib.sha256).digest()
    return f"{TOKEN_PREFIX}:{nonce.hex()}:{ct.hex()}:{tag.hex()}"


def open_token(master: str, token: str) -> str:
    """Verify + decrypt a ``seal()`` token.

    :raises SecretBoxError: on any malformed/tampered/wrong-key input — the
        caller must treat the stored value as unusable, never as empty.
    """
    if not master:
        raise SecretBoxError("no settings_key configured")
    parts = token.split(":")
    if len(parts) != 4 or parts[0] != TOKEN_PREFIX:
        raise SecretBoxError("malformed secret token")
    try:
        nonce, ct, tag = (bytes.fromhex(p) for p in parts[1:])
    except ValueError as exc:
        raise SecretBoxError("malformed secret token") from exc
    enc_key, mac_key = _keys(master)
    expect = hmac.new(mac_key, nonce + ct, hashlib.sha256).digest()
    if not hmac.compare_digest(expect, tag):
        raise SecretBoxError("secret token failed authentication (wrong key or tampered)")
    return bytes(a ^ b for a, b in zip(ct, _keystream(enc_key, nonce, len(ct)))).decode()


def is_token(value: str | None) -> bool:
    return bool(value) and str(value).startswith(TOKEN_PREFIX + ":")

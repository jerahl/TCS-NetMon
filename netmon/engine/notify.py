"""Notifier — records notifications; sends SMTP only when not in shadow mode.

Shadow mode (default) writes a ``notifications`` row with ``shadow=1`` and
sends nothing. Maintenance-suppressed notifications are recorded (with a summary
noting the suppression) and never sent, regardless of shadow.
"""

from __future__ import annotations

import logging
import smtplib
from datetime import datetime, timezone
from email.message import EmailMessage

from sqlalchemy.engine import Engine

from netmon import db
from netmon.config import EngineConfig

log = logging.getLogger("netmon.engine.notify")


def record_notification(
    engine: Engine,
    cfg: EngineConfig,
    *,
    alert_id: int,
    target: str,
    summary: str,
    suppressed: bool,
) -> None:
    """Write a notifications row; send email only when live + not suppressed."""
    shadow = cfg.shadow or suppressed
    note = summary if not suppressed else f"[suppressed: maintenance] {summary}"
    db.execute(
        engine,
        "INSERT INTO notifications (alert_id, channel, target, sent_at, shadow, payload_summary) "
        "VALUES (:a, 'email', :t, :ts, :shadow, :p)",
        {"a": alert_id, "t": target or (cfg.default_target or ""),
         "ts": datetime.now(timezone.utc), "shadow": int(shadow), "p": note[:512]},
    )
    if shadow:
        log.info("shadow notification (alert %s → %s): %s", alert_id, target, note)
        return
    _send_email(cfg, target or cfg.default_target, summary)


def _send_email(cfg: EngineConfig, target: str, summary: str) -> None:  # pragma: no cover
    if not (cfg.smtp_host and cfg.smtp_from and target):
        log.error("live notify requested but SMTP is not fully configured; not sent")
        return
    msg = EmailMessage()
    msg["From"] = cfg.smtp_from
    msg["To"] = target
    msg["Subject"] = f"[NetMon] {summary[:120]}"
    msg.set_content(summary)
    with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=30) as s:
        s.send_message(msg)
    log.info("sent notification to %s", target)

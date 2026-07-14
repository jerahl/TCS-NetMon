"""Shadow-mode report — the NetMon side of the parallel-run comparison.

Summarizes a window of `notifications` (what the engine would have sent) plus
alerts opened/closed, into a readable report the owner diffs against Zabbix
during the Phase 8 parallel run. The Zabbix side is the owner's export.

    python -m scripts.shadow_report --days 7 [--config PATH]
    (or: NETMON_CONF=/etc/netmon/netmon.conf python scripts/shadow_report.py --days 7)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from netmon import db  # noqa: E402
from netmon.config import load_config  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NetMon shadow-mode alert report.")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)
    # SQLite and MariaDB both accept a bound cutoff computed in Python.
    from datetime import datetime, timedelta, timezone
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)

    notes = db.fetch_all(
        engine,
        "SELECT n.shadow, n.target, n.payload_summary, n.sent_at, r.severity "
        "FROM notifications n "
        "LEFT JOIN alerts a ON a.id = n.alert_id "
        "LEFT JOIN alert_rules r ON r.id = a.rule_id "
        "WHERE n.sent_at >= :cut ORDER BY n.sent_at DESC",
        {"cut": cutoff},
    )
    opened = db.fetch_one(engine, "SELECT COUNT(*) AS c FROM alerts WHERE opened_at >= :cut",
                          {"cut": cutoff})
    closed = db.fetch_one(engine, "SELECT COUNT(*) AS c FROM alerts WHERE closed_at >= :cut",
                          {"cut": cutoff})
    open_now = db.fetch_one(engine, "SELECT COUNT(*) AS c FROM alerts WHERE closed_at IS NULL")

    shadow_n = sum(1 for n in notes if n["shadow"])
    sent_n = len(notes) - shadow_n

    print(f"NetMon shadow report — last {args.days} day(s)")
    print("=" * 48)
    print(f"  alerts opened:      {opened['c'] if opened else 0}")
    print(f"  alerts closed:      {closed['c'] if closed else 0}")
    print(f"  alerts open now:    {open_now['c'] if open_now else 0}")
    print(f"  notifications:      {len(notes)}  (shadow {shadow_n} / sent {sent_n})")
    print("-" * 48)
    for n in notes[:200]:
        tag = "SHADOW" if n["shadow"] else "SENT  "
        print(f"  [{tag}] {n['sent_at']}  {n['severity'] or '-':5}  {n['payload_summary'] or ''}")
    if len(notes) > 200:
        print(f"  … {len(notes) - 200} more")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

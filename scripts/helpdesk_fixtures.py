"""Regenerate the render-check fixtures for the Helpdesk dashboard and board.

Runs the real ``netmon.helpdesk_stats`` over the unit tests' hand-built queue
(and over an empty one), so the React views are checked against exactly the
shapes the API returns. Synthetic data only — no help desk is contacted.

    PYTHONPATH=. .venv/bin/python scripts/helpdesk_fixtures.py
"""

import json
from datetime import timezone
from pathlib import Path

from netmon import helpdesk_stats as hs
from tests.test_helpdesk_stats import NOW, sample_queue

OUT = Path(__file__).resolve().parent.parent / "frontend" / "fixtures"


def main() -> None:
    active, window = sample_queue()
    extra = {"fetched_at": NOW.isoformat(), "stale": False, "error": None, "ticket_url": None}
    cases = {
        "dashboard": hs.dashboard(active, window, now=NOW, tz=timezone.utc, window_days=70),
        "dashboard_empty": hs.dashboard([], [], now=NOW, tz=timezone.utc, window_days=70),
        "board": dict(hs.board(active, window, now=NOW, tz=timezone.utc),
                      assignees=hs.assignees(active), window_days=70),
        "board_empty": dict(hs.board([], [], now=NOW, tz=timezone.utc), assignees=[], window_days=70),
    }
    OUT.mkdir(exist_ok=True)
    for name, data in cases.items():
        (OUT / f"helpdesk_{name}.json").write_text(json.dumps({**data, **extra}, indent=1) + "\n")
        print("wrote", name)


if __name__ == "__main__":
    main()

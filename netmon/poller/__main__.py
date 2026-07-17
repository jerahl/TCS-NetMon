"""Standalone poller — the documented escape hatch (CLAUDE.md §5).

    python -m netmon.poller --once            # one ping + snmp sweep, exit
    python -m netmon.poller --loop --ping      # loop ping only on its interval
    python -m netmon.poller --once --snmp      # one snmp sweep

Same code / models / DB as the in-process supervised tasks.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from netmon import db
from netmon.config import load_config
from netmon.poller.poller import Poller


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the NetMon native poller.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="run one sweep and exit")
    mode.add_argument("--loop", action="store_true", help="loop on the configured intervals")
    which = parser.add_mutually_exclusive_group()
    which.add_argument("--ping", action="store_true", help="ping sweep only")
    which.add_argument("--snmp", action="store_true", help="snmp sweep only")
    which.add_argument("--both", action="store_true", help="both (default)")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)
    # Web-managed overrides ride along in standalone runs too (spec 12 S9).
    from netmon import settings as settings_engine
    cfg = settings_engine.overlay_config(cfg, engine)
    poller = Poller(engine, cfg.poller)

    do_ping = args.ping or args.both or not (args.ping or args.snmp)
    do_snmp = args.snmp or args.both or not (args.ping or args.snmp)

    async def once() -> None:
        if do_ping:
            n = await poller.sweep_ping()
            print(f"ping sweep: {n} device(s)")
        if do_snmp:
            n = await poller.sweep_snmp()
            print(f"snmp sweep: {n} device(s)")

    async def loop() -> None:
        async def ping_loop() -> None:
            while True:
                await poller.run_ping()
                await asyncio.sleep(cfg.poller.ping_interval_s)

        async def snmp_loop() -> None:
            while True:
                await poller.run_snmp()
                await asyncio.sleep(cfg.poller.snmp_interval_s)

        tasks = []
        if do_ping:
            tasks.append(asyncio.create_task(ping_loop()))
        if do_snmp:
            tasks.append(asyncio.create_task(snmp_loop()))
        await asyncio.gather(*tasks)

    try:
        asyncio.run(loop() if args.loop else once())
    except FileNotFoundError as exc:
        # A probe binary is missing. Fail loud but readable — no traceback.
        # (In-process the supervisor catches this and records collector_health.)
        print(
            f"error: required probe binary not found: {exc.filename or 'fping/snmpget'}.\n"
            f"  Install it — fping (ICMP) and net-snmp/snmp (snmpget). "
            f"scripts/deploy.sh installs both.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

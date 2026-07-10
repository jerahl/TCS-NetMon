"""Native poller — fping sweep + snmp-alive with hysteresis.

Placeholder package for Phase 2. The poller runs as a supervised task and as
``python -m netmon.poller --once|--loop``, writing ping/snmp dimensions to
``device_state``/``state_events``. Implemented against ``docs/spec/02-poller.md``.
"""

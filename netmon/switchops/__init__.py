"""Direct SNMP switch operations (docs/spec/26-switch-ops.md).

* ``snmp``   — subprocess wrappers: snmpset (SNMPv3 write user) and
               snmpget/snmpbulkwalk (the poller's read credential).
* ``ports``  — port/index resolution and the refusal rules.
* ``ops``    — PoE cycle, port bounce, read-back verification, restore sweep.
* ``live``   — the live port view (read-only, request-driven, in memory).
"""

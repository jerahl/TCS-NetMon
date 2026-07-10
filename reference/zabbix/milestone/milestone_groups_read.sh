#!/usr/bin/env bash
# milestone_groups_read.sh
# ------------------------
# Tiny reader that Zabbix's external check invokes. Just cats the JSON
# file produced by milestone_groups_refresh.sh. Completes in
# milliseconds, well under Zabbix's 30-second timeout cap.
#
# The full snapshot (including each group's cameraIds[] / hardwareIds[])
# is emitted as-is: the dashboard's Sites tab uses cameraIds to attribute
# cameras — and their state — to each group, so we must NOT strip them.
#
# If the snapshot file is older than $MAX_AGE seconds (default 3600 = 1h,
# tuned for a 15-minute refresh cadence with 4x slack), prints a JSON
# error object so Zabbix shows the master item as "no recent data".
#
# Usage from Zabbix item key:
#   milestone_groups_read.sh[]
#   milestone_groups_read.sh[3600]    # custom max age
#
# Output file (must match milestone_groups_refresh.sh):
#   /var/lib/zabbix/milestone_groups_state.json

set -euo pipefail

OUT_FILE="/var/lib/zabbix/milestone_groups_state.json"
ERR_FILE="/var/lib/zabbix/milestone_groups_state.err"

# Tolerated age in seconds before we consider the snapshot stale.
# Default: 1 hour (4x the recommended 15-minute refresh cadence).
MAX_AGE="${1:-3600}"

if [[ ! -f "$OUT_FILE" ]]; then
    msg="snapshot file missing at $OUT_FILE; has milestone_groups_refresh.sh run yet?"
    printf '{"error":"no_snapshot","detail":"%s"}\n' "$msg"
    exit 0  # exit 0 so Zabbix stores the JSON, not a script-failure state
fi

# File age check.
NOW=$(date +%s)
MTIME=$(stat -c%Y "$OUT_FILE" 2>/dev/null || echo 0)
AGE=$(( NOW - MTIME ))
if [[ "$AGE" -gt "$MAX_AGE" ]]; then
    err_detail=""
    if [[ -f "$ERR_FILE" ]]; then
        err_detail=$(tr '\n' ' ' < "$ERR_FILE")
    fi
    printf '{"error":"stale","age_seconds":%d,"max_age_seconds":%d,"last_refresh_error":"%s"}\n' \
        "$AGE" "$MAX_AGE" "$err_detail"
    exit 0
fi

cat "$OUT_FILE"

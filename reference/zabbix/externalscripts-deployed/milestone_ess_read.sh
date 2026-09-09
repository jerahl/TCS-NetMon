#!/usr/bin/env bash
# milestone_ess_read.sh
# ---------------------
# Tiny reader that Zabbix's external check invokes. Just cats the JSON
# file produced by milestone_ess_refresh.sh. Completes in milliseconds,
# well under Zabbix's 30-second timeout cap.
#
# If the snapshot file is older than $MAX_AGE seconds (default 172800 = 48h,
# tuned for a daily refresh cadence with generous slack), print a JSON
# error object so Zabbix can alert on stale data.
#
# Usage from Zabbix item key:
#   milestone_ess_read.sh[]
#
# Output file (must match milestone_ess_refresh.sh):
#   /var/lib/zabbix/milestone_ess_state.json

set -euo pipefail

OUT_FILE="/var/lib/zabbix/milestone_ess_state.json"
ERR_FILE="/var/lib/zabbix/milestone_ess_state.err"

# Tolerated age in seconds before we consider the snapshot stale.
# Default: 48 hours (2x the daily refresh cadence).
# Override with an argument if you use a different refresh cadence.
MAX_AGE="${1:-172800}"

if [[ ! -f "$OUT_FILE" ]]; then
    msg="snapshot file missing at $OUT_FILE; has milestone_ess_refresh.sh run yet?"
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

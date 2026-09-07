#!/usr/bin/env bash
# milestone_ess_refresh.sh
# ------------------------
# Cron/systemd-timer wrapper around milestone_ess_state.py.
#
# Runs the WebSocket fetch (which can take 1-2 minutes at 2500+ cameras),
# writes the result atomically to a JSON file, and logs stderr. Zabbix's
# external check then just reads the file — no 30-second timeout issue.
#
# Usage:
#   milestone_ess_refresh.sh <host> <username> <password> [--scheme https]
#
# Recommended cron entry (as the zabbix user, once a day at 03:15):
#   15 3 * * * /usr/local/bin/milestone_ess_refresh.sh \
#              milestone.example.com zbx_monitor 'password' --scheme https
#
# Output file:      /var/lib/zabbix/milestone_ess_state.json
# Log file:         /var/log/zabbix/milestone_ess_state.log
# Lock file:        /var/lib/zabbix/milestone_ess_state.lock
#
# Exit codes:
#   0   success, file updated
#   1   ESS script failed (see log)
#   2   another instance was already running (flock)

set -euo pipefail

HELPER="/usr/lib/zabbix/externalscripts/milestone_ess_state.py"
OUT_FILE="/var/lib/zabbix/milestone_ess_state.json"
ERR_FILE="/var/lib/zabbix/milestone_ess_state.err"
LOG_FILE="/var/log/zabbix/milestone_ess_state.log"
LOCK_FILE="/var/lib/zabbix/milestone_ess_state.lock"
TMP_FILE="${OUT_FILE}.tmp.$$"

mkdir -p "$(dirname "$OUT_FILE")" "$(dirname "$LOG_FILE")"

# flock — prevent overlapping runs if a previous invocation is still going.
# -n: fail immediately rather than wait.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "$(date -Iseconds) another instance is running, exiting" >> "$LOG_FILE"
    exit 2
fi

START=$(date +%s)
echo "$(date -Iseconds) starting ESS fetch: $*" >> "$LOG_FILE"

# Run the helper. stdout -> temp file, stderr -> log.
# The helper exits non-zero on any failure and prints a JSON error to stderr.
if "$HELPER" "$@" > "$TMP_FILE" 2>> "$LOG_FILE"; then
    # Atomic rename — Zabbix readers never see a half-written file.
    mv -f "$TMP_FILE" "$OUT_FILE"
    # Clear any stale error marker from previous failed runs.
    rm -f "$ERR_FILE"
    END=$(date +%s)
    SIZE=$(stat -c%s "$OUT_FILE" 2>/dev/null || wc -c < "$OUT_FILE")
    echo "$(date -Iseconds) success: ${SIZE} bytes in $((END - START))s" >> "$LOG_FILE"
    exit 0
else
    RC=$?
    # Preserve the failure message where the reader can pick it up.
    date -Iseconds > "$ERR_FILE"
    echo "helper exit code: $RC" >> "$ERR_FILE"
    rm -f "$TMP_FILE"
    echo "$(date -Iseconds) FAILURE rc=$RC" >> "$LOG_FILE"
    exit 1
fi

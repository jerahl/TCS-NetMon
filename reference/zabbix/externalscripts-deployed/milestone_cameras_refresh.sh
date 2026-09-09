#!/usr/bin/env bash
# milestone_cameras_refresh.sh
# ----------------------------
# Cron/systemd-timer wrapper around milestone_cameras_state.py.
#
# Runs the REST fetch (typically a few seconds, even at 2500 cameras
# since it's one or two HTTP calls) and writes the result atomically
# to a JSON file. Zabbix's external check then just reads the file.
#
# This mirrors the milestone_ess_refresh.sh pattern so operators have
# one mental model: refresh.sh writes, read.sh cats.
#
# Usage:
#   milestone_cameras_refresh.sh <host> <username> <password> [--scheme https]
#
# Recommended cron entry (as the zabbix user, every 15 minutes — cameras
# rarely change but new IP assignments should propagate quickly):
#   */15 * * * * /usr/local/bin/milestone_cameras_refresh.sh \
#                milestone.example.com zbx_monitor 'password' --scheme https
#
# Output file:  /var/lib/zabbix/milestone_cameras_state.json
# Log file:     /var/log/zabbix/milestone_cameras_state.log
# Lock file:    /var/lib/zabbix/milestone_cameras_state.lock
#
# Exit codes:
#   0   success, file updated
#   1   helper failed (see log)
#   2   another instance was already running (flock)

set -euo pipefail

HELPER="/usr/lib/zabbix/externalscripts/milestone_cameras_state.py"
OUT_FILE="/var/lib/zabbix/milestone_cameras_state.json"
ERR_FILE="/var/lib/zabbix/milestone_cameras_state.err"
LOG_FILE="/var/log/zabbix/milestone_cameras_state.log"
LOCK_FILE="/var/lib/zabbix/milestone_cameras_state.lock"
TMP_FILE="${OUT_FILE}.tmp.$$"

mkdir -p "$(dirname "$OUT_FILE")" "$(dirname "$LOG_FILE")"

# flock — prevent overlapping runs.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "$(date -Iseconds) another instance is running, exiting" >> "$LOG_FILE"
    exit 2
fi

START=$(date +%s)
echo "$(date -Iseconds) starting cameras fetch: $*" >> "$LOG_FILE"

# Run the helper. stdout -> temp file, stderr -> log.
if "$HELPER" "$@" > "$TMP_FILE" 2>> "$LOG_FILE"; then
    # Atomic rename — Zabbix readers never see a half-written file.
    mv -f "$TMP_FILE" "$OUT_FILE"
    rm -f "$ERR_FILE"
    END=$(date +%s)
    SIZE=$(stat -c%s "$OUT_FILE" 2>/dev/null || wc -c < "$OUT_FILE")
    echo "$(date -Iseconds) success: ${SIZE} bytes in $((END - START))s" >> "$LOG_FILE"
    exit 0
else
    RC=$?
    date -Iseconds > "$ERR_FILE"
    echo "helper exit code: $RC" >> "$ERR_FILE"
    rm -f "$TMP_FILE"
    echo "$(date -Iseconds) FAILURE rc=$RC" >> "$LOG_FILE"
    exit 1
fi

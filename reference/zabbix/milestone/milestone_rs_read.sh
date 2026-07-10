#!/bin/bash
# Emits the latest milestone_rs_state.json snapshot for the Zabbix
# "Milestone XProtect RS extras by HTTP" template's master item.
#
# Usage from a Zabbix EXTERNAL item:  milestone_rs_read.sh[3600]
#   The argument is the max acceptable age in seconds; if the file is
#   older than that, emit an explicit error JSON so the staleness
#   trigger can fire.
#
# Override the snapshot path with MILESTONE_RS_SNAP=/some/path if you
# moved /var/lib/zabbix.
set -eu
MAX_AGE="${1:-3600}"
SNAP="${MILESTONE_RS_SNAP:-/var/lib/zabbix/milestone_rs_state.json}"

if [ ! -f "$SNAP" ]; then
  printf '{"error":"no_snapshot","path":"%s"}\n' "$SNAP"
  exit 0
fi

NOW=$(date +%s)
# Linux stat -c first, BSD/macOS stat -f as fallback (helps when the
# script is run from a non-Linux test box).
MTIME=$(stat -c %Y "$SNAP" 2>/dev/null || stat -f %m "$SNAP")
AGE=$(( NOW - MTIME ))

if [ "$AGE" -gt "$MAX_AGE" ]; then
  printf '{"error":"stale","age_seconds":%d,"max_age":%d}\n' "$AGE" "$MAX_AGE"
  exit 0
fi

cat "$SNAP"

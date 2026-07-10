#!/usr/bin/env bash
# milestone_ess_read.sh
# ---------------------
# Reader that Zabbix's external check invokes for the ESS (per-camera state)
# master item. It cats the JSON file produced by milestone_ess_refresh.sh,
# but FIRST drops the raw per-camera "states" event list, keeping only the
# compact "by_group" summary the dashboard's state items resolve against.
#
# Why slim: each camera carries both a raw "states" array (every current
# stateful event) and a deduped "by_group" map ({stategroupId: {type,time}}).
# The dashboard only reads by_group (that's what the milestone.cam.* state
# extraction targets), so the raw states list is redundant. At ~2,560
# cameras dropping it cuts the snapshot from ~6 MB to ~2 MB.
#
# Usage from Zabbix item key:
#   milestone_ess_read.sh[]
#   milestone_ess_read.sh[172800]    # custom max age
#
# Output file (must match milestone_ess_refresh.sh):
#   /var/lib/zabbix/milestone_ess_state.json

set -euo pipefail

OUT_FILE="/var/lib/zabbix/milestone_ess_state.json"
ERR_FILE="/var/lib/zabbix/milestone_ess_state.err"

# Tolerated age in seconds before we consider the snapshot stale.
# Default: 48 hours (2x the daily refresh cadence).
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

# Emit the snapshot with each camera's raw states[] dropped, keeping by_group.
# Falls back to the raw file only if python is unavailable.
python3 - "$OUT_FILE" <<'PY' || cat "$OUT_FILE"
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

cams = data.get("cameras")
if isinstance(cams, dict):
    for guid, rec in cams.items():
        if isinstance(rec, dict):
            rec.pop("states", None)

sys.stdout.write(json.dumps(data, separators=(",", ":")))
sys.stdout.write("\n")
PY

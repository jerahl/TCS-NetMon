#!/bin/bash
# Refreshes /var/lib/zabbix/milestone_rs_state.json for the Zabbix
# "Milestone XProtect RS extras by HTTP" template.
#
# Usage:
#   milestone_rs_refresh.sh HOST USER PASSWORD [extra args passed through]
#
# Cron entry (as the zabbix user):
#   */15 * * * * /usr/lib/zabbix/externalscripts/milestone_rs_refresh.sh \
#       {$MILESTONE.HOST} {$MILESTONE.USER} 'PASSWORD' --scheme https \
#       >/dev/null 2>&1
#
# Companion scripts:
#   milestone_rs_state.py  — does the actual REST work
#   milestone_rs_read.sh   — emits the snapshot for the Zabbix EXTERNAL item
set -eu
DIR="$(dirname "$(readlink -f "$0")")"
exec /usr/bin/python3 "$DIR/milestone_rs_state.py" "$@"

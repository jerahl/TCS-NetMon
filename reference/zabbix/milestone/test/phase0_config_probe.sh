#!/usr/bin/env bash
# phase0_config_probe.sh
# ----------------------
# Phase 0 verification for the Milestone REST+WS rework, config plane.
#
# Captures the facts the chosen camera-plane design ("single native SCRIPT
# aggregator", milestone-rework-brief.md Phase 1 task 2) depends on, and the
# fixtures the brief's Phase 0 DoD calls for. Run it against the DEV API
# Gateway, never production.
#
# It answers, on stdout, the gating questions:
#   Q-A  Does GET /recordingServers/{id}/hardware?includeChildren=cameras,settings
#        embed each hardware's cameras[] AND a MAC address setting, in ONE call
#        per recording server?  (If yes, the aggregator is one call per RS.)
#   Q-B  Does the Config API honour ?size= / ?page=, or ignore them and return
#        everything?  (Determines whether paging is available for staging.)
#   Q-C  Which IDP token path works here: /API/IDP/connect/token or
#        /IDP/connect/token?  (The template SCRIPTs use the latter; the python
#        helpers default to the former.)
#
# Fixtures are written to ./fixtures/ (gitignored). Capture them, then attach
# the summary block to the Phase 0 notes.
#
# Requires: bash, curl, and either jq OR python3 for JSON inspection.
# Usage:
#   cp .env.example .env && $EDITOR .env
#   ./phase0_config_probe.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$HERE/fixtures"
mkdir -p "$FIX"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
if [[ -f "$HERE/.env" ]]; then
    # shellcheck disable=SC1091
    set -a; . "$HERE/.env"; set +a
else
    echo "FATAL: $HERE/.env not found. Copy .env.example to .env and fill it in." >&2
    exit 1
fi

HOST="${MILESTONE_HOST:?set MILESTONE_HOST in .env}"
SCHEME="${MILESTONE_SCHEME:-https}"
USER="${MILESTONE_USER:?set MILESTONE_USER in .env}"
PASSWORD="${MILESTONE_PASSWORD:?set MILESTONE_PASSWORD in .env}"
CLIENT_ID="${MILESTONE_CLIENT_ID:-GrantValidatorClient}"
VERIFY_TLS="${MILESTONE_VERIFY_TLS:-0}"

BASE="$SCHEME://$HOST"
API="$BASE/api/rest/v1"

CURL=(curl -sS --max-time 60)
[[ "$VERIFY_TLS" == "1" ]] || CURL+=(-k)

# ---------------------------------------------------------------------------
# JSON helpers — prefer jq, fall back to python3.
# ---------------------------------------------------------------------------
if command -v jq >/dev/null 2>&1; then
    JQ() { jq "$@"; }
    HAVE_JQ=1
elif command -v python3 >/dev/null 2>&1; then
    HAVE_JQ=0
else
    echo "FATAL: need jq or python3 to inspect JSON." >&2
    exit 1
fi

# pyq <jsonfile> <python-expr-on-`d`>  — print result, '' on error.
pyq() {
    python3 - "$1" "$2" <<'PY' 2>/dev/null || true
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(eval(sys.argv[2]))
except Exception:
    print("")
PY
}

# count_array <jsonfile> — number of elements in the `.array` collection
# (Config API list responses wrap results in {"array":[...]}).
count_array() {
    if [[ "$HAVE_JQ" == "1" ]]; then
        jq -r '(.array // []) | length' "$1" 2>/dev/null || echo "?"
    else
        pyq "$1" 'len(d.get("array",[]))'
    fi
}

# first_id <jsonfile> — id of the first element of `.array`.
first_id() {
    if [[ "$HAVE_JQ" == "1" ]]; then
        jq -r '(.array // [])[0].id // empty' "$1" 2>/dev/null
    else
        pyq "$1" 'd.get("array",[{}])[0].get("id","")'
    fi
}

ok()   { printf '  [ ok ] %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 0. Token — try /API/IDP first (python helper default), then /IDP (template).
# ---------------------------------------------------------------------------
echo "== Phase 0 config probe =="
echo "Gateway: $BASE   user: $USER   verify-tls: $VERIFY_TLS"
echo

TOKEN=""; IDP_PATH=""
for path in /API/IDP/connect/token /IDP/connect/token; do
    resp="$("${CURL[@]}" -X POST "$BASE$path" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-urlencode "grant_type=password" \
        --data-urlencode "username=$USER" \
        --data-urlencode "password=$PASSWORD" \
        --data-urlencode "client_id=$CLIENT_ID" 2>/dev/null)"
    if [[ "$HAVE_JQ" == "1" ]]; then
        tok="$(printf '%s' "$resp" | jq -r '.access_token // empty' 2>/dev/null)"
        exp="$(printf '%s' "$resp" | jq -r '.expires_in // empty' 2>/dev/null)"
    else
        tok="$(printf '%s' "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)"
        exp="$(printf '%s' "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("expires_in",""))' 2>/dev/null)"
    fi
    if [[ -n "$tok" ]]; then
        TOKEN="$tok"; IDP_PATH="$path"
        ok "token via $path  (expires_in=${exp:-?}s)"
        break
    fi
done
if [[ -z "$TOKEN" ]]; then
    fail "could not obtain a token on either IDP path. Check creds/host/scheme."
    echo "  last response: ${resp:0:300}"
    exit 2
fi
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Accept: application/json')
echo

# get <path> <fixture-basename>  — GET $API$path, save body to fixtures, echo path
get() {
    local p="$1" name="$2" out="$FIX/$2.json"
    "${CURL[@]}" "${AUTH[@]}" "$API$p" > "$out" 2>/dev/null
    echo "$out"
}

# ---------------------------------------------------------------------------
# 1. RS → hardware → cameras walk (baseline fixtures)
# ---------------------------------------------------------------------------
echo "== 1. Config walk =="
RS_F="$(get /recordingServers rs_list)"
RS_N="$(count_array "$RS_F")"; RS_ID="$(first_id "$RS_F")"
[[ -n "$RS_ID" ]] && ok "GET /recordingServers -> $RS_N RS (first: $RS_ID)" \
                  || { fail "GET /recordingServers returned no usable array"; cat "$RS_F" | head -c 300; echo; exit 3; }

HW_F="$(get "/recordingServers/$RS_ID/hardware" rs_hardware)"
HW_N="$(count_array "$HW_F")"; HW_ID="$(first_id "$HW_F")"
[[ -n "$HW_ID" ]] && ok "GET /recordingServers/$RS_ID/hardware -> $HW_N hardware (first: $HW_ID)" \
                  || warn "no hardware under first RS; try another RS for the cameras step"

if [[ -n "${HW_ID:-}" ]]; then
    CAM_F="$(get "/hardware/$HW_ID/cameras" hw_cameras)"
    CAM_N="$(count_array "$CAM_F")"
    ok "GET /hardware/$HW_ID/cameras -> $CAM_N cameras (one full camera object captured)"
fi
echo

# ---------------------------------------------------------------------------
# 2. Q-A — RS-scoped includeChildren=cameras,settings  (THE gating probe)
# ---------------------------------------------------------------------------
echo "== 2. Q-A: includeChildren on RS-scoped hardware =="
INC_F="$(get "/recordingServers/$RS_ID/hardware?includeChildren=cameras,settings" rs_hardware_inc)"
if [[ "$HAVE_JQ" == "1" ]]; then
    emb_cams="$(jq -r '[.array[]? | (.cameras // [] | length)] | add // 0' "$INC_F" 2>/dev/null)"
    has_settings="$(jq -r 'any(.array[]?; has("settings")) // false' "$INC_F" 2>/dev/null)"
    mac_hit="$(jq -r '[.. | objects | to_entries[]? | select((.key|ascii_downcase)|test("mac")) | .value] | length' "$INC_F" 2>/dev/null)"
else
    emb_cams="$(pyq "$INC_F" 'sum(len(h.get("cameras",[])) for h in d.get("array",[]))')"
    has_settings="$(pyq "$INC_F" 'any("settings" in h for h in d.get("array",[]))')"
    mac_hit="$(python3 - "$INC_F" <<'PY' 2>/dev/null || echo 0
import json,sys
d=json.load(open(sys.argv[1])); n=0
def walk(o):
    global n
    if isinstance(o,dict):
        for k,v in o.items():
            if "mac" in str(k).lower(): n+=1
            walk(v)
    elif isinstance(o,list):
        for v in o: walk(v)
walk(d); print(n)
PY
)"
fi
if [[ "${emb_cams:-0}" =~ ^[0-9]+$ ]] && (( emb_cams > 0 )); then
    ok "cameras ARE embedded per hardware (total embedded cameras: $emb_cams)"
    echo "       => aggregator can be ONE call per RS. Option A viable as designed."
else
    warn "no embedded cameras under includeChildren=cameras — aggregator must keep"
    warn "the per-hardware /hardware/{id}/cameras fallback (slower; check timeout)."
fi
[[ "$has_settings" == "true" ]] && ok "hardware 'settings' present (MAC source)" \
                                || warn "no inline 'settings' — MAC needs per-hardware /hardware/{id}/settings"
[[ "${mac_hit:-0}" =~ ^[0-9]+$ ]] && (( mac_hit > 0 )) \
    && ok "a MAC-like field is present in the embedded payload ($mac_hit hits)" \
    || warn "no MAC-like field found inline; confirm where milestone_cameras_state.py sources \$.mac"
echo

# ---------------------------------------------------------------------------
# 3. Q-B — pagination behaviour on the Config API
# ---------------------------------------------------------------------------
echo "== 3. Q-B: does the Config API honour ?size= / ?page= ? =="
ALL_F="$(get "/hardware?disabled" hw_all)"; ALL_N="$(count_array "$ALL_F")"
S2_F="$(get "/hardware?disabled&size=2" hw_size2)"; S2_N="$(count_array "$S2_F")"
ok "GET /hardware?disabled            -> $ALL_N"
ok "GET /hardware?disabled&size=2     -> $S2_N"
if [[ "$S2_N" =~ ^[0-9]+$ ]] && (( S2_N == 2 )); then
    ok "size=2 TRUNCATES -> Config API honours paging (page/size usable for staging)"
elif [[ "$S2_N" == "$ALL_N" ]]; then
    warn "size=2 returned the full set -> Config API IGNORES paging (as the spec implies)"
else
    warn "size=2 returned $S2_N (inconclusive — inspect fixtures/hw_size2.json)"
fi
echo

# ---------------------------------------------------------------------------
# 4. cameraGroups — for the milestone.groups.get conversion
# ---------------------------------------------------------------------------
echo "== 4. cameraGroups (groups SCRIPT conversion) =="
GRP_F="$(get /cameraGroups groups_list)"; GRP_N="$(count_array "$GRP_F")"
GRP_ID="$(first_id "$GRP_F")"
ok "GET /cameraGroups -> $GRP_N groups (first: ${GRP_ID:-none})"
if [[ -n "${GRP_ID:-}" ]]; then
    GC_F="$(get "/cameraGroups/$GRP_ID/cameras" group_cameras)"; GC_N="$(count_array "$GC_F")"
    ok "GET /cameraGroups/$GRP_ID/cameras -> $GC_N cameras"
    if [[ "$HAVE_JQ" == "1" ]]; then
        has_counts="$(jq -r 'any(.array[]?; has("cameraCount") or has("hardwareCount")) // false' "$GRP_F" 2>/dev/null)"
    else
        has_counts="$(pyq "$GRP_F" 'any(("cameraCount" in g) or ("hardwareCount" in g) for g in d.get("array",[]))')"
    fi
    [[ "$has_counts" == "true" ]] \
        && ok "groups carry cameraCount/hardwareCount inline (no per-group fan-out needed)" \
        || warn "groups lack inline counts -> milestone.groups.get must walk /cameraGroups/{id}/cameras per group"
fi
echo

# ---------------------------------------------------------------------------
# 5. storages — for the RS-extras disposition (storage rollups)
# ---------------------------------------------------------------------------
echo "== 5. RS storages (RS-extras disposition) =="
ST_F="$(get "/recordingServers/$RS_ID/storages" rs_storages)"; ST_N="$(count_array "$ST_F")"
ok "GET /recordingServers/$RS_ID/storages -> $ST_N storages (capacity/used/retention source)"
echo

# ---------------------------------------------------------------------------
# 6. GLOBAL-endpoint variants — what milestone.cameras.getall will actually do.
#    Section 2 (Q-A) probed the RS-SCOPED /recordingServers/{id}/hardware, which
#    does NOT support includeChildren. The deployed milestone_cameras_state.py
#    uses the GLOBAL /hardware?includeChildren=cameras,settings with paging.
#    These probes confirm that path on this Gateway.
# ---------------------------------------------------------------------------
echo "== 6. Global /hardware includeChildren + /cameras paging =="
GINC_F="$(get "/hardware?disabled&includeChildren=cameras,settings&size=3" hw_global_inc)"
if [[ "$HAVE_JQ" == "1" ]]; then
    g_cams="$(jq -r '[.array[]? | (.cameras // [] | length)] | add // 0' "$GINC_F" 2>/dev/null)"
    g_settings="$(jq -r 'any(.array[]?; has("settings")) // false' "$GINC_F" 2>/dev/null)"
    g_mac="$(jq -r '[.. | objects | to_entries[]? | select((.key|ascii_downcase)|test("mac")) | .value] | length' "$GINC_F" 2>/dev/null)"
else
    g_cams="$(pyq "$GINC_F" 'sum(len(h.get("cameras",[])) for h in d.get("array",[]))')"
    g_settings="$(pyq "$GINC_F" 'any("settings" in h for h in d.get("array",[]))')"
    g_mac="$(python3 - "$GINC_F" <<'PY' 2>/dev/null || echo 0
import json,sys
d=json.load(open(sys.argv[1])); n=0
def walk(o):
    global n
    if isinstance(o,dict):
        for k,v in o.items():
            if "mac" in str(k).lower(): n+=1
            walk(v)
    elif isinstance(o,list):
        for v in o: walk(v)
walk(d); print(n)
PY
)"
fi
if [[ "${g_cams:-0}" =~ ^[0-9]+$ ]] && (( g_cams > 0 )); then
    ok "GLOBAL /hardware?includeChildren=cameras embeds cameras ($g_cams in 3 hw)"
    echo "       => milestone.cameras.getall = paged global includeChildren. Viable."
else
    warn "GLOBAL includeChildren=cameras did NOT embed cameras either."
    warn "=> fall back to two-endpoint join: page /hardware + page /cameras, join on parent."
fi
[[ "$g_settings" == "true" ]] && ok "GLOBAL includeChildren=settings present" \
                              || warn "no inline settings globally -> MAC unavailable in bulk"
[[ "${g_mac:-0}" =~ ^[0-9]+$ ]] && (( g_mac > 0 )) \
    && ok "MAC-like field present in global payload ($g_mac hits) -> \$.mac preservable" \
    || warn "no MAC inline -> \$.mac would be blank unless per-hardware /settings fan-out (infeasible)"

# Does the GLOBAL /cameras collection exist and page? (Two-endpoint-join fallback.)
GCAM2_F="$(get "/cameras?disabled&size=2" cameras_size2)"; GCAM2_N="$(count_array "$GCAM2_F")"
GCAM_F="$(get "/cameras?disabled" cameras_all)"; GCAM_N="$(count_array "$GCAM_F")"
ok "GET /cameras?disabled -> $GCAM_N cameras;  &size=2 -> $GCAM2_N"
if [[ "$GCAM2_N" =~ ^[0-9]+$ ]] && (( GCAM2_N == 2 )); then
    ok "global /cameras exists AND pages -> two-endpoint join is a valid fallback"
elif [[ "$GCAM2_N" == "$GCAM_N" && "$GCAM_N" =~ ^[0-9]+$ ]]; then
    warn "global /cameras returns all (no paging) -> join fallback needs the full /cameras blob"
else
    warn "global /cameras inconclusive ($GCAM2_N) -> inspect fixtures/cameras_size2.json"
fi
echo

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
cat <<EOF
== FACTS SUMMARY (copy into Phase 0 notes) ==
  IDP token path that works here : $IDP_PATH
  Config REST base               : $API
  recording servers              : $RS_N
  hardware (first RS / total)    : ${HW_N:-?} / ${ALL_N:-?}
  Q-A includeChildren (RS-scoped): $( [[ "${emb_cams:-0}" =~ ^[0-9]+$ && "${emb_cams:-0}" -gt 0 ]] && echo "embeds cams" || echo "NO (expected; RS-scoped has no includeChildren)" )
  Q-A* includeChildren (GLOBAL)  : $( [[ "${g_cams:-0}" =~ ^[0-9]+$ && "${g_cams:-0}" -gt 0 ]] && echo "YES embeds cams ($g_cams/3)" || echo "NO -> use two-endpoint join" )
  global includeChildren MAC     : $( [[ "${g_mac:-0}" =~ ^[0-9]+$ && "${g_mac:-0}" -gt 0 ]] && echo "YES (\$.mac preservable)" || echo "NO (\$.mac blank)" )
  Q-B paging honoured            : $( [[ "${S2_N:-}" =~ ^[0-9]+$ && "${S2_N:-0}" -eq 2 ]] && echo "YES (size= truncates)" || echo "NO (size= ignored)" )
  global /cameras pages          : $( [[ "${GCAM2_N:-}" =~ ^[0-9]+$ && "${GCAM2_N:-0}" -eq 2 ]] && echo "YES" || echo "NO/all" )
  cameraGroups inline counts     : ${has_counts:-?}
  Fixtures written to            : $FIX

  Decision gate for milestone.cameras.getall (brief Phase 1 task 2/3):
    * Q-A* GLOBAL YES -> paged global /hardware?includeChildren=cameras,settings
                         (matches the proven milestone_cameras_state.py path).
    * Q-A* GLOBAL NO  -> two-endpoint join: page /hardware (address/model/rsid)
                         + page /cameras (id/enabled/channel), join on
                         camera.relations.parent.id == hardware.id; \$.mac blank.
    * Either way: SOAK-TEST total fetch time against the SCRIPT item timeout at
      ~2489 hardware before cutover (paging lets us split across items if needed).
EOF

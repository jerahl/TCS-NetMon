#!/usr/bin/env bash
#
# setup_db.sh — create the NetMon MariaDB database + application user.
#
# Complements scripts/deploy.sh (which assumes the DB already exists). Run this
# once against your MariaDB server — locally or remotely — to create the
# `netmon` schema and a least-privilege application user scoped to it. Idempotent.
#
# SECURITY
#   * Grants are scoped to `netmon.*` only — no global privileges, no GRANT
#     OPTION. The one app user covers both runtime DML and migration DDL (the
#     app runs its own migrations); pass --dml-only for a runtime user with no
#     schema-change rights (then migrate separately as an admin).
#   * Passwords are NEVER put on the command line (they would leak via `ps` /
#     shell history). Admin auth uses a mode-0600 temp defaults-file, local
#     unix_socket auth, or an interactive prompt. The app password is generated
#     if you don't supply one.
#   * Nothing is written into the repo. With --write-config the generated URL
#     (password included) is written only into /etc/netmon/netmon.conf (0640).
#
# USAGE
#   sudo ./scripts/setup_db.sh                      # local DB, socket auth as root
#   DB_HOST=db.internal ADMIN_USER=admin \
#     ./scripts/setup_db.sh                         # remote DB, prompts for admin pw
#   DB_USER_HOST='10.10.%' ./scripts/setup_db.sh    # app connects from a subnet
#   ./scripts/setup_db.sh --write-config            # also set [db] url in the conf
#   ./scripts/setup_db.sh --dry-run                 # print the SQL, run nothing
#   ./scripts/setup_db.sh --help
#
# ENVIRONMENT (defaults shown)
#   DB_HOST=localhost  DB_PORT=3306  DB_NAME=netmon
#   DB_USER=netmon     DB_USER_HOST=localhost   # host(s) the app connects FROM
#   DB_PASSWORD=<generated>                      # app user password
#   ADMIN_USER=root    ADMIN_PASSWORD=<prompt>   # admin used to run the setup
#   CONF=/etc/netmon/netmon.conf
#
set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-netmon}"
DB_USER="${DB_USER:-netmon}"
DB_USER_HOST="${DB_USER_HOST:-localhost}"
DB_PASSWORD="${DB_PASSWORD:-}"
ADMIN_USER="${ADMIN_USER:-root}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
CONF="${CONF:-/etc/netmon/netmon.conf}"

DRY_RUN=0
WRITE_CONFIG=0
DML_ONLY=0

c_reset=$'\033[0m'; c_blue=$'\033[34m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_green=$'\033[32m'
log()  { printf '%s[db]%s %s\n' "$c_blue" "$c_reset" "$*"; }
ok()   { printf '%s[ ok ]%s %s\n' "$c_green" "$c_reset" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$c_yellow" "$c_reset" "$*" >&2; }
die()  { printf '%s[fail]%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }

usage() { sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# Full set = DML + the DDL migrations need (FKs → REFERENCES, generated col/
# InnoDB → CREATE/ALTER). --dml-only drops the schema-change privileges.
PRIVS_FULL="SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES"
PRIVS_DML="SELECT, INSERT, UPDATE, DELETE"

CLIENT=""
ADMIN_CNF=""
cleanup() { [[ -n "$ADMIN_CNF" && -f "$ADMIN_CNF" ]] && rm -f "$ADMIN_CNF"; }
trap cleanup EXIT

parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      --write-config) WRITE_CONFIG=1 ;;
      --dml-only) DML_ONLY=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $arg (see --help)" ;;
    esac
  done
}

pick_client() {
  CLIENT="$(command -v mariadb || command -v mysql || true)"
  [[ -n "$CLIENT" ]] || die "no mariadb/mysql client found — install the MariaDB client package (e.g. apt-get install mariadb-client)"
}

gen_password() {
  # Alphanumeric only — safe in a SQL string literal and in a URL without
  # percent-encoding.
  openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32
}

# Build the admin connection args (into ADMIN_ARGS[]) without exposing a
# password on the command line.
declare -a ADMIN_ARGS
build_admin_conn() {
  local is_local=0
  [[ "$DB_HOST" =~ ^(localhost|127\.0\.0\.1|::1)$ ]] && is_local=1

  if [[ -z "$ADMIN_PASSWORD" && $is_local -eq 1 ]]; then
    # Local unix_socket auth (Debian/Ubuntu root default). Needs to be root.
    [[ ${EUID:-$(id -u)} -eq 0 ]] || die "local admin uses unix_socket auth — run with sudo, or set ADMIN_PASSWORD for a TCP login"
    ADMIN_ARGS=(-u "$ADMIN_USER")
    log "admin auth: local unix_socket as $ADMIN_USER"
    return
  fi

  if [[ -z "$ADMIN_PASSWORD" ]]; then
    read -rsp "MariaDB admin password for ${ADMIN_USER}@${DB_HOST}: " ADMIN_PASSWORD; echo
    [[ -n "$ADMIN_PASSWORD" ]] || die "admin password required for a TCP login"
  fi
  ADMIN_CNF="$(mktemp)"; chmod 600 "$ADMIN_CNF"
  printf '[client]\nuser=%s\npassword=%s\n' "$ADMIN_USER" "$ADMIN_PASSWORD" > "$ADMIN_CNF"
  ADMIN_ARGS=(--defaults-extra-file="$ADMIN_CNF" -h "$DB_HOST" -P "$DB_PORT")
  log "admin auth: TCP ${ADMIN_USER}@${DB_HOST}:${DB_PORT}"
}

admin_sql() { printf '%s\n' "$1" | "$CLIENT" "${ADMIN_ARGS[@]}"; }

user_exists() {
  local out
  out="$(admin_sql "SELECT 1 FROM mysql.user WHERE User='${DB_USER}' AND Host='${DB_USER_HOST}';" 2>/dev/null | tail -n1 || true)"
  [[ "$out" == "1" ]]
}

main() {
  parse_args "$@"
  [[ $DRY_RUN -eq 1 ]] && log "DRY RUN — no changes will be made"
  [[ $DRY_RUN -eq 0 ]] && pick_client  # client only needed for a real run

  local privs="$PRIVS_FULL"
  [[ $DML_ONLY -eq 1 ]] && privs="$PRIVS_DML"

  # Decide the app password: keep an existing user's password unless one is
  # explicitly provided; generate for a new user.
  local set_password=1 generated=0
  if [[ $DRY_RUN -eq 0 ]]; then
    build_admin_conn
    if [[ -z "$DB_PASSWORD" ]]; then
      if user_exists; then
        set_password=0
        log "user '${DB_USER}'@'${DB_USER_HOST}' exists; keeping its current password"
      else
        DB_PASSWORD="$(gen_password)"; generated=1
      fi
    fi
  else
    # Dry run can't inspect the server; show the create-with-password path.
    [[ -n "$DB_PASSWORD" ]] || { DB_PASSWORD="********(generated)"; generated=1; }
  fi

  # Compose idempotent SQL.
  local sql
  sql="CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'${DB_USER_HOST}' IDENTIFIED BY '${DB_PASSWORD}';"
  if [[ $set_password -eq 1 ]]; then
    sql+="
ALTER USER '${DB_USER}'@'${DB_USER_HOST}' IDENTIFIED BY '${DB_PASSWORD}';"
  fi
  sql+="
GRANT ${privs} ON \`${DB_NAME}\`.* TO '${DB_USER}'@'${DB_USER_HOST}';
FLUSH PRIVILEGES;"

  if [[ $DRY_RUN -eq 1 ]]; then
    log "would run against ${DB_HOST}:${DB_PORT} as ${ADMIN_USER}:"
    # Mask the password in the printed SQL.
    printf '%s\n' "$sql" | sed "s/IDENTIFIED BY '[^']*'/IDENTIFIED BY '********'/g" | sed 's/^/    /'
    return 0
  fi

  log "creating database '${DB_NAME}' and user '${DB_USER}'@'${DB_USER_HOST}' (${DML_ONLY:+DML-only})"
  admin_sql "$sql" >/dev/null
  ok "database + user ready; privileges scoped to \`${DB_NAME}\`.*"

  # Verify the app user can actually connect and see the schema.
  verify_app_login

  # Build the SQLAlchemy URL (password percent-encoded for safety).
  local enc host_for_url url
  enc="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$DB_PASSWORD")"
  host_for_url="$DB_HOST"; [[ "$host_for_url" == "localhost" ]] && host_for_url="127.0.0.1"
  url="mysql+pymysql://${DB_USER}:${enc}@${host_for_url}:${DB_PORT}/${DB_NAME}?charset=utf8mb4"

  if [[ $WRITE_CONFIG -eq 1 ]]; then
    write_db_url "$url"
  fi

  print_summary "$url" "$generated" "$set_password"
}

verify_app_login() {
  local cnf; cnf="$(mktemp)"; chmod 600 "$cnf"
  printf '[client]\nuser=%s\npassword=%s\n' "$DB_USER" "$DB_PASSWORD" > "$cnf"
  local vargs=(--defaults-extra-file="$cnf")
  [[ "$DB_HOST" =~ ^(localhost)$ ]] || vargs+=(-h "$DB_HOST" -P "$DB_PORT")
  if printf 'SELECT 1;\n' | "$CLIENT" "${vargs[@]}" "$DB_NAME" >/dev/null 2>&1; then
    ok "verified: '${DB_USER}' can connect to '${DB_NAME}'"
  else
    warn "app user created but a test connection to '${DB_NAME}' failed — check DB_USER_HOST ('${DB_USER_HOST}') matches where the app connects from, and any DB firewall."
  fi
  rm -f "$cnf"
}

write_db_url() {
  local url="$1"
  [[ -f "$CONF" ]] || { warn "--write-config: $CONF not found (run scripts/deploy.sh install first); skipping"; return; }
  # Replace the single active 'url = ...' line (not the commented example).
  # '#' delimiter is safe: the URL contains no '#'.
  sed -i "s#^url = .*#url = ${url}#" "$CONF"
  chown root:netmon "$CONF" 2>/dev/null || true
  chmod 0640 "$CONF"
  ok "wrote [db] url into $CONF"
}

print_summary() {
  local url="$1" generated="$2" set_password="$3"
  echo
  ok "MariaDB setup complete."
  echo "  database : ${DB_NAME} (utf8mb4)"
  echo "  user     : ${DB_USER}@${DB_USER_HOST}"
  echo "  grants   : ${DML_ONLY:+DML only}${DML_ONLY:-full DML + migration DDL} on ${DB_NAME}.*"
  if [[ $WRITE_CONFIG -eq 1 ]]; then
    echo "  config   : [db] url set in ${CONF}"
  else
    # Show the URL with the password masked; print the password separately once.
    echo "  set this in ${CONF} under [db]:"
    echo "    url = $(printf '%s' "$url" | sed -E "s#://([^:]+):[^@]+@#://\1:********@#")"
    if [[ "$set_password" == "1" ]]; then
      warn "app user password (store securely — shown once):"
      printf '    %s\n' "$DB_PASSWORD"
    fi
  fi
  echo
  echo "  next: sudo ./scripts/deploy.sh update   # migrate + start against MariaDB"
}

main "$@"

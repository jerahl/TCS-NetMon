#!/usr/bin/env bash
#
# deploy.sh — install / update / secure the TCS NetMon service on a dedicated VM.
#
# Automates docs/runbooks/deploy.md and hardens the host. Idempotent: safe to
# re-run. Nothing here writes a secret into the repo — the real config lives at
# /etc/netmon/netmon.conf (root-owned, 0640) and is created from the example
# for the operator to fill in.
#
# USAGE
#   sudo ./scripts/deploy.sh install      # first-time full setup + hardening
#   sudo ./scripts/deploy.sh update       # pull code, reinstall deps, migrate, restart
#   sudo ./scripts/deploy.sh secure       # (re)apply host/service hardening only
#   sudo ./scripts/deploy.sh migrate      # apply DB migrations only
#   sudo ./scripts/deploy.sh status       # show service + health
#   ./scripts/deploy.sh --help
#
#   Add --dry-run to any action to print what would happen without doing it.
#
# CONFIGURABLE via environment (defaults in the CONFIG block below), e.g.:
#   SERVER_NAME=netmon.tcs.local NETMON_TLS_CERT=/etc/ssl/netmon.crt \
#   NETMON_TLS_KEY=/etc/ssl/netmon.key sudo -E ./scripts/deploy.sh install
#
# What it sets up:
#   * system packages (python, nginx, openssl, fping/snmp for the poller, firewall)
#   * a locked-down system service user (no login, no home writes)
#   * /opt/netmon (app + venv), /etc/netmon (config), /var/lib/netmon (state),
#     /var/log/netmon (logs) with least-privilege ownership/permissions
#   * Python venv + editable install of this repo
#   * /etc/netmon/netmon.conf from the example (0640 root:netmon) — never overwritten
#   * DB schema via `python -m netmon.migrate`
#   * a hardened systemd unit (sandboxed uvicorn bound to 127.0.0.1)
#   * nginx TLS reverse proxy (HSTS + security headers, HTTP->HTTPS redirect)
#   * host firewall (SSH + HTTPS only; the app port stays loopback-only)
#
set -euo pipefail

# ─────────────────────────── CONFIG (env-overridable) ───────────────────────
APP_USER="${APP_USER:-netmon}"
APP_GROUP="${APP_GROUP:-netmon}"
APP_HOME="${APP_HOME:-/opt/netmon}"
VENV="${VENV:-$APP_HOME/venv}"
CONF_DIR="${CONF_DIR:-/etc/netmon}"
CONF="${CONF:-$CONF_DIR/netmon.conf}"
STATE_DIR="${STATE_DIR:-/var/lib/netmon}"
LOG_DIR="${LOG_DIR:-/var/log/netmon}"
TLS_DIR="${TLS_DIR:-$CONF_DIR/tls}"

BIND_HOST="${BIND_HOST:-127.0.0.1}"     # app listens on loopback only; nginx fronts it
BIND_PORT="${BIND_PORT:-8080}"
# The Phase 1 session store is in-process, so a single worker only until it is
# promoted to a shared backend (docs/spec/01-foundation.md). Do not raise this
# without that change or logins will break across workers.
WORKERS="${WORKERS:-1}"

SERVER_NAME="${SERVER_NAME:-$(hostname -f 2>/dev/null || hostname)}"
NETMON_TLS_CERT="${NETMON_TLS_CERT:-}"   # provide real cert paths, or a self-signed pair is generated
NETMON_TLS_KEY="${NETMON_TLS_KEY:-}"

ENABLE_FIREWALL="${ENABLE_FIREWALL:-1}"
ENABLE_FAIL2BAN="${ENABLE_FAIL2BAN:-0}"
SSH_PORT="${SSH_PORT:-22}"               # allowed through the firewall so you don't lock yourself out

SERVICE_NAME="netmon"
# The source tree = the directory this script lives in, one level up.
APP_SRC="${APP_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

DRY_RUN=0

# ─────────────────────────────── helpers ────────────────────────────────────
c_reset=$'\033[0m'; c_blue=$'\033[34m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_green=$'\033[32m'
log()  { printf '%s[deploy]%s %s\n' "$c_blue" "$c_reset" "$*"; }
ok()   { printf '%s[ ok ]%s %s\n' "$c_green" "$c_reset" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$c_yellow" "$c_reset" "$*" >&2; }
die()  { printf '%s[fail]%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }

# run CMD... — execute (or echo when --dry-run). Use for every mutating action.
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  %s+%s %s\n' "$c_yellow" "$c_reset" "$*"
  else
    "$@"
  fi
}
# write_file PATH MODE OWNER < heredoc — dry-run aware file writer.
write_file() {
  local path="$1" mode="$2" owner="$3" content; content="$(cat)"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  %s+%s write %s (mode %s, owner %s, %d bytes)\n' \
      "$c_yellow" "$c_reset" "$path" "$mode" "$owner" "${#content}"
    return 0
  fi
  install -d -m 0755 "$(dirname "$path")"
  printf '%s' "$content" > "$path"
  chmod "$mode" "$path"
  chown "$owner" "$path"
}

require_root() { [[ ${EUID:-$(id -u)} -eq 0 ]] || die "must run as root (use sudo)"; }

# The hardened unit sets ProtectHome=yes, which makes /home inaccessible to the
# service — an editable install from a home-dir clone would then fail to import.
check_src_location() {
  case "$APP_SRC" in
    /home/*) warn "APP_SRC=$APP_SRC is under /home; the service sets ProtectHome=yes and will NOT be able to import it. Clone the repo to /opt/netmon/src (or set APP_SRC to a non-home path) before go-live." ;;
  esac
}

# ─────────────────────────── OS / package detection ─────────────────────────
PKG=""; FW=""
detect_os() {
  if command -v apt-get >/dev/null 2>&1; then PKG=apt
  elif command -v dnf >/dev/null 2>&1; then PKG=dnf
  elif command -v yum >/dev/null 2>&1; then PKG=yum
  else die "unsupported distro: need apt, dnf, or yum"; fi

  if command -v ufw >/dev/null 2>&1; then FW=ufw
  elif command -v firewall-cmd >/dev/null 2>&1; then FW=firewalld
  else FW=""; fi
  log "package manager: $PKG${FW:+, firewall: $FW}"
}

pkg_install() {
  case "$PKG" in
    apt)
      run env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
      ;;
    dnf) run dnf install -y "$@" ;;
    yum) run yum install -y "$@" ;;
  esac
}

install_packages() {
  log "installing system packages"
  local common=(nginx git openssl curl ca-certificates)
  # fping + snmpget are needed by the native poller (Phase 2). Package names differ.
  case "$PKG" in
    apt)
      pkg_install "${common[@]}" fping snmp python3 python3-venv python3-pip
      # Prefer 3.12 where available; system python3 (3.11+, e.g. Debian 12) is supported.
      run env DEBIAN_FRONTEND=noninteractive apt-get install -y python3.12 python3.12-venv 2>/dev/null || \
        log "python3.12 not in apt; using system python3 (3.11+ supported)"
      [[ "$ENABLE_FIREWALL" == 1 ]] && pkg_install ufw || true
      [[ "$ENABLE_FAIL2BAN" == 1 ]] && pkg_install fail2ban || true
      ;;
    dnf|yum)
      pkg_install "${common[@]}" fping net-snmp-utils python3 python3-pip
      run "$PKG" install -y python3.12 2>/dev/null || log "python3.12 not available; using system python3 (3.11+ supported)"
      [[ "$ENABLE_FIREWALL" == 1 ]] && pkg_install firewalld || true
      [[ "$ENABLE_FAIL2BAN" == 1 ]] && pkg_install fail2ban || true
      ;;
  esac
  ok "packages installed"
}

pick_python() {
  local p
  for p in python3.12 python3; do
    if command -v "$p" >/dev/null 2>&1; then echo "$p"; return; fi
  done
  die "no python3 found"
}

# ───────────────────────────── setup steps ──────────────────────────────────
create_user() {
  if id "$APP_USER" >/dev/null 2>&1; then
    ok "service user $APP_USER exists"
  else
    log "creating locked system user $APP_USER"
    run useradd --system --home-dir "$APP_HOME" --no-create-home \
        --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null || \
    run useradd --system --home-dir "$APP_HOME" --no-create-home \
        --shell /sbin/nologin "$APP_USER"
    ok "user $APP_USER created (no login shell)"
  fi
}

create_dirs() {
  log "creating directories"
  # App tree is root-owned and read-only to the service; only state + logs are writable.
  run install -d -m 0755 -o root -g root "$APP_HOME"
  run install -d -m 0750 -o root -g "$APP_GROUP" "$CONF_DIR"
  run install -d -m 0710 -o root -g "$APP_GROUP" "$TLS_DIR"
  run install -d -m 0750 -o "$APP_USER" -g "$APP_GROUP" "$STATE_DIR"
  run install -d -m 0750 -o "$APP_USER" -g "$APP_GROUP" "$LOG_DIR"
  ok "directories ready"
}

setup_venv() {
  local py; py="$(pick_python)"
  log "setting up venv ($py)"
  [[ -x "$VENV/bin/python" ]] || run "$py" -m venv "$VENV"
  run "$VENV/bin/pip" install --quiet --upgrade pip
  # Editable install so `git pull` updates code in place; re-resolves pinned deps.
  run "$VENV/bin/pip" install --quiet -e "$APP_SRC"
  run chown -R root:root "$VENV"
  ok "venv ready at $VENV"
}

setup_config() {
  if [[ -f "$CONF" ]]; then
    ok "config exists at $CONF (left untouched)"
  else
    log "creating $CONF from example (fill in real values before go-live)"
    if [[ $DRY_RUN -eq 1 ]]; then
      printf '  %s+%s cp %s %s\n' "$c_yellow" "$c_reset" "$APP_SRC/netmon.conf.example" "$CONF"
    else
      cp "$APP_SRC/netmon.conf.example" "$CONF"
      # This is a TLS deployment behind nginx → require Secure cookies (also
      # forbids the dev auth bypass, per config validation).
      sed -i 's/^secure_cookies = false/secure_cookies = true/' "$CONF"
    fi
    run chown root:"$APP_GROUP" "$CONF"
    run chmod 0640 "$CONF"
    warn "EDIT $CONF: set [db] url (MariaDB) and [auth] (interim AD/LDAP login; ClassLink SAML pending) before the service will authenticate anyone."
  fi
  # Always reassert perms in case a prior run or operator loosened them.
  run chown root:"$APP_GROUP" "$CONF"
  run chmod 0640 "$CONF"
}

as_app() { # run a command as the service user with the config env set
  run runuser -u "$APP_USER" -- env NETMON_CONF="$CONF" "$@" 2>/dev/null || \
  run sudo -u "$APP_USER" env NETMON_CONF="$CONF" "$@"
}

validate_config() {
  log "validating configuration"
  if [[ $DRY_RUN -eq 1 ]]; then printf '  %s+%s load_config() check\n' "$c_yellow" "$c_reset"; return 0; fi
  if runuser -u "$APP_USER" -- env NETMON_CONF="$CONF" "$VENV/bin/python" \
       -c "from netmon.config import load_config; load_config(); print('config OK')"; then
    ok "config valid"
    return 0
  fi
  warn "config is not yet valid (placeholders remain). Edit $CONF, then re-run: sudo $0 update"
  return 1
}

run_migrations() {
  log "applying database migrations"
  as_app "$VENV/bin/python" -m netmon.migrate
  ok "migrations applied"
}

# ───────────────────────────── systemd unit ─────────────────────────────────
install_systemd() {
  log "installing hardened systemd unit"
  write_file "/etc/systemd/system/${SERVICE_NAME}.service" 0644 root:root <<EOF
[Unit]
Description=TCS NetMon (FastAPI monitoring platform)
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=$APP_USER
Group=$APP_GROUP
Environment=NETMON_CONF=$CONF
WorkingDirectory=$STATE_DIR
ExecStart=$VENV/bin/uvicorn netmon.app:create_app --factory --host $BIND_HOST --port $BIND_PORT --workers $WORKERS
Restart=on-failure
RestartSec=3
# --- sandboxing / hardening ---
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=
# Only these paths are writable; the whole app tree stays read-only.
ReadWritePaths=$STATE_DIR $LOG_DIR
# NOTE (Phase 2): the native poller shells out to fping/snmpget. fping needs
# raw sockets — when the poller lands, either grant this service
# AmbientCapabilities=CAP_NET_RAW (and drop NoNewPrivileges if using setuid
# fping), or run the poller as its own less-restricted unit. Left off here
# because Phase 1 only serves the API.

[Install]
WantedBy=multi-user.target
EOF
  run systemctl daemon-reload
  ok "unit installed: ${SERVICE_NAME}.service"
}

# ─────────────────────────────── nginx / TLS ────────────────────────────────
ensure_tls() {
  if [[ -n "$NETMON_TLS_CERT" && -n "$NETMON_TLS_KEY" ]]; then
    [[ -f "$NETMON_TLS_CERT" && -f "$NETMON_TLS_KEY" ]] || die "TLS cert/key not found at provided paths"
    CERT="$NETMON_TLS_CERT"; KEY="$NETMON_TLS_KEY"
    ok "using provided TLS certificate"
    return
  fi
  CERT="$TLS_DIR/netmon.crt"; KEY="$TLS_DIR/netmon.key"
  if [[ -f "$CERT" && -f "$KEY" ]]; then
    ok "using existing self-signed certificate ($CERT)"
    return
  fi
  warn "no TLS cert provided — generating a self-signed placeholder for $SERVER_NAME."
  warn "Replace it with a CA-issued cert (set NETMON_TLS_CERT/NETMON_TLS_KEY and re-run 'secure')."
  run openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
      -keyout "$KEY" -out "$CERT" \
      -subj "/CN=$SERVER_NAME" -addext "subjectAltName=DNS:$SERVER_NAME"
  run chmod 0600 "$KEY"; run chmod 0644 "$CERT"; run chown root:root "$KEY" "$CERT"
}

install_nginx() {
  log "configuring nginx TLS reverse proxy"
  ensure_tls
  # conf.d/*.conf is included by the default nginx.conf on both Debian and RHEL.
  write_file "/etc/nginx/conf.d/${SERVICE_NAME}.conf" 0644 root:root <<EOF
# Managed by scripts/deploy.sh — edits will be overwritten on the next run.
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;
    # Redirect all plaintext to TLS.
    return 301 https://\$host\$request_uri;
}

server {
    # Combined "ssl http2" form works on nginx 1.9.5+ (incl. Debian 12's 1.22).
    # nginx 1.25.1+ prefers a separate "http2 on;" but still accepts this with
    # only a deprecation notice (nginx -t stays green), so it is the portable form.
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $SERVER_NAME;

    ssl_certificate     $CERT;
    ssl_certificate_key $KEY;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:NetMonTLS:5m;
    ssl_session_timeout 1h;

    server_tokens off;
    client_max_body_size 4m;

    # Security headers.
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    # A Content-Security-Policy is intentionally NOT set here: the Phase 4 React
    # UI and the Phase 9 map page will dictate their own source allowances
    # (e.g. map tile hosts). Add one when that UI lands. See docs/spec/09-site-map.md.

    location / {
        proxy_pass http://$BIND_HOST:$BIND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
EOF
  # Drop Debian's default site if present so it doesn't shadow us on :80.
  [[ -e /etc/nginx/sites-enabled/default ]] && run rm -f /etc/nginx/sites-enabled/default || true

  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  %s+%s nginx -t && systemctl reload nginx\n' "$c_yellow" "$c_reset"
  else
    nginx -t || die "nginx config test failed — not reloading"
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl reload nginx 2>/dev/null || systemctl restart nginx
  fi
  ok "nginx configured for https://$SERVER_NAME"
}

# ─────────────────────────────── firewall ───────────────────────────────────
setup_firewall() {
  if [[ "$ENABLE_FIREWALL" != 1 ]]; then warn "firewall setup skipped (ENABLE_FIREWALL=0)"; return; fi
  # Re-detect here: the firewall package may have been installed in this same
  # run (after the initial detect_os), so FW could be stale/empty.
  if command -v ufw >/dev/null 2>&1; then FW=ufw
  elif command -v firewall-cmd >/dev/null 2>&1; then FW=firewalld; fi
  if [[ -z "$FW" ]]; then warn "no supported firewall (ufw/firewalld) found; skipping"; return; fi
  log "configuring firewall ($FW): allow SSH(:$SSH_PORT) + HTTP/HTTPS, deny the rest"
  warn "the app port $BIND_PORT is loopback-only and is never exposed."
  case "$FW" in
    ufw)
      run ufw allow "$SSH_PORT/tcp"
      run ufw allow 80/tcp
      run ufw allow 443/tcp
      run ufw default deny incoming
      run ufw default allow outgoing
      run ufw --force enable
      ;;
    firewalld)
      run systemctl enable --now firewalld
      run firewall-cmd --permanent --add-port="$SSH_PORT/tcp"
      run firewall-cmd --permanent --add-service=http
      run firewall-cmd --permanent --add-service=https
      run firewall-cmd --reload
      ;;
  esac
  ok "firewall active"
}

setup_fail2ban() {
  [[ "$ENABLE_FAIL2BAN" == 1 ]] || return 0
  log "enabling fail2ban (sshd jail)"
  write_file "/etc/fail2ban/jail.d/netmon.conf" 0644 root:root <<'EOF'
[sshd]
enabled = true
EOF
  run systemctl enable --now fail2ban
  ok "fail2ban enabled"
}

# ───────────────────────── start / health / status ──────────────────────────
start_service() {
  log "enabling and starting ${SERVICE_NAME}.service"
  run systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  run systemctl restart "$SERVICE_NAME"
}

health_check() {
  [[ $DRY_RUN -eq 1 ]] && { printf '  %s+%s curl /healthz\n' "$c_yellow" "$c_reset"; return 0; }
  log "health check"
  for _ in $(seq 1 20); do
    if curl -fsS "http://$BIND_HOST:$BIND_PORT/healthz" >/dev/null 2>&1; then
      local body; body="$(curl -fsS "http://$BIND_HOST:$BIND_PORT/healthz")"
      ok "service healthy: $body"
      return 0
    fi
    sleep 0.5
  done
  warn "health check failed. Inspect: journalctl -u $SERVICE_NAME -n 50 --no-pager"
  return 1
}

cmd_status() {
  systemctl status "$SERVICE_NAME" --no-pager 2>/dev/null || true
  echo
  curl -fsS "http://$BIND_HOST:$BIND_PORT/healthz" 2>/dev/null && echo || warn "healthz not reachable"
}

# ──────────────────────────────── actions ───────────────────────────────────
cmd_install() {
  require_root; detect_os; check_src_location
  install_packages
  create_user
  create_dirs
  setup_venv
  setup_config
  install_systemd
  install_nginx
  setup_firewall
  setup_fail2ban
  if validate_config; then
    run_migrations
    start_service
    health_check || true
  else
    warn "Setup is in place but the service was NOT started (config incomplete)."
    warn "Fill in $CONF, then run: sudo $0 update"
  fi
  echo; ok "install complete. URL: https://$SERVER_NAME/  (docs: /docs)"
}

cmd_update() {
  require_root; detect_os; check_src_location
  local before after
  before="$(git -C "$APP_SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  if [[ $DRY_RUN -eq 0 && -d "$APP_SRC/.git" ]]; then
    log "updating source (was $before)"
    git -C "$APP_SRC" fetch --all --quiet || warn "git fetch failed; using working tree"
    git -C "$APP_SRC" pull --ff-only --quiet || warn "git pull --ff-only failed; using working tree"
  else
    log "updating from working tree at $APP_SRC"
  fi
  after="$(git -C "$APP_SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  setup_venv          # re-resolve pinned deps for the new code
  setup_config        # reassert perms; never clobber operator secrets
  install_systemd     # pick up any unit changes
  if validate_config; then
    run_migrations
    start_service
    if health_check; then
      ok "updated $before -> $after"
    else
      die "update applied but health check failed. Roll back with: git -C $APP_SRC checkout $before && sudo $0 update"
    fi
  else
    die "config invalid; not restarting. Fix $CONF and re-run."
  fi
}

cmd_secure() {
  require_root; detect_os
  create_user
  create_dirs
  setup_config        # reassert config perms
  install_systemd     # reassert hardened unit
  install_nginx       # reassert TLS + headers
  setup_firewall
  setup_fail2ban
  if [[ $DRY_RUN -eq 0 ]]; then systemctl restart "$SERVICE_NAME" 2>/dev/null || true; fi
  ok "hardening reapplied"
}

cmd_migrate() { require_root; detect_os; setup_config; validate_config && run_migrations; }

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ──────────────────────────────── main ──────────────────────────────────────
main() {
  local action=""
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; exit 0 ;;
      install|update|secure|migrate|status) action="$arg" ;;
      *) die "unknown argument: $arg (see --help)" ;;
    esac
  done
  [[ -n "$action" ]] || { usage; exit 1; }
  [[ $DRY_RUN -eq 1 ]] && log "DRY RUN — no changes will be made"
  case "$action" in
    install) cmd_install ;;
    update)  cmd_update ;;
    secure)  cmd_secure ;;
    migrate) cmd_migrate ;;
    status)  cmd_status ;;
  esac
}

main "$@"

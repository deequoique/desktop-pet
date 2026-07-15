#!/usr/bin/env bash
set -Eeuo pipefail

readonly MARKER='desktop-pet-coturn'
readonly STATE_DIR='/var/lib/desktop-pet-coturn'
MODE='' CONFIG=''

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "[$MARKER] $*"; }
usage() { echo "Usage: $0 (--preflight|--dry-run|--install|--verify|--rollback) --config PATH"; }

while (($#)); do
  case "$1" in
    --preflight|--dry-run|--install|--verify|--rollback) [[ -z "$MODE" ]] || die 'choose exactly one mode'; MODE="${1#--}" ;;
    --config) shift; (($#)) || die '--config requires a path'; CONFIG="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[[ -n "$MODE" && -n "$CONFIG" ]] || { usage; exit 2; }
[[ $EUID -eq 0 ]] || die 'run as root (sudo)'
[[ -f "$CONFIG" ]] || die "config not found: $CONFIG"
perm=$(stat -c '%a' "$CONFIG")
(( 10#$perm <= 600 )) || die 'config permissions must be 600 or stricter'

# shellcheck disable=SC1090
source "$CONFIG"
required=(PUBLIC_IP PRIVATE_IP TURN_REALM TURN_SHARED_SECRET APP_ENV_FILE LISTENER_PORT RELAY_MIN_PORT RELAY_MAX_PORT MAX_BPS BPS_CAPACITY USER_QUOTA TOTAL_QUOTA ENABLE_TLS TLS_PORT)
for key in "${required[@]}"; do [[ -n "${!key:-}" ]] || die "missing $key"; done
(( ${#TURN_SHARED_SECRET} >= 32 )) || die 'TURN_SHARED_SECRET must contain at least 32 characters'
[[ "$ENABLE_TLS" == true || "$ENABLE_TLS" == false ]] || die 'ENABLE_TLS must be true or false'
if [[ "$ENABLE_TLS" == true ]]; then
  [[ -f "${TLS_CERT_FILE:-}" && -f "${TLS_KEY_FILE:-}" ]] || die 'TLS certificate/key files are required'
fi

preflight() {
  [[ -r /etc/os-release ]] || die '/etc/os-release unavailable'
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || die 'Ubuntu 24.04 is required'
  [[ "$(uname -m)" == x86_64 || "$(uname -m)" == aarch64 ]] || die 'unsupported architecture'
  command -v systemctl >/dev/null || die 'systemd is required'
  [[ -f "$APP_ENV_FILE" ]] || die "application env file not found: $APP_ENV_FILE"
  if command -v ss >/dev/null && ss -H -lntu | awk '{print $5}' | grep -Eq "(^|:)$LISTENER_PORT$"; then
    systemctl is-active --quiet coturn 2>/dev/null || die "port $LISTENER_PORT is occupied by another service"
  fi
  info "preflight ok: public=$PUBLIC_IP private=$PRIVATE_IP realm=$TURN_REALM relay=$RELAY_MIN_PORT-$RELAY_MAX_PORT"
  info 'cloud firewall is not modified; verify its rules separately'
}

render_turn_config() {
  local target=$1
  {
    echo "# Managed by $MARKER"
    echo "listening-port=$LISTENER_PORT"
    echo "min-port=$RELAY_MIN_PORT"
    echo "max-port=$RELAY_MAX_PORT"
    echo "listening-ip=$PRIVATE_IP"
    echo "relay-ip=$PRIVATE_IP"
    [[ "$PUBLIC_IP" == "$PRIVATE_IP" ]] || echo "external-ip=$PUBLIC_IP/$PRIVATE_IP"
    echo "realm=$TURN_REALM"
    echo 'fingerprint'
    echo 'use-auth-secret'
    echo "static-auth-secret=$TURN_SHARED_SECRET"
    echo 'no-cli'
    echo 'no-multicast-peers'
    echo 'stale-nonce'
    echo "max-bps=$MAX_BPS"
    echo "bps-capacity=$BPS_CAPACITY"
    echo "user-quota=$USER_QUOTA"
    echo "total-quota=$TOTAL_QUOTA"
    if [[ "$ENABLE_TLS" == true ]]; then
      echo "tls-listening-port=$TLS_PORT"
      echo "cert=$TLS_CERT_FILE"
      echo "pkey=$TLS_KEY_FILE"
    else
      echo 'no-tls'
      echo 'no-dtls'
    fi
  } >"$target"
  chmod 600 "$target"
}

update_app_env() {
  local tmp=$1
  grep -Ev '^RTC_(STUN_URLS|TURN_URLS|TURN_SHARED_SECRET|TURN_REALM|TURN_CREDENTIAL_TTL_SEC|ICE_TRANSPORT_POLICY)=' "$APP_ENV_FILE" >"$tmp" || true
  {
    echo "RTC_STUN_URLS=stun:$TURN_REALM:$LISTENER_PORT"
    echo "RTC_TURN_URLS=turn:$TURN_REALM:$LISTENER_PORT?transport=udp,turn:$TURN_REALM:$LISTENER_PORT?transport=tcp"
    echo "RTC_TURN_SHARED_SECRET=$TURN_SHARED_SECRET"
    echo "RTC_TURN_REALM=$TURN_REALM"
    echo 'RTC_TURN_CREDENTIAL_TTL_SEC=43200'
    echo 'RTC_ICE_TRANSPORT_POLICY=all'
  } >>"$tmp"
  chmod --reference="$APP_ENV_FILE" "$tmp"
}

verify() {
  systemctl is-active --quiet coturn || die 'coturn is not active'
  ss -H -lnut | awk '{print $5}' | grep -Eq "(^|:)$LISTENER_PORT$" || die "coturn is not listening on $LISTENER_PORT"
  [[ "$(stat -c '%a' /etc/turnserver.conf)" == 600 ]] || die '/etc/turnserver.conf must be mode 600'
  grep -Fqx "realm=$TURN_REALM" /etc/turnserver.conf || die 'realm mismatch'
  grep -Fqx "RTC_TURN_SHARED_SECRET=$TURN_SHARED_SECRET" "$APP_ENV_FILE" || die 'application secret mismatch'
  if command -v turnutils_stunclient >/dev/null; then turnutils_stunclient -p "$LISTENER_PORT" 127.0.0.1 >/dev/null || die 'local STUN check failed'; fi
  info 'verify ok; external TURN allocation and cloud firewall still require remote verification'
}

rollback() {
  [[ -d "$STATE_DIR/backup" ]] || die 'no backup available'
  [[ -f "$STATE_DIR/backup/turnserver.conf" ]] && install -m 600 "$STATE_DIR/backup/turnserver.conf" /etc/turnserver.conf
  [[ -f "$STATE_DIR/backup/app.env" ]] && install -m "$(stat -c '%a' "$STATE_DIR/backup/app.env")" "$STATE_DIR/backup/app.env" "$APP_ENV_FILE"
  if command -v ufw >/dev/null; then
    ufw --force delete allow "$LISTENER_PORT/udp" comment "$MARKER" >/dev/null 2>&1 || true
    ufw --force delete allow "$LISTENER_PORT/tcp" comment "$MARKER" >/dev/null 2>&1 || true
    ufw --force delete allow "$RELAY_MIN_PORT:$RELAY_MAX_PORT/udp" comment "$MARKER" >/dev/null 2>&1 || true
  fi
  systemctl restart coturn 2>/dev/null || true
  info 'rollback complete'
}

case "$MODE" in
  preflight) preflight ;;
  dry-run)
    preflight
    tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
    render_turn_config "$tmp"
    sed -E 's/^(static-auth-secret=).*/\1<redacted>/' "$tmp"
    info 'dry-run only; no system changes made'
    ;;
  verify) preflight; verify ;;
  rollback) rollback ;;
  install)
    preflight
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y coturn ufw
    install -d -m 700 "$STATE_DIR/backup"
    [[ -f /etc/turnserver.conf && ! -f "$STATE_DIR/backup/turnserver.conf" ]] && cp -a /etc/turnserver.conf "$STATE_DIR/backup/turnserver.conf"
    [[ -f "$STATE_DIR/backup/app.env" ]] || cp -a "$APP_ENV_FILE" "$STATE_DIR/backup/app.env"
    turn_tmp=$(mktemp); env_tmp=$(mktemp); trap 'rm -f "$turn_tmp" "$env_tmp"' EXIT
    render_turn_config "$turn_tmp"; update_app_env "$env_tmp"
    install -m 600 "$turn_tmp" /etc/turnserver.conf
    install -m "$(stat -c '%a' "$APP_ENV_FILE")" "$env_tmp" "$APP_ENV_FILE"
    sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
    if ufw status | grep -q '^Status: active'; then
      ufw allow "$LISTENER_PORT/udp" comment "$MARKER"
      ufw allow "$LISTENER_PORT/tcp" comment "$MARKER"
      ufw allow "$RELAY_MIN_PORT:$RELAY_MAX_PORT/udp" comment "$MARKER"
      [[ "$ENABLE_TLS" == true ]] && ufw allow "$TLS_PORT/tcp" comment "$MARKER"
    fi
    systemctl enable --now coturn
    systemctl restart coturn
    verify
    date -u +%FT%TZ >"$STATE_DIR/installed-at"
    info 'install complete; restart the desktop-pet application server to load RTC env'
    ;;
esac

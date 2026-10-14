#!/bin/bash
#
# Trusted-stage entrypoint. In ordinary Docker, run.sh calls this before the
# runtime stage. Split-bootstrap platforms can call this script before applying
# sandbox/landlock/sudo/env restrictions.

set -euo pipefail

. /opt/gem/gem_env.sh
gem_env_prepare_defaults

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S,%3N') INFO gem_init: $*"
}

pid_is_running() {
  local pid="$1"
  [ -n "${pid}" ] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  if [ -r "/proc/${pid}/stat" ]; then
    local state
    state="$(awk '{print $3}' "/proc/${pid}/stat" 2>/dev/null || true)"
    [ "${state}" != "Z" ] || return 1
  fi
  return 0
}

pid_cmdline() {
  local pid="$1"
  if [ -r "/proc/${pid}/cmdline" ]; then
    tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true
    return 0
  fi
  ps -p "${pid}" -o command= 2>/dev/null || true
}

pid_matches_browser_supervisor() {
  local pid="$1"
  local cmdline
  [ -n "${pid}" ] || return 1
  cmdline="$(pid_cmdline "${pid}")"
  case "${cmdline}" in
    *"${HELPER_SCRIPT}"*|*"browser-supervisor.py"*)
      return 0
      ;;
  esac
  return 1
}

clear_stale_browser_supervisor_config() {
  rm -f "${HELPER_CONFIG_FILE}" "${HELPER_CONFIG_FILE}.tmp"
}

RUN_DIR="/var/run/gem"
LOG_ROOT="${LOG_DIR:-/var/log/gem}"
HELPER_PID_FILE="${RUN_DIR}/browser-supervisor.pid"
HELPER_CONFIG_FILE="${RUN_DIR}/browser-supervisor.json"
HELPER_LOG_FILE="${LOG_ROOT}/browser-supervisor.log"
HELPER_SCRIPT="/opt/gem/browser-supervisor.py"

if [ "${DISABLE_BROWSER:-false}" = "true" ]; then
  log "browser is disabled, skip browser supervisor"
  exit 0
fi

if [ ! -x "${HELPER_SCRIPT}" ]; then
  log "ERROR: browser supervisor not executable: ${HELPER_SCRIPT}"
  exit 1
fi

mkdir -p "${RUN_DIR}" "${LOG_ROOT}"
chmod 750 "${RUN_DIR}"

if [ -s "${HELPER_PID_FILE}" ]; then
  helper_pid="$(tr -d '[:space:]' <"${HELPER_PID_FILE}" 2>/dev/null || true)"
  if pid_is_running "${helper_pid}" && pid_matches_browser_supervisor "${helper_pid}"; then
    log "browser supervisor already running pid=${helper_pid}"
    exit 0
  fi
  if pid_is_running "${helper_pid}"; then
    log "ignoring stale browser supervisor pid file: pid=${helper_pid} is not browser-supervisor.py"
  fi
fi

clear_stale_browser_supervisor_config
log "starting trusted browser supervisor"
python3 "${HELPER_SCRIPT}" >>"${HELPER_LOG_FILE}" 2>&1 &
helper_pid=$!
echo "${helper_pid}" > "${HELPER_PID_FILE}"
chmod 644 "${HELPER_PID_FILE}"
log "browser supervisor started pid=${helper_pid}"

#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.codex.remote"
TARGET="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DEPLOY_DIR="${HOME}/.codex-remote/app"

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/.codex-remote" "${DEPLOY_DIR}"

for name in bin src public; do
  rm -rf "${DEPLOY_DIR:?}/${name}"
  cp -R "${PROJECT_DIR}/${name}" "${DEPLOY_DIR}/${name}"
done
chmod +x "${DEPLOY_DIR}/bin/codex-remote"

sed -e "s|__HOME__|${HOME}|g" \
  "${PROJECT_DIR}/launchd/${LABEL}.plist" > "${TARGET}"

UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
sleep 2

if ! launchctl bootstrap "gui/${UID_NUM}" "${TARGET}" 2>/dev/null; then
  sleep 2
  launchctl bootstrap "gui/${UID_NUM}" "${TARGET}"
fi
launchctl enable "gui/${UID_NUM}/${LABEL}"
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
echo "installed ${LABEL}"

echo "  deployed : ${DEPLOY_DIR}"
echo "  plist    : ${TARGET}"
echo "  logs     : ${HOME}/.codex-remote/bridge.log"
echo "  restart  : launchctl kickstart -k gui/$(id -u)/${LABEL}"
echo "  stop     : launchctl bootout gui/$(id -u)/${LABEL}"
echo ""
echo "编辑代码后重新运行本脚本即可重新部署。"

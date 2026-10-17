#!/usr/bin/env bash
set -euo pipefail

LABEL="com.codex.remote"
TARGET="${HOME}/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
if [[ -f "${TARGET}" ]]; then
  mv "${TARGET}" "${TARGET}.removed"
  echo "removed ${TARGET} (kept as ${TARGET}.removed)"
else
  echo "no plist at ${TARGET}"
fi

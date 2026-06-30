#!/bin/bash
# Double-click to start the Projects Hub launcher and open it in your browser.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found in PATH."
  echo "Install it from https://nodejs.org and try again."
  read -r -p "Press return to close…"
  exit 1
fi

echo "Starting Projects Hub…  (close this window to stop)"
exec node launcher.mjs --open

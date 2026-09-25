#!/usr/bin/env bash
#
# Smoke test for the Hello World app.
#
# Starts the app, waits for the port, checks `GET /` returns
# HTTP 200 with body "Hello World", then stops the app.
# No process is left behind (trap kills the server on any exit path).
#
set -uo pipefail

PORT="${PORT:-3000}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node "$APP_DIR/server.js" &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 50); do
  if curl --fail --silent --output /dev/null "http://127.0.0.1:${PORT}/"; then
    ready=1
    break
  fi
  sleep 0.2
done

if (( ready == 0 )); then
  echo "FAIL: app did not answer on http://127.0.0.1:${PORT}/" >&2
  exit 1
fi

body_file="$(mktemp)"
http_code="$(curl --silent --output "$body_file" --write-out '%{http_code}' "http://127.0.0.1:${PORT}/")"
body="$(cat "$body_file")"
rm -f "$body_file"

if [[ "$http_code" != "200" ]]; then
  echo "FAIL: expected HTTP 200, got HTTP $http_code" >&2
  exit 1
fi

if [[ "$body" != "Hello World" ]]; then
  echo "FAIL: expected body 'Hello World', got '$body'" >&2
  exit 1
fi

echo "PASS: HTTP 200 with body 'Hello World' on http://127.0.0.1:${PORT}/"

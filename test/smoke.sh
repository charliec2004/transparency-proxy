#!/usr/bin/env bash
# Smoke test: spins up the mock upstream and the proxy, then curls the proxy
# the way Codex would (streaming and non-streaming) and checks /inspect.
# No API key required. Exits non-zero on any failure.
set -euo pipefail

cd "$(dirname "$0")/.."

PROXY_PORT="${PROXY_PORT:-8080}"
MOCK_PORT="${MOCK_PORT:-9090}"

cleanup() {
  [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null || true
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT

MOCK_PORT="$MOCK_PORT" node test/mock-upstream.js &
MOCK_PID=$!
PORT="$PROXY_PORT" UPSTREAM_URL="http://127.0.0.1:$MOCK_PORT/v1/responses" node server.js &
PROXY_PID=$!

for i in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$PROXY_PORT/inspect" >/dev/null 2>&1 && break
  sleep 0.2
done

BODY='{"model":"gpt-5.4","instructions":"You are Codex, a coding agent. (mock instruction block)","input":[{"role":"user","content":[{"type":"input_text","text":"say hi"}]}],"tools":[{"type":"function","name":"shell","description":"Run a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"}}}}],"stream":true}'

echo "--- streaming round trip ---"
STREAM_OUT="$(curl -sf -N http://127.0.0.1:$PROXY_PORT/v1/responses \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer test-token' \
  -d "$BODY")"
grep -q 'response.created' <<<"$STREAM_OUT"
grep -q 'response.output_text.delta' <<<"$STREAM_OUT"
grep -q 'response.completed' <<<"$STREAM_OUT"
echo "OK: SSE events relayed"

echo "--- non-streaming round trip ---"
NOSTREAM_OUT="$(curl -sf http://127.0.0.1:$PROXY_PORT/v1/responses \
  -H 'content-type: application/json' \
  -d "${BODY/\"stream\":true/\"stream\":false}")"
grep -q '"object": *"response"' <<<"$NOSTREAM_OUT" || grep -q '"object":"response"' <<<"$NOSTREAM_OUT"
echo "OK: JSON body relayed"

echo "--- capture / inspect ---"
sleep 0.5
INSPECT="$(curl -sf "http://127.0.0.1:$PROXY_PORT/inspect")"
grep -q 'mock instruction block' <<<"$INSPECT"
grep -q '"shell"' <<<"$INSPECT"
grep -q '"input_tokens": *4321' <<<"$INSPECT" || grep -q '"input_tokens":4321' <<<"$INSPECT"
grep -q '"cost"' <<<"$INSPECT"
if grep -q 'test-token' <<<"$INSPECT"; then
  echo "FAIL: client bearer token leaked into /inspect" >&2
  exit 1
fi
echo "OK: instructions, tools, usage captured; no token leak"

echo
echo "ALL SMOKE TESTS PASSED"

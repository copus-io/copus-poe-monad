#!/usr/bin/env bash
set -euo pipefail
poe_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
frontend="${COPUS_DEMO_FRONTEND:-/Users/handuo/Desktop/copus}"
if [[ ! -f "$frontend/src/features/time/poe-product-demo.ts" ]]; then
  echo 'Set COPUS_DEMO_FRONTEND to the current Copus frontend checkout containing the product demo integration.' >&2
  exit 1
fi
# This script runs existing source; it never checks out or edits the frontend.
if [[ "$frontend" == /Users/handuo/Desktop/copus || "$frontend" == /Users/handuo/copus ]]; then
  [[ "$(git -C "$frontend" rev-parse --show-toplevel | xargs realpath)" == /Users/handuo/Desktop/copus ]] || exit 1
fi
api_pid=''
ui_pid=''
cleanup() {
  [[ -z "$ui_pid" ]] || kill "$ui_pid" 2>/dev/null || true
  [[ -z "$api_pid" ]] || kill "$api_pid" 2>/dev/null || true
  [[ -z "$ui_pid" ]] || wait "$ui_pid" 2>/dev/null || true
  [[ -z "$api_pid" ]] || wait "$api_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$poe_root"
# Local EVM demos are ephemeral. Public testnet data requires an explicit
# POE_DEMO_DATA directory so pending claims/campaigns survive operator restarts.
if [[ "${POE_DEMO_NETWORK:-local}" == testnet && -z "${POE_DEMO_DATA:-}" ]]; then
  echo 'Set POE_DEMO_DATA to a private persistent directory for testnet demos.' >&2; exit 1
fi
node services/product-demo.js &
api_pid=$!
ready=0
for _ in {1..90}; do
  if curl --noproxy '*' --silent --fail --output /dev/null http://127.0.0.1:8792/client/user/time/poe/demo; then ready=1; break; fi
  if ! kill -0 "$api_pid" 2>/dev/null; then wait "$api_pid"; exit 1; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'Demo API failed to become ready' >&2; exit 1; }
cd "$frontend"
VITE_API_BASEURL='' VITE_POE_PRODUCT_DEMO=1 VITE_TIME_PROXY_TARGET=http://127.0.0.1:8792 pnpm dev --host 127.0.0.1 --port 3000 --strictPort &
ui_pid=$!
echo 'Real Copus UI: http://localhost:3000/time-sponsors?sponsorshipDemo=1'
echo 'Proofs and chain transactions are real. Experience data and the TIME ledger are isolated demo fixtures.'
wait "$ui_pid"

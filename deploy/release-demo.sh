#!/usr/bin/env bash
# Official release path for this isolated hackathon demo. Never deploy Copus production here.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo"
chain="monad"
release="${1:?Pass the exact pushed main commit}"
[[ "$release" =~ ^[a-f0-9]{40}$ ]] || exit 1
[[ -z "$(git status --porcelain)" ]] || { echo 'Working tree must be clean'; exit 1; }
git fetch origin main
[[ "$(git rev-parse HEAD)" == "$release" ]] || { echo 'Checkout does not match release'; exit 1; }
[[ "$(git rev-parse origin/main)" == "$release" ]] || { echo 'Release must match pushed main'; exit 1; }
export POE_RELEASE_COMMIT="$release"
export POE_DEMO_HOME="${POE_DEMO_HOME:-$HOME/hackathon-demos/$chain/runtime}"
[[ -f "$POE_DEMO_HOME/runtime.env" && -f "$POE_DEMO_HOME/secrets/operator.json" ]] || { echo 'Configure private testnet runtime first'; exit 1; }
[[ "$(stat -c '%a' "$POE_DEMO_HOME/secrets/operator.json")" == 600 ]] || { echo 'Operator key must be mode 0600'; exit 1; }
previous="$HOME/hackathon-demos/$chain/DEPLOYED_COMMIT"
if [[ -s "$previous" ]]; then git merge-base --is-ancestor "$(cat "$previous")" "$release" || { echo 'Release must retain the previous deployed commit'; exit 1; }; fi
# Each chain has its own network, volume and image. No production DB or API credentials are mounted.
docker compose -p "copus-poe-$chain-public" -f deploy/compose.demo.yml build
if [[ -s "$previous" ]]; then cp "$previous" "$previous.rollback"; fi
docker compose -p "copus-poe-$chain-public" -f deploy/compose.demo.yml up -d --wait --wait-timeout 180
# Attach only Caddy to this demo network; the demo has no production network membership.
docker network connect "copus-poe-$chain-demo" copus-caddy-1 2>/dev/null || docker inspect copus-caddy-1 --format '{{json .NetworkSettings.Networks}}' | python3 -c 'import sys,json; assert "copus-poe-monad-demo" in json.load(sys.stdin)'
# Serialize route changes and retain every existing site block.
(
flock -x 9
route_backup=$(python3 - "$repo/deploy/Caddyfile.demo" "$HOME/copus-stack/caddy/Caddyfile" <<'PYROUTE'
from pathlib import Path
import sys,datetime
new,live=map(Path,sys.argv[1:]);block=new.read_text();old=live.read_text()
if block in old:sys.exit(0)
start=block.splitlines()[0]
if start in old:raise SystemExit('Existing demo route differs; reconcile before deployment')
backup=live.with_name('Caddyfile.bak-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.write_text(old);live.write_text(old.rstrip()+'\n\n'+block);print(backup)
PYROUTE
)
if ! docker exec copus-caddy-1 caddy validate --config /etc/caddy/Caddyfile || ! docker exec copus-caddy-1 caddy reload --config /etc/caddy/Caddyfile; then
  if [[ -n "$route_backup" ]]; then cat "$route_backup" > "$HOME/copus-stack/caddy/Caddyfile"; docker exec copus-caddy-1 caddy reload --config /etc/caddy/Caddyfile; fi
  echo 'Caddy route update failed; original configuration restored'; exit 1
fi
) 9>"$HOME/hackathon-demos/caddy-release.lock"
printf '%s\n' "$release" > "$previous"
echo "Released $chain demo at https://$chain.copus.io/time-sponsors ($release)"

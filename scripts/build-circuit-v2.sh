#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="$repo_root/zk-v2-build"
mkdir -p "$build_dir"

"$repo_root/node_modules/.bin/circom2" "$repo_root/circuits/poe-v2.circom" \
  --r1cs --wasm --sym \
  -l "$repo_root/node_modules" \
  -o "$build_dir"

"$repo_root/node_modules/.bin/snarkjs" r1cs info "$build_dir/poe-v2.r1cs"

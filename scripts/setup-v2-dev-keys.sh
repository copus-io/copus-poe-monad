#!/usr/bin/env bash
set -euo pipefail

# Separate testnet-only ceremony. Entropy is generated locally and never committed.
# A production setup requires independently audited, retained multi-party contributions.
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="$repo_root/zk-v2-build"
artifacts_dir="$repo_root/zk-v2-artifacts"
mkdir -p "$artifacts_dir" "$repo_root/contracts/generated"

bash "$repo_root/scripts/build-circuit-v2.sh"
"$repo_root/node_modules/.bin/snarkjs" powersoftau new bn128 16 "$build_dir/pot16_0000.ptau"
phase1_entropy="$(openssl rand -hex 64)"
"$repo_root/node_modules/.bin/snarkjs" powersoftau contribute "$build_dir/pot16_0000.ptau" "$build_dir/pot16_0001.ptau" \
  --name="Copus Monad PoE testnet contribution" -e="$phase1_entropy"
unset phase1_entropy
"$repo_root/node_modules/.bin/snarkjs" powersoftau prepare phase2 "$build_dir/pot16_0001.ptau" "$build_dir/pot16_final.ptau"
"$repo_root/node_modules/.bin/snarkjs" groth16 setup "$build_dir/poe-v2.r1cs" "$build_dir/pot16_final.ptau" "$build_dir/poe-v2_0000.zkey"
phase2_entropy="$(openssl rand -hex 64)"
"$repo_root/node_modules/.bin/snarkjs" zkey contribute "$build_dir/poe-v2_0000.zkey" "$artifacts_dir/poe-v2_final.zkey" \
  --name="Copus Monad PoE testnet contribution" -e="$phase2_entropy"
unset phase2_entropy
"$repo_root/node_modules/.bin/snarkjs" zkey export verificationkey "$artifacts_dir/poe-v2_final.zkey" "$artifacts_dir/verification_key.json"
"$repo_root/node_modules/.bin/snarkjs" zkey export solidityverifier "$artifacts_dir/poe-v2_final.zkey" "$repo_root/contracts/generated/PoEV2Groth16Verifier.sol"
node -e 'const fs=require("fs"); const p=process.argv[1]; const source=fs.readFileSync(p,"utf8"); if (!source.includes("contract Groth16Verifier")) throw Error("generated verifier name changed"); fs.writeFileSync(p,source.replace("contract Groth16Verifier","contract PoEV2Groth16Verifier").split("\n").map(line=>line.trimEnd()).join("\n"));' "$repo_root/contracts/generated/PoEV2Groth16Verifier.sol"
cp "$build_dir/poe-v2_js/poe-v2.wasm" "$artifacts_dir/poe-v2.wasm"
(cd "$artifacts_dir" && shasum -a 256 poe-v2.wasm poe-v2_final.zkey verification_key.json > SHA256SUMS)

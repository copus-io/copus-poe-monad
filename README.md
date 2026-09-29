# Copus PoE on Monad Testnet

This is the Monad Testnet implementation of Copus Proof of Experience (PoE). A sponsor funds a TIME campaign with a test ERC-20 payment, the Copus issuer commits a Merkle root of private experience receipts, and a reader submits a Groth16 proof. The contract checks the exact campaign policy, epoch, evidence age, claim cap, and nullifier before emitting `SponsorshipApproved`. TIME is an off-chain Copus ledger credit, not a tradable token.

**Status:** the v2 contract, 12-slot eligibility circuit, issuer, prover, relayer and settlement indexer are implemented and tested locally. Monad Testnet deployment and Copus backend chain registration are still required. No live campaign or payment token is implied by this repository.

## What is verified

The circuit enforces mandatory reading count, cumulative dwell time and observation window plus up to 12 rules combined with `ALL` or `ANY`. The rule types are active days, published works, comments, created spaces, TIME spent, followers, space membership, work keyword viewed, followed author and sponsor link opened. Public and hidden rules follow the same proof path. A v2 campaign binds one immutable `ruleHash`, and ongoing batches expire after 24 hours.

The issuer supplies account-bound facts. PoE proves that committed facts meet the policy without revealing the facts. It does not independently prove that Copus's private database reported the facts truthfully.

## Local verification

Requires Node.js 22 and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm compile
pnpm test
pnpm test:zk
```

`test/poe-v2.js` creates a real proof, funds a campaign with a mock token, commits evidence, claims once and rejects false conditions. Indexer tests cover lagging RPC nodes, reorgs, dead letters and idempotent settlement.

The `zk-v2-artifacts` and generated Solidity verifier in this repository belong to **this Monad testnet ceremony**. They are independent of the Base Sepolia deployment. `pnpm circuit:setup:dev` creates a new local test setup with fresh random contributions; after doing so, redeploy the generated verifier and use the matching `.zkey`. The included setup is for a testnet demo, not a production trusted setup.

## Monad Testnet deployment

Monad Testnet uses chain ID `10143` and the public RPC `https://testnet-rpc.monad.xyz`. Keep keys in an untracked `.env` or a secret manager; see `.env.example`. Obtain test MON for the deployer and operator wallets. The payment contract accepts one configured ERC-20. For a self-contained demo you can deploy the freely mintable `MockUSDC` using `pnpm deploy:monad:test-token`; it is **not real USDC**.

1. Set `DEPLOYER_PRIVATE_KEY`, `MONAD_TESTNET_RPC_URL`, `ISSUER_ADDRESS`, `TREASURY_ADDRESS` and `FUNDING_TOKEN_ADDRESS`.
2. Run `pnpm deploy:monad:testnet`. The script checks chain ID, code, transaction receipts and contract wiring, and writes an untracked manifest under `deployments/`.
3. Prepare the policy with `pnpm campaign:prepare:v2 -- draft.json prepared.json`; fund a campaign only after reviewing the immutable manifest and funding amount.
4. Point the issuer, prover, relayer and indexer at the deployed contracts. Set `POE_VERSION=2`, `RPC_URL` and separate bearer tokens. Supply private backend evidence paths through `EVIDENCE_EXPORT_PATH` and `EVIDENCE_WRITEBACK_PATH`. The local `settlement-stub` can acknowledge indexer posts on port 8791 for development. Real TIME credit requires Copus backend registration of Monad chain 10143, wallet/subject binding, and the backend settlement endpoint.

No operator keys, Copus receipts, backend credentials, private deployment manifests or Base Sepolia production configuration are stored here. Keep `batch*.json`, receipt exports, encrypted archives and `.env` files out of Git.

## Security boundaries

The funding token is transferred directly from advertiser to the configured treasury. The contract never holds the token. A test mock is freely mintable and must not be presented as a stablecoin. The proof binds `evidenceRoot`, `ruleHash`, `nullifier`, `campaignId` and `epoch`. The indexer must settle only confirmed canonical events; the backend must enforce idempotency before crediting TIME.

See [Monad documentation](https://docs.monad.xyz/) for network details.

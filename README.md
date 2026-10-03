# Copus PoE on Monad Testnet

## Run the complete demo locally

The repository includes the real English Copus UI. Start with Node.js 22+ and pnpm 10.15+:

```sh
pnpm install --frozen-lockfile
pnpm demo:product
```

First-time reviewers create their own testnet wallet/deployment and supply faucet gas. No private Copus checkout, production backend or shared issuer secret is required. **Follow the complete setup and expected click-by-click flow in [PRODUCT_DEMO.md](PRODUCT_DEMO.md).**


This is the Monad Testnet implementation of Copus Proof of Experience (PoE). A sponsor funds a TIME campaign with a test ERC-20 payment, the Copus issuer commits a Merkle root of private experience receipts, and a reader submits a Groth16 proof. The contract checks the exact campaign policy, epoch, evidence age, claim cap, and nullifier before emitting `SponsorshipApproved`. TIME is an off-chain Copus ledger credit, not a tradable token.

**Status:** the v2 contracts are deployed on Monad Testnet and a self-contained proof and claim demo has succeeded. The issuer, prover, relayer and settlement indexer are implemented and tested locally. Copus backend chain registration is still required for real TIME ledger credit. The deployed payment token is a freely mintable test fixture, not USDC.

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

The public testnet deployment uses chain ID `10143`:

| Component | Address |
| --- | --- |
| Evidence registry | `0x8AbF600a37a9E0dBaDF1c95202389637bE017076` |
| Groth16 verifier | `0xD9Cd08BA1aDF0B1132f9444c573eB28C64D51fc6` |
| Verifier adapter | `0xedc31075543bCfbbDE77103a6535faAa5f71483A` |
| Funded campaigns v2 | `0x0eB8f0d8eef814b035Cf970E9CC76320BC52682d` |
| Freely mintable demo token | `0x57812F6a0c07A6a31bCA56F660D737DD955F4ADF` |

The test fixture funded campaign `1` with one demo token, committed batch `1`, and produced a [successful proof claim](https://testnet.monadscan.com/tx/0xa743429de94082fa90b3d5c613999ef2f33e74cb705f7e7798efaf9eba8ef064). A second claim with the same nullifier was rejected as `AlreadyClaimed`. The [funding transaction](https://testnet.monadscan.com/tx/0x7f56833fe56db9972a70148de5871a274c2ef995e87f520578495d18c97ac900) transferred the test token directly to the demo treasury. Run `pnpm demo:monad:testnet` with the deployed manifest and an operator key to reproduce a new test campaign. No Copus TIME ledger credit is implied.

Monad Testnet uses chain ID `10143` and the public RPC `https://testnet-rpc.monad.xyz`. Keep keys in an untracked `.env` or a secret manager; see `.env.example`. Obtain test MON for the deployer and operator wallets. The payment contract accepts one configured ERC-20. For a self-contained demo you can deploy the freely mintable `MockUSDC` using `pnpm deploy:monad:test-token`; it is **not real USDC**.

1. Set `DEPLOYER_PRIVATE_KEY`, `MONAD_TESTNET_RPC_URL`, `ISSUER_ADDRESS`, `TREASURY_ADDRESS` and `FUNDING_TOKEN_ADDRESS`.
2. Run `pnpm deploy:monad:testnet`. The script checks chain ID, code, transaction receipts and contract wiring, and writes an untracked manifest under `deployments/`.
3. Prepare the policy with `pnpm campaign:prepare:v2 -- draft.json prepared.json`; fund a campaign only after reviewing the immutable manifest and funding amount.
4. Point the issuer, prover, relayer and indexer at the deployed contracts. Set `POE_VERSION=2`, `RPC_URL` and separate bearer tokens. Supply private backend evidence paths through `EVIDENCE_EXPORT_PATH` and `EVIDENCE_WRITEBACK_PATH`. The local `settlement-stub` can acknowledge indexer posts on port 8791 for development. Real TIME credit requires Copus backend registration of Monad chain 10143, wallet/subject binding, and the backend settlement endpoint.

No operator keys, Copus receipts, backend credentials, private deployment manifests or Base Sepolia production configuration are stored here. Keep `batch*.json`, receipt exports, encrypted archives and `.env` files out of Git.

## Security boundaries

The funding token is transferred directly from advertiser to the configured treasury. The contract never holds the token. A test mock is freely mintable and must not be presented as a stablecoin. The proof binds `evidenceRoot`, `ruleHash`, `nullifier`, `campaignId` and `epoch`. The indexer must settle only confirmed canonical events; the backend must enforce idempotency before crediting TIME.

See [Monad documentation](https://docs.monad.xyz/) for network details.

## Actual Copus product demo

Run `pnpm demo:product` with [PRODUCT_DEMO.md](PRODUCT_DEMO.md). This connects the actual sponsor editor, reader card, clock and isolated TIME ledger to the matching v2 chain verifier. [SUBMISSION.md](SUBMISSION.md) contains only technical recording/evidence steps. The on-chain transactions are real; experience summaries and TIME balances are explicitly labeled demo fixtures.

## Latest real UI acceptance (2026-10-04)

The bundled UI created campaign 2, completed a [real proof claim](https://testnet.monadscan.com/tx/0x2a6a7cef801a5e19b7f6a59a27a24eff07f1a7e67c77a2a535a04e08ce7310c6) after [test-token funding](https://testnet.monadscan.com/tx/0x8c7c6a3a268d41ccb6a225e9199d5ab846abfa733717e4bef5343642ec89c186), credited 30 minutes and settled 13 seconds of reading. The browser made no external API requests. See [demo-evidence.json](demo-evidence.json) for exact network identifiers and checks.

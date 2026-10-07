# Review the Monad demo

## Requirements

- Node.js 22+, pnpm 10.15+, an internet connection and test MON for gas.
- The real Copus UI is bundled in `demo-ui/copus-ui.tar.gz`; its hash and frontend commit are recorded in `demo-ui/manifest.json`. You do not need access to the private frontend repository.
- All blockchain actions run on **Monad Testnet, chain ID 10143**. The normal review command never falls back to a local EVM or mainnet.

## Start from a fresh clone

```sh
git clone https://github.com/copus-io/copus-poe-monad.git
cd copus-poe-monad
pnpm install --frozen-lockfile
pnpm demo:product
```

On the first run, the command generates an owner-only operator wallet under `~/.local/share/copus-poe-review/monad/`. If it needs gas, it prints **only the public address** and stops. Fund that address with test MON at <https://faucet.monad.xyz>, then rerun `pnpm demo:product`. Allow enough test MON for five small contract deployments and subsequent transactions; 1 test MON is a useful starting balance. The command deploys your own matching v2 verifier, evidence registry, immutable campaigns and freely mintable test token. It does not change the published Copus deployment and does not require a Copus issuer's private key.

After setup, open **http://localhost:8792/time-sponsors?sponsorshipDemo=1**. Keep the command running. Subsequent starts reuse the wallet, deployment and isolated ledger. To run another instance use `POE_DEMO_PORT=8793 pnpm demo:product`.

## Expected UI walkthrough

1. **Create a sponsorship.** The editor starts with an English campaign. Adjust the brand, title, description, cover, budget and claim amount. The preview is the actual reader card.
2. **Set eligibility.** Add public conditions, choose all/any matching and optionally add private conditions. Private values do not appear on the reader card. Experience facts are fixed demo fixtures, not production user records.
3. **Continue to funding.** Click **Confirm and continue to funding**. This opens the payment page directly; there is no extra review/save-plan screen.
4. **Fund and publish.** Click **Fund and publish**. A real transaction transfers **1 freely mintable test token** to the treasury and publishes the campaign. The USD budget shown in the editor is a product preview, not a real charge or a TIME exchange rate. Open the funding transaction link if you want to inspect the receipt.
5. **Open the claim card.** Click **Open claim card**. Default campaigns start approximately 30 seconds after funding; allow the card to refresh. Conditions use readable English such as “Published at least 1 work.”
6. **Claim TIME.** Click **Claim 30 minutes**. The local issuer commits a real evidence batch, privately generates a Groth16 proof and submits it to the on-chain v2 verifier. The button waits for confirmation; there is no “Proof submitted” toast. Only a canonical approval credits the demo ledger. The left clock briefly shows green **+00:30:00**.
7. **Inspect the balance and sponsor.** Open the left TIME clock. It shows the remaining balance and the sponsor's cover, name, title, full description and link. The balance decreases while exploring; the timing UI reuses Copus's normal attention runtime.
8. **Inspect the ledger.** Open **View TIME activity**. A sponsored credit and settled reading debits appear. Closing and reopening a reading session cannot debit twice. The claimed campaign cannot be claimed twice in the same period.

The page scrolls on desktop and mobile. No test-controls banner or technical network/verifier label is shown on the reader card. The network is identifiable through transaction links and the command's startup output.

## Existing authorized deployment (operators)

If you already have an issuer authorized on a matching deployment, set these variables before the normal command:

```sh
export POE_DEMO_KEY_PATH=/private/path/to/operator.json  # {address, privateKey}; chmod 600
export POE_DEMO_DEPLOYMENT=/private/path/to/matching-deployment.json
export POE_REVIEW_DATA=/private/path/to/review-data
export RPC_URL=https://testnet-rpc.monad.xyz
# Optional for environments that require an RPC proxy:
export POE_RPC_PROXY=http://127.0.0.1:17891
pnpm demo:product
```

Never commit wallets or copy another deployment's proving key. The operator must be an authorized issuer. Our published deployment addresses and prior transactions are recorded in the README for independent inspection; they are not credentials for the review demo.

## Isolation and checks

The browser only calls the local demo service. Its CSP blocks external fetch/XHR connections. It does not send Copus account tokens, contact Copus's production APIs, read a production database or change production TIME. Cookie sessions are HMAC-signed; browser-selected subjects, epochs and issuer facts are ignored. Wallets, sessions and SQLite files remain outside Git. Closing the command stops the app; it does not delete your private local data.

Chain funding and verification are real. Experience inputs and TIME credits are explicitly a fixture-based, isolated demonstration. This is not a production ledger integration or an audit claim. The app's public-content feed is disabled rather than fetched from the production backend. Work publishing is not connected: the `/create` route displays an explanation with links to sponsorship creation, claims and TIME activity instead of a blank page.

```sh
pnpm test
pnpm test:product
pnpm verify:demo
```

The advanced `pnpm demo:frontend-dev` command is for maintainers with a local current Copus frontend; it is not needed by reviewers.

### Local TIME ledger API

`GET /client/user/time/ledger?direction=ALL&pageIndex=1&pageSize=30` returns only the signed session's records. `direction` accepts `ALL`, `IN` (settled sponsorship credits), or `OUT` (settled attention debits). Filtering precedes counting and pagination; `pageIndex` is one-based (maximum 1,000,000) and `pageSize` is 1–100. Rows sort newest first, with stable ID ordering for equal timestamps. The demo returns individual entries (`entryCount: 1`); `merge=true` does not aggregate them. Group expansion is not implemented.

New credits retain their local settlement timestamp, including reconciliation; debits retain their session-close timestamp across repeated closes. Legacy credits have `createTime: null` and `timeSource: UNKNOWN` because the previous database did not store their dates. Unknown dates sort last; no historical timestamp is invented. Legacy closed sessions retain their previously recorded `last_seen` value as the best available close timestamp.

Credit rows include `campaignId`, `sponsorId` (the demo campaign ID), `sponsorName`, `fromUsername`, `campaignTitle`, and `transactionHash`. The bundled frontend currently overrides individual SPONSOR row names with the account's current sponsor and does not format unknown dates explicitly; these presentation changes require a frontend update. The API supplies the correct per-entry values without changing the bundled frontend.

Run the focused API regression tests with `node --test test/product-ledger.test.js`. They use an in-memory ledger and a test chain adapter, without broadcasting transactions.

### Campaign schedule and Top sponsors

The editor validates dates before opening funding: an explicit start must be in the future; turning off **No end date** requires an end later than the start. A blank start defaults to approximately 30 seconds after the chain adapter begins funding. The API revalidates before queueing funding and after waiting for the transaction queue. Both chain adapters validate before committing evidence, minting or approving tokens. The Monad in-process demo no longer fast-forwards chain time during publication; future campaigns remain scheduled.

Sponsor cards expose `poeScheduleStatus` (`SCHEDULED`, `ACTIVE`, `ENDED`) and ISO `startsAt`. Before the start they show **Starts soon / 尚未开始**, and after the end **Campaign ended / 活动已结束**; eligibility is evaluated for claiming only during the active window. The claim API rejects premature and ended claims before creating a pending claim or calling the chain. Server time drives the displayed status; the contract/program still enforces chain time.

`GET /client/user/time/ledger/top-sponsors` returns the current signed session's settled sponsorship credits, grouped by campaign and ranked by total credited seconds (descending, campaign ID as a stable tie-breaker). Entries contain `sourceType: BRAND`, `sourceId` (campaign ID), `name`, `description`, and `totalSeconds`. Pending, expired and other readers' claims are excluded. An empty array is correct when the reader has no settled sponsorships. This uses the demo's existing local settlement ledger; no additional chain scanning service is introduced.

The checksummed frontend archive is preserved. `services/demo-ui-patches.js` adapts its known modern and legacy editor/card hooks when served by `services/product-web.js`. If the frontend archive is replaced, rerun `node --test test/demo-ui-patches.test.js` and update these hooks as needed. The focused API/state tests are in `test/product-ledger.test.js`. These changes are local to the two demo repositories, not a deployment of the production Copus frontend.

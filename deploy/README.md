# Public Monad hackathon demo

This is the repository's release workflow for `https://monad.copus.io`. It serves the same bundled Copus UI and fixture-based TIME API as the local demo, using Monad Testnet (10143) for real proof/funding transactions. It cannot access the production database or production TIME settlement. There are no real money payments. A freely mintable test token funds each campaign.

1. Run the existing verification and product tests, commit the release and push this repository's `main`.
2. On the demo host, clone this repository into `~/hackathon-demos/monad/repo` and check out the exact pushed commit.
3. Create `~/hackathon-demos/monad/runtime/secrets/operator.json` with the authorized testnet operator key (mode 0600, owner UID 1000). Keep all runtime keys and ledger data out of the repository/image. The container runs as UID 1000.
4. Create a mode 0600 `runtime/runtime.env` using the documented testnet variables from `PRODUCT_DEMO.md`, with key paths under `/run/demo-secrets/`. Create `runtime/data` mode 0700, UID 1000. For Monad, also supply the matching public deployment manifest under `runtime/secrets/deployment.json`.
5. Create an A record `monad.copus.io` pointing to the demo host. Caddy obtains HTTPS automatically.
6. Run `bash deploy/release-demo.sh <full-commit>`. It requires a clean checkout matching remote main and preserves the previous deployed commit. It builds the committed image, starts only this isolated service, adds only this demo route, validates and reloads Caddy, and records `DEPLOYED_COMMIT`.
7. Verify `/healthz`, the sponsor editor, test funding, proof claim, clock and ledger. The homepage redirects to `/time-sponsors`.

Each chain has a separate Docker network, SQLite ledger, HMAC session key and testnet operator. The demo container never joins `copus_internal` and receives no production credentials. The HTTP layer limits public funding/claims, signs host-only Secure cookies and restricts origins. Browser `connect-src 'self'` prevents production API requests. `X-Robots-Tag` excludes the demo from search indexing.

For rollback, rebuild/start the previously recorded image using the previous commit; do not replace the data directory, session key or chain manifest. Code rollback should be committed as a revert and released through this script so git ancestry remains verifiable. This workflow never pushes the main Copus frontend or releases the Java backend.

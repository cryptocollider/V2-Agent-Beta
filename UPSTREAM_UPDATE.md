# Update V2-Agent-Beta to Agent1 RC1

Prepared package: agent1-rc1-20261115; runtime0.2.0-rc1.1. Upstream baseline: 44e448ab3640dae059804c00bb79b1e911817933. This is a complete clean Node/browser source snapshot, not an automatically applied Git patch or a GitHub publication.

1. Pause and reconcile any running instance. Back up its original profile and external encrypted wallet. No launch, funding or resume is part of this update.
2. Use a separate Git checkout, check its origin and current main SHA, and create a review branch (for example cc/agent1-rc1-20261113). If main advanced from the baseline above, review those intervening changes before overlaying.
3. Extract ZIP contents into that checkout. It has a flat repository-root layout. Review UPSTREAM-RECONCILIATION.json: 196 added, 57 changed, 43 unchanged source files. Files outside the snapshot are listed for deliberate review; never blanket-delete local data.
4. Remove the old tracked beta data/settings.json from the repository index, preserving any real local file: `git rm --cached --ignore-unmatch -- data/settings.json`. Remove tracked backup files deliberately. The old mirrorDeposit/random-identity bootstrap is not RC1 onboarding. Desktop and legacy monitor sources outside this Node snapshot are not a newly qualified installer.
5. Run npm ci --no-audit --no-fund, npm run check, npm run build, npm test, npm run verify:rc1 and node dist/cli/rc1-start.js --help. These checks do not claim tokens or start live play.
6. Review git status, source diff and staged diff; include runtime assets, root UI modules, generated doctrine cards/guides, current docs and the lockfile. Commit reviewed source, not local profiles, dependencies, dist or secrets.

For a fresh user after publication: npm ci; npm run start:rc1. That command explicitly opts into the pinned test-only one-use grant/deposit. At packaging, new funding readiness/faucet were held; preserve the same identity and journal until the service recovers. Existing users start paused unless explicitly resumed after reconciliation.

SOURCE-MANIFEST.json lists SHA256 for each source file. The separate ZIP .sha256 verifies the archive. Synthetic unit-test inputs are not operational wallets; no shared live wallet or key is bundled. Do not upload the enclosing workspace, release-staging, test runs or private application data.

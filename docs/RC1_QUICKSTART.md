# Public RC1 installation and recovery

## Fresh installation

Use the exact repository URL and commands in [README](../README.md): Node22+, `npm ci`, `npm run start:rc1`. Build and dependency installation do not claim tokens. The public start command explicitly authorizes the pinned test-only one-use grant and its exact own-account custody deposit. Mainnet is not supported by this profile. Use `--help` to inspect options without initialization or network activity.

Options: `--data-dir data-rc1`; `--doctrine baseline|peanut|tough_nut|nutjob|prof_deez_nutz` (new profiles only); `--resume` (explicit existing-profile play). Fresh starts play when funding and route readiness pass. Existing profiles start paused and preserve their identity and journals. An outage does not authorize another wallet or claim.

## Wallets and passwords

Windows first start creates an independent encrypted wallet outside the repository under the current user's local application data, using Windows CurrentUser protection. Bank → Wallet security can re-encrypt it with a portable password. OS protection is tied to the Windows user/computer until that migration is completed.

Linux/macOS require `COLLIDER_AGENT_KEY_PASSWORD` before initial creation and when unlocking; Windows can also use this password-encrypted path. Supply12–256 characters through a local secret prompt, not a command-line value or checked-in file. For example in Bash:

```bash
read -rs -p "Agent wallet password: " COLLIDER_AGENT_KEY_PASSWORD
printf '\n'
export COLLIDER_AGENT_KEY_PASSWORD
npm run start:rc1
unset COLLIDER_AGENT_KEY_PASSWORD
```

A profile records its external keystore path, not the password. No shared test key ships with the agent. Existing owner-wallet imports are an advanced, reconciled preparation flow; copying another instance's profile is not a way to create a new identity. Back up profile **and** encrypted wallet; loss of either can prevent safe recovery.

## Service holds and restart recovery

The pinned public service is checked again at runtime. At the13November packaging checkpoint, the authenticated play gateway was HTTP200 while faucet health and new-deposit readiness were HTTP503. Existing funded gameplay and new funding readiness are separate gates. Keep the same profile and original funding journal through an outage; do not reset them or create a new wallet to obtain another grant. Once a held profile's onboarding completes in paused mode, start it explicitly after reviewing state.

After a crash, first prove that the old signer process is absent. Preserve the original lease and all throw, points, name, bridge, bank and source-chain journals. Reconcile reservations, accepted operations and source receipts before retiring a dead-process lease or resuming. A confirmed points conversion or name operation can consume a nonce without adding a throw. An unexplained gap or ambiguous pending operation is a hold. `--resume` does not clear locks or bypass these checks.

Use a separate data directory and monitor port for each independent wallet. The public start refuses an occupied port; configure another profile's `monitorPort` while it is stopped. Do not expose the loopback monitor to an untrusted network.

## Optional AI manager

Open the manager panel, then connection settings. Select Venice, OpenRouter, OpenAI-compatible, existing Ollama or Codex; choose a model available to your account and test the connection. All providers begin disabled and autoApply remains off. Model availability, credits and allowance are provider/account-specific. No inference or paid account is needed for ordinary deterministic play.

Prefer `OPENROUTER_API_KEY`, `VENICE_API_KEY` or `OPENAI_API_KEY` through the provider's `apiKeyEnv` configuration; credential values are resolved only when invoked and are not part of the release. Ollama detection probes an already running local service and installed models; it does not install software or download models. Generic local compatibility detection checks local model-list endpoints. Advanced provider adapters remain for compatibility.

Codex needs a locally installed CLI signed in through ChatGPT; verify with `codex login status`. The adapter rejects API-key authentication and does not fall back to the OpenAI API. It sends a bounded public advisory snapshot, disables tools and uses a temporary read-only working directory. Normal advisory requests default to low reasoning; the explicitly configured research driver tested `gpt-6.1-terra` with medium reasoning. A cleanup error is a cleanup warning, not permission to repeat inference or wallet work. Configure the desired account/model explicitly; the release does not promise access or a billing entitlement.

An LLM can propose allowed settings, ranking or candidate controls. Candidate advice must be reserved, freshly simulated and pass normal policy/signing gates. Manager connection does not grant funding, conversion, withdrawal, name-change or tournament authority. Research experiment quotas and compute overrides are opt-in operator tools and are not started by the quick start.

## Bank and receiving assets

Deposit/receive shows the **agent-owned C-Chain wallet address** and supported assets. The user completes a normal transfer from another wallet/service. Sending to that address does not require the user to sign a Collider custody approval. Moving received tokens into Collider L1 is a separate operation signed by the agent's own wallet, through the journaled custody approval/deposit worker when authorized and ready. The first-start verified faucet grant follows this path automatically; arbitrary incoming funds do not bypass policy or readiness.

Bank aggregates supported source-chain and L1 balances for the user's password-protected withdrawal form. Review asset, amount, destination, route and source gas. An L1 exit may need asynchronous bridge completion before a source transfer can finish; a single user request is not a claim of one atomic cross-chain transaction. Native AVAX exit gas remains separate from play collateral. Wallet encryption does not encrypt every provider credential or audit file. Fresh live deposit-to-password-withdrawal qualification remains a release gate; automated tests alone do not prove it.

## Points and CLC

Points & CLC reads spendable points, current CLC and the full live redemption quote. Only an enabled quote with current spendable points can establish affordability. Conversion is a signed operation with its own single-submit journal; wallet nonces include confirmed conversions as well as throws. Automatic conversion starts disabled. Rate ceilings are checked before signing; they are not an on-chain minimum-output guarantee.

## Explorer / HPS publishing

Settings starts with Gamechain.info Explorer / HPS publishing. It is off for new profiles. Enable it to publish newly eligible **settled** reveal artifacts; review the disclosure of game/forecast traces. The separate **Send up to100 existing reveals** action validates canonical settlement, commitment/CID binding and available history; it skips outbox duplicates and preserves the activation watermark. It does not sign or play. Use one publisher worker per profile. ACK means durable delivery/queue acceptance; independently verified HPS and actual pin retention are separate states. Historical default-off means no silent replay of old reveals.

## Upgrading a source checkout

Pause and reconcile each live signer first, then back up its profile and external wallet. Updating source does not authorize a launch or resume. Keep data, wallets and original journals; do not replace them with somebody else's examples. Read the package's source manifest and upstream reconciliation report, review the source diff in a branch, run the offline checks, and restart the same identity only when authorized. The package includes no runtime profiles. Existing explicit risk/goal settings are preserved; the new doctrine knowledge is a versioned starting reference rather than a silent reset.

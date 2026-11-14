# Agent1 RC1 manager API and supervision

The loopback monitor serves monitor21.html at /, normally http://127.0.0.1:8787. Use the [public quick start](RC1_QUICKSTART.md) for installation, wallet recovery and providers. The previous beta/random-identity bootstrap is retired for this public profile.

## UI and connection

The wider manager panel contains connection settings, conversation, bounded proposals and a scrollable audit. Chat and proposals use separate layout areas. Points & CLC is embedded in the same monitor navigation; Bank includes the agent address and on-chain name. Doctrine theses displays the same generated seed JSON used by fresh profiles and manager prompts. /research.html reads the local notebook; ordinary play need not have one.

Choose Venice, OpenRouter, OpenAI-compatible, an already running Ollama installation or Codex. Test the connection before enabling optional inference. Local detection is read-only discovery, not provisioning. Advanced adapters remain for compatibility. API-key values are local configuration, not part of a public snapshot; prefer apiKeyEnv. AI autoApply is off for new profiles.

The Codex adapter invokes an installed CLI with its ChatGPT sign-in, explicitly rejects other authentication modes and has no paid API fallback. General Codex supports multiple authentication methods; this adapter deliberately selects one. Check locally with codex login status; see [official authentication documentation](https://learn.chatgpt.com/docs/auth). Model availability and allowance depend on the account. Do not promise that a direct OpenAI API provider shares a weekly allowance. Normal advisory effort defaults to low; an explicitly configured research driver can request supported low/medium/high effort. The recent tests requested gpt-6.1-terra at medium. The adapter uses a bounded public snapshot, temporary read-only directory, tool-disabled ephemeral execution and a strict response schema. Its cleanup warning must not replay inference or signing.

## Read first

Read current state, effective settings, control, eligible game supply, durable accepted/settled history, pending-operation flags and live asset/oracle readiness before proposing activity. A wallet nonce includes confirmed signed operations such as conversions and names, not just accepted throws. Unknown history/coverage is unknown, not zero. Canonical VM input, physics and exact receipt amounts outrank a model explanation.

| Surface | Purpose |
| --- | --- |
| GET /api/manager/state | Public manager/profile, effective doctrine and live candidate context |
| GET /api/settings | Effective saved/runtime play settings |
| GET /api/control/status | Live/paused state and current control boundary |
| GET /api/history/summary | Durable counts and recent game rows |
| GET /api/history/game?gameId=… | Related history for one displayed game |
| GET /api/doctrines | Read-only generated doctrine cards and evidence grades |
| GET /api/manager/candidates | Current ranked candidate context |
| POST /api/manager/preview | Keyless planning preview; no throw or wallet action |
| GET /api/manager/research | Local scientific notebook and joined outcome summary |
| GET /api/manager/llm | Redacted provider/conversation/proposal state |
| GET /api/manager/llm/audit | Persisted proposal decisions |
| GET /api/points/ledger | Spendable ladder points and balance context |
| GET /api/points/quote | Live redemption quote |
| GET /api/bank/wallet | Public receiving address and wallet protection status |
| GET /api/bank/balances | Source-chain and Collider L1 balance context |
| GET /api/publisher/status | Outbox/delivery/HPS/retention state |
| GET /api/manager/honest-score | HPS, coverage and diagnostics |

Read routes are not authority to sign. Mutation requests require the local control header and the relevant schema/authorization. Prefer the UI for forms involving credentials, financial actions or explicit confirmation; never send keys/passwords through chat. Server implementations define exact field names and validation.

## Proposals and influence

Settings patches, tactical overlays and candidate sets remain validated, auditable proposals. /api/manager/overlay and /api/manager/candidate-set accept bounded structures; /api/manager/llm/chat produces advice and proposals, while /api/manager/llm/apply applies an explicitly chosen proposal. The normal runtime then evaluates valid controls through its own signing gates. A manager response is not a receipt.

A candidate hash alone can vanish from a later finite search. Bind useful advice to controls, reserve it for the next search and freshly simulate the actual current board. Never reuse a frozen expected_hash or alter canonical confirmation input. Record proposed, eligible, simulated, score-affected, selected, accepted and settled separately. Keeping the optimizer winner is valid when it already meets the goal; disagreement is not a success metric.

Risk caps, per-game exposure, fixed stake, protected source gas and wallet single-submit journals remain authoritative. More search cannot increase stake authorization. A backup slot is a plan inside existing limits, not another grant of throws. A losing position is not a reason to double stakes. A purposeful wait needs a trigger and re-entry check.

## Doctrine knowledge and research

Read [DOCTRINE_STARTERS.md](DOCTRINE_STARTERS.md). The JSON source export and skill reference are generated by npm run build from src/core/doctrine-knowledge.ts. Current version is2026-11-13.research.v2. Existing explicit settings take precedence; old audit records retain their original version. Mechanics, inherited heuristics and observed experiments have separate evidence grades.

The research tools are optional operator experiments, not a new automatic play mode. They maintain manager-research-notebook.json plus an append-only local notebook audit, with hypothesis IDs, baseline/treatment episodes, quota/search decisions and linked accepted/settled evidence. Candidate/time budgets, bounded perturbations and the hard run deadline are explicit. Full evidence is retained while prompts use compact recent summaries. A pair shares activity/compute; baseline removes tactical LLM ranking and novel controls. Changing boards, correlated forecasts and interacting players prevent a simple causal win claim.

Keep at least several comparable episodes before revising a hypothesis; the tested harness uses6–12 windows and holds confidence updates until4 settled throws per arm. Confidence remains a belief, not a statistical result. Preserve late/pending outcomes and review old hypotheses when evidence matures. Unknown future throws are outside a current-known-board forecast. Per-candidate point forecasts are not implemented. Use actual matched awards, current live conversion quotes and exact returned amounts.

The controller's window quota is enforced in runtime limits and checked before signed preparation, with a separate remaining process allowance. Fresh runtime/control epochs must still match after planning. Deadline cleanup restores temporary settings and pauses; no background restart or signed retry follows a failure. Comparison pages must read durable outcomes after stop, not freeze the final live minute event. See [recent lessons](RC1_RESEARCH_LESSONS_2026-11-13.md).

## Reporting and privacy

Report current identity/chain, accepted versus settled/scored, explained wallet nonce, pending flags, actual balances and source gas, eligibility/oracle/game supply, and what changed versus the deterministic choice. Then explain a hypothesis, evidence and limitations. Do not read or expose private keys, raw signed transactions, salts or credentials to infer health. Never present local HPS as independently verified explorer HPS.

Publishing is default-off. Enabling newly eligible reveals and explicitly exporting up to100 existing reveals are separate user actions. Use durable outbox identities and preserve the activation watermark. Delivery ACK, HPS verification and IPFS retention remain separate. A publishing or temporary cleanup problem does not authorize another throw, replay, wallet action or funding claim.

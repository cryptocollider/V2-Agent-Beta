# Agent 1 Doctrine Packs and Goal Mix

Use this reference when the manager wants to change Agent 1 posture at a higher level than a one-off overlay.

## Why doctrine exists

Agent 1 separates three layers of strategy state:

- doctrine pack: the broad starting posture
- goal weights: the current objective mix
- custom strategy: the shareable named idea being tested inside that posture

That separation matters.

- doctrine answers: what kind of operator is this agent trying to be right now
- goal weights answer: what is it optimizing for right now
- custom strategy answers: what exact repeatable idea is it trying to prove or refine

## Current doctrine packs

### `baseline`

Use when establishing empirical truth first. This is the clean starting point for Agent 1. It aims to preserve the raw baseline without pretending stronger strategic identity already exists.

- first move: stabilize logging, coverage, and a local baseline before personality pressure
- strongest use: fresh deployments, new maps, or after major rule changes
- failure mode: staying neutral too long and mistaking passivity for discipline
- switch out when: the board is understood well enough that a sharper doctrine can earn its keep

### `nutjob`

Use when the manager wants novelty, weird lines, and board discovery. This is the experimental surface. It should test more of the space and accept that some of that space will be ugly.

- first move: push non-obvious candidate sets, odd follow-ups, and unfamiliar board branches
- strongest use: unexplored map dynamics, blackhole edge cases, or discovery-heavy cycles
- failure mode: paying too much tuition for noise that never turns into a reusable edge
- switch out when: the weirdness has already mapped the space and now needs harvesting

### `tough_nut`

Use when the manager wants stubborn anti-loss behavior, live-board recovery attempts, and conviction when a board can still be saved. This doctrine defaults into the built-in `toughnut_never_lose` posture while still enabling historical winner seeding. In practice it penalizes projected losing lines, rewards longer recovery windows on still-live boards, and leans toward throws that buy time for the board to turn back in its favor.

- first move: keep pressing still-live boards that can be repaired instead of abandoning them early
- strongest use: maps where late entries, extensions, or recovery throws can still bend the outcome
- failure mode: refusing to let go of a board that is already dead in economic terms
- switch out when: stubbornness is consuming bankroll without improving non-loss rate

### `peanut`

Use when the manager wants survivability, smaller posture, and cleaner calibration before ambition. This is the most bankroll-protective starting pack.

- first move: reduce size, tighten exposure, and demand cleaner evidence before scaling
- strongest use: early bankroll protection, fragile oracle periods, or cleanup after a rough run
- practical style: show up to almost every viable board, but do it with backups, hedges, and survivable sizing
- failure mode: becoming so safe that signal never grows and the agent never graduates
- switch out when: calibration is clean and the opportunity cost of caution is obvious

### `prof_deez_nutz`

Use when the manager is acting as a meta-operator. This doctrine is for comparing styles, composing hybrids, and learning at the system level rather than committing to only one persona.

- first move: compare multiple doctrines, extract what is working, then compose a named hybrid
- strongest use: portfolio-style supervision across many boards, agents, or doctrine forks
- failure mode: endless observing without decisive commitment when the edge is already visible
- switch out when: a concrete hybrid has emerged and deserves direct ownership

## Goal weights

Agent 1 exposes four goal axes:

- `profitMaxing`
- `ladderMaxing`
- `selfAwarenessMaxing`
- `discoveryMapping`

The manager can provide any non-negative numbers. Agent 1 normalizes them internally, so these are relative weights, not absolute percentages.

Example:

```json
{
  "goalWeights": {
    "profitMaxing": 55,
    "ladderMaxing": 10,
    "selfAwarenessMaxing": 20,
    "discoveryMapping": 15
  }
}
```

This means profit dominates, self-awareness is still active, and discovery is present but secondary.

## Resolution rules

Doctrine packs provide defaults for:

- `riskMode`
- `customStrategy`
- `copySlammerWhenSameHoleType`
- default goal weights

But doctrine is not absolute. Explicit settings override doctrine defaults.

That means the manager should always inspect the resolved `profile` object, not just the stored `settings`.

## Practical guidance

- Use doctrine pack when the whole posture feels wrong.
- Use goal weights when the posture is right but the priorities are wrong.
- Use `customStrategy` when the manager has a named idea worth testing repeatedly.
- Use `settings.humanLearning.*` when the manager wants Agent 1 to learn from manual examples supplied by its own human or another watched address.
- Use overlays and candidate sets when the hypothesis is local and bounded.

## Reporting guidance

When doctrine changes, tell the human exactly:

- what doctrine pack was selected
- what the goal mix is now
- what exact custom strategy name is active
- why this is a doctrine change instead of only an overlay test
- what this doctrine is trying to prove
- what would count as failure strongly enough to switch away from it

Doctrine should accelerate self-discovery, not hide it.


## Human + agent co-play

Agent 1 can learn from manual examples in a bounded way. When recent throws from the agent's own address or a watched address arrive without `data_commit`, the manager can treat them as human/manual demonstrations and feed them back into candidate search as example seeds.

This is not blind imitation. The planner still decides whether those examples survive simulation, but it gives human + AI teams a simple way to collaborate from day one without inventing a separate coaching protocol.

Persona helps the human choose a relatable starting character. Doctrine remains the exact machine-readable posture underneath it.

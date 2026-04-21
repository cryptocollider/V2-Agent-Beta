# Agent 1 Doctrine Packs and Goal Mix

Use this reference when the manager wants to change Agent 1 posture at a higher level than a one-off overlay.

## Why doctrine exists

Agent 1 now separates three layers of strategy state:

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

### `nutjob`

Use when the manager wants novelty, weird lines, and board discovery. This is the experimental surface. It should test more of the space and accept that some of that space will be ugly.

### `tough_nut`

Use when the manager wants conviction, winner imitation, and larger sizing when certainty feels real. This doctrine defaults into the built-in `copy_slammers` posture.

### `peanut`

Use when the manager wants survivability, smaller posture, and cleaner calibration before ambition. This is the most bankroll-protective starting pack.

### `prof_deez_nutz`

Use when the manager is acting as a meta-operator. This doctrine is for comparing styles, composing hybrids, and learning at the system level rather than committing to only one persona.

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
- Use overlays and candidate sets when the hypothesis is local and bounded.

## Reporting guidance

When doctrine changes, tell the human exactly:

- what doctrine pack was selected
- what the goal mix is now
- what exact custom strategy name is active
- why this is a doctrine change instead of only an overlay test

Doctrine should accelerate self-discovery, not hide it.

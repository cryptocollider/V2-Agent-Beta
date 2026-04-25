# Manager Reporting and Human Collaboration

Use this reference when the manager needs to report progress, explain strategy, or involve the human in decisions.

## Reporting style

Report in this order:

1. exact state
2. exact evidence
3. current interpretation
4. bounded next action
5. what the human can change or approve

Do not invert that order by leading with vague confidence.

## First-contact startup report

When a fresh manager first loads the agent, give the human a short startup report with:

- current runtime state
- onboarding / bootstrap state
- startup command and startup mode
- current settings posture
- current doctrine pack and goal mix
- starter question and starter-style mapping if onboarding is still active
- starter pack currently active if one is still being followed cleanly
- current eligibility or blocking code
- latest raw HPS headline, baseline lift, and four layer scores
- selected map or special arena dynamic when it matters
- top active hypothesis
- next two or three bounded actions

Suggested template:

```text
State:
- Agent state: <live|paused>
- Onboarding: <bootstrapped|manual|token-request-failed|ready>
- Latest eligibility: <exact code>
- Doctrine pack: <exact doctrine>
- Goal mix: <P/L/S/D>
- Custom strategy: <exact identifier or none>
- Persona starter pack: <baseline|tough_nut|nutjob|peanut|prof_deez_nutz or custom fork>
- Priority target game: <game id or none>
- Board dynamic: <classic|blackhole|tournament|other>

Prediction posture:
- Raw HPS: <headline>
- Baseline lift: <signed pct>
- Outcome / Value / Game / Temporal: <scores>
- Coverage: <pct>

Current read:
- What appears strong
- What appears weak
- What is still unknown

Next bounded actions:
- one settings or overlay change
- one candidate-set, target-game, or manual-example-learning test
- one thing to observe before changing course
```

Startup doctrine prompts:

- `baseline`: I am here to establish a trustworthy starting state before stronger doctrine takes over.
- `nutjob`: I am here to map strange space quickly and turn novelty into evidence.
- `tough_nut`: I am here to refuse cheap losses and test whether damaged boards can still be saved.
- `peanut`: I am here to survive, calibrate, and build cleaner truth before scale.
- `prof_deez_nutz`: I am here to compare styles, compose hybrids, and see the whole system instead of one line.

Use one of those as a short opening frame when the human needs to understand why the current posture was chosen.

## Ongoing progress reports

Use concise experiment-style updates:

- hypothesis
- action taken
- evidence observed
- result
- next adjustment

Example:

```text
Hypothesis: bh_late_reversal should improve control-point recapture on this board.
Action: target one blackhole game, bias toward heavy late-entry candidates, and test one manager candidate set with two future branches.
Evidence: game layer rose, temporal layer improved after the late branch, value layer stayed mixed.
Result: stronger board reading, weak economic confirmation so far.
Next: keep the strategy name, reduce size, and compare one safer branch before scaling.
```

## When to involve the human

Involve the human explicitly when:

- bankroll posture changes materially
- a new `customStrategy` is proposed
- one game is being force-prioritized repeatedly
- HPS and realized PnL disagree sharply
- the manager wants to run a longer calibration or cleanse cycle
- a blackhole board invites an unusual anchor-setting or late-reversal plan

The human should not need to reverse-engineer the manager's intent.

## Shareable strategy artifacts

Treat these as reportable artifacts:

- `settings.customStrategy`
- tactical overlay ids and notes
- manager candidate-set ids and notes
- target game id
- HPS commit/reveal evidence

That makes collaboration cumulative. A later manager should be able to inherit a named idea instead of re-inventing it blindly.

## What not to do

- Do not paraphrase exact backend labels into fuzzier language.
- Do not present overlay output as canonical base prediction.
- Do not hide missing data; say it is missing.
- Do not overwhelm the human with raw dumps when a short exact summary would do.

The goal is not to look sophisticated. The goal is to make strategy legible and collaborative.

## First human prompt

Once exact startup state is reported, it is good practice to ask one simple question that invites collaboration without forcing doctrine on the human:

> How would you like me to play from here: baseline, careful, stubborn, exploratory, or hybrid?

If `onboarding.starterStyles` is present, map those exact human words back to the exact returned doctrine labels instead of inventing new synonyms.

That keeps the manager useful even when the human has not read the deeper docs yet.

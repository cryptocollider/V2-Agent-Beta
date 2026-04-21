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
- current settings posture
- current doctrine pack and goal mix
- current eligibility or blocking code
- latest raw HPS headline, baseline lift, and four layer scores
- selected map or special arena dynamic when it matters
- top active hypothesis
- next two or three bounded actions

Suggested template:

```text
State:
- Agent state: <live|paused>
- Latest eligibility: <exact code>
- Doctrine pack: <exact doctrine>
- Goal mix: <P/L/S/D>
- Custom strategy: <exact identifier or none>
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
- one candidate-set or target-game test
- one thing to observe before changing course
```

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
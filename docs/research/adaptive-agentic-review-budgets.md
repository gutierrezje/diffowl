# Adaptive budgets for agentic code review

Research checked September 1, 2026. This note uses vendor documentation, vendor engineering posts, official model guidance, and original research. Vendor measurements are labeled as vendor results, not independent benchmarks.

## Conclusion

An eight-tool hard limit is too small and too rigid to be DiffOwl's normal review contract. It may stop one runaway trace, but it also prevents a reviewer from spending additional work on a genuinely difficult change. It is especially hard to justify when the user explicitly selected maximum reasoning effort.

The better design has three layers:

1. A prompt that defines what evidence is relevant, what completion means, and when another lookup has no expected value.
2. Adaptive review depth based on the change's risk, dispersion, and uncertainty, while preserving an explicit user choice of model and reasoning effort.
3. A generous safety backstop for stalled or runaway executions. Hitting it should produce an explicit incomplete result with coverage metadata, not turn an otherwise useful review into a policy-violation failure.

This is not an argument for unlimited execution. It is an argument for separating the normal stopping rule from the emergency stop.

## What the current DiffOwl evidence does and does not show

The diagnosis used a private two-regression case and found that the original Luna/max run was active rather than stalled. It used 33 tool rounds and about 246,000 tokens, took roughly 808 seconds, and found both known regressions. The Luna/medium replay without the new restrictions took about 190 seconds, used 19 tool batches and about 103,000 tokens, and found one of the two. The bounded Luna/medium replay took about 83 seconds, used six tool batches and about 45,000 tokens, and found the same one.

These observations establish a real exploration problem. They do not isolate the effect of the new prompt from the effect of the eight-tool and 60,000-token ceilings. The bounded replay stopped below both ceilings, so it cannot tell us whether eight is the right limit. The only observed run that found both known bugs used far more than eight rounds. That does not prove 33 rounds were necessary, but it makes an eight-call product limit an unsupported guess.

There is also a contract mismatch in the current PR implementation:

- The prompt says "8 tool batches." The execution layer counts individual non-passive tool items. A parallel batch can spend several units.
- The prompt says to return the best supported review when the budget is exhausted. The execution layer interrupts the ninth tool item and raises a policy-violation error.
- The same limit applies regardless of changed surface, uncertainty, model, reasoning effort, or user preference.

Those are local code observations, not claims from the external sources below.

## Evidence from model providers

### OpenAI recommends outcome contracts and workload-specific evaluation

OpenAI's GPT-5.6 guidance says to set reasoning effort intentionally. It recommends medium as a balanced starting point, low for latency-sensitive work, high or xhigh when evaluations show a quality gain, and max for the hardest quality-first work. It also says to compare max with xhigh on the application's own quality, latency, and cost measures. This makes reasoning effort a deliberate quality and latency choice, not an implementation detail for the harness to cancel with a fixed exploration limit. [OpenAI model guidance](https://developers.openai.com/api/docs/guides/model-guidance?model=gpt-5.6#prompting-best-practices)

The same guide recommends lean prompts, relevant tools, explicit evidence and success criteria, and representative evaluations. OpenAI reports that leaner prompts improved its internal coding-agent eval scores by about 10 to 15 percent while reducing tokens by 41 to 66 percent, but it calls those results directional and tells builders to validate their own workload. It also says fewer calls, turns, or intermediate outputs count as improvements only when the final answer still meets the required quality bar. [OpenAI model guidance](https://developers.openai.com/api/docs/guides/model-guidance?model=gpt-5.6#prompting-best-practices)

Codex exposes `model_reasoning_effort` as a user setting. Its current configuration reference also exposes a rollout-token budget, but labels that feature "under development" and off by default. DiffOwl should not make an unreleased Codex feature part of its stable review semantics. It can be an optional provider backstop after compatibility checks. [Codex configuration reference](https://developers.openai.com/codex/config-reference)

Inference for DiffOwl: start with a better prompt and a focused tool set. Preserve the user's reasoning effort. Judge any resource reduction against known-bug recall and review completeness, not elapsed time alone.

### Anthropic separates task completion from maximum iterations

Anthropic describes agents as useful when the required number of steps is difficult or impossible to predict. Its agent loop normally ends when the task is complete, while a maximum iteration count is a common control mechanism. This wording separates the semantic stopping condition from the safety bound. Anthropic also recommends testing agents in sandboxes because longer autonomous loops can accumulate cost and errors. [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

Anthropic's context-engineering guidance warns against both brittle prompt logic and vague instructions. It recommends direct heuristics at the right level, the smallest useful set of high-signal context, and tools whose contracts encourage efficient behavior. It also says more capable models need less prescriptive engineering, which matters for a system expected to outlive the current model generation. [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

There is direct evidence that fixed resource assumptions age quickly. In one Anthropic security-agent benchmark, the median tokens needed for a successful exploit fell 70.2 percent across four Claude generations. The benchmark is about smart contracts, not code review, so the number should not be transferred to DiffOwl. It does support the narrower claim that a fixed token or tool allowance can change meaning sharply as models improve. [AI agents find smart contract exploits](https://www.anthropic.com/research/smart-contracts)

Inference for DiffOwl: a hard ceiling can remain, but normal completion should be driven by evidence and progress. The ceiling should be configurable and measured as a backstop-hit rate. It should not define what a complete review is.

## Evidence from code-review products

### CodeRabbit treats long review work as a job

CodeRabbit says its CLI reviews can take 7 to 30 minutes or longer depending on scope. It tells coding agents to run the review in the background and check periodically. Its suggested limit of two applies to the outer review-and-repair loop, not to an internal tool-call count within one review. [CodeRabbit CLI](https://docs.coderabbit.ai/cli/index)

CodeRabbit also distinguishes `chill` and `assertive` review profiles and uses path-scoped review instructions, code guidelines, incremental reviews, and repository context to focus work. Its public docs do not reveal the internal stopping policy, so they cannot prove that CodeRabbit has no internal ceilings. They do show that the user-facing controls are about review scope and desired feedback, not a universal number of repository reads. [Configuration reference](https://docs.coderabbit.ai/reference/configuration) [Path-based review instructions](https://docs.coderabbit.ai/configuration/path-instructions) [Code-review overview](https://docs.coderabbit.ai/guides/code-review-overview)

Inference for DiffOwl: long max-effort review is not itself a defect. A silent foreground wait with weak progress and no durable status is a defect. Latency work should improve the loop and job contract without redefining maximum reasoning as a shallow review.

### Greptile moved from broad looping to narrow hypotheses

Greptile's v3 engineering post says its earlier fixed flow missed multi-hop effects. V3 let an agent recursively search in a loop and gave it a "very high" limit on inference and tool access. Greptile attributed higher issue acceptance to the agent's ability to challenge its own hypotheses with more context. These are Greptile's own product measurements. [Greptile v3](https://www.greptile.com/blog/greptile-v3-agentic-code-review)

Greptile did keep a maximum-turn control. Its changelog says teams could configure the model and maximum number of agentic turns to balance speed, depth, and cost. This supports a backstop, but it also supports making it a user or policy choice rather than a hidden eight-call constant. [Greptile changelog](https://www.greptile.com/changelog)

Greptile's latest iteration is more instructive than either unlimited breadth or a tiny global cap. V5 runs narrowly scoped agents in parallel, with each agent exploring one potential-bug hypothesis. Greptile reports that a production A/B test reduced median review time from 5:04 to 2:25 while increasing the share of comments addressed by authors from 52 to 66 percent. Again, these are vendor results. [Greptile changelog](https://www.greptile.com/changelog)

Inference for DiffOwl: the useful control variable is the hypothesis, not the raw tool count. A reviewer should be able to follow a concrete auth, persistence, or API-contract concern several hops. It should not roam through dependencies, skills, web results, and unrelated history without a candidate bug that the next lookup could confirm or reject.

### Qodo routes effort by risk and defines modes by outcomes

Qodo's 2026 Review Effort Modes are the clearest public design for this problem. Fast uses one lightweight pass, Balanced uses one complete pass, Deep uses several independent passes, and Auto routes the PR. Qodo says the modes are defined by intended outcomes rather than a fixed model lineup, so it can change models and architecture as they improve without changing the user contract. It evaluates precision, recall, F1, latency, token use, and cost together. [Qodo Review Effort Modes](https://www.qodo.ai/blog/the-right-depth-for-every-pr-introducing-review-effort-modes/)

Qodo also documents why line count is a bad routing signal. Its router combines a lightweight semantic classifier with deterministic guardrails and uses logic risk, change dispersion, uncertainty, blast radius, and diff-hunk count. Unknown changes are not downgraded. In Qodo's vendor benchmark, the revised router matched its all-Deep F1 while reducing model cost by 21 percent, token use by 30 percent, and average runtime by 27 percent. [Building an adaptive router for code-review depth](https://www.qodo.ai/blog/building-an-adaptive-router-for-code-review-depth/)

Qodo's engineering write-up also argues against one monolithic reviewer. It gives context collection, issue finding, and compliance enforcement separate prompts and tools, and has each agent evaluate progress toward a defined goal. Qodo reports better tool accuracy and latency from this specialization. [When your system is an agent, you need a different benchmark](https://www.qodo.ai/blog/when-your-system-is-an-agent-you-need-a-different-benchmark/)

Inference for DiffOwl: preserve explicit model and effort selections, but make an optional `auto` depth policy a separate product feature. Risk routing should decide context and review architecture. It should not silently replace the user's selected reasoning effort.

## Evidence from test-time compute research

Snell, Lee, Xu, and Kumar found that the value of test-time computation varies with prompt difficulty. Their compute-optimal strategy allocated work per prompt and was more than four times as efficient as a fixed best-of-N baseline on their math-reasoning experiments. The domain and inference method differ from agentic code review, so this is directional evidence rather than a ready-made algorithm for DiffOwl. The relevant result is that uniform compute allocation was inferior to difficulty-aware allocation. [ICLR 2025 paper](https://openreview.net/pdf?id=4FWAwZtd2n)

Inference for DiffOwl: one fixed allowance for a README typo, a generated lockfile, an authentication change, and a cross-service migration is unlikely to be compute-optimal. The routing and stopping policy needs task signals and measured outcomes.

## Recommended design for DiffOwl

### Replace the eight-call normal limit with an evidence-based stop rule

The system prompt should make the supplied diff and generated local context primary. It should then govern exploration through expected evidence:

```text
Review the changed behavior, not the repository in general.

Start from the supplied diff and local context. Form a small set of concrete
candidate failures tied to changed behavior. Use a tool only when its result can
confirm or reject one named candidate, locate its direct caller or callee, or
verify a changed contract.

After each tool result, reassess the candidates. Stop and return the review when
each candidate is supported, rejected, or cannot be resolved with relevant local
evidence. Do not keep searching to increase confidence after the required evidence
is already present.

If two consecutive tool batches add no new relevant evidence, repeat an earlier
search, or only broaden the repository area without sharpening a candidate, stop.
Return the best supported review and state no finding that lacks an evidence path.

Do not run tests, builds, linters, web searches, dependency tours, or unrelated
history unless the reviewed change directly makes that source necessary to decide
a concrete candidate. Batch independent reads and searches when possible.
```

The stagnation rule is a soft progress test. It still permits ten useful lookups on a subtle authorization path and stops after three wasteful lookups on a trivial diff. The wording should be evaluated and shortened if any line fails to change model behavior.

### Keep a separate emergency backstop

Use at least two independent controls:

- A stall timeout based on the absence of provider or tool activity.
- A generous total deadline based on the chosen review mode, with a user override for quality-first work.

A token or tool ceiling can remain as a final runaway detector, but derive it from observed tail behavior by model, reasoning effort, and review mode. Do not use the median successful run as the ceiling. Track how often the limit fires and whether known-bug recall drops near it.

When a soft budget reminder fires, ask the reviewer to resolve its current candidates and return. If the hard backstop fires, persist the partial review as `incomplete`, including the exact covered commit, inspected files, unresolved candidates, stop reason, and consumed resources. Do not label normal excess exploration a policy violation.

The Codex rollout-budget feature may help implement reminders, but its under-development status makes it unsuitable as DiffOwl's only enforcement mechanism.

### Respect explicit reasoning effort

Pass the selected model and reasoning effort through unchanged. A user who chooses max has asked for a quality-first tradeoff. DiffOwl can show an expected latency range, recommend xhigh based on evals, or offer an `auto` review-depth mode. It should not silently make max behave like medium by restricting repository evidence to the same eight calls.

Reasoning effort and review depth should remain separate:

| Setting | Controls |
| --- | --- |
| Model and reasoning effort | How much internal reasoning the selected model performs |
| Review depth | Which context, passes, and validation stages DiffOwl makes available |
| Timeout and backstop | When the system interrupts a stalled or runaway execution |

This separation also survives faster future models. A faster model can do more useful work before a wall-clock deadline, while the outcome and evidence contract stays the same.

### Add adaptive depth only after a small, real eval proves it

Do not revive a large synthetic timing matrix, and do not add private project source or identifiers to the DiffOwl corpus. Build a small set of independent synthetic or permissively licensed known-bug reviews that cover different risk shapes. The fixtures may reproduce general review challenges, but must not copy or closely derive from private code. Compare these variants with Luna/max:

1. The original unbounded prompt.
2. The proposed evidence and stagnation prompt with a high emergency backstop.
3. The current eight-tool and 60,000-token implementation.

Repeat each exact replay enough to expose agent variance. Measure:

- recall of the known accepted bugs and precision of additional findings;
- wall time, time to first supported candidate, tokens, tool items, and unique files read;
- repeated searches or reads, unrelated files visited, and context compactions;
- normal completion, soft-reminder completion, and hard-backstop rate;
- which changed surfaces and unresolved candidates remained when a run stopped.

The prompt-first design should replace the hard-eight design only if it preserves or improves recall without returning to the original runaway pattern. After that, risk signals such as auth, permissions, money movement, migrations, public contracts, hunk dispersion, and uncertainty can drive an optional adaptive depth policy. Raw line count should not.

## Decision for PR #172

The research did not support merging the eight-tool ceiling as the product fix for issue #168. PR #172 was subsequently revised to remove the eight-item execution failure and 60,000-token rollout budget while retaining the focused capability set. Its broad mandatory-pass checklist was replaced with a changed-contract method that traces changed conditions, return values, and callbacks through their direct consumers and permits tools only to resolve concrete candidate failures.

The final private replays support that decision. Their source and project identifiers remain outside the DiffOwl repository and test corpus:

| Review | Tool-activity phases | Total | Accepted regressions found |
| --- | ---: | ---: | ---: |
| Original Luna/max incident | 33 | 807.8s | 2/2 |
| Luna/medium before this work | 19 | 190.2s | 1/2 |
| Final evidence-focused prompt, Luna/medium | 6 | 60.2s | 1/2 |
| Final evidence-focused prompt, Luna/max sample 1 | 20 | 431.3s | 2/2 |
| Final evidence-focused prompt, Luna/max sample 2 | 21 | 472.5s | 1/2 |
| Final evidence-focused prompt, Luna/max sample 3 | 22 | 330.0s | 1/2 |
| Final evidence-focused prompt, Luna/max sample 4 | 32 | 492.5s | 2/2 |
| Final evidence-focused prompt, OpenCode `openai/gpt-5.6-luna` max | Not exposed | 393.2s | 1/2 |

The four Luna/max samples ranged from 330.0 to 492.5 seconds with a 451.9-second median. Tool-activity phases ranged from 20 to 32 with a 21.5 median. Every run found the easier known regression, but only two found the harder one. All four samples were faster than the single incident, and three used materially fewer tool phases, but the single original sample does not prove a causal speedup. The repeated quality result is more important: the prompt did not preserve the harder finding reliably. The OpenCode replay also found only one known regression, and the backend did not return an effective-model identity or detailed tool-activity telemetry.

The durable product contract should be: finish when the changed behavior has been reviewed with enough evidence, spend more effort when risk or uncertainty warrants it, and stop safely when progress stalls. A number like eight belongs in telemetry or a tested backstop policy, not in the definition of a complete review.

# Plan: effort profiles (after Perplexity's Agent API `effort`)

Source of the idea: https://docs.perplexity.ai/docs/agent-api/effort. One `effort` value there selects a bundle
(model, `max_steps`, `reasoning.effort`, output ceiling, tools), and fields sent next to it override the bundle.

Fane already has three levels, Vane's Speed / Balanced / Quality, but what a level means is spread over five places.
This plan covers four ideas:

1. Reasoning effort per mode (today `low` everywhere).
2. One table per mode.
3. Explicit research step budgets.
4. CLI overrides with a fixed precedence.

## Where a mode's settings live today

| Setting | Where | Value per mode (speed / balanced / quality) |
|---|---|---|
| Mode list | `cli/client.mjs` `VALID_MODES`, `cli/write/models.mjs` `MODES` (two copies) | `speed, balanced, quality` |
| Default mode | `cli/write/models.mjs` `DEFAULT_MODE`, `cli/client.mjs` `DEFAULTS.mode` | balanced |
| Price band | `cli/image/catalogue.mjs` `TIER_FOR_MODE` (inverted in `cli/runners.mjs` `MODE_FOR_TIER`) | budget / value / premium |
| Reasoning effort | `cli/write/models.mjs` `REASONING = { effort: 'low' }`, sent by `write/llm.mjs` `createRoleCaller` and `scripts/trial-lib.mjs` | low / low / low |
| Thinking headroom | `cli/write/models.mjs` `THINKING_HEADROOM` (8000), added by `tokensFor`, `code/models.mjs` `codeTokensFor`, `brainstorm/pipeline.mjs` `tokensFor` | 8000 / 8000 / 8000 |
| Phases | `write/models.mjs` `PHASES`, `POST_PHASES`; `code/models.mjs` `CODE_PHASES`; `brainstorm/pipeline.mjs` `PHASES` | per feature |
| Vane research rounds | in the bundle (module 87044): `"speed"===b.config.mode?2:"balanced"===b.config.mode?6:25`; `patch-quality-mode` target "iteration budget" turns 25 into 10 | 2 / 6 / 10 |
| CLI timeout | `cli/vane.mjs` `parseCli`: `modeOf(values) === 'quality' ? '600' : '180'` | 180 / 180 / 600 s |
| Spend cap | `FANE_MAX_COST`, read once by `write/llm.mjs` `maxCostFromEnv` | none by default |

## Design

### Paradigm: table-driven configuration plus a pure resolver
- **Data, not classes.** The modes differ only in numbers and names, not in behaviour. So a mode is a row of data.
  - A Strategy class per mode would be three classes with no logic in them.
  - A global mutable config object would hide which run used which values.
- **Functional core, imperative shell.** This is the repo's existing split.
  - `resolveEffort(mode, overrides)` is pure: it validates, merges, derives the dependent values and returns a frozen object.
  - The shells pass the result down through the injection points that already exist: the CLI runners, the four `vane-hook.mjs` files, and the trial and bench scripts.
- **Parameter object.** Pipelines and the role caller get one `effort` object, not four loose options.
  - A new knob later changes the table and its readers, not every signature on the way.
- **Derived values are computed, never stored.**
  - Headroom follows from reasoning effort.
  - `MODE_FOR_TIER` follows from `tier`.
  - So an override of `reasoning` cannot leave a stale headroom behind.
- **One precedence rule, in one place:** CLI flag > environment > profile.
  - `resolveEffort` is the only function that knows it.
  - Pipelines never read `process.env`. This matches the CLAUDE.md rule about `DEFAULTS` and `maxCostFromEnv`.
- **Immutability.** `Object.freeze` on the table and on each resolved profile. Tests mutate copies only.
- **Single source of truth across the CJS/ESM boundary.**
  - Patches are CommonJS and run in the container before any ESM module is guaranteed to be there, so they cannot import `cli/core`.
  - The research rounds therefore get a copy in `patches/lib/vane.js`, and a test keeps the two equal.
  - This is the pattern the repo already uses for `IMAGE_ANSWER_MARKER`, `CODE_ANSWER_MARKER` and `IMAGE_STORE_DIR`.

### Layering (`cli/test/boundaries.test.mjs`)
- **The table goes in `cli/core/effort.mjs`.** `core` imports nothing, and the table is plain data. Every layer may read it.
- **Feature phase lists stay where they are.** They name feature roles, which `core` must not know. A test checks that every phase table has exactly the keys in `MODES`.
- **`image/catalogue.mjs` re-exports `TIER_FOR_MODE`, derived from the table.** Existing imports keep working.

### The table (sketch)

```js
// cli/core/effort.mjs: what each Vane mode spends. Imports nothing (core layer).
export const MODES = Object.freeze(['speed', 'balanced', 'quality']);
export const DEFAULT_MODE = 'balanced';
// OpenRouter's reasoning.effort values. Check the accepted set against OpenRouter's docs when implementing.
export const REASONING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high']);
// Room for thinking on top of an answer's own budget, by reasoning effort. `low` is today's THINKING_HEADROOM.
// The others are a first guess, to be checked with the bench (finish_reason "length" counts).
export const HEADROOM = Object.freeze({ minimal: 4000, low: 8000, medium: 16000, high: 24000 });

export const EFFORT = Object.freeze({
  speed:    Object.freeze({ tier: 'budget',  reasoning: 'low', researchRounds: 2,  cliTimeoutS: 180 }),
  balanced: Object.freeze({ tier: 'value',   reasoning: 'low', researchRounds: 6,  cliTimeoutS: 180 }),
  quality:  Object.freeze({ tier: 'premium', reasoning: 'low', researchRounds: 10, cliTimeoutS: 600 }),
});

// mode + overrides -> a frozen profile with the derived values. Throws RangeError on a bad value (the CLI turns it
// into a UsageError, exit 2). `env` is passed in, never read here.
export function resolveEffort(mode = DEFAULT_MODE, { reasoning, maxCost } = {}, env = {}) { /* ... */ }
// -> { mode, tier, reasoning, headroom, researchRounds, cliTimeoutS, maxCost }
```

`maxCost` resolves as flag, then `env.FANE_MAX_COST`, then `Infinity`. The parsing moves out of `maxCostFromEnv` into the resolver. `maxCostFromEnv` stays as a thin wrapper for the callers that only have an environment.

## Steps (one commit each; the order lets each step be measured with the one before)

### Step 1: one table, no change in behaviour (idea 2)
- **New:** `cli/core/effort.mjs`, containing the table, `resolveEffort` and `HEADROOM`.
- **Point the copies at it:**
  - `cli/client.mjs` `VALID_MODES = MODES`.
  - `cli/write/models.mjs` re-exports `MODES` and `DEFAULT_MODE`; `THINKING_HEADROOM = HEADROOM.low` stays exported for old imports.
  - `cli/image/catalogue.mjs` `TIER_FOR_MODE` is derived from `EFFORT`.
  - `cli/vane.mjs` `parseCli` reads `resolveEffort(modeOf(values)).cliTimeoutS` instead of `'quality' ? 600 : 180`.
- **Tests** (`cli/test/effort.test.mjs`):
  - The table gives today's values exactly (the 2/6/10 rounds, the 180/600 timeouts, the budget/value/premium bands, and `low`).
  - Every phase table (`PHASES`, `POST_PHASES`, `CODE_PHASES`, brainstorm `PHASES`) has the keys of `MODES`.
  - `resolveEffort` refuses an unknown mode, reasoning or cost, and its result is frozen.
- **Docs:** the CLAUDE.md architecture section names `core/effort.mjs` as the one place a mode is defined.

### Step 2: reasoning and headroom come from the profile (plumbing for idea 1; still `low` everywhere)
- **`write/llm.mjs` `createRoleCaller({ client, log, sleep, effort })`:**
  - It sends `reasoning: { effort: effort.reasoning }`.
  - `maxCost` comes from `effort.maxCost`.
  - The `REASONING` constant goes.
- **Token budgets take the headroom as a parameter:** `tokensFor(role, words, lang, headroom)` in write, `codeTokensFor(role, headroom)` in code, `tokensFor(role, lang, headroom)` in brainstorm.
  - The pipelines pass `effort.headroom`.
- **Who builds the profile:** each pipeline (`write/pipeline.mjs`, `write/edit.mjs`, `code/pipeline.mjs`, `brainstorm/pipeline.mjs`) takes `effort` in its options. It defaults to `resolveEffort(mode)`, so callers that pass only `mode` keep working.
  - The four hooks call `resolveEffort(mode, {}, process.env)` once.
  - The CLI runners in `cli/runners.mjs` call it with the parsed flags.
- **Trials stay at `low`:** `scripts/trial-lib.mjs` uses `TRIAL_REASONING = 'low'`. A trial checks whether a model can do the job at the cheapest setting, and higher effort only adds tokens. The constant gets a comment saying so.
- **Log line:** `core/runlog.mjs` `runSummary` adds `reasoning`, so a web run's log line says which effort it used.
- **Tests:**
  - A fake client records the request bodies: a `quality` profile with `reasoning: 'medium'` sends `medium` and a budget raised by `HEADROOM.medium`.
  - The default profile sends `low`, which is today's behaviour.

### Step 3: CLI overrides (idea 4)
- **Flags in `cli/vane.mjs`:**
  - `--reasoning <minimal|low|medium|high>` and `--max-cost <usd>`.
  - Both are checked in `parseCli`. A bad value is a `UsageError` (exit 2).
  - Both are accepted only with `--article`, `--edit-article`, `--code` or `--brainstorm`, and are a usage error otherwise. A plain search goes to Vane's `/api/search`, which has no field for them.
- **Precedence:** a flag beats the environment, which beats the profile. This is stated in `--help` and in the README option table, which restates `--help`.
- **Tests in `cli/test/vane.test.mjs`:**
  - Parsing, refusal without a feature flag, and precedence (`--max-cost 0.5` with `FANE_MAX_COST=2` gives 0.5).
  - `autoRoute` keeps the flags when it re-parses.
- **Not here:** no web UI override. Vane's UI has no field for it, and an environment variable per mode would be a second table.

### Step 4: measure reasoning per mode, then set it (idea 1)
- **`scripts/article-bench.mjs`:**
  - A `--reasoning` option is passed through to the child `vane --article` (this uses step 3).
  - The value is written into every result row, so a baseline is only compared with a run at the same effort.
- **Experiment.** It costs money, so it needs your go-ahead first (about $5 at the default `--budget`).
  1. Run `node scripts/article-bench.mjs --key-from-vane --modes quality --out bench/quality-low.json`.
  2. Run the same with `--reasoning medium --baseline bench/quality-low.json`.
- **When to keep `medium` for Quality:** all three must hold.
  - Judged claim support is not lower (within the bench's `TOLERANCE`).
  - The judged audit is not lower.
  - "cut off at N tokens" attempts do not rise.
- **Report:** the cost and time differences, from the summary lines.
- **Optionally Balanced:** the same comparison for Balanced, only if Quality improved.
- **The change itself:** one value in `EFFORT`, plus a CLAUDE.md note with the measured numbers. This is the style of the `dateRule` note.

### Step 5: research rounds from the table (idea 3)
- **`patches/lib/vane.js` `RESEARCH_ROUNDS = { speed: 2, balanced: 6, quality: 10 }`.** A test keeps it equal to `EFFORT[mode].researchRounds`.
- **`patch-quality-mode`'s "iteration budget" target becomes `alts`, all with the same `to`** (built from `RESEARCH_ROUNDS`, with the speed part included):
  - from Vane's original (`…?2:"balanced"===b.config.mode?6:25`),
  - and from the first Fane version (`…?6:10`).
- **Later changes:** a later change of a value adds one alt from the old `to`. This is the documented upgrade pattern (`COLORS_V1`, `TYPE_V4`).
- **Before writing the target:** check that no other patch's `from` or `to` contains these fragments. Today only `patch-quality-mode` does.
- **Restart:** the target is a server chunk, so `apply.mjs` restarts Vane. Apply it only after `docker logs --since 3m vane` shows no answer in progress.
- **No values change in this step.** Lowering Balanced's 6, for example, is a separate decision, measured with `scripts/bench.mjs --modes speed,balanced --baseline bench/baseline.json`.
- **Tests:**
  - The target's shape, done by `patches.test.mjs`.
  - Both `from` alternatives produce the same bundle text.
  - `RESEARCH_ROUNDS` equals the table.
- **Docs:** CLAUDE.md, under `patch-quality-mode`; the README row for `patch-quality-mode`. No new patch file, so the patch count on `docs/` stays the same.

## Files touched

- **New:** `cli/core/effort.mjs`, `cli/test/effort.test.mjs`.
- **Changed:**
  - CLI: `cli/client.mjs`, `cli/vane.mjs`, `cli/runners.mjs`.
  - Image: `cli/image/catalogue.mjs`.
  - Write: `cli/write/{models,llm,pipeline,edit}.mjs`, `cli/write/vane-hook.mjs`.
  - Code, brainstorm and image hooks: `cli/code/{models,pipeline,vane-hook}.mjs`, `cli/brainstorm/{pipeline,vane-hook}.mjs`, `cli/image/vane-hook.mjs` (tier only).
  - Core: `cli/core/runlog.mjs`.
  - Scripts: `scripts/trial-lib.mjs`, `scripts/article-bench.mjs`.
  - Patches: `patches/lib/vane.js`, `patches/patch-quality-mode.js`.
  - Docs: `README.md`, `CLAUDE.md`.
  - Existing tests that call `tokensFor` or `createRoleCaller` directly.

## Risks

- **Cut-offs.** Higher effort spends more of the token budget on thinking. Expect more `finish_reason: length` and more fallbacks, which the chain absorbs at the cost of time. `HEADROOM` per level is the guard, and step 4 measures it.
- **Ignored values.** Some models ignore `reasoning` and some providers refuse values they don't know. A 400 on an unknown effort would walk the chain. Check OpenRouter's accepted values before allowing `minimal`.
- **Restart.** Step 5 restarts Vane once, which kills answers in progress.
- **Free models.** freellmapi strips fields that strict providers refuse. Check whether `reasoning` reaches them or must be dropped for `free:` models, as `usage` already is.

## Not in this plan

- An `ultra` level or background mode.
- Pinned profile versions: `trial.json` and the prompt fingerprint in the run log already identify what a run used.
- A step cap for Fane's own pipelines: their phase lists are already fixed counts.
- Per-request overrides from the web UI.

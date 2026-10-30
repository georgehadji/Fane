// What each Vane mode spends: the one table every feature reads (after Perplexity's Agent API `effort`, which bundles
// a model, a step budget and a reasoning effort per level). Feature phase lists stay with their features
// (write/models.mjs PHASES, code/models.mjs CODE_PHASES, brainstorm/pipeline.mjs PHASES); a test keeps their keys
// equal to MODES. patches/lib/vane.js cannot import this file (patches are CommonJS run in the container), so
// anything a patch needs from here gets a copy there and a test that keeps both equal.
export const MODES = Object.freeze(['speed', 'balanced', 'quality']);
export const DEFAULT_MODE = 'balanced';

// OpenRouter's reasoning.effort values Fane sends ("none" is left out: models that must reason refuse it). Models
// without reasoning ignore the field. `low` because the first model trial found thinking models spending the whole
// token budget on reasoning and returning no text; the trials (scripts/trial-lib.mjs) stay at `low`.
export const REASONING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high']);
export const DEFAULT_REASONING = 'low';
// Room for thinking on top of an answer's own token budget, by reasoning effort. `low` is the measured value (a Quality
// copy edit was cut off at 4975 tokens); the others are a first guess, to be checked with scripts/article-bench.mjs.
// A cap is not a spend: only generated tokens are paid.
export const HEADROOM = Object.freeze({ minimal: 4000, low: 8000, medium: 16000, high: 24000 });

// tier: the price band of images and of the text models' default chains. researchRounds: Vane's research loop
// (module 87044, set by patch-quality-mode). cliTimeoutS: the CLI's default request timeout.
export const EFFORT = Object.freeze({
  speed: Object.freeze({ tier: 'budget', reasoning: DEFAULT_REASONING, researchRounds: 2, cliTimeoutS: 180 }),
  balanced: Object.freeze({ tier: 'value', reasoning: DEFAULT_REASONING, researchRounds: 6, cliTimeoutS: 180 }),
  quality: Object.freeze({ tier: 'premium', reasoning: DEFAULT_REASONING, researchRounds: 10, cliTimeoutS: 600 }),
});

// A spend cap in USD from the environment: a positive number, else no limit (FANE_MAX_COST).
export const costCap = (value) => {
  const n = Number(value);
  return n > 0 ? n : Infinity;
};

// mode + overrides -> the frozen profile of one run. An override wins over the environment, which wins over the
// table; the headroom follows the reasoning effort. Throws RangeError on an unknown mode, an unknown effort or a cap
// that is not a positive number (the CLI turns that into a usage error). `env` is passed in, never read here.
export function resolveEffort(mode = DEFAULT_MODE, { reasoning, maxCost } = {}, env = {}) {
  if (!MODES.includes(mode)) throw new RangeError(`unknown mode "${mode}" (${MODES.join(', ')})`);
  const row = EFFORT[mode];
  const effort = reasoning ?? row.reasoning;
  if (!REASONING_LEVELS.includes(effort)) throw new RangeError(`unknown reasoning effort "${effort}" (${REASONING_LEVELS.join(', ')})`);
  let cap = costCap(env.FANE_MAX_COST);
  if (maxCost !== undefined) {
    cap = Number(maxCost);
    if (!(cap > 0) || !Number.isFinite(cap)) throw new RangeError(`invalid spend cap "${maxCost}" (a positive number of USD)`);
  }
  return Object.freeze({ mode, ...row, reasoning: effort, headroom: HEADROOM[effort], maxCost: cap });
}

// Which phases run on each Vane mode, which models run them, and how many tokens each may use.
// Modes are Vane's Speed / Balanced / Quality. Phase counts (model calls, sources are free):
//   speed 2 (outline, draft), balanced 6, quality 8 (+4 for the one retry after a failed audit),
//   plus one or two trim calls whenever a text ends up more than a quarter over its target (pipeline.mjs MAX_OVER);
//   a Greek or other non-English topic adds one cheap call to write English search queries.
import { DEFAULT_TEXT_MODEL } from '../image/openrouter.mjs';

export const MODES = ['speed', 'balanced', 'quality'];
export const DEFAULT_MODE = 'balanced';
export const ROLES = ['queries', 'outline', 'draft', 'factcheck', 'critique', 'revise', 'polish', 'style', 'copy', 'audit'];

export const PHASES = {
  speed: ['queries', 'outline', 'draft'],
  balanced: ['queries', 'outline', 'draft', 'factcheck', 'critique', 'revise', 'polish'],
  quality: ['queries', 'outline', 'draft', 'factcheck', 'critique', 'revise', 'style', 'copy', 'audit'],
};

// Posts (formats.mjs) have no sections: no outline, no structural critique, and no audit, whose dimensions
// (thesis, transitions) are an article's. The revision runs only when claims failed the fact-check.
export const POST_PHASES = {
  speed: ['queries', 'draft'],
  balanced: ['queries', 'draft', 'factcheck', 'revise', 'polish'],
  quality: ['queries', 'draft', 'factcheck', 'revise', 'polish'],
};

// Sent with every call. The first model trial found thinking models (Mistral Large, Qwen Max, Cohere ...)
// spending the whole token budget on reasoning and returning no text (finish_reason "length", 0 words);
// models without reasoning ignore the parameter. The trial (scripts/article-trial.mjs) uses the same value.
export const REASONING = { effort: 'low' };

export const DEFAULT_WORDS = 900;
export const MIN_WORDS = 300;
export const MAX_WORDS = 2500;
export const clampWords = (n) => Math.min(MAX_WORDS, Math.max(MIN_WORDS, Math.round(Number(n) || DEFAULT_WORDS)));

// Models for each role: a list, primary first, then its fallbacks. `models` (--article-model a,b,c)
// is used for every role. Per-tier chains of text models come with the tier-selection step; until
// then the default is one cheap model, so the default has no fallback.
export const chainsFor = (models) => {
  const chain = (models && models.length ? models : [DEFAULT_TEXT_MODEL]);
  return Object.fromEntries(ROLES.map(r => [r, chain]));
};

// Tokens per word: Greek takes about 2-3 times as many as English. Reasoning models also spend
// output tokens on thinking, hence the headroom: reasoner's postmortem found phases silently
// cut at a 2048 default.
const TOKENS_PER_WORD = { en: 1.5, el: 3.6 };
const PROSE = new Set(['draft', 'rewrite', 'revise', 'polish', 'style', 'copy']);
const JSON_TOKENS = { queries: 800, outline: 3000, factcheck: 4000, critique: 3500, audit: 2500 };
// Room for thinking on top of the answer, even at low effort: the first live run in Vane's web UI had an
// outline cut off at 3880 tokens by three models in a row, and a Quality copy edit cut off at 4975 tokens
// (qwen3.8-max-prime; its fallback took 79 s). A cap is not a spend: only generated tokens are paid.
export const THINKING_HEADROOM = 8000;

export function tokensFor(role, words, lang) {
  const k = TOKENS_PER_WORD[lang] || TOKENS_PER_WORD.en;
  if (PROSE.has(role)) return Math.ceil(words * k * 1.3) + THINKING_HEADROOM;
  return Math.ceil((JSON_TOKENS[role] || 1500) * (lang === 'el' ? 1.6 : 1)) + THINKING_HEADROOM;
}

export const isJsonRole = (role) => role in JSON_TOKENS;

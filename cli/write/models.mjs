// Which phases run on each Vane mode, which models run them, and how many tokens each may use.
// Modes are Vane's Speed / Balanced / Quality. Phase counts (model calls, sources are free):
//   speed 2 (outline, draft), balanced 6, quality 8 (+4 for the one retry after a failed audit);
//   a Greek or other non-English topic adds one cheap call to write English search queries.
import { DEFAULT_TEXT_MODEL } from '../image/generate.mjs';

export const MODES = ['speed', 'balanced', 'quality'];
export const DEFAULT_MODE = 'balanced';
export const ROLES = ['queries', 'outline', 'draft', 'factcheck', 'critique', 'revise', 'polish', 'style', 'copy', 'audit'];

export const PHASES = {
  speed: ['queries', 'outline', 'draft'],
  balanced: ['queries', 'outline', 'draft', 'factcheck', 'critique', 'revise', 'polish'],
  quality: ['queries', 'outline', 'draft', 'factcheck', 'critique', 'revise', 'style', 'copy', 'audit'],
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
const PROSE = new Set(['draft', 'revise', 'polish', 'style', 'copy']);
const JSON_TOKENS = { queries: 400, outline: 1800, factcheck: 2600, critique: 2000, audit: 1500 };

export function tokensFor(role, words, lang) {
  const k = TOKENS_PER_WORD[lang] || TOKENS_PER_WORD.en;
  if (PROSE.has(role)) return Math.ceil(words * k * 1.3) + 1500;
  return Math.ceil((JSON_TOKENS[role] || 1500) * (lang === 'el' ? 1.6 : 1)) + 1000;
}

export const isJsonRole = (role) => role in JSON_TOKENS;

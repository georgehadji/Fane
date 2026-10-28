// Models for the coding pipeline. As for articles (write/catalogue.mjs), OpenRouter's catalogue says nothing
// about code quality, so no model reaches a default chain unless it passed the live trial (scripts/code-trial.mjs,
// results in trial.json): one function written with the real generate prompt that must parse and pass a fixed
// test, and a spec answered as JSON. Code specialists (coder, codex) are candidates here; the article trial leaves
// them out. Chains are price bands per mode, like the article chains. Untried models: --code-model.
import { buildTextCatalogue, selectChains } from '../write/catalogue.mjs';
import { extractJson } from '../write/llm.mjs';
import { extractCode, safePath } from './files.mjs';
import { CODE_JSON_ROLES } from './models.mjs';

// Order in which roles take primaries from the ranked list: the writer and its reviewer differ in lab.
export const CODE_ROLE_ORDER = ['generate', 'review', 'fix', 'tests', 'spec'];
export const TRIAL_KEY = 'code';

export const buildCodeCatalogue = (entries, opts) => buildTextCatalogue(entries, { ...opts, code: true });

export const selectCodeChains = (catalogue, trial, { mode = 'balanced' } = {}) =>
  selectChains(catalogue, trial, { mode, lang: TRIAL_KEY, roles: CODE_ROLE_ORDER, jsonRoles: CODE_JSON_ROLES });

// ---- the live trial: a task with one right answer ----

export const TRIAL_REQUEST = 'Write a JavaScript ES module duration.mjs that exports parseDuration(text), which turns a duration such as "1h30m" into whole seconds.';
export const TRIAL_FILE = {
  path: 'duration.mjs',
  purpose: 'parseDuration(text): parses "1h30m", "45s", "2h", "1h 5m 10s" or "90m" into whole seconds. Units h, m and s, each at most once and in that order, written as non-negative whole numbers; spaces are allowed between the parts and around the text. Throws TypeError when text is not a string, and RangeError for anything else that is not such a duration: an empty string, an unknown unit, a unit twice, units out of order, a number without a unit, a sign or a decimal point.',
  exports: ['parseDuration'],
  imports: [],
};
export const TRIAL_SPEC = {
  language: 'JavaScript', framework: '', summary: 'One ES module with one pure function.', files: [TRIAL_FILE],
  dependencies: [], error_strategy: 'throw TypeError or RangeError with a message naming the input', security_notes: [], test_strategy: '', test_command: '', setup: '', run: '',
};
// [input, expected seconds, or the name of the error it must throw]
export const TRIAL_CASES = [
  ['1h30m', 5400], ['45s', 45], ['2h', 7200], ['1h 5m 10s', 3910], ['90m', 5400], [' 2h ', 7200], ['0s', 0], ['10m5s', 605],
  ['', 'RangeError'], ['5x', 'RangeError'], ['1m1h', 'RangeError'], ['1h1h', 'RangeError'], ['1.5h', 'RangeError'],
  ['-5s', 'RangeError'], ['h', 'RangeError'], ['15', 'RangeError'], [42, 'TypeError'], [null, 'TypeError'],
];

// results: [{ ok }] per case from the sandboxed run (scripts/code-trial.mjs), or null when the code did not load.
// -> { ok, problems, passed, total, score } (score: lower is better, for ranking the models that pass)
export function judgeTrialCode(text, { results, finish = 'stop', loadError = '', ms = 0 } = {}) {
  const problems = [];
  if (finish !== 'stop') problems.push(`finish_reason ${finish}`);
  const code = extractCode(text);
  if (!code.trim()) problems.push('no code');
  if (loadError) problems.push(`does not load: ${loadError.slice(0, 120)}`);
  const total = TRIAL_CASES.length;
  const passed = Array.isArray(results) ? results.filter(r => r?.ok).length : 0;
  // one miss is allowed: models disagree on a corner of the spec ("0s", "15") without being unusable
  if (!loadError && passed < total - 1) problems.push(`passed ${passed} of ${total} cases`);
  if (/\b(?:TODO|FIXME)\b/.test(code)) problems.push('left a TODO');
  const score = 5 * (total - passed) + ms / 30_000;
  return { ok: !problems.length, problems, passed, total, score: Math.round(score * 100) / 100 };
}

// The spec prompt answered as JSON, with at least one usable file path and a language.
export function judgeTrialSpec(text, finish = 'stop') {
  const data = extractJson(text);
  const files = Array.isArray(data?.files) ? data.files.filter(f => safePath(f?.path)) : [];
  const ok = finish === 'stop' && typeof data?.language === 'string' && data.language.trim() !== '' && files.length > 0;
  return { ok, problems: ok ? [] : [finish !== 'stop' ? `finish_reason ${finish}` : 'not the requested JSON'] };
}

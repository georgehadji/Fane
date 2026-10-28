// Text models for the article pipeline: which OpenRouter models are candidates, and which chain
// each phase gets on each Vane mode. Pure functions over catalogue data and trial results.
//
// OpenRouter's catalogue says nothing about writing quality or Greek, so no model reaches a default
// chain on its price or its name alone: it must have passed the live trial (scripts/article-trial.mjs,
// results in trial.json): a short article in English and in Greek that clears the deterministic checks,
// and a JSON answer. Untried models can still be used with --article-model.
// Tiers are price bands like the image tiers: Speed the cheapest third of the verified models,
// Balanced the middle, Quality the dearest. Inside a band the cleanest writers (fewest stock phrases)
// come first, one lab at a time, so neighbouring roles (draft, critique, fact-check ...) get models
// from different labs where the pool allows, and each chain ends in fallbacks from other labs.

import { THINKING_LEAK, checkCitations, rhythm } from './checks.mjs';
import { countTells, findHomoglyphs, greekShare, greekTypography, wordCount } from '../core/language.mjs';
import { extractJson } from './llm.mjs';

export const FALLBACKS_PER_ROLE = 3;
export const MIN_CONTEXT = 64_000; // 16 sources of 700 characters plus the article fit with room to spare

// Not for writing: routers, embedding/vision/code/translation specialists, preview aliases.
const NOT_FOR_ARTICLES = /(?:^|[/-])(?:router|switchyard|embed\w*|moderation|guard\w*|ocr|vl|vision|omni|coder?|codex|math|summari[sz]e|extract|translate\w*|moondream|image|audio|tts|whisper)(?:$|[/-])/i;
// The coding pipeline (cli/code) takes the code specialists too.
const NOT_FOR_CODE = /(?:^|[/-])(?:router|switchyard|embed\w*|moderation|guard\w*|ocr|vl|vision|omni|math|summari[sz]e|extract|translate\w*|moondream|image|audio|tts|whisper)(?:$|[/-])/i;
const VARIANT = /:(?:free|batch|extended|nitro|floor|online|exacto)$|^~/;

// OpenRouter prices are USD per token strings; the blend weighs output 3:1 over input
// because an article is mostly generated text. Stored as USD per million tokens.
const perMillion = (x) => Math.round(Number(x) * 1e8) / 100;
export const blend = (m) => (m.priceIn + 3 * m.priceOut) / 4;

export function toTextModel(entry, { now = Date.now(), code = false } = {}) {
  const id = String(entry?.id || '');
  if (!id.includes('/') || VARIANT.test(id) || (code ? NOT_FOR_CODE : NOT_FOR_ARTICLES).test(id)) return null;
  if ((entry.architecture?.output_modalities || []).join() !== 'text') return null;
  const priceIn = perMillion(entry.pricing?.prompt), priceOut = perMillion(entry.pricing?.completion);
  if (!(priceIn > 0 && priceOut > 0)) return null; // free, unpriced and router entries
  if ((entry.context_length || 0) < MIN_CONTEXT) return null;
  if (entry.expiration_date && Date.parse(entry.expiration_date) < now) return null;
  const params = entry.supported_parameters || [];
  return {
    id,
    name: entry.name || id,
    lab: id.split('/')[0],
    created: entry.created || 0,
    context: entry.context_length,
    priceIn,
    priceOut,
    price: 0,
    json: params.includes('response_format') || params.includes('structured_outputs'),
    reasoning: params.includes('reasoning'),
  };
}

export function buildTextCatalogue(entries, opts) {
  return (entries || []).map(e => toTextModel(e, opts)).filter(Boolean).map(m => ({ ...m, price: blend(m) }));
}

// Models to put through the trial: the newest few of each lab, so every lab is tried and the
// price range is covered, capped overall (every model is paid calls).
export function trialCandidates(catalogue, { perLab = 2, max = 40 } = {}) {
  const labs = new Map();
  for (const m of [...catalogue].sort((a, b) => b.created - a.created)) {
    const list = labs.get(m.lab) || [];
    if (list.length < perLab) labs.set(m.lab, [...list, m]);
  }
  return [...labs.values()].flat().sort((a, b) => b.created - a.created).slice(0, max);
}

// Round-robin over labs, the best model of each lab first. `better` orders the models.
function diverse(list, better) {
  const byLab = new Map();
  for (const m of [...list].sort(better)) byLab.set(m.lab, [...(byLab.get(m.lab) || []), m]);
  const out = [];
  for (let round = 0; out.length < list.length; round++) for (const group of byLab.values()) if (group[round]) out.push(group[round]);
  return out;
}

const JSON_ROLES = new Set(['queries', 'outline', 'factcheck', 'critique', 'audit']);
// Order in which roles take primaries from the ranked list: neighbours differ in lab.
const ROLE_ORDER = ['draft', 'critique', 'factcheck', 'revise', 'audit', 'polish', 'style', 'copy', 'outline'];
const BANDS = { speed: [0, 1 / 3], balanced: [1 / 3, 2 / 3], quality: [2 / 3, 1] };

// trial: { [modelId]: { en: { ok, tellsPerThousand }, el: { ok, tellsPerThousand }, json: { ok } } }
// -> { chains: { role: [id...] }, pool: n, band: [id...], prices: { id: { in, out } } } | null when no model passed for `lang`.
// The coding pipeline passes its own roles and its trial's key ('code' for `lang`, cli/code/trial.json).
export function selectChains(catalogue, trial, { mode = 'balanced', lang = 'en', roles = ROLE_ORDER, jsonRoles = JSON_ROLES } = {}) {
  const pool = catalogue.filter(m => trial?.[m.id]?.[lang]?.ok);
  if (!pool.length) return null;
  // the trial's combined score; a trial.json written before it existed has stock phrases only
  const tells = (m) => trial[m.id][lang].score ?? trial[m.id][lang].tellsPerThousand ?? 99;
  const better = (a, b) => tells(a) - tells(b) || b.created - a.created;
  const byPrice = [...pool].sort((a, b) => a.price - b.price);
  const n = byPrice.length;
  const lo = Math.min(Math.round(BANDS[mode][0] * n), n - 1);
  const hi = Math.min(n, Math.max(lo + 1, Math.round(BANDS[mode][1] * n)));
  const band = byPrice.slice(lo, hi);
  const centre = (lo + hi - 1) / 2;
  const others = byPrice.map((m, i) => ({ m, d: Math.abs(i - centre) })).filter(({ m }) => !band.includes(m)).sort((a, b) => a.d - b.d).map(({ m }) => m);

  const chain = (role) => {
    const ok = (m) => !jsonRoles.has(role) || trial[m.id]?.json?.ok;
    const inBand = diverse(band.filter(ok), better);
    // from this role's start, around the band (so fallbacks cost about what the primary does), then neighbouring bands
    const start = inBand.length ? roles.indexOf(role) % inBand.length : 0;
    const around = inBand.map((_, i) => inBand[(start + i) % inBand.length]);
    return [...around, ...diverse(others.filter(ok), better)].slice(0, 1 + FALLBACKS_PER_ROLE).map(m => m.id);
  };
  const chains = Object.fromEntries(roles.map(r => [r, chain(r)]));
  for (const r of jsonRoles) if (chains[r] && !chains[r].length) chains[r] = chains[roles[0]]; // nobody verified for JSON: try, and let the pipeline report it
  if (jsonRoles.has('queries')) {
    // the query-writing call is cheap whatever the mode: the cheapest verified models that answer JSON
    chains.queries = byPrice.filter(m => trial[m.id]?.json?.ok).slice(0, 2).map(m => m.id);
    if (!chains.queries.length) chains.queries = chains.outline;
  }
  // USD per million tokens, for the models that report no usage.cost (llm.mjs estimates their cost)
  const prices = Object.fromEntries(pool.map(m => [m.id, { in: m.priceIn, out: m.priceOut }]));
  return { chains, pool: n, band: band.map(m => m.id), prices };
}

// ---- the live trial: what counts as a pass ----

// A short article written with the real draft prompt (scripts/article-trial.mjs). `finish` is the
// provider's finish_reason. -> { ok, problems, words, tellsPerThousand, score }
// `score` ranks the models that pass (lower is better). Stock phrases alone did not separate them: in the
// first trial all 27 that passed had 0 per 1000 words. So it adds numbers that are in no cited source, the
// share of uncited sentences, the miss on the length, flat sentence rhythm and Greek typography faults.
export function judgeTrialDraft(text, { lang, sources, finish = 'stop', target = 150 }) {
  const problems = [];
  const words = wordCount(text);
  if (finish !== 'stop') problems.push(`finish_reason ${finish}`);
  if (THINKING_LEAK.test(text)) problems.push('reasoning in place of an answer');
  if (words < target * 0.45 || words > target * 3) problems.push(`${words} words for a target of ${target}`);
  const greek = greekShare(text);
  if (lang === 'el' && greek < 0.75) problems.push('not written in Greek');
  if (lang === 'en' && greek > 0.05) problems.push('not written in English');
  if (lang === 'el' && findHomoglyphs(text).length) problems.push('Latin letters inside Greek words');
  const c = checkCitations(text, sources);
  if (c.invalid.length) problems.push(`cites source ${c.invalid[0]}, which does not exist`);
  else if (!c.used.length) problems.push('no citations');
  const tellsPerThousand = countTells(text, lang).perThousand;
  const invented = c.numbersMissing.reduce((n, m) => n + m.numbers.length, 0);
  const uncited = c.cited + c.uncited ? c.uncited / (c.cited + c.uncited) : 1;
  const { cv } = rhythm(text);
  const typography = lang === 'el' ? greekTypography(text).reduce((n, f) => n + f.count, 0) : 0;
  const score = tellsPerThousand + 3 * invented + 5 * uncited + 10 * Math.abs(words - target) / target + (cv === null ? 2 : 20 * Math.max(0, 0.35 - cv)) + typography;
  return { ok: !problems.length, problems, words, tellsPerThousand, invented, score: Math.round(score * 100) / 100 };
}

// The query-writing prompt answered as JSON: a "queries" array of at least two strings.
export function judgeTrialJson(text, finish = 'stop') {
  const data = extractJson(text);
  const ok = finish === 'stop' && Array.isArray(data?.queries) && data.queries.filter(q => typeof q === 'string' && q.trim()).length >= 2;
  return { ok, problems: ok ? [] : [finish !== 'stop' ? `finish_reason ${finish}` : 'not the requested JSON'] };
}

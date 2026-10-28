// Brainstorming pipeline, after reasoner's brainstorming method (src/reasoner/application/flows/brainstorming.py,
// brainstorming_phases.py): prior art -> rounds of Verbalized Sampling -> merge, theme and score -> develop the best
// -> synthesis. Which phases run, and how many rounds, depends on the Vane mode (PHASES). Model calls go through
// write/llm.mjs (cut-off, empty and non-JSON answers walk the role's chain); every role answers JSON. Fixes of
// reasoner's flow:
//  - the prior-art pages reach the rounds and the scoring (reasoner fetched them and used them nowhere);
//  - code ranks the scored ideas and picks the ones to develop, one theme at a time (reasoner developed the first
//    three ideas the clustering model marked "keep", in the order of its themes, whatever their scores);
//  - ids are given by code; answers that name an unknown id are ignored, so nothing invented reaches the result.
// Failures are values: a round, the development or the synthesis that fails is listed in `degraded`.
import { createRoleCaller, statusOf } from '../write/llm.mjs';
import { selectChains, selectFreeChains } from '../write/catalogue.mjs';
import { LANGUAGE_NAMES, detectLanguage, fold, repairFinalNu, repairHomoglyphs } from '../core/language.mjs';
import { DEFAULT_MODE, MODES, THINKING_HEADROOM } from '../write/models.mjs';
import { DEFAULT_TEXT_MODEL } from '../image/openrouter.mjs';
import { brainstormPrompts } from './prompts.mjs';

export const ROLES = ['generate', 'cluster', 'develop', 'synthesis'];
// reasoner's defaults (3 rounds of 5, 2 tail ideas under 0.10, 3 developed), on Balanced
export const PHASES = {
  speed: { prior: false, rounds: 2, develop: 0 },
  balanced: { prior: true, rounds: 3, develop: 3 },
  quality: { prior: true, rounds: 4, develop: 4 },
};
export const IDEAS_PER_ROUND = 5;
export const TAIL = 0.1;
export const TAIL_PER_ROUND = 2;
export const MAX_PRIOR = 8;
const WEIGHTS = { novelty: 0.4, impact: 0.35, feasibility: 0.25 };
const MIN_FEASIBILITY = 3; // a brilliant idea nobody can build is not developed

const TOKENS = { generate: 2500, cluster: 4000, develop: 5000, synthesis: 3000 };
const PER_LANGUAGE = { en: 1, el: 2.4 }; // Greek takes ~2.4x the tokens (write/models.mjs)
export const tokensFor = (role, lang) => Math.round(TOKENS[role] * (PER_LANGUAGE[lang] || 1)) + THINKING_HEADROOM;
const TEMPERATURE = { generate: 1, cluster: 0.2, develop: 0.5, synthesis: 0.5 };

// Default chains: the models that passed the article trial (cli/write/trial.json: prose in the language and JSON),
// in the mode's price band. Brainstorming needs both, and no second trial is needed. English when none passed for lang.
export const selectBrainstormChains = (catalogue, trial, { mode = DEFAULT_MODE, lang = 'en' } = {}) =>
  selectChains(catalogue, trial, { mode, lang, roles: ROLES, jsonRoles: new Set(ROLES) })
  || (lang !== 'en' ? selectChains(catalogue, trial, { mode, lang: 'en', roles: ROLES, jsonRoles: new Set(ROLES) }) : null);
// The same over the free models of the article trial (freellmapi; see withFreeLlm).
export const selectFreeBrainstormChains = (trial, ready, { lang = 'en', last } = {}) =>
  selectFreeChains(trial, ready, { lang, roles: ROLES, jsonRoles: new Set(ROLES), last })
  || (lang !== 'en' ? selectFreeChains(trial, ready, { lang: 'en', roles: ROLES, jsonRoles: new Set(ROLES), last }) : null);

export const chainsFor = (models) => Object.fromEntries(ROLES.map(r => [r, models?.length ? models : [DEFAULT_TEXT_MODEL]]));

const text = (s) => (typeof s === 'string' ? s.trim() : '');
const strings = (a) => (Array.isArray(a) ? a.map(text).filter(Boolean) : []);
const score = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Math.min(10, Math.round(Number(x)))) : null);
const key = (title) => fold(title).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const KEEP = new Set(['id', 'ids', 'recommended', 'url', 'tier']); // values the final text pass leaves alone

// One round's answer -> ideas with ids from code; titles already seen are dropped.
export function normalizeIdeas(data, round, seen = new Set()) {
  const out = [];
  for (const i of Array.isArray(data?.ideas) ? data.ideas : []) {
    const title = text(i?.title);
    if (!title || seen.has(key(title))) continue;
    seen.add(key(title));
    const p = Number(i.probability);
    out.push({
      id: `R${round}I${out.length + 1}`, round, title, description: text(i.description), insight: text(i.insight),
      probability: Number.isFinite(p) && p >= 0 && p <= 1 ? p : null,
      tier: ['conventional', 'lateral', 'disruptive'].includes(text(i.tier).toLowerCase()) ? text(i.tier).toLowerCase() : '',
    });
  }
  return out;
}

// The clustering answer applied to the ideas: themes, scores, duplicates dropped, existing work noted.
// -> { themes: [{ theme, ids }], ideas (scored, duplicates removed), unscored: n }
export function applyClusters(data, ideas, prior = []) {
  const byId = new Map(ideas.map(i => [i.id, { ...i }]));
  const placed = new Set(), dropped = new Set(), themes = [];
  for (const t of Array.isArray(data?.themes) ? data.themes : []) {
    const ids = [];
    for (const s of Array.isArray(t?.ideas) ? t.ideas : []) {
      const idea = byId.get(text(s?.id));
      if (!idea || placed.has(idea.id)) continue;
      placed.add(idea.id);
      const dup = text(s.duplicate_of);
      // a pair marked as duplicates of each other keeps the second one
      if (dup && dup !== idea.id && byId.has(dup) && !dropped.has(dup)) { dropped.add(idea.id); continue; }
      idea.feasibility = score(s.feasibility); idea.novelty = score(s.novelty); idea.impact = score(s.impact);
      if (idea.feasibility != null && idea.novelty != null && idea.impact != null) {
        idea.score = Math.round((WEIGHTS.novelty * idea.novelty + WEIGHTS.impact * idea.impact + WEIGHTS.feasibility * idea.feasibility) * 10) / 10;
      }
      const n = Number(s.exists);
      if (Number.isInteger(n) && prior[n - 1]) idea.exists = { title: prior[n - 1].title, url: prior[n - 1].url };
      idea.theme = text(t.theme);
      ids.push(idea.id);
    }
    if (ids.length) themes.push({ theme: text(t.theme) || '—', ids });
  }
  const kept = ideas.filter(i => !dropped.has(i.id)).map(i => byId.get(i.id));
  return { themes, ideas: kept, unscored: kept.filter(i => i.score == null).length };
}

// The ideas to develop: the best of each theme in turn (themes ordered by their best idea), so a run does not develop
// three variants of one idea; ideas below MIN_FEASIBILITY are skipped, unless no idea reaches it (then the best
// scored, rather than paying for a development and a synthesis of nothing). Without scores: the rarest ideas first.
export function pickIdeas(ideas, themes, n) {
  if (n <= 0) return [];
  const byId = new Map(ideas.map(i => [i.id, i]));
  const scored = ideas.filter(i => i.score != null);
  if (!scored.length) return [...ideas].sort((a, b) => (a.probability ?? 1) - (b.probability ?? 1)).slice(0, n);
  const queues = themes
    .map(t => t.ids.map(id => byId.get(id)).filter(i => i?.score != null && i.feasibility >= MIN_FEASIBILITY).sort((a, b) => b.score - a.score))
    .filter(q => q.length)
    .sort((a, b) => b[0].score - a[0].score);
  if (!queues.length) return [...scored].sort((a, b) => b.score - a.score).slice(0, n);
  const out = [];
  while (out.length < n && queues.some(q => q.length)) for (const q of queues) if (q.length && out.length < n) out.push(q.shift());
  return out;
}

export function createBrainstormPipeline({ client, retrieve, log = () => {}, now = Date.now }) {
  const call = createRoleCaller({ client, log });

  return async function brainstorm({ request, mode = DEFAULT_MODE, lang, models, chains, prices, onProgress = () => {} }) {
    if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}"`);
    const t0 = now();
    lang = LANGUAGE_NAMES[lang] ? lang : detectLanguage(request);
    chains ||= chainsFor(models);
    const plan = PHASES[mode];
    const phases = [], degraded = [];
    let cost = 0, calls = 0;
    const emit = (e) => { try { onProgress(e); } catch { /* a throwing listener must not stop the run */ } };
    const fail = (error, extra = {}) => ({ ok: false, error, phases, language: lang, mode, calls, cost, ...extra });

    async function step(role, ctx, note = '') {
      emit({ phase: role, status: 'running', note });
      const started = now();
      const r = await call(role, brainstormPrompts[role]({ text: request, lang, ...ctx }), { chain: chains[role] || chains.generate, maxTokens: tokensFor(role, lang), temperature: TEMPERATURE[role], prices, json: true });
      calls += r.attempts.length;
      cost += r.cost;
      const rec = { phase: role, note, model: r.model || null, status: statusOf(r), ms: now() - started };
      phases.push(rec);
      emit(rec);
      return { ...r, rec };
    }

    // 1. What already exists (Balanced, Quality): Vane's research on the problem. A failed search is a note.
    let prior = [];
    if (plan.prior && retrieve) {
      emit({ phase: 'prior', status: 'running' });
      let found = [];
      try { found = await retrieve(request); } catch (err) { degraded.push(`the search for existing work failed (${err.message})`); }
      const seen = new Set();
      for (const s of found || []) if (s?.url && !seen.has(s.url)) { seen.add(s.url); prior.push({ title: s.title || s.url, url: s.url, content: s.content || '' }); }
      prior = prior.slice(0, MAX_PRIOR);
      phases.push({ phase: 'prior', model: null, status: prior.length ? 'ok' : 'failed', ms: 0, note: `${prior.length} pages` });
      emit({ phase: 'prior', status: 'done', note: `${prior.length} pages` });
    }

    // 2. Rounds of Verbalized Sampling, one after another: each round sees the titles of the earlier ones.
    let ideas = [];
    const rounds = [], seen = new Set();
    for (let round = 1; round <= plan.rounds; round++) {
      const r = await step('generate', { round, k: IDEAS_PER_ROUND, tail: TAIL, nTail: TAIL_PER_ROUND, previous: ideas, prior }, `round ${round}`);
      if (r.fatal) return fail(r.errors[0] || 'the provider refused the request', { fatal: true, status: r.status });
      if (!r.ok) { degraded.push(`round ${round} gave no ideas (${r.errors.at(-1) || 'no answer'})`); continue; }
      const got = normalizeIdeas(r.data, round, seen);
      const tail = got.filter(i => i.probability != null && i.probability < TAIL).length;
      if (tail < TAIL_PER_ROUND) degraded.push(`round ${round} has ${tail} rare idea${tail === 1 ? '' : 's'} (asked for ${TAIL_PER_ROUND})`);
      rounds.push({ round, ideas: got.length, tail });
      ideas = ideas.concat(got);
      emit({ phase: 'generate', status: 'preview', ideas });
    }
    if (!ideas.length) return fail('no round gave a usable idea');

    // 3. Merge, theme and score. Without it the ideas stay one unscored list.
    let themes = [{ theme: '', ids: ideas.map(i => i.id) }];
    const c = await step('cluster', { ideas, prior });
    if (c.fatal) return fail(c.errors[0], { fatal: true, status: c.status });
    if (c.ok) {
      const applied = applyClusters(c.data, ideas, prior);
      if (applied.themes.length) {
        ({ themes, ideas } = applied);
        if (applied.unscored) degraded.push(`${applied.unscored} idea${applied.unscored === 1 ? ' was' : 's were'} not scored`);
      } else degraded.push('the scoring named none of the ideas: they are not ranked');
    } else degraded.push('the ideas could not be scored: they are not ranked');
    emit({ phase: 'cluster', status: 'preview', ideas, themes });

    // 4. Develop the picked ideas (Balanced, Quality); Speed goes to the synthesis with the best ideas as they are.
    const picked = pickIdeas(ideas, themes, plan.develop || 3);
    let developed = 0;
    if (plan.develop) {
      const d = await step('develop', { ideas: picked });
      if (d.fatal) return fail(d.errors[0], { fatal: true, status: d.status });
      if (!d.ok) degraded.push('the ideas could not be developed: the synthesis works from the ideas alone');
      for (const dev of Array.isArray(d.data?.developments) ? d.data.developments : []) {
        const idea = picked.find(i => i.id === text(dev?.id));
        if (!idea || idea.development) continue;
        idea.development = { use_case: text(dev.use_case), steps: strings(dev.steps), risks: strings(dev.risks), success: strings(dev.success) };
        developed++;
      }
      if (d.ok && developed < picked.length) degraded.push(`${picked.length - developed} of ${picked.length} picked ideas were not developed`);
    }

    // 5. Synthesis: a recommendation that points at ideas of this run only.
    let synthesis = null;
    const s = await step('synthesis', { ideas: picked, themes: themes.map(t => t.theme).filter(Boolean) });
    if (s.fatal) return fail(s.errors[0], { fatal: true, status: s.status });
    if (s.ok) {
      const known = new Set(picked.map(i => i.id));
      synthesis = {
        recommended: strings(s.data.recommended).filter(id => known.has(id)),
        recommendation: text(s.data.recommendation),
        insights: strings(s.data.insights),
        plan: (Array.isArray(s.data.plan) ? s.data.plan : []).map(p => (typeof p === 'string' ? { action: text(p) } : { action: text(p?.action), when: text(p?.when), go_if: text(p?.go_if), fallback: text(p?.fallback) })).filter(p => p.action),
        open_questions: strings(s.data.open_questions),
        riskiest_assumption: text(s.data.riskiest_assumption),
        likely_bias: text(s.data.likely_bias),
        uncertainty: text(s.data.uncertainty),
      };
      if (!synthesis.recommendation) { degraded.push('the synthesis gave no recommendation'); synthesis = null; }
    } else degraded.push('the synthesis failed: the ideas are shown without a recommendation');

    // Text for people: ideas named by title, not by id (a live synthesis wrote "R1I1 and R2I4"), and the Greek
    // spelling repairs of the article pipeline (Latin look-alike letters, the dropped final ν).
    const titles = new Map(ideas.map(i => [i.id, i.title]));
    const fix = (s) => {
      const named = s.replace(/\bR\d+I\d+\b/g, (id) => titles.get(id) || id);
      return lang === 'el' ? repairFinalNu(repairHomoglyphs(named).text).text : named;
    };
    const tidy = (v) => (typeof v === 'string' ? fix(v) : Array.isArray(v) ? v.map(tidy)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, KEEP.has(k) ? x : tidy(x)])) : v);

    emit({ phase: 'done', status: 'done' });
    return { ok: true, request, language: lang, mode, prior, rounds, ideas: tidy(ideas), themes: tidy(themes), picked: picked.map(i => i.id), synthesis: tidy(synthesis), phases, degraded, calls, cost, ms: now() - t0 };
  };
}

#!/usr/bin/env node
// Live trial of text models for `vane --article`: each candidate writes a short article in English and
// in Greek with the real draft prompt, and answers the query-writing prompt as JSON. A model passes a
// language when its article clears judgeTrialDraft (not cut off, no leaked reasoning, right language,
// valid citations, no Latin letters in Greek words). Results go to cli/write/trial.json, which
// selectChains() reads: only models that passed can be in a default chain.
//
//   node scripts/article-trial.mjs --key-from-vane [--dry] [--budget 1.5] [--per-lab 2] [--max 40] [--only a/x,b/y]
//
// Needs OPENROUTER_API_KEY or --key-from-vane (the key of Vane's OpenRouter provider; never printed).
// Every candidate is 3 paid calls, so --dry prints the candidates and the cost estimate and stops.
//
//   node scripts/article-trial.mjs --free [--dry] [--only free:a,free:b] [--concurrency 2]
//
// --free tries the models freellmapi can serve now (Vane's provider with a freellmapi- key) instead, at no cost.
// They are saved as free:<id> and ranked by selectFreeChains; a model with a call that got no answer (rate limit,
// timeout: freellmapi's quotas, not the model's writing) is not saved, so a later run tries it again.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { DEFAULTS } from '../cli/vane.mjs';
import { OpenRouterError, createOpenRouterClient, findOpenRouterKey, fromHost, modelClientFor } from '../cli/image/openrouter.mjs';
import { buildTextCatalogue, freeTrialCandidates, judgeTrialDraft, judgeTrialJson, trialCandidates } from '../cli/write/catalogue.mjs';
import { REASONING } from '../cli/write/models.mjs';
import { prompts } from '../cli/write/prompts.mjs';

const TRIAL_FILE = fileURLToPath(new URL('../cli/write/trial.json', import.meta.url));
// A topic that invites stock phrases ("a beacon of hope", "the future of energy"), sources full of numbers
// (a model that invents or bends one is caught by judgeTrialDraft's score) and one that disagrees with another.
const SOURCES = [
  { title: 'Tidal energy in Orkney', url: 'https://example.org/orkney', content: 'The Orkney test site supplied about 1,200 homes in 2023 and produced 2 TWh since 2016. Turbines sit on the seabed at 35 metres and are serviced by boat. The site employs 46 people in Stromness.' },
  { title: 'Costs of marine power', url: 'https://example.org/costs', content: 'Costs fell by 40% between 2015 and 2023, to about 180 pounds per megawatt hour, but remain above onshore wind at 50 pounds. Tides are predictable twice a day, which grid operators value.' },
  { title: 'Environmental effects', url: 'https://example.org/effects', content: 'Five years of monitoring found no change in local seal numbers. Noise from turbines is low. Seabirds that dive near turbines were tracked; 3 collisions were recorded.' },
  { title: 'A sceptical view', url: 'https://example.org/sceptic', content: 'Critics say subsidies of 211 pounds per megawatt hour in the 2022 auction show tidal power is still far from competitive, and that only 10 MW were built in Scotland in a decade.' },
];
const TOPICS = { en: 'whether tidal power has a future in Orkney', el: 'αν η παλιρροϊκή ενέργεια έχει μέλλον στις Ορκάδες' };
const TARGET_WORDS = 350; // long enough for sentence rhythm and stock phrases to show (the first trial used 150)
const MAX_TOKENS = 12000; // room for models that think before they write

const { values } = parseArgs({
  options: {
    'key-from-vane': { type: 'boolean', default: false },
    free: { type: 'boolean', default: false },
    dry: { type: 'boolean', default: false },
    budget: { type: 'string', default: '1.5' },
    'per-lab': { type: 'string', default: '2' },
    max: { type: 'string', default: '40' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '5' },
  },
});

const vaneProviders = async () => (await (await fetch(`${DEFAULTS.url}/api/config`, { signal: AbortSignal.timeout(10_000) })).json()).values?.modelProviders || [];

async function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (!values['key-from-vane']) throw new Error('Set OPENROUTER_API_KEY or pass --key-from-vane.');
  const key = findOpenRouterKey(await vaneProviders());
  if (!key) throw new Error(`No Vane provider with an OpenRouter Base URL and an API key at ${DEFAULTS.url}.`);
  return key;
}

// Rough cost of one candidate: two 350-word articles and a short JSON answer; thinking models spend more tokens.
const estimate = (m) => (m.priceOut * (m.reasoning ? 2 * 3500 + 800 : 2 * 1100 + 150) + m.priceIn * 3 * 1500) / 1e6;

async function ask(client, model, { system, user }, { json = false } = {}) {
  const started = Date.now();
  try {
    const res = await client.chat({
      model: model.id,
      max_tokens: MAX_TOKENS,
      temperature: json ? 0.2 : 0.7,
      usage: { include: true },
      reasoning: REASONING,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }, 150_000);
    const choice = res?.choices?.[0];
    const c = choice?.message?.content;
    const text = (Array.isArray(c) ? c.map(p => p?.text || '').join('') : String(c ?? '')).replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '').trim();
    return { text, finish: choice?.finish_reason || 'stop', ms: Date.now() - started, cost: Number(res?.usage?.cost) || 0 };
  } catch (err) {
    if (err instanceof OpenRouterError && [401, 402].includes(err.status)) throw err;
    return { text: '', finish: 'error', error: String(err.message || err).slice(0, 140), ms: Date.now() - started, cost: 0 };
  }
}

async function trialOne(client, model) {
  const out = { price: { in: model.priceIn, out: model.priceOut } };
  let cost = 0, errors = 0;
  for (const lang of ['en', 'el']) {
    const r = await ask(client, model, prompts.draft({ topic: TOPICS[lang], lang, words: TARGET_WORDS, sources: SOURCES, outline: null }));
    cost += r.cost;
    if (r.error || r.finish === 'error') errors++;
    const verdict = r.error ? { ok: false, problems: [r.error], words: 0, tellsPerThousand: null } : judgeTrialDraft(r.text, { lang, sources: SOURCES, finish: r.finish, target: TARGET_WORDS });
    out[lang] = { ...verdict, ms: r.ms };
  }
  const j = await ask(client, model, prompts.queries({ topic: TOPICS.en, lang: 'en' }), { json: true });
  cost += j.cost;
  if (j.error || j.finish === 'error') errors++;
  out.json = { ...(j.error ? { ok: false, problems: [j.error] } : judgeTrialJson(j.text, j.finish)), ms: j.ms };
  out.cost = Math.round(cost * 1e5) / 1e5;
  return { out, unanswered: errors > 0 };
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { for (let m = queue.shift(); m; m = queue.shift()) await fn(m); }));
}

const only = values.only ? new Set(values.only.split(',').map(s => s.trim())) : null;
let client, candidates;
if (values.free) {
  client = modelClientFor(await vaneProviders(), { freeBaseUrl: fromHost });
  if (!client?.freeLlm) throw new Error(`No Vane provider with a freellmapi- key at ${DEFAULTS.url}.`);
  candidates = freeTrialCandidates(await client.freeReady()).filter(id => !only || only.has(id)).map(id => ({ id, priceIn: 0, priceOut: 0 }));
  console.log(`${candidates.length} free models freellmapi can serve now`);
  for (const m of candidates) console.log(`  ${m.id}`);
  if (values.dry) process.exit(0);
} else {
  const catalogue = buildTextCatalogue((await createOpenRouterClient().models()));
  candidates = only ? catalogue.filter(m => only.has(m.id)) : trialCandidates(catalogue, { perLab: Number(values['per-lab']), max: Number(values.max) });
  const budget = Number(values.budget);
  while (candidates.length > 1 && candidates.reduce((s, m) => s + estimate(m), 0) > budget) {
    const dearest = candidates.reduce((a, b) => (estimate(b) > estimate(a) ? b : a));
    candidates = candidates.filter(m => m !== dearest);
  }
  const total = candidates.reduce((s, m) => s + estimate(m), 0);
  console.log(`${candidates.length} candidates of ${catalogue.length} usable text models; estimated cost $${total.toFixed(2)} (budget $${budget.toFixed(2)})`);
  for (const m of candidates) console.log(`  ${m.id.padEnd(46)} $${m.priceIn}/${m.priceOut} per M tokens${m.reasoning ? '  thinks' : ''}`);
  if (values.dry) process.exit(0);
  client = createOpenRouterClient({ apiKey: await apiKey() });
}

let saved = { models: {} };
try { saved = JSON.parse(await readFile(TRIAL_FILE, 'utf8')); } catch { /* first run */ }
let spent = 0;
try {
  await pool(candidates, Number(values.concurrency), async (m) => {
    const { out: r, unanswered } = await trialOne(client, m);
    if (unanswered && values.free) return console.log(`${m.id.padEnd(46)} not saved: a call got no answer (${[r.en, r.el, r.json].flatMap(x => x.problems || []).find(p => /^[1-5]\d\d [A-Z]/.test(p)) || 'no status'})`);
    spent += r.cost;
    saved.models[m.id] = r;
    const mark = (x) => (x.ok ? 'ok  ' : 'FAIL');
    const problems = [...new Set([r.en, r.el, r.json].flatMap(x => x.problems || []))];
    console.log(`${m.id.padEnd(46)} en ${mark(r.en)} el ${mark(r.el)} json ${mark(r.json)}  score ${r.en.score ?? '-'}/${r.el.score ?? '-'}  $${r.cost.toFixed(4)}${problems.length ? `  (${problems.join('; ')})` : ''}`);
  });
} finally {
  saved.updated = new Date().toISOString().slice(0, 10);
  await writeFile(TRIAL_FILE, `${JSON.stringify(saved, null, 1)}\n`);
  console.log(`\nspent $${spent.toFixed(4)}; wrote ${TRIAL_FILE}`);
}

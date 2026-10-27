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
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { DEFAULTS } from '../cli/vane.mjs';
import { OpenRouterError, createOpenRouterClient, findOpenRouterKey } from '../cli/image/openrouter.mjs';
import { buildTextCatalogue, judgeTrialDraft, judgeTrialJson, trialCandidates } from '../cli/write/catalogue.mjs';
import { REASONING } from '../cli/write/models.mjs';
import { prompts } from '../cli/write/prompts.mjs';

const TRIAL_FILE = fileURLToPath(new URL('../cli/write/trial.json', import.meta.url));
const SOURCES = [
  { title: 'Tidal energy in Orkney', url: 'https://example.org/orkney', content: 'The Orkney test site supplied about 1,200 homes in 2023 and produced 2 TWh. Turbines sit on the seabed and are serviced by boat.' },
  { title: 'Costs of marine power', url: 'https://example.org/costs', content: 'Costs fell by 40% between 2015 and 2023, but remain above onshore wind. Tides are predictable twice a day.' },
  { title: 'Environmental effects', url: 'https://example.org/effects', content: 'Monitoring found no change in local seal numbers. Noise from turbines is low.' },
];
const TOPICS = { en: 'tidal power in Orkney', el: 'η παλιρροϊκή ενέργεια στις Ορκάδες' };
const MAX_TOKENS = 12000; // room for models that think before they write

const { values } = parseArgs({
  options: {
    'key-from-vane': { type: 'boolean', default: false },
    dry: { type: 'boolean', default: false },
    budget: { type: 'string', default: '1.5' },
    'per-lab': { type: 'string', default: '2' },
    max: { type: 'string', default: '40' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '5' },
  },
});

async function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (!values['key-from-vane']) throw new Error('Set OPENROUTER_API_KEY or pass --key-from-vane.');
  const res = await fetch(`${DEFAULTS.url}/api/config`, { signal: AbortSignal.timeout(10_000) });
  const key = findOpenRouterKey((await res.json()).values?.modelProviders);
  if (!key) throw new Error(`No Vane provider with an OpenRouter Base URL and an API key at ${DEFAULTS.url}.`);
  return key;
}

// Rough cost of one candidate: two 150-word articles and a short JSON answer; thinking models spend more tokens.
const estimate = (m) => (m.priceOut * (m.reasoning ? 2 * 3000 + 800 : 2 * 450 + 150) + m.priceIn * 3 * 1200) / 1e6;

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
  let cost = 0;
  for (const lang of ['en', 'el']) {
    const r = await ask(client, model, prompts.draft({ topic: TOPICS[lang], lang, words: 150, sources: SOURCES, outline: null }));
    cost += r.cost;
    const verdict = r.error ? { ok: false, problems: [r.error], words: 0, tellsPerThousand: null } : judgeTrialDraft(r.text, { lang, sources: SOURCES, finish: r.finish });
    out[lang] = { ...verdict, ms: r.ms };
  }
  const j = await ask(client, model, prompts.queries({ topic: TOPICS.en, lang: 'en' }), { json: true });
  cost += j.cost;
  out.json = { ...(j.error ? { ok: false, problems: [j.error] } : judgeTrialJson(j.text, j.finish)), ms: j.ms };
  out.cost = Math.round(cost * 1e5) / 1e5;
  return out;
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { for (let m = queue.shift(); m; m = queue.shift()) await fn(m); }));
}

const catalogue = buildTextCatalogue((await createOpenRouterClient().models()));
const only = values.only ? new Set(values.only.split(',').map(s => s.trim())) : null;
let candidates = only ? catalogue.filter(m => only.has(m.id)) : trialCandidates(catalogue, { perLab: Number(values['per-lab']), max: Number(values.max) });
const budget = Number(values.budget);
while (candidates.length > 1 && candidates.reduce((s, m) => s + estimate(m), 0) > budget) {
  const dearest = candidates.reduce((a, b) => (estimate(b) > estimate(a) ? b : a));
  candidates = candidates.filter(m => m !== dearest);
}
const total = candidates.reduce((s, m) => s + estimate(m), 0);
console.log(`${candidates.length} candidates of ${catalogue.length} usable text models; estimated cost $${total.toFixed(2)} (budget $${budget.toFixed(2)})`);
for (const m of candidates) console.log(`  ${m.id.padEnd(46)} $${m.priceIn}/${m.priceOut} per M tokens${m.reasoning ? '  thinks' : ''}`);
if (values.dry) process.exit(0);

const client = createOpenRouterClient({ apiKey: await apiKey() });
let saved = { models: {} };
try { saved = JSON.parse(await readFile(TRIAL_FILE, 'utf8')); } catch { /* first run */ }
let spent = 0;
try {
  await pool(candidates, Number(values.concurrency), async (m) => {
    const r = await trialOne(client, m);
    spent += r.cost;
    saved.models[m.id] = r;
    const mark = (x) => (x.ok ? 'ok  ' : 'FAIL');
    const problems = [...new Set([r.en, r.el, r.json].flatMap(x => x.problems || []))];
    console.log(`${m.id.padEnd(46)} en ${mark(r.en)} el ${mark(r.el)} json ${mark(r.json)}  tells ${r.en.tellsPerThousand ?? '-'}/${r.el.tellsPerThousand ?? '-'}  $${r.cost.toFixed(4)}${problems.length ? `  (${problems.join('; ')})` : ''}`);
  });
} finally {
  saved.updated = new Date().toISOString().slice(0, 10);
  await writeFile(TRIAL_FILE, `${JSON.stringify(saved, null, 1)}\n`);
  console.log(`\nspent $${spent.toFixed(4)}; wrote ${TRIAL_FILE}`);
}

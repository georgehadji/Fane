// What the model trials share (scripts/article-trial.mjs, scripts/code-trial.mjs): the options, the key, the
// candidates (OpenRouter's catalogue cut to the budget, or with --free what freellmapi can serve now), one call
// to a model, and the run that saves every result to trial.json as it lands.
import { readFile, writeFile } from 'node:fs/promises';

import { DEFAULTS } from '../cli/vane.mjs';
import { getModelProviders } from '../cli/client.mjs';
import { OpenRouterError, createOpenRouterClient, findOpenRouterKey, fromHost, modelClientFor } from '../cli/image/openrouter.mjs';
import { freeTrialCandidates } from '../cli/write/catalogue.mjs';
import { REASONING } from '../cli/write/models.mjs';

export const TRIAL_OPTIONS = {
  'key-from-vane': { type: 'boolean', default: false },
  free: { type: 'boolean', default: false },
  dry: { type: 'boolean', default: false },
  budget: { type: 'string', default: '1.5' },
  'per-lab': { type: 'string', default: '2' },
  max: { type: 'string', default: '40' },
  only: { type: 'string' },
  concurrency: { type: 'string', default: '5' },
};

const MAX_TOKENS = 12000; // room for models that think before they write

const vaneProviders = () => getModelProviders(DEFAULTS.url);

// OPENROUTER_API_KEY, or with fromVane the key of Vane's OpenRouter provider (never printed).
export async function apiKey(fromVane) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (!fromVane) throw new Error('Set OPENROUTER_API_KEY or pass --key-from-vane.');
  const key = findOpenRouterKey(await vaneProviders());
  if (!key) throw new Error(`No Vane provider with an OpenRouter Base URL and an API key at ${DEFAULTS.url}.`);
  return key;
}

// The models to try and the client to try them with. paid(only) -> { catalogue, candidates } from OpenRouter's
// catalogue; estimate(model) is a candidate's rough cost, and the dearest are dropped until the total fits --budget.
// --dry prints the candidates and exits.
export async function pickCandidates(values, { code = false, paid, estimate }) {
  const only = values.only ? new Set(values.only.split(',').map(s => s.trim())) : null;
  if (values.free) {
    const client = modelClientFor(await vaneProviders(), { freeBaseUrl: fromHost });
    if (!client?.freeLlm) throw new Error(`No Vane provider with a freellmapi- key at ${DEFAULTS.url}.`);
    const candidates = freeTrialCandidates(await client.freeReady(), { code }).filter(id => !only || only.has(id)).map(id => ({ id, priceIn: 0, priceOut: 0 }));
    console.log(`${candidates.length} free models freellmapi can serve now`);
    for (const m of candidates) console.log(`  ${m.id}`);
    if (values.dry) process.exit(0);
    return { client, candidates };
  }
  const budget = Number(values.budget);
  if (!(budget >= 0)) throw new Error(`invalid --budget "${values.budget}"`); // NaN would trim nothing
  const { catalogue, candidates: picked } = await paid(only, createOpenRouterClient());
  let candidates = picked;
  while (candidates.length > 1 && candidates.reduce((s, m) => s + estimate(m), 0) > budget) {
    const dearest = candidates.reduce((a, b) => (estimate(b) > estimate(a) ? b : a));
    candidates = candidates.filter(m => m !== dearest);
  }
  const total = candidates.reduce((s, m) => s + estimate(m), 0);
  console.log(`${candidates.length} candidates of ${catalogue.length} usable text models; estimated cost $${total.toFixed(2)} (budget $${budget.toFixed(2)})`);
  for (const m of candidates) console.log(`  ${m.id.padEnd(46)} $${m.priceIn}/${m.priceOut} per M tokens${m.reasoning ? '  thinks' : ''}`);
  if (values.dry) process.exit(0);
  return { client: createOpenRouterClient({ apiKey: await apiKey(values['key-from-vane']) }), candidates };
}

// One call, as the pipelines make it. A failure is a value (finish 'error'), except 401/402, which stop the trial.
export async function ask(client, model, { system, user }, { json = false, temperature = 0.2 } = {}) {
  const started = Date.now();
  try {
    const res = await client.chat({
      model: model.id,
      max_tokens: MAX_TOKENS,
      temperature,
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

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { for (let m = queue.shift(); m; m = queue.shift()) await fn(m); }));
}

// Tries every candidate (trialOne(client, model) -> { out, unanswered }) and saves the results to `file`, also when
// the run stops halfway. parts(out) are the verdicts with `problems`; line(model, out) is the line printed for one.
// A free model with a call that got no answer (rate limit, timeout: freellmapi's quotas, not the model's writing)
// is not saved, so a later run tries it again.
export async function runTrial({ file, values, client, candidates, trialOne, parts, line }) {
  let saved = { models: {} };
  try { saved = JSON.parse(await readFile(file, 'utf8')); } catch { /* first run */ }
  let spent = 0;
  try {
    await pool(candidates, Number(values.concurrency), async (m) => {
      const { out, unanswered } = await trialOne(client, m);
      if (unanswered && values.free) return console.log(`${m.id.padEnd(46)} not saved: a call got no answer (${parts(out).flatMap(x => x.problems || []).find(p => /^[1-5]\d\d [A-Z]/.test(p)) || 'no status'})`);
      spent += out.cost;
      saved.models[m.id] = out;
      const problems = [...new Set(parts(out).flatMap(x => x.problems || []))];
      console.log(`${m.id.padEnd(46)} ${line(m, out)}  $${out.cost.toFixed(4)}${problems.length ? `  (${problems.join('; ')})` : ''}`);
    });
  } finally {
    saved.updated = new Date().toISOString().slice(0, 10);
    await writeFile(file, `${JSON.stringify(saved, null, 1)}\n`);
    console.log(`\nspent $${spent.toFixed(4)}; wrote ${file}`);
  }
}

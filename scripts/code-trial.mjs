#!/usr/bin/env node
// Live trial of text models for `vane --code`: each candidate writes duration.mjs with the real generate prompt
// (cli/code/catalogue.mjs TRIAL_FILE), which must parse and pass the fixed cases (TRIAL_CASES, one miss allowed),
// and answers the spec prompt as JSON. Results go to cli/code/trial.json, which selectCodeChains() reads: only
// models that passed can be in a default chain.
//
//   node scripts/code-trial.mjs --key-from-vane [--dry] [--budget 1.5] [--per-lab 2] [--max 40] [--only a/x,b/y]
//
// The generated function is run, so it runs in its own Node process with the permission model on (no file writes,
// no child processes, no workers, file reads only in its temporary folder) and a 10 s limit. That process can
// still open network connections; the code comes from our fixed prompt, with no web page in it.
// Needs OPENROUTER_API_KEY or --key-from-vane (the key of Vane's OpenRouter provider; never printed).
//
//   node scripts/code-trial.mjs --free [--dry] [--only free:a,free:b] [--concurrency 2]
//
// --free tries the models freellmapi can serve now instead, at no cost (saved as free:<id>, ranked by
// selectFreeCodeChains; a model with a call that got no answer is not saved, so a later run tries it again).
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { DEFAULTS } from '../cli/vane.mjs';
import { OpenRouterError, createOpenRouterClient, findOpenRouterKey, fromHost, modelClientFor } from '../cli/image/openrouter.mjs';
import { freeTrialCandidates, trialCandidates } from '../cli/write/catalogue.mjs';
import { REASONING } from '../cli/write/models.mjs';
import { TRIAL_CASES, TRIAL_FILE, TRIAL_KEY, TRIAL_REQUEST, TRIAL_SPEC, buildCodeCatalogue, judgeTrialCode, judgeTrialSpec } from '../cli/code/catalogue.mjs';
import { extractCode } from '../cli/code/files.mjs';
import { codePrompts } from '../cli/code/prompts.mjs';

const run = promisify(execFile);
const TRIAL_JSON = fileURLToPath(new URL('../cli/code/trial.json', import.meta.url));
const MAX_TOKENS = 12000; // room for models that think before they write
const SPEC_REQUEST = 'Write a command-line tool in Python that counts the words in the text files of a folder and prints the ten most common words.';

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

// Rough cost of one candidate: a ~60-line module and a spec; thinking models spend more tokens.
const estimate = (m) => (m.priceOut * (m.reasoning ? 2 * 3000 : 1500 + 700) + m.priceIn * 2 * 1200) / 1e6;

async function ask(client, model, { system, user }, { json = false } = {}) {
  const started = Date.now();
  try {
    const res = await client.chat({
      model: model.id,
      max_tokens: MAX_TOKENS,
      temperature: 0.2,
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

const HARNESS = `const cases = JSON.parse(process.argv[2]);
let mod;
try { mod = await import('./duration.mjs'); } catch (e) { console.log(JSON.stringify({ loadError: String(e && e.message) })); process.exit(0); }
if (typeof mod.parseDuration !== 'function') { console.log(JSON.stringify({ loadError: 'no parseDuration export' })); process.exit(0); }
const results = cases.map(([input, want]) => {
  try { const got = mod.parseDuration(input); return { ok: typeof want === 'number' && got === want }; }
  catch (e) { return { ok: typeof want === 'string' && e instanceof globalThis[want] }; }
});
console.log(JSON.stringify({ results }));
`;

// Runs the cases against the generated module in a locked-down Node process. -> { results } | { loadError }
async function runCases(code) {
  const dir = await mkdtemp(join(tmpdir(), 'fane-code-trial-'));
  try {
    await writeFile(join(dir, 'duration.mjs'), code);
    await writeFile(join(dir, 'harness.mjs'), HARNESS);
    const flag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
    const { stdout } = await run(process.execPath, [flag, `--allow-fs-read=${dir}`, join(dir, 'harness.mjs'), JSON.stringify(TRIAL_CASES)], { timeout: 10_000, windowsHide: true, maxBuffer: 1 << 20 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } catch (err) {
    return { loadError: err.killed ? 'timed out' : String(err.stderr || err.message).trim().split('\n')[0] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function trialOne(client, model) {
  const out = { price: { in: model.priceIn, out: model.priceOut } };
  const g = await ask(client, model, codePrompts.generate({ text: TRIAL_REQUEST, spec: TRIAL_SPEC, file: TRIAL_FILE, docs: [] }));
  const ran = g.error || g.finish !== 'stop' ? { loadError: g.error || '' } : await runCases(extractCode(g.text));
  out[TRIAL_KEY] = { ...(g.error ? { ok: false, problems: [g.error] } : judgeTrialCode(g.text, { results: ran.results, loadError: ran.loadError, finish: g.finish, ms: g.ms })), ms: g.ms };
  const j = await ask(client, model, codePrompts.spec({ text: SPEC_REQUEST, lang: 'en' }), { json: true });
  out.json = { ...(j.error ? { ok: false, problems: [j.error] } : judgeTrialSpec(j.text, j.finish)), ms: j.ms };
  out.cost = Math.round((g.cost + j.cost) * 1e5) / 1e5;
  return { out, unanswered: [g, j].some(x => x.error || x.finish === 'error') };
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
  candidates = freeTrialCandidates(await client.freeReady(), { code: true }).filter(id => !only || only.has(id)).map(id => ({ id, priceIn: 0, priceOut: 0 }));
  console.log(`${candidates.length} free models freellmapi can serve now`);
  for (const m of candidates) console.log(`  ${m.id}`);
  if (values.dry) process.exit(0);
} else {
  const catalogue = buildCodeCatalogue(await createOpenRouterClient().models());
  // The newest models of each lab, plus the newest code specialist of each lab (they are rarely a lab's newest).
  const SPECIALIST = /(?:^|[/-])(?:code|coder|codex|codestral|devstral)(?:$|[/-])/i;
  const specialists = trialCandidates(catalogue.filter(m => SPECIALIST.test(m.id)), { perLab: 1, max: 10 });
  candidates = only ? catalogue.filter(m => only.has(m.id))
    : [...new Set([...trialCandidates(catalogue, { perLab: Number(values['per-lab']), max: Number(values.max) }), ...specialists])];
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
try { saved = JSON.parse(await readFile(TRIAL_JSON, 'utf8')); } catch { /* first run */ }
let spent = 0;
try {
  await pool(candidates, Number(values.concurrency), async (m) => {
    const { out: r, unanswered } = await trialOne(client, m);
    if (unanswered && values.free) return console.log(`${m.id.padEnd(46)} not saved: a call got no answer (${[r[TRIAL_KEY], r.json].flatMap(x => x.problems || []).find(p => /^[1-5]\d\d [A-Z]/.test(p)) || 'no status'})`);
    spent += r.cost;
    saved.models[m.id] = r;
    const c = r[TRIAL_KEY];
    const problems = [...new Set([c, r.json].flatMap(x => x.problems || []))];
    console.log(`${m.id.padEnd(46)} code ${c.ok ? 'ok  ' : 'FAIL'} ${c.passed ?? '-'}/${c.total ?? '-'} json ${r.json.ok ? 'ok  ' : 'FAIL'}  score ${c.score ?? '-'}  $${r.cost.toFixed(4)}${problems.length ? `  (${problems.join('; ')})` : ''}`);
  });
} finally {
  saved.updated = new Date().toISOString().slice(0, 10);
  await writeFile(TRIAL_JSON, `${JSON.stringify(saved, null, 1)}\n`);
  console.log(`\nspent $${spent.toFixed(4)}; wrote ${TRIAL_JSON}`);
}

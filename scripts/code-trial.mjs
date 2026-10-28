#!/usr/bin/env node
// Live trial of text models for `vane --code`: each candidate writes duration.mjs with the real generate prompt
// (cli/code/catalogue.mjs TRIAL_FILE), which must parse and pass the fixed cases (TRIAL_CASES, one miss allowed),
// and answers the spec prompt as JSON. Results go to cli/code/trial.json, which selectCodeChains() reads: only
// models that passed can be in a default chain.
//
//   node scripts/code-trial.mjs --key-from-vane [--dry] [--budget 1.5] [--per-lab 2] [--max 40] [--only a/x,b/y]
//
// The generated function is run, in a locked-down Node process with an empty environment (scripts/code-sandbox.mjs).
// That process can still open network connections, Vane's /api/config on 127.0.0.1 included: see that file.
// Needs OPENROUTER_API_KEY or --key-from-vane (the key of Vane's OpenRouter provider; never printed).
//
//   node scripts/code-trial.mjs --free [--dry] [--only free:a,free:b] [--concurrency 2]
//
// --free tries the models freellmapi can serve now instead, at no cost (saved as free:<id>, ranked by
// selectFreeCodeChains; a model with a call that got no answer is not saved, so a later run tries it again).
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { trialCandidates } from '../cli/write/catalogue.mjs';
import { TRIAL_CASES, TRIAL_FILE, TRIAL_KEY, TRIAL_REQUEST, TRIAL_SPEC, buildCodeCatalogue, judgeTrialCode, judgeTrialSpec } from '../cli/code/catalogue.mjs';
import { extractCode } from '../cli/code/files.mjs';
import { codePrompts } from '../cli/code/prompts.mjs';
import { runCases } from './code-sandbox.mjs';
import { TRIAL_OPTIONS, ask, pickCandidates, runTrial } from './trial-lib.mjs';

const TRIAL_JSON = fileURLToPath(new URL('../cli/code/trial.json', import.meta.url));
const SPEC_REQUEST = 'Write a command-line tool in Python that counts the words in the text files of a folder and prints the ten most common words.';
// The newest models of each lab, plus the newest code specialist of each lab (they are rarely a lab's newest).
const SPECIALIST = /(?:^|[/-])(?:code|coder|codex|codestral|devstral)(?:$|[/-])/i;

const { values } = parseArgs({ options: TRIAL_OPTIONS });

// Rough cost of one candidate: a ~60-line module and a spec; thinking models spend more tokens.
const estimate = (m) => (m.priceOut * (m.reasoning ? 2 * 3000 : 1500 + 700) + m.priceIn * 2 * 1200) / 1e6;

async function trialOne(client, model) {
  const out = { price: { in: model.priceIn, out: model.priceOut } };
  const g = await ask(client, model, codePrompts.generate({ text: TRIAL_REQUEST, spec: TRIAL_SPEC, file: TRIAL_FILE, docs: [] }));
  const ran = g.error || g.finish !== 'stop' ? { loadError: g.error || '' } : await runCases(extractCode(g.text), TRIAL_CASES);
  out[TRIAL_KEY] = { ...(g.error ? { ok: false, problems: [g.error] } : judgeTrialCode(g.text, { results: ran.results, loadError: ran.loadError, finish: g.finish, ms: g.ms })), ms: g.ms };
  const j = await ask(client, model, codePrompts.spec({ text: SPEC_REQUEST, lang: 'en' }), { json: true });
  out.json = { ...(j.error ? { ok: false, problems: [j.error] } : judgeTrialSpec(j.text, j.finish)), ms: j.ms };
  out.cost = Math.round((g.cost + j.cost) * 1e5) / 1e5;
  return { out, unanswered: [g, j].some(x => x.error || x.finish === 'error') };
}

const { client, candidates } = await pickCandidates(values, {
  code: true,
  estimate,
  paid: async (only, catalogueClient) => {
    const catalogue = buildCodeCatalogue(await catalogueClient.models());
    const specialists = trialCandidates(catalogue.filter(m => SPECIALIST.test(m.id)), { perLab: 1, max: 10 });
    return { catalogue, candidates: only ? catalogue.filter(m => only.has(m.id))
      : [...new Set([...trialCandidates(catalogue, { perLab: Number(values['per-lab']), max: Number(values.max) }), ...specialists])] };
  },
});
await runTrial({
  file: TRIAL_JSON, values, client, candidates, trialOne,
  parts: (r) => [r[TRIAL_KEY], r.json],
  line: (m, r) => { const c = r[TRIAL_KEY]; return `code ${c.ok ? 'ok  ' : 'FAIL'} ${c.passed ?? '-'}/${c.total ?? '-'} json ${r.json.ok ? 'ok  ' : 'FAIL'}  score ${c.score ?? '-'}`; },
});

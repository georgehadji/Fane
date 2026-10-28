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
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { buildTextCatalogue, judgeTrialDraft, judgeTrialJson, trialCandidates } from '../cli/write/catalogue.mjs';
import { prompts } from '../cli/write/prompts.mjs';
import { TRIAL_OPTIONS, ask, pickCandidates, runTrial } from './trial-lib.mjs';

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

const { values } = parseArgs({ options: TRIAL_OPTIONS });

// Rough cost of one candidate: two 350-word articles and a short JSON answer; thinking models spend more tokens.
const estimate = (m) => (m.priceOut * (m.reasoning ? 2 * 3500 + 800 : 2 * 1100 + 150) + m.priceIn * 3 * 1500) / 1e6;

async function trialOne(client, model) {
  const out = { price: { in: model.priceIn, out: model.priceOut } };
  let cost = 0, errors = 0;
  for (const lang of ['en', 'el']) {
    const r = await ask(client, model, prompts.draft({ topic: TOPICS[lang], lang, words: TARGET_WORDS, sources: SOURCES, outline: null }), { temperature: 0.7 });
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

const { client, candidates } = await pickCandidates(values, {
  estimate,
  paid: async (only, catalogueClient) => {
    const catalogue = buildTextCatalogue(await catalogueClient.models());
    return { catalogue, candidates: only ? catalogue.filter(m => only.has(m.id)) : trialCandidates(catalogue, { perLab: Number(values['per-lab']), max: Number(values.max) }) };
  },
});
const mark = (x) => (x.ok ? 'ok  ' : 'FAIL');
await runTrial({
  file: TRIAL_FILE, values, client, candidates, trialOne,
  parts: (r) => [r.en, r.el, r.json],
  line: (m, r) => `en ${mark(r.en)} el ${mark(r.el)} json ${mark(r.json)}  score ${r.en.score ?? '-'}/${r.el.score ?? '-'}`,
});

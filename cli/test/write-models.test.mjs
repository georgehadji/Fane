import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FALLBACKS_PER_ROLE, blend, buildTextCatalogue, judgeTrialDraft, judgeTrialJson, selectChains, toTextModel, trialCandidates } from '../write/catalogue.mjs';
import { ROLES } from '../write/models.mjs';

for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { parseCli } = await import('../vane.mjs');

const entry = (id, { pin = '0.000001', pout = '0.000004', ctx = 200000, out = ['text'], params = ['response_format', 'reasoning'], created = 1_790_000_000, ...rest } = {}) =>
  ({ id, name: id, created, context_length: ctx, architecture: { output_modalities: out }, pricing: { prompt: pin, completion: pout }, supported_parameters: params, ...rest });

test('toTextModel keeps writing models and prices them per million tokens', () => {
  const m = toTextModel(entry('anthropic/claude-x'));
  assert.deepEqual([m.id, m.lab, m.priceIn, m.priceOut, m.json, m.reasoning], ['anthropic/claude-x', 'anthropic', 1, 4, true, true]);
  assert.equal(blend({ priceIn: 1, priceOut: 4 }), 3.25);
  assert.equal(toTextModel(entry('a/b', { params: [] })).json, false);
});

test('toTextModel drops free, batch, alias, unpriced, non-text, specialist, short and expired entries', () => {
  const NOW = Date.parse('2026-10-27');
  for (const bad of [
    entry('a/b:free'), entry('a/b:batch'), entry('~a/latest'), entry('a/b', { pin: '-1', pout: '-1' }), entry('a/b', { pin: '0', pout: '0' }),
    entry('a/b', { out: ['text', 'image'] }), entry('a/qwen-vl'), entry('a/model-coder'), entry('a/jev-router'), entry('a/summarize'), entry('a/b', { ctx: 8000 }),
    entry('a/b', { expiration_date: '2026-01-01' }), entry('nolab'),
  ]) assert.equal(toTextModel(bad, { now: NOW }), null, bad.id);
  assert.ok(toTextModel(entry('a/b', { expiration_date: '2027-01-01' }), { now: NOW }));
});

test('trialCandidates takes the newest few of each lab, capped overall', () => {
  const cat = buildTextCatalogue([...Array.from({ length: 5 }, (_, i) => entry(`a/m${i}`, { created: 100 + i })), entry('b/m0', { created: 50 }), entry('c/m0', { created: 60 })]);
  const c = trialCandidates(cat, { perLab: 2, max: 10 });
  assert.deepEqual(c.map(m => m.id).sort(), ['a/m3', 'a/m4', 'b/m0', 'c/m0']);
  assert.equal(trialCandidates(cat, { perLab: 2, max: 2 }).length, 2);
});

// 9 models: three labs at three prices each
const LABS = ['alpha', 'beta', 'gamma'];
const catalogue = buildTextCatalogue(LABS.flatMap((lab, li) => [1, 2, 3].map(level => entry(`${lab}/m${level}`, { pin: String(level * 1e-6), pout: String(level * 4e-6 + li * 1e-8), created: 1_790_000_000 + li }))));
const passing = (tells = 3) => ({ ok: true, tellsPerThousand: tells });
const trialAll = Object.fromEntries(catalogue.map(m => [m.id, { en: passing(), el: passing(), json: { ok: true } }]));

test('selectChains: each mode takes its price band, every role has a chain, no chain repeats a model', () => {
  const speed = selectChains(catalogue, trialAll, { mode: 'speed' });
  const quality = selectChains(catalogue, trialAll, { mode: 'quality' });
  assert.deepEqual(speed.band.map(id => id.split('/')[1]), ['m1', 'm1', 'm1']);
  assert.deepEqual(quality.band.map(id => id.split('/')[1]), ['m3', 'm3', 'm3']);
  assert.deepEqual(selectChains(catalogue, trialAll, { mode: 'balanced' }).band.map(id => id.split('/')[1]), ['m2', 'm2', 'm2']);
  for (const role of ROLES) {
    const chain = speed.chains[role];
    assert.ok(chain.length >= 1 && chain.length <= 1 + FALLBACKS_PER_ROLE, role);
    assert.equal(new Set(chain).size, chain.length, `${role} repeats a model`);
  }
  assert.ok(speed.chains.draft[0].endsWith('/m1')); // primary from the cheapest band
});

test('selectChains: fallbacks stay inside the mode\'s price band while the band has enough models', () => {
  const many = buildTextCatalogue(Array.from({ length: 12 }, (_, i) => entry(`lab${i % 6}/m${i}`, { pin: String((i + 1) * 1e-6), pout: String((i + 1) * 4e-6) })));
  const trial = Object.fromEntries(many.map(m => [m.id, { en: passing(), el: passing(), json: { ok: true } }]));
  for (const mode of ['speed', 'balanced', 'quality']) {
    const { chains, band } = selectChains(many, trial, { mode });
    for (const role of ['draft', 'critique', 'revise', 'outline', 'copy']) assert.ok(chains[role].every(id => band.includes(id)), `${mode} ${role}`);
  }
});

test('selectChains: neighbouring roles get different labs when the band allows', () => {
  const { chains } = selectChains(catalogue, trialAll, { mode: 'balanced' });
  const lab = (role) => chains[role][0].split('/')[0];
  assert.notEqual(lab('draft'), lab('critique'));
  assert.notEqual(lab('critique'), lab('factcheck'));
  assert.equal(new Set(['draft', 'critique', 'factcheck'].map(lab)).size, 3);
});

test('selectChains: only models that passed the trial for the language; none means null', () => {
  assert.equal(selectChains(catalogue, {}, { mode: 'speed' }), null);
  const trial = { ...trialAll };
  for (const id of Object.keys(trial)) if (id.startsWith('gamma/')) trial[id] = { ...trial[id], el: { ok: false } };
  const el = selectChains(catalogue, trial, { mode: 'quality', lang: 'el' });
  const used = new Set(Object.values(el.chains).flat());
  assert.ok([...used].every(id => !id.startsWith('gamma/')));
  const en = selectChains(catalogue, trial, { mode: 'quality', lang: 'en' });
  assert.ok(Object.values(en.chains).flat().some(id => id.startsWith('gamma/')));
});

test('selectChains: JSON roles use only models that answered the JSON trial; the better writers come first', () => {
  const trial = { ...trialAll };
  trial['alpha/m1'] = { en: passing(1), el: passing(1), json: { ok: false } };
  trial['beta/m1'] = { en: passing(9), el: passing(9), json: { ok: true } };
  trial['gamma/m1'] = { en: passing(5), el: passing(5), json: { ok: true } };
  const { chains } = selectChains(catalogue, trial, { mode: 'speed' });
  for (const role of ['outline', 'factcheck', 'critique', 'audit', 'queries']) assert.ok(!chains[role].includes('alpha/m1'), role);
  assert.equal(chains.draft[0], 'alpha/m1'); // fewest stock phrases writes the draft
  assert.deepEqual(chains.queries.map(id => id.split('/')[1]), ['m1', 'm1']); // the two cheapest that answer JSON
});

test('selectChains copes with a pool smaller than a band', () => {
  const one = selectChains(catalogue.slice(0, 1), { [catalogue[0].id]: trialAll[catalogue[0].id] }, { mode: 'quality' });
  assert.deepEqual(one.chains.draft, [catalogue[0].id]);
  assert.deepEqual(one.chains.queries, [catalogue[0].id]);
});

const SRC = [{ title: 't', url: 'https://x.org/1', content: 'c' }, { title: 'u', url: 'https://x.org/2', content: 'd' }];
const words = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}${i % 7}`).join(' ');

test('judgeTrialDraft passes a clean article and names what failed otherwise', () => {
  const en = `# Title\n\n${words(60, 'tide')}. ${words(50, 'wave')} [1]. ${words(10, 'sea')} [2].`;
  assert.deepEqual(judgeTrialDraft(en, { lang: 'en', sources: SRC }).problems, []);
  assert.match(judgeTrialDraft(en, { lang: 'en', sources: SRC, finish: 'length' }).problems[0], /finish_reason length/);
  assert.match(judgeTrialDraft(`Thinking Process: x\n${en}`, { lang: 'en', sources: SRC }).problems.join(), /reasoning/);
  assert.match(judgeTrialDraft(en.replace(/\[\d\]/g, ''), { lang: 'en', sources: SRC }).problems.join(), /no citations/);
  assert.match(judgeTrialDraft(`${en} [7]`, { lang: 'en', sources: SRC }).problems.join(), /source 7/);
  assert.match(judgeTrialDraft('too short [1]', { lang: 'en', sources: SRC }).problems.join(), /words/);
  assert.match(judgeTrialDraft(en, { lang: 'el', sources: SRC }).problems.join(), /not written in Greek/);
  const el = `# Τίτλος\n\n${Array.from({ length: 90 }, () => 'παλίρροια').join(' ')} [1].`;
  assert.equal(judgeTrialDraft(el, { lang: 'el', sources: SRC }).ok, true);
  assert.match(judgeTrialDraft(el.replace('παλίρροια', 'παλίρροιa'), { lang: 'el', sources: SRC }).problems.join(), /Latin letters/);
  assert.match(judgeTrialDraft(el, { lang: 'en', sources: SRC }).problems.join(), /not written in English/);
});

test('judgeTrialJson wants a queries array', () => {
  assert.equal(judgeTrialJson('{"queries": ["a", "b", "c"]}').ok, true);
  assert.equal(judgeTrialJson('```json\n{"queries": ["a", "b"]}\n```').ok, true);
  assert.equal(judgeTrialJson('{"queries": ["a"]}').ok, false);
  assert.equal(judgeTrialJson('sure!').ok, false);
  assert.equal(judgeTrialJson('{"queries": ["a", "b"]}', 'length').ok, false);
});

test('parseCli accepts --list-article-models with a mode and a language', () => {
  const o = parseCli(['--list-article-models', '-o', 'quality', '--lang', 'el']);
  assert.deepEqual([o['list-article-models'], o.mode, o.lang], [true, 'quality', 'el']);
  assert.throws(() => parseCli(['--list-article-models', '--lang', 'fr']), /Invalid --lang/);
});

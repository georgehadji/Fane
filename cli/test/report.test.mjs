// Report mode (format 'report'): the plan, the fan-out research, the notes and the draft, with a fake model and a fake search.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MODES } from '../core/effort.mjs';
import { REPORT, clampReportWords } from '../core/formats.mjs';
import { wordCount } from '../core/language.mjs';
import { REPORT_PHASES, isJsonRole } from '../write/models.mjs';
import { createArticlePipeline } from '../write/pipeline.mjs';
import { mergeSources, normalizeNotes, normalizePlan, runPool } from '../write/report.mjs';

// ---- pure helpers ----

test('normalizePlan: bad JSON is nothing, duplicates and extras are dropped, a missing query is the question', () => {
  assert.deepEqual(normalizePlan(null, { max: 3 }), []);
  assert.deepEqual(normalizePlan({ sub_questions: 'x' }, { max: 3 }), []);
  const plan = normalizePlan({ sub_questions: [
    { question: 'What does it cost?', query: 'heat pump cost 2025', covers: 'prices' },
    { question: 'what does it  cost' }, // same words
    { question: '' }, { query: 'no question' }, 7,
    'How many are installed?',
    { question: 'Who pays?' }, { question: 'Which countries lead?' }, { question: 'A fifth one' },
  ] }, { max: 3 });
  assert.deepEqual(plan.map(p => p.question), ['What does it cost?', 'How many are installed?', 'Who pays?']);
  assert.equal(plan[0].query, 'heat pump cost 2025');
  assert.equal(plan[1].query, 'How many are installed?');
  assert.ok(normalizePlan({ sub_questions: [{ question: 'x'.repeat(900) }] }, { max: 3 })[0].question.length <= 200);
});

test('mergeSources: one list in sub-question order, a page found twice once, the caps hold, groups are numbers into the list', () => {
  const s = (n) => ({ title: `T${n}`, url: `https://ex.org/${n}`, content: `c${n}` });
  const { sources, groups } = mergeSources([[s(1), s(2), s(3)], [], [s(2), s(4)], null], { perQuestion: 2, maxSources: 3 });
  assert.deepEqual(sources.map(x => x.url), ['https://ex.org/1', 'https://ex.org/2', 'https://ex.org/4']);
  assert.deepEqual(groups, [[1, 2], [], [2, 3], []]);
  assert.deepEqual(mergeSources([[{ title: 'no url' }]], { perQuestion: 6, maxSources: 24 }), { sources: [], groups: [[]] });
});

test('normalizeNotes: a fact may cite only its own sub-question\'s sources, and cites something', () => {
  const facts = normalizeNotes({ facts: [
    { text: 'Costs fell 40% [2023]', sources: [3, 9, '4', 3] }, // 9 belongs to another sub-question
    { text: 'Cites only a foreign source', sources: [1] },
    { text: '', sources: [3] },
    { text: 'Single "source" key', source: 4 },
    { text: 'No sources' },
  ] }, [3, 4]);
  assert.deepEqual(facts, [{ text: 'Costs fell 40% [2023]', sources: [3, 4] }, { text: 'Single "source" key', sources: [4] }]);
  assert.equal(normalizeNotes({ facts: Array.from({ length: 20 }, (_, i) => ({ text: `f${i}`, sources: [3] })) }, [3]).length, 8);
  assert.deepEqual(normalizeNotes('nonsense', [1]), []);
});

test('runPool: at most `limit` at a time, results in order, a failure is a value', async () => {
  let active = 0, peak = 0;
  const out = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
    if (n === 3) throw new Error('three');
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(out.map(o => o.value), [10, 20, undefined, 40, 50]);
  assert.equal(out[2].error.message, 'three');
  assert.deepEqual(await runPool([], 2, async () => 1), []);
});

test('the report tables have one entry per mode, and the plan and notes are JSON roles', () => {
  for (const t of [REPORT_PHASES, REPORT.words, REPORT.subQuestions]) assert.deepEqual(Object.keys(t).sort(), [...MODES].sort());
  assert.ok(isJsonRole('plan') && isJsonRole('notes') && !isJsonRole('draft'));
  assert.equal(clampReportWords(undefined, 'quality'), REPORT.words.quality);
  assert.equal(clampReportWords(50, 'speed'), REPORT.minWords);
  assert.equal(clampReportWords(99999, 'speed'), REPORT.maxWords);
});

// ---- pipeline ----

const ROLE_OF = [
  ['plan the research for a report', 'plan'], ['research notes for a report', 'notes'], ['research analyst writing a report', 'draft'], ['adversarial fact-checker', 'factcheck'],
  ['developmental editor', 'revise'], ['style and copy editor', 'polish'], ['final editorial auditor', 'audit'], ['revising a finished article', 'rewrite'],
];
const roleOf = (body) => ROLE_OF.find(([needle]) => body.messages[0].content.includes(needle))?.[1];
const reply = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { cost: 0.001 } });

const SUBS = ['What does a heat pump cost?', 'How many are installed?', 'Which countries lead?'];
const PLAN = { sub_questions: SUBS.map((q, i) => ({ question: q, query: `query ${i + 1}`, covers: `part ${i + 1}` })) };
// sub-question i finds two pages: global numbers 2i-1 and 2i
const pagesFor = (query) => { const i = Number(query.at(-1)); return [1, 2].map(k => ({ title: `Page ${i}.${k}`, url: `https://ex.org/${i}/${k}`, content: `Page ${i}.${k} says that 1,200 homes got a pump and costs fell by 40%.` })); };

const sentence = (n) => `Heat pumps reached about 1,200 homes in the pilot and costs fell by 40% once installers learned the work [${n}].`;
const prose = (words, nums) => { const out = []; for (let i = 0; wordCount(out.join(' ')) < words; i++) out.push(sentence(nums[i % nums.length])); return out.join(' '); };
// cites global source 5 first, then 1, then 4 (in the table), so renumbering must give 1, 2, 3
const REPORT_TEXT = `# Heat pumps in Europe\n\n## Summary\n\n${prose(90, [5])}\n\n## Costs\n\n${prose(130, [1])}\n\n## Installed base\n\n${prose(130, [1])}\n\n## Key figures\n\n| Figure | Value |\n|---|---|\n| Homes in the pilot | 1,200 [4] |\n\n## Where the sources disagree or are thin\n\n${prose(70, [5])}`;

function fake(handlers = {}) {
  const calls = [];
  const defaults = {
    plan: JSON.stringify(PLAN),
    notes: (n, body) => { const nums = [...body.messages[1].content.matchAll(/^\[(\d+)\]/gm)].map(m => Number(m[1])); return JSON.stringify({ facts: [{ text: 'Costs fell by 40% since 2015.', sources: [nums[0]] }, { text: 'A foreign claim.', sources: [99] }] }); },
    draft: REPORT_TEXT,
    factcheck: JSON.stringify({ claims: [{ claim: 'a', source: 1, verdict: 'supported' }] }),
    polish: REPORT_TEXT,
  };
  return {
    calls,
    chat: async (body) => {
      const role = roleOf(body);
      calls.push({ role, body });
      const n = calls.filter(c => c.role === role).length;
      const h = role in handlers ? handlers[role] : defaults[role];
      const out = typeof h === 'function' ? h(n, body) : h;
      if (out instanceof Error) throw out;
      return reply(out);
    },
  };
}

const run = (client, opts = {}, retrieve) => {
  const asked = [];
  const search = retrieve || (async (q) => { asked.push(q); return pagesFor(q); });
  return createArticlePipeline({ client, retrieve: search })({ topic: 'heat pumps in Europe', format: 'report', words: 600, mode: 'speed', ...opts }).then(r => Object.assign(r, { asked }));
};

test('Speed report: a plan, one research and one notes call per sub-question, then the draft', async () => {
  const c = fake();
  const r = await run(c);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.format, 'report');
  assert.deepEqual(c.calls.map(x => x.role).sort(), ['draft', 'notes', 'notes', 'notes', 'plan']);
  assert.deepEqual(r.asked.sort(), ['query 1', 'query 2', 'query 3']); // the English query of each sub-question, not the topic
  assert.deepEqual(r.subQuestions, SUBS);
  // the notes of sub-question 2 see its pages under their numbers in the whole list
  const second = c.calls.filter(x => x.role === 'notes')[1].body.messages[1].content;
  assert.match(second, /Sub-question: How many are installed\?/);
  assert.match(second, /\[3\] Page 2\.1/);
  assert.doesNotMatch(second, /Page 1\.1|Page 3\.1/);
  // the draft reads the notes, which carry only their own pages' numbers (the foreign [99] fact is gone)
  const draft = c.calls.find(x => x.role === 'draft').body.messages[1].content;
  assert.match(draft, /<sub_question n="2">\nHow many are installed\?\n- Costs fell by 40% since 2015\. \[3\]/);
  assert.doesNotMatch(draft, /foreign claim/);
  assert.match(draft, /## Key figures/);
  assert.equal(r.phases.filter(p => (p.phase || p.name) === 'notes').length, 3);
  assert.equal(r.degraded.length, 0, r.degraded.join('; '));
});

test('citations from different sub-questions are renumbered by first appearance, also inside a table cell', async () => {
  const r = await run(fake());
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.sources.map(s => s.url), ['https://ex.org/3/1', 'https://ex.org/1/1', 'https://ex.org/2/2']); // global 5, 1, 4
  assert.match(r.article, /\| Homes in the pilot \| 1,200 \[3\] \|/);
  assert.match(r.article, /^## Summary\n\n.*\[1\]/m);
  assert.equal(r.checks.ok, true, JSON.stringify(r.checks.items.filter(i => i.level === 'fail')));
});

test('one sub-question whose research fails is listed, not fatal; all failing is a failed run', async () => {
  const one = await run(fake(), {}, async (q) => { if (q === 'query 2') throw new Error('search down'); return pagesFor(q); });
  assert.equal(one.ok, true, one.error);
  assert.ok(one.degraded.some(d => /How many are installed\?.*search down/.test(d)), one.degraded.join('; '));
  assert.ok(one.degraded.some(d => /no sources for "How many are installed\?"/.test(d)));
  const none = await run(fake(), {}, async () => { throw new Error('search down'); });
  assert.equal(none.ok, false);
  assert.match(none.error, /no sources found.*search down/);
});

test('a sub-question whose notes fail has its own pages read by the draft, and is listed', async () => {
  const c = fake({ notes: (n) => (n === 2 ? 'not json' : JSON.stringify({ facts: [{ text: 'A fact.', sources: [1] }] })) });
  const r = await run(c);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.degraded.some(d => /^notes for ".*" failed/.test(d)), r.degraded.join('; '));
  assert.match(c.calls.find(x => x.role === 'draft').body.messages[1].content, /<sources>/); // the raw pages of that sub-question
});

test('a plan that fails or is empty falls back to the question as one sub-question', async () => {
  for (const plan of ['not json', JSON.stringify({ sub_questions: [] })]) {
    const c = fake({ plan });
    const r = await run(c);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.subQuestions, ['heat pumps in Europe']);
    assert.ok(r.degraded.some(d => /the plan/.test(d)), r.degraded.join('; '));
    assert.equal(c.calls.filter(x => x.role === 'notes').length, 1);
  }
});

test('Quality researches one sub-question at a time', async () => {
  let active = 0, peak = 0;
  const four = { sub_questions: [1, 2, 3, 4].map(i => ({ question: `Question ${i}?`, query: `query ${i}` })) };
  const c = fake({ plan: JSON.stringify(four) });
  const r = await run(c, { mode: 'quality' }, async (q) => { active++; peak = Math.max(peak, active); await new Promise(x => setTimeout(x, 5)); active--; return pagesFor(q); });
  assert.equal(r.ok, true, r.error);
  assert.equal(peak, 1);
  assert.equal(r.subQuestions.length, 4);
});

test('Balanced researches at most two sub-questions at a time and fact-checks against all the pages', async () => {
  let active = 0, peak = 0;
  const four = { sub_questions: [1, 2, 3, 4].map(i => ({ question: `Question ${i}?`, query: `query ${i}` })) };
  const c = fake({ plan: JSON.stringify(four) });
  const r = await run(c, { mode: 'balanced' }, async (q) => { active++; peak = Math.max(peak, active); await new Promise(x => setTimeout(x, 5)); active--; return pagesFor(q); });
  assert.equal(r.ok, true, r.error);
  assert.equal(peak, REPORT.researchAtATime.balanced);
  assert.equal(r.subQuestions.length, 4);
  assert.ok(c.calls.some(x => x.role === 'factcheck'));
  assert.equal(c.calls.filter(x => x.role === 'plan').length, 1);
});

test('the plan is capped by the mode: a model that returns ten sub-questions gets three on Speed', async () => {
  const ten = { sub_questions: Array.from({ length: 10 }, (_, i) => ({ question: `Question ${i}?`, query: `query ${i}` })) };
  const r = await run(fake({ plan: JSON.stringify(ten) }), {}, async (q) => pagesFor(q.replace(/\d+$/, '1')));
  assert.equal(r.subQuestions.length, REPORT.subQuestions.speed);
});

test('a 402 in a notes call ends the run with no report (nothing was drafted yet)', async () => {
  const { OpenRouterError } = await import('../image/openrouter.mjs');
  const r = await run(fake({ notes: new OpenRouterError('402 no credits', 402) }));
  assert.equal(r.ok, false);
  assert.equal(r.fatal, true);
  assert.equal(r.status, 402);
});

test('an unknown format is a programming error', async () => {
  await assert.rejects(run(fake(), { format: 'dossier' }), /unknown format/);
});

// ---- the web hook and the CLI ----

for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { handleArticleRequest } = await import('../write/vane-hook.mjs');
const { autoRoute, parseCli } = await import('../vane.mjs');

test('the web hook writes a report for a report request, before a post or an article', async () => {
  const seen = [];
  const blocks = new Map();
  const ui = { emit: (x) => { blocks.set('b1', x); return 'b1'; }, update: (id, x) => blocks.set(id, x) };
  const TRIAL = { 'alpha/m1': { en: { ok: true, score: 1 }, el: { ok: true, score: 1 }, json: { ok: true } } };
  const client = { models: async () => [{ id: 'alpha/m1', name: 'M1', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.0000001', completion: '0.0000004' }, context_length: 100000 }] };
  const pipeline = async (args) => { seen.push(args); return { ok: false, error: 'stop here' }; };
  const go = (q) => handleArticleRequest(q, { ...ui, mode: 'balanced', client, trial: TRIAL, research: async () => [], pipeline });
  assert.equal(await go('Write a detailed report on heat pumps in Europe, 1500 words'), true);
  assert.deepEqual([seen[0].format, seen[0].topic, seen[0].words], ['report', 'heat pumps in Europe, 1500 words', 1500]);
  assert.equal(await go('Γράψε μια έκθεση για την αιολική ενέργεια'), true);
  assert.deepEqual([seen[1].format, seen[1].topic], ['report', 'την αιολική ενέργεια']);
  assert.equal(await go('write an article about heat pumps'), true);
  assert.equal(seen[2].format, 'article');
  assert.equal(await go('write a report generator in Python'), false); // the code hook takes it
});

test('the CLI: --report is the article feature with the report format, its own word range, and a report request is routed there', () => {
  const o = parseCli(['heat pumps', '--report']);
  assert.deepEqual([o.report, o.article], [true, true]);
  assert.equal(parseCli(['heat pumps', '--report', '--words', '1800']).words, 1800);
  assert.throws(() => parseCli(['heat pumps', '--report', '--words', '300']), /Invalid --words "300" \(600-3500\)/);
  assert.throws(() => parseCli(['x', '--report', '--article']), /one feature flag.*--article and --report/);
  assert.throws(() => parseCli(['x', '--report', '--post', 'linkedin']), /one feature flag/);
  assert.throws(() => parseCli(['x', '--report', '--image']), /one feature flag/);
  const route = (...argv) => autoRoute(parseCli(argv), argv);
  assert.equal(route('write a report on heat pumps').report, true);
  assert.equal(route('Γράψε μια έκθεση για τη λειψυδρία').report, true);
  assert.equal(route('write a report on heat pumps', '--no-auto-article'), null);
  assert.equal(route('write an article about heat pumps').report, false);
  assert.equal(route('write a report generator in Python').code, true);
});

test('an editing pass that renames the fixed sections is rejected, and a draft without them is noted', async () => {
  // Quality, 2026-11-13: the style and copy passes left a report with no Summary and no "Where the sources disagree" section
  const renamed = REPORT_TEXT.replace('## Summary', '## Overview').replace('## Where the sources disagree or are thin', '## Caveats');
  const c = fake({ polish: renamed });
  const r = await run(c, { mode: 'balanced' });
  assert.equal(r.ok, true, r.error);
  assert.match(r.article, /## Summary/);
  assert.ok(r.degraded.some(d => /polish was rejected \(lost a fixed section of the report\)/.test(d)), r.degraded.join('; '));
  const d = await run(fake({ draft: renamed, polish: renamed }));
  assert.ok(d.degraded.some(x => /does not have its fixed sections/.test(x)), d.degraded.join('; '));
});

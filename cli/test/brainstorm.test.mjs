// Brainstorming (cli/brainstorm): intent, the idea bookkeeping, the pipeline with a fake client, the answer and the
// hook. No network, no Vane.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBrainstormRequest } from '../brainstorm/intent.mjs';
import { applyClusters, createBrainstormPipeline, normalizeIdeas, pickIdeas, selectBrainstormChains } from '../brainstorm/pipeline.mjs';
import { renderBrainstorm, renderBrainstormResult } from '../brainstorm/present.mjs';
import { handleBrainstormRequest } from '../brainstorm/vane-hook.mjs';
import { isCodeRequest } from '../code/intent.mjs';
import { buildTextCatalogue } from '../write/catalogue.mjs';
import { isArticleRequest, postPlatform } from '../write/intent.mjs';
import { ANSWER_MARKER } from '../image/present.mjs';

const { autoRoute, parseCli } = await import('../vane.mjs');

test('brainstorm requests: "brainstorm ...", or an asking verb with ideas/ways/names and what they are for', () => {
  for (const q of [
    'brainstorm ways to cut plastic waste in cities',
    "let's brainstorm a name for the podcast",
    'give me 10 ideas for a café',
    'suggest names for my bakery',
    'come up with some creative ways to teach fractions',
    'list ways to reduce costs',
    'generate ideas for a game in Python',
    'δώσε μου ιδέες για ένα καφέ',
    'πρότεινε τρόπους να μειώσουμε τα απόβλητα',
    'καταιγισμός ιδεών για το σχολείο',
    'γράψε 5 τίτλους για ένα άρθρο',
    'suggest ways a medium greek publishing house can win authors, especially university professors',
    'give me some ways my team could ship faster',
  ]) assert.equal(isBrainstormRequest(q), true, q);
  for (const q of [
    'what are good ideas for dinner?',
    'ideas for dinner',
    'suggest alternatives to Photoshop',
    'brainstorming techniques for teams',
    'give me a Python script that renames files',
    'write an article about brainstorming',
    'τι ιδέες υπάρχουν για το σχολείο;',
    'ways a medium greek publishing house can win authors',
    'list ways the virus can spread',
  ]) assert.equal(isBrainstormRequest(q), false, q);
});

test('a brainstorm request is not code, an article or a post, and the CLI routes it to --brainstorm', () => {
  assert.equal(isCodeRequest('generate ideas for a game in Python'), false);
  assert.equal(isArticleRequest('γράψε 5 τίτλους για ένα άρθρο'), false);
  assert.equal(postPlatform('give me ideas for LinkedIn posts'), null);
  const route = (...argv) => autoRoute(parseCli(argv), argv);
  assert.equal(route('brainstorm ways to cut plastic waste').brainstorm, true);
  assert.equal(route('brainstorm ways to cut plastic waste', '--no-auto-brainstorm'), null);
  assert.throws(() => parseCli(['--brainstorm', 'x', '--lang', 'fr']), /Invalid --lang/);
});

test('normalizeIdeas: ids from code, repeated titles dropped, probability and tier checked', () => {
  const seen = new Set();
  const a = normalizeIdeas({ ideas: [{ id: 'X', title: 'Bike Library', description: 'd', probability: 0.05, tier: 'Lateral' }, { title: 'bike library!' }, { title: '' }, { title: 'Odd', probability: 7, tier: 'weird' }] }, 1, seen);
  assert.deepEqual(a.map(i => [i.id, i.title, i.probability, i.tier]), [['R1I1', 'Bike Library', 0.05, 'lateral'], ['R1I2', 'Odd', null, '']]);
  assert.equal(normalizeIdeas({ ideas: [{ title: 'Bike  library' }] }, 2, seen).length, 0); // seen in round 1
});

const idea = (id, title, extra = {}) => ({ id, title, description: `${title} description`, insight: '', probability: 0.2, ...extra });

test('applyClusters: scores and themes from the answer, unknown ids ignored, duplicates dropped, existing work named', () => {
  const ideas = [idea('R1I1', 'A'), idea('R1I2', 'B'), idea('R1I3', 'C'), idea('R2I1', 'A again')];
  const prior = [{ title: 'Existing A', url: 'https://example.org/a' }];
  const r = applyClusters({ themes: [
    { theme: 'Sharing', ideas: [{ id: 'R1I1', feasibility: 8, novelty: 2, impact: 7, exists: 1 }, { id: 'R2I1', duplicate_of: 'R1I1' }, { id: 'R9I9', novelty: 10 }] },
    { theme: 'Pricing', ideas: [{ id: 'R1I2', feasibility: 6, novelty: 9, impact: 8 }, { id: 'R1I1', novelty: 10 }] },
  ] }, ideas, prior);
  assert.deepEqual(r.themes, [{ theme: 'Sharing', ids: ['R1I1'] }, { theme: 'Pricing', ids: ['R1I2'] }]);
  assert.deepEqual(r.ideas.map(i => i.id), ['R1I1', 'R1I2', 'R1I3']); // the duplicate is gone, C is unscored
  assert.equal(r.unscored, 1);
  const a = r.ideas[0];
  assert.equal(a.novelty, 2); // the second listing of R1I1 is ignored
  assert.equal(a.score, Math.round((0.4 * 2 + 0.35 * 7 + 0.25 * 8) * 10) / 10);
  assert.deepEqual(a.exists, { title: 'Existing A', url: 'https://example.org/a' });
});

test('pickIdeas: the best of each theme in turn, never an unbuildable idea; without scores, the rarest first', () => {
  const s = (id, score, feasibility = 6) => ({ id, title: id, score, feasibility });
  const ideas = [s('a1', 9), s('a2', 8.5), s('a3', 8), s('b1', 7), s('c1', 9.5, 2), s('c2', 6)];
  const themes = [{ theme: 'A', ids: ['a1', 'a2', 'a3'] }, { theme: 'B', ids: ['b1'] }, { theme: 'C', ids: ['c1', 'c2'] }];
  assert.deepEqual(pickIdeas(ideas, themes, 3).map(i => i.id), ['a1', 'b1', 'c2']); // not a1, a2, a3; c1 is not feasible
  assert.deepEqual(pickIdeas(ideas, themes, 5).map(i => i.id), ['a1', 'b1', 'c2', 'a2', 'a3']);
  assert.deepEqual(pickIdeas([idea('x', 'x', { probability: 0.5 }), idea('y', 'y', { probability: 0.02 })], [{ theme: '', ids: ['x', 'y'] }], 1).map(i => i.id), ['y']);
});

// ---- the pipeline with a fake client ----

const reply = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { cost: 0.001 } });
const roleOf = (body) => {
  const s = body.messages[0].content;
  return /generate ideas/.test(s) ? 'generate' : /analyse a pool/.test(s) ? 'cluster' : /develop selected/.test(s) ? 'develop' : /one decision/.test(s) ? 'synthesis' : 'other';
};
const roundOf = (body) => Number(/Round (\d+)/.exec(body.messages[1].content)?.[1]);
const idsIn = (body) => [...body.messages[1].content.matchAll(/^(R\d+I\d+):/gm)].map(m => m[1]);

function fakeClient(over = {}) {
  const calls = [];
  const answers = {
    generate: (b) => JSON.stringify({ ideas: [1, 2, 3, 4, 5].map(n => ({ title: `Idea ${roundOf(b)}.${n}`, description: `d${n}`, probability: n <= 2 ? 0.05 : 0.4, tier: 'lateral', insight: 'i' })) }),
    cluster: (b) => {
      const ids = idsIn(b);
      return JSON.stringify({ themes: [{ theme: 'One', ideas: ids.slice(0, 6).map((id, n) => ({ id, feasibility: 6, novelty: 9 - n, impact: 7 })) }, { theme: 'Two', ideas: ids.slice(6).map((id, n) => ({ id, feasibility: 7, novelty: 8 - (n % 5), impact: 6 })) }] });
    },
    develop: (b) => JSON.stringify({ developments: idsIn(b).map(id => ({ id, use_case: 'u', steps: ['Step 1: s1', 's2'], risks: ['r'], success: ['s'] })).concat([{ id: 'R9I9', use_case: 'invented' }]) }),
    synthesis: (b) => JSON.stringify({ recommended: [idsIn(b)[0], 'R9I9'], recommendation: 'Do the first one [1].', insights: [`${idsIn(b)[0]} and R9I9 work together`], plan: [{ action: 'pilot', when: 'week 1', go_if: '10 users', fallback: 'stop' }, 'tell people'], open_questions: ['q'], riskiest_assumption: 'a', likely_bias: 'b', uncertainty: 'c' }),
    ...over,
  };
  return {
    calls,
    chat: async (body) => {
      const role = roleOf(body);
      calls.push({ role, body });
      const out = answers[role](body);
      if (out instanceof Error) throw out;
      return reply(out);
    },
  };
}

test('pipeline (balanced): existing work in the rounds and the scoring, 3 rounds that see earlier titles, 3 developed ideas across themes, a grounded synthesis', async () => {
  const client = fakeClient();
  const queries = [];
  const retrieve = async (q) => { queries.push(q); return [{ title: 'City refill shops', url: 'https://example.org/refill', content: 'Refill stations exist.' }]; };
  const r = await createBrainstormPipeline({ client, retrieve })({ request: 'ways to cut plastic waste', mode: 'balanced' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(queries, ['ways to cut plastic waste']);
  assert.deepEqual(client.calls.map(c => c.role), ['generate', 'generate', 'generate', 'cluster', 'develop', 'synthesis']);
  const gen = client.calls.filter(c => c.role === 'generate');
  assert.match(gen[0].body.messages[1].content, /<existing_work>[\s\S]*City refill shops/);
  assert.match(gen[1].body.messages[1].content, /Ideas of earlier rounds[\s\S]*- Idea 1\.5/);
  assert.equal(gen[0].body.temperature, 1);
  assert.match(client.calls.find(c => c.role === 'cluster').body.messages[1].content, /City refill shops/);
  assert.equal(r.ideas.length, 15);
  assert.deepEqual(r.rounds.map(x => x.tail), [2, 2, 2]);
  assert.equal(r.picked.length, 3);
  assert.equal(new Set(r.picked.map(id => r.ideas.find(i => i.id === id).theme)).size, 2); // both themes, not three ideas of the first
  assert.ok(r.picked.every(id => r.ideas.find(i => i.id === id).development));
  assert.ok(!r.ideas.some(i => i.development?.use_case === 'invented'));
  assert.equal(r.synthesis.recommended.length, 1); // R9I9 is not an idea of this run
  assert.match(r.synthesis.insights[0], /^Idea \d\.\d and R9I9 work together$/); // a known id becomes its title
  assert.match(r.synthesis.recommended[0], /^R\d+I\d+$/); // the ids themselves stay ids
  assert.deepEqual(r.synthesis.plan.map(p => p.action), ['pilot', 'tell people']);
  assert.equal(r.calls, 6);
  assert.deepEqual(r.degraded, []);
});

test('pipeline (speed): no search, 2 rounds, no development; a failed scoring leaves the ideas unranked', async () => {
  const client = fakeClient({ cluster: () => 'no json' });
  let searched = false;
  const r = await createBrainstormPipeline({ client, retrieve: async () => { searched = true; return []; } })({ request: 'names for a bakery', mode: 'speed' });
  assert.equal(r.ok, true, r.error);
  assert.equal(searched, false);
  assert.deepEqual(client.calls.map(c => c.role), ['generate', 'generate', 'cluster', 'synthesis']);
  assert.ok(r.degraded.some(d => /could not be scored/.test(d)));
  assert.equal(r.picked.length, 3);
  assert.ok(r.picked.every(id => r.ideas.find(i => i.id === id).probability === 0.05)); // the rarest go to the synthesis
});

test('pipeline: a round without rare ideas is noted; no idea at all ends the run; a 402 stops it', async () => {
  const flat = await createBrainstormPipeline({ client: fakeClient({ generate: (b) => JSON.stringify({ ideas: [{ title: `Common ${roundOf(b)}`, probability: 0.9 }] }) }) })({ request: 'x', mode: 'speed' });
  assert.ok(flat.degraded.some(d => /round 1 has 0 rare ideas/.test(d)));
  const none = await createBrainstormPipeline({ client: fakeClient({ generate: () => '{"ideas": []}' }) })({ request: 'x', mode: 'speed' });
  assert.equal(none.ok, false);
  assert.match(none.error, /no round gave a usable idea/);
  const { OpenRouterError } = await import('../image/openrouter.mjs');
  const broke = await createBrainstormPipeline({ client: fakeClient({ generate: () => new OpenRouterError('402 no credits', 402) }) })({ request: 'x', mode: 'speed' });
  assert.equal(broke.fatal, true);
  assert.equal(broke.status, 402);
});

test('Greek text gets the article pipeline\'s spelling repairs (Latin look-alikes, the dropped final ν)', async () => {
  const client = fakeClient({
    generate: (b) => JSON.stringify({ ideas: [{ title: `Ιδέα ${roundOf(b)}`, description: 'Βοηθά στη οργάνωση', probability: 0.05 }, { title: `Άλλη ${roundOf(b)}`, description: 'x', probability: 0.05 }] }),
    synthesis: () => JSON.stringify({ recommendation: 'Ξεκινήστε από το πρώτo.' }), // a Latin o inside a Greek word
  });
  const r = await createBrainstormPipeline({ client })({ request: 'δώσε μου ιδέες για το σχολείο', mode: 'speed' });
  assert.equal(r.language, 'el');
  assert.equal(r.ideas[0].description, 'Βοηθά στην οργάνωση');
  assert.equal(r.synthesis.recommendation, 'Ξεκινήστε από το πρώτο.');
});

test('the answer: recommendation first, developed ideas, plan; on the web escaped, brackets made parentheses, links as <a>', async () => {
  const r = await createBrainstormPipeline({ client: fakeClient(), retrieve: async () => [{ title: 'Refill <shops>', url: 'https://example.org/refill', content: '' }] })({ request: 'ways to cut plastic waste', mode: 'balanced' });
  const md = renderBrainstorm(r);
  assert.ok(md.indexOf('## Recommendation') < md.indexOf('## Developed ideas'));
  assert.match(md, /1\. s1\n2\. s2/); // "Step 1:" is not repeated
  assert.match(md, /Do the first one \[1\]\./);
  assert.match(md, /\[Refill <shops>\]\(https:\/\/example\.org\/refill\)/);
  const web = renderBrainstormResult(r);
  assert.match(web, /Do the first one \(1\)\./);
  assert.doesNotMatch(web, /\[\d+\]/);
  assert.match(web, /<a href="https:\/\/example\.org\/refill">Refill &lt;shops&gt;<\/a>/);
  assert.match(web, /15 ideas · 2 themes/);
});

test('hook: not a brainstorm -> false; no trial -> a message; a run -> the answer with the marker, research closed', async () => {
  const ui = () => { const blocks = new Map(); let n = 0; return { blocks, emit: (x) => { const id = `b${++n}`; blocks.set(id, x); return id; }, update: (id, x) => blocks.set(id, x) }; };
  const plain = ui();
  assert.equal(await handleBrainstormRequest('what is brainstorming?', { ...plain, client: {} }), false);
  assert.equal(plain.blocks.size, 0);

  const catalogue = [{ id: 'lab/writer', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 128000, supported_parameters: ['response_format'] }];
  const none = ui();
  assert.equal(await handleBrainstormRequest('brainstorm names for a bakery', { ...none, client: { models: async () => catalogue }, trial: {} }), true);
  assert.match([...none.blocks.values()][0], /article trial/);

  const run = ui();
  let closed = 0;
  const pipeline = async ({ onProgress }) => {
    onProgress({ phase: 'prior', status: 'done' });
    return { ok: true, language: 'en', mode: 'balanced', prior: [], rounds: [], ideas: [{ id: 'R1I1', title: 'Sourdough Sundays', description: 'd' }], themes: [{ theme: '', ids: ['R1I1'] }], picked: ['R1I1'], synthesis: null, phases: [], degraded: [], calls: 1, cost: 0, ms: 1000 };
  };
  const trial = { 'lab/writer': { en: { ok: true }, json: { ok: true } } };
  assert.equal(await handleBrainstormRequest('brainstorm names for a bakery', { ...run, client: { models: async () => catalogue }, trial, pipeline, research: async () => [], researchDone: () => closed++, mode: 'balanced' }), true);
  const final = [...run.blocks.values()][0];
  assert.match(final, /Sourdough Sundays/);
  assert.ok(final.endsWith(ANSWER_MARKER));
  assert.equal(closed, 1);
});

test('chains: every role answers JSON, so only models with a JSON pass; Greek falls back to English models', () => {
  const entry = (id, price) => ({ id, architecture: { output_modalities: ['text'] }, pricing: { prompt: String(price / 1e6), completion: String(price * 2 / 1e6) }, context_length: 128000, supported_parameters: ['response_format'] });
  const catalogue = buildTextCatalogue([entry('a/one', 1), entry('b/two', 2)]);
  const trial = { 'a/one': { en: { ok: true }, json: { ok: true } }, 'b/two': { en: { ok: true }, json: { ok: false } } };
  const chosen = selectBrainstormChains(catalogue, trial, { mode: 'balanced', lang: 'en' });
  assert.deepEqual(Object.keys(chosen.chains).sort(), ['cluster', 'develop', 'generate', 'synthesis']);
  assert.ok(!Object.values(chosen.chains).flat().includes('b/two'));
  assert.ok(selectBrainstormChains(catalogue, trial, { mode: 'balanced', lang: 'el' })); // nobody passed Greek: English models
});

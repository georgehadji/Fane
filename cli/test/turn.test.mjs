import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurn } from '../core/turn.mjs';

// A turn over a fake chat: blocks by id, every log line, and the parsed summary lines.
const rig = (opts = {}) => {
  const blocks = new Map(), lines = [], updates = [];
  let n = 0;
  const turn = createTurn({
    feature: 'demo', prompts: { a: 'x' }, tag: (m) => `${m}<!--t-->`,
    emit: (m) => { const id = `b${++n}`; blocks.set(id, m); return id; },
    update: (id, m) => { updates.push(m); blocks.set(id, m); },
    log: (m) => lines.push(m), ...opts,
  });
  const summaries = () => lines.filter(l => /"feature":"demo"/.test(l)).map(l => JSON.parse(l.slice(l.indexOf('{'))));
  return { turn, blocks, lines, updates, summaries };
};

test('turn: the summary line is written once on every way out of run()', async () => {
  const cases = [
    ['a finished run', async () => ({ ok: true, cost: 0.01 }), { ok: true, outcome: 'complete' }],
    ['a degraded run', async () => ({ ok: true, degraded: ['x'] }), { ok: true, outcome: 'degraded', degraded: 1 }],
    ['an early return', async () => {}, { ok: false, outcome: 'failed' }],
    ['an early return of a bare result', async () => ({ ok: false }), { ok: false, outcome: 'failed' }],
    ['a stop by the user', async () => ({ ok: false, status: 499 }), { ok: false, outcome: 'stopped', stopped: true }],
    ['a throw', async () => { throw new Error('boom'); }, { ok: false, outcome: 'failed' }],
  ];
  for (const [name, fn, expected] of cases) {
    const r = rig();
    await r.turn.run('first', fn);
    const s = r.summaries();
    assert.equal(s.length, 1, name);
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(k => [k, s[0][k]])), expected, name);
  }
});

test('turn: a throw is shown through failed(), and the summary keeps the phases and cost seen so far', async () => {
  const r = rig();
  const seen = [];
  const onProgress = r.turn.progress((e) => (e.status === 'running' ? () => `running ${e.phase}` : undefined));
  await r.turn.run('first', async () => {
    onProgress({ phase: 'outline', status: 'running' });
    onProgress({ phase: 'outline', status: 'ok', ms: 12 });
    onProgress({ phase: 'draft', status: 'preview', text: 'x' }); // a draft to show, not a record
    onProgress({ phase: 'draft', status: 'running' });
    onProgress({ phase: 'sources', status: 'done' });
    onProgress({ phase: 'done', status: 'done' }); // the run's own end
    r.turn.spend(0.004);
    r.turn.spend(0.006);
    throw new Error('boom');
  }, { failed: (err) => { seen.push(err.message); r.turn.say('it failed'); } });
  assert.deepEqual(seen, ['boom']);
  assert.equal(r.blocks.get('b1'), 'it failed<!--t-->');
  const [s] = r.summaries();
  assert.deepEqual([s.ok, s.outcome, s.cost], [false, 'failed', 0.01]);
  assert.deepEqual(s.phases, ['outline=ok/12ms', 'sources=done/0ms']);
});

test('turn: run() emits the tagged first answer once, and a second finish is ignored', async () => {
  const r = rig();
  await r.turn.run('first', async () => {
    r.turn.finish({ ok: true, calls: 3 });
    r.turn.finish({ ok: false });
    return { ok: false };
  });
  assert.equal(r.blocks.get('b1'), 'first<!--t-->');
  assert.equal(r.blocks.size, 1);
  const s = r.summaries();
  assert.deepEqual([s.length, s[0].ok, s[0].calls], [1, true, 3]);
});

test('turn: a failing failed() handler still leaves the summary', async () => {
  const r = rig();
  await assert.rejects(r.turn.run('first', async () => { throw new Error('boom'); }, { failed: () => { throw new Error('worse'); } }), /worse/);
  assert.equal(r.summaries().length, 1);
});

test('turn: progress renders run one at a time in event order, even when a later one is faster', async () => {
  const r = rig();
  const delays = [30, 1, 15];
  const onProgress = r.turn.progress((e) => (e.show ? async () => { await new Promise(res => setTimeout(res, delays[e.n])); return `render ${e.n}`; } : undefined));
  await r.turn.run('first', async () => {
    onProgress({ n: 0, show: true });
    onProgress({ n: 9 }); // the handler shows nothing for it
    onProgress({ n: 1, show: true });
    onProgress({ n: 2, show: true });
    await r.turn.settle();
    return { ok: true };
  });
  assert.deepEqual(r.updates, ['render 0<!--t-->', 'render 1<!--t-->', 'render 2<!--t-->']);
});

test('turn: a progress event is handled at once; only the render waits in the queue', async () => {
  const r = rig();
  const state = [];
  const onProgress = r.turn.progress((e) => { state.push(e.n); return () => `state ${state.join(',')}`; });
  await r.turn.run('first', async () => {
    onProgress({ n: 1 });
    onProgress({ n: 2 });
    assert.deepEqual(state, [1, 2]); // before any render ran
    await r.turn.settle();
    return { ok: true };
  });
  assert.deepEqual(r.updates, ['state 1,2<!--t-->', 'state 1,2<!--t-->']);
});

test('turn: an update that throws is logged and ignored; the run still ends well', async () => {
  const r = rig({ update: () => { throw new Error('socket closed'); } });
  await r.turn.run('first', async () => { r.turn.say('a'); r.turn.say('b'); return { ok: true }; });
  assert.equal(r.lines.filter(l => /could not update the answer: socket closed/.test(l)).length, 2);
  assert.deepEqual(r.summaries().map(s => s.ok), [true]);
});

test('turn: a queued render that fails does not hide the failure message, and is not left unhandled', async () => {
  const r = rig();
  const onProgress = r.turn.progress(() => () => { throw new Error('render broke'); });
  await r.turn.run('first', async () => {
    onProgress({ phase: 'x', status: 'ok' });
    await r.turn.settle(); // the same rejection surfaces here, in the pipeline's own path
  }, { failed: (err) => r.turn.say(`failed: ${err.message}`) });
  assert.equal(r.blocks.get('b1'), 'failed: render broke<!--t-->');
  assert.equal(r.summaries().length, 1);
});

test('turn: every log line carries the run id', async () => {
  const r = rig();
  await r.turn.run('first', async () => { r.turn.log('hello'); return { ok: true }; });
  assert.ok(r.lines.length >= 2 && r.lines.every(l => /^\[[0-9a-f]{8}\] /.test(l)));
});

// ---- the four hooks share the lifecycle: one summary line on every way out, a throw keeps what was seen ----

const { handleArticleRequest } = await import('../write/vane-hook.mjs');
const { handleCodeRequest } = await import('../code/vane-hook.mjs');
const { handleBrainstormRequest } = await import('../brainstorm/vane-hook.mjs');
const { handleImageRequest } = await import('../image/vane-hook.mjs');

const CATALOGUE = [{ id: 'lab/writer', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 128000, supported_parameters: ['response_format'] }];
const HOOKS = [
  { feature: 'article', handle: handleArticleRequest, query: 'write an article about tidal power', noTrial: /No text model has passed the trial/, pipeline: true },
  { feature: 'code', handle: handleCodeRequest, query: 'write a Python script that sorts files', noTrial: /coding trial/, pipeline: true },
  { feature: 'brainstorm', handle: handleBrainstormRequest, query: 'brainstorm names for a bakery', noTrial: /article trial/, pipeline: true },
  { feature: 'image', handle: handleImageRequest, query: 'draw a fox' },
];
const chat = () => { const blocks = new Map(); let n = 0; return { blocks, emit: (x) => { const id = `b${++n}`; blocks.set(id, x); return id; }, update: (id, x) => blocks.set(id, x) }; };
const summariesOf = (feature, lines) => lines.filter(l => new RegExp(`"feature":"${feature}"`).test(l)).map(l => JSON.parse(l.slice(l.indexOf('{'))));

for (const { feature, handle, query, noTrial, pipeline } of HOOKS) {
  test(`hook ${feature}: a run that ends early (no provider${noTrial ? ', no trial' : ''}) still writes one summary line`, async () => {
    const lines = [], io = chat();
    assert.equal(await handle(query, { ...io, readConfig: async () => '{"modelProviders":[]}', log: (m) => lines.push(m) }), true);
    assert.deepEqual(summariesOf(feature, lines).map(s => [s.ok, s.outcome]), [[false, 'failed']]);
    assert.match(io.blocks.get('b1'), /OpenRouter/); // the provider message replaced the first status line
    if (!noTrial) return;
    // a trial that has no passing model (an empty trial.json too) is the "no model passed" message, not a crash
    const none = [], u = chat();
    assert.equal(await handle(query, { ...u, client: { models: async () => CATALOGUE }, trial: {}, log: (m) => none.push(m) }), true);
    assert.deepEqual(summariesOf(feature, none).map(s => s.ok), [false]);
    assert.match(u.blocks.get('b1'), noTrial);
  });

  test(`hook ${feature}: a throw mid-run is shown, and its summary keeps the phases and cost seen so far`, async () => {
    const lines = [], io = chat();
    const trial = { 'lab/writer': { en: { ok: true }, json: { ok: true }, code: { ok: true } } };
    const boom = pipeline
      ? { client: { models: async () => CATALOGUE }, trial, pipeline: async ({ onProgress }) => { onProgress({ phase: 'prior', status: 'ok', ms: 7 }); throw new Error('boom'); } }
      : { generator: async ({ onProgress }) => { onProgress({ ready: 1, total: 2, slot: 0, model: 'a/one', name: 'One', image: { dataUrl: 'data:image/png;base64,AAAA', model: 'a/one', name: 'One', pricePerImage: 0.01 } }); throw new Error('boom'); } };
    assert.equal(await handle(query, { ...io, ...boom, log: (m) => lines.push(m) }), true);
    assert.match(io.blocks.get('b1'), /boom/);
    const [s, ...more] = summariesOf(feature, lines);
    assert.equal(more.length, 0);
    assert.deepEqual([s.ok, s.outcome], [false, 'failed']);
    if (pipeline) assert.deepEqual(s.phases, ['prior=ok/7ms']);
    else assert.equal(s.cost, 0.01);
  });
}

test('hook image: an edit of an SVG, and a missing earlier image, end early with one summary line', async () => {
  const lines = [], io = chat();
  const link = (ext) => `/api/uploads?fane-image=${'a'.repeat(64)}.${ext}`;
  const base = { ...io, generator: async () => { throw new Error('not reached'); }, log: (m) => lines.push(m) };
  assert.equal(await handleImageRequest('make it blue', { ...base, store: { get: async () => '' }, lastAnswer: async () => `<img src="${link('svg')}">` }), true);
  assert.match(io.blocks.get('b1'), /Vector images \(SVG\) cannot be edited/);
  assert.equal(await handleImageRequest('make it blue', { ...base, store: { get: async () => { throw new Error('gone'); } }, lastAnswer: async () => `<img src="${link('jpg')}">` }), true);
  assert.match(io.blocks.get('b2'), /no longer stored/);
  assert.deepEqual(summariesOf('image-edit', lines).map(s => s.ok), [false, false]);
});

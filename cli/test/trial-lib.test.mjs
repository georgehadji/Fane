import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pickCandidates } = await import('../../scripts/trial-lib.mjs');

const models = [0.5, 0.4, 0.3].map((p, i) => ({ id: `lab/m${i}`, priceIn: p, priceOut: p, price: p }));
const paid = async () => ({ catalogue: models, candidates: models });
const estimate = (m) => m.price;

test('pickCandidates: a --budget that is not a number is refused instead of trimming nothing', async () => {
  for (const budget of ['1,5', 'abc', '-1']) await assert.rejects(pickCandidates({ budget }, { paid, estimate }), /invalid --budget/, budget);
});

test('pickCandidates: the dearest candidates are dropped until the total fits the budget', async () => {
  const keep = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key-not-real';
  const log = console.log;
  console.log = () => {};
  try {
    const { candidates } = await pickCandidates({ budget: '0.75' }, { paid, estimate });
    assert.deepEqual(candidates.map(m => m.id), ['lab/m1', 'lab/m2']);
  } finally {
    console.log = log;
    if (keep === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = keep;
  }
});

test('pickCandidates: --concurrency, --per-lab and --max must be whole numbers of at least 1', async () => {
  for (const name of ['concurrency', 'per-lab', 'max']) {
    for (const v of ['0', '-2', '2.5', 'abc', '']) await assert.rejects(pickCandidates({ [name]: v }, { paid, estimate }), new RegExp(`invalid --${name}`), `${name}=${v}`);
  }
  const log = console.log;
  console.log = () => {};
  const keep = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key-not-real';
  try {
    const ok = await pickCandidates({ budget: '5', concurrency: '3', 'per-lab': '2', max: '40' }, { paid, estimate });
    assert.equal(ok.candidates.length, 3);
  } finally {
    console.log = log;
    if (keep === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = keep;
  }
});

test('runTrial: trial.json is written only when a model was tried', async () => {
  const { runTrial } = await import('../../scripts/trial-lib.mjs');
  const { mkdtempSync, existsSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'fane-trial-'));
  const file = join(dir, 'trial.json');
  const log = console.log;
  console.log = () => {};
  try {
    const base = { file, values: { concurrency: '2' }, client: {}, parts: () => [], line: () => '' };
    await runTrial({ ...base, candidates: [], trialOne: async () => { throw new Error('not called'); } });
    assert.equal(existsSync(file), false);
    await runTrial({ ...base, candidates: [{ id: 'lab/a' }], trialOne: async () => ({ out: { cost: 0.01 }, unanswered: false }) });
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).models), ['lab/a']);
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Runs runTrial in a temp folder; saved() lists the models in trial.json, or null when no file was written.
async function withTrial(run) {
  const { runTrial } = await import('../../scripts/trial-lib.mjs');
  const { mkdtempSync, existsSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'fane-trial-'));
  const file = join(dir, 'trial.json');
  const log = console.log;
  console.log = () => {};
  try {
    const base = { file, client: {}, parts: () => [], line: () => '' };
    await run({ runTrial, base, saved: () => (existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, 'utf8')).models) : null) });
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
}

const noAnswer = async () => ({ out: { cost: 0, finish: 'error', text: '' }, unanswered: true });

test('runTrial: an unanswered model is not saved, paid or free, so the next trial tries it again', async () => {
  await withTrial(async ({ runTrial, base, saved }) => {
    await runTrial({ ...base, values: { concurrency: '1' }, candidates: [{ id: 'lab/paid' }], trialOne: noAnswer });
    assert.equal(saved(), null);
  });
  await withTrial(async ({ runTrial, base, saved }) => {
    await runTrial({ ...base, values: { concurrency: '1', free: true }, candidates: [{ id: 'lab/free' }], trialOne: noAnswer });
    assert.equal(saved(), null);
  });
});

test('runTrial: a 401/402 stops the run only after the workers in flight have finished and saved', async () => {
  await withTrial(async ({ runTrial, base, saved }) => {
    const trialOne = async (client, m) => {
      if (m.id === 'lab/slow') { await new Promise(r => setTimeout(r, 30)); return { out: { cost: 0.02, finish: 'stop', text: 'ok' }, unanswered: false }; }
      throw Object.assign(new Error('402 out of credit'), { status: 402 });
    };
    const error = await runTrial({ ...base, values: { concurrency: '2' }, candidates: [{ id: 'lab/slow' }, { id: 'lab/broke' }], trialOne }).catch(e => e);
    assert.equal(error.status, 402);
    assert.deepEqual(saved(), ['lab/slow']);
  });
});

test('loadTrial: a missing file is an empty trial, a corrupt one is an error', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadTrial } = await import('../runners.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'fane-trial-'));
  try {
    assert.deepEqual(await loadTrial(join(dir, 'none.json')), { models: {} });
    await writeFile(join(dir, 'bad.json'), '{ not json');
    await assert.rejects(loadTrial(join(dir, 'bad.json')), /could not read the model trial/);
    await writeFile(join(dir, 'ok.json'), '{"updated":"2026-10-28","models":{"a/b":{}}}');
    assert.deepEqual((await loadTrial(join(dir, 'ok.json'))).models, { 'a/b': {} });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

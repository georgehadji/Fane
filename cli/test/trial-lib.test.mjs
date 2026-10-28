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

// The mode table (cli/core/effort.mjs), the copies it replaced, and the CLI's --reasoning and --max-cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT, HEADROOM, MODES, resolveEffort } from '../core/effort.mjs';
import { TIER_FOR_MODE } from '../image/catalogue.mjs';
import { VALID_MODES } from '../client.mjs';
import { PHASES, POST_PHASES, THINKING_HEADROOM } from '../write/models.mjs';
import { CODE_PHASES } from '../code/models.mjs';
import { PHASES as BRAINSTORM_PHASES } from '../brainstorm/pipeline.mjs';
import { runSummary } from '../core/runlog.mjs';

const { parseCli, autoRoute } = await import('../vane.mjs');

test('the table holds the values the copies had: tiers, low reasoning, 2/6/10 research rounds, 180/600 s timeouts', () => {
  assert.deepEqual(TIER_FOR_MODE, { speed: 'budget', balanced: 'value', quality: 'premium' });
  assert.equal(VALID_MODES, MODES);
  assert.equal(THINKING_HEADROOM, 8000);
  assert.deepEqual(MODES.map(m => [EFFORT[m].reasoning, EFFORT[m].researchRounds, EFFORT[m].cliTimeoutS]), [['low', 2, 180], ['low', 6, 180], ['low', 10, 600]]);
});

test('every feature\'s phase table has exactly the modes of the table', () => {
  for (const [name, table] of Object.entries({ PHASES, POST_PHASES, CODE_PHASES, BRAINSTORM_PHASES })) assert.deepEqual(Object.keys(table), [...MODES], name);
});

test('resolveEffort: an override wins over the environment, which wins over the table; headroom follows reasoning', () => {
  const q = resolveEffort('quality');
  assert.deepEqual([q.tier, q.reasoning, q.headroom, q.maxCost], ['premium', 'low', HEADROOM.low, Infinity]);
  assert.equal(resolveEffort('quality', {}, { FANE_MAX_COST: '2' }).maxCost, 2);
  assert.equal(resolveEffort('quality', {}, { FANE_MAX_COST: 'abc' }).maxCost, Infinity); // as maxCostFromEnv always did
  assert.equal(resolveEffort('quality', { maxCost: '0.5' }, { FANE_MAX_COST: '2' }).maxCost, 0.5);
  const m = resolveEffort('speed', { reasoning: 'medium' });
  assert.deepEqual([m.reasoning, m.headroom, m.researchRounds], ['medium', HEADROOM.medium, 2]);
  assert.ok(Object.isFrozen(m) && Object.isFrozen(EFFORT.speed));
  assert.equal(resolveEffort().mode, 'balanced');
});

test('resolveEffort refuses an unknown mode, an unknown effort and a cap that is not a positive number', () => {
  assert.throws(() => resolveEffort('turbo'), RangeError);
  assert.throws(() => resolveEffort('speed', { reasoning: 'none' }), /unknown reasoning effort/);
  for (const c of ['0', '-1', 'abc', 'Infinity']) assert.throws(() => resolveEffort('speed', { maxCost: c }), /invalid spend cap/, c);
});

test('CLI: --reasoning and --max-cost reach the profile; bad values and image runs are usage errors', () => {
  const o = parseCli(['--article', 'tidal power', '-o', 'quality', '--reasoning', 'medium', '--max-cost', '0.5']);
  assert.deepEqual([o.effort.mode, o.effort.reasoning, o.effort.maxCost], ['quality', 'medium', 0.5]);
  assert.equal(o.timeoutMs, 600_000);
  assert.equal(parseCli(['--code', 'x', '--tier', 'premium']).effort.mode, 'quality'); // --tier is the mode
  assert.throws(() => parseCli(['--article', 'x', '--reasoning', 'loud']), /Invalid --reasoning: unknown/);
  assert.throws(() => parseCli(['--article', 'x', '--max-cost', 'free']), /Invalid --max-cost: invalid spend cap/);
  assert.throws(() => parseCli(['--image', 'a cat', '--reasoning', 'high']), /apply only to/);
});

test('CLI: --max-cost wins over FANE_MAX_COST, and an auto-routed request keeps both flags', () => {
  const saved = process.env.FANE_MAX_COST;
  process.env.FANE_MAX_COST = '2';
  try {
    assert.equal(parseCli(['--brainstorm', 'x']).effort.maxCost, 2);
    assert.equal(parseCli(['--brainstorm', 'x', '--max-cost', '0.5']).effort.maxCost, 0.5);
  } finally {
    if (saved === undefined) delete process.env.FANE_MAX_COST; else process.env.FANE_MAX_COST = saved;
  }
  const argv = ['write an article about tidal power', '--reasoning', 'high', '--max-cost', '1'];
  const routed = autoRoute(parseCli(argv), argv);
  assert.equal(routed.article, true);
  assert.deepEqual([routed.effort.reasoning, routed.effort.maxCost], ['high', 1]);
});

test('the run log says which reasoning effort a run used', () => {
  assert.equal(JSON.parse(runSummary('article', { ok: true, mode: 'quality', reasoning: 'medium', phases: [] })).reasoning, 'medium');
});

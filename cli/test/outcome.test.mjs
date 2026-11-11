// core/outcome.mjs: how a run ends (OUTCOME), how a phase is recorded (PHASE), and what the run log says about both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OUTCOME, PHASE, STOPPED_STATUS, isStopped, outcomeOf, phaseRecord } from '../core/outcome.mjs';
import * as runlog from '../core/runlog.mjs';
import { OpenRouterError } from '../image/openrouter.mjs';

test('the vocabularies are frozen and hold exactly the documented names', () => {
  assert.deepEqual(Object.keys(OUTCOME), ['complete', 'degraded', 'stopped', 'failed']);
  assert.deepEqual(Object.keys(PHASE), ['running', 'preview', 'ok', 'fallback', 'failed', 'rejected', 'skipped']);
  assert.ok(Object.isFrozen(OUTCOME) && Object.isFrozen(PHASE));
  assert.equal(STOPPED_STATUS, 499);
  assert.equal(runlog.STOPPED_STATUS, STOPPED_STATUS); // the old import path keeps working
});

// Every shape a pipeline or a hook hands to runSummary today.
const SHAPES = [
  ['a full result', { ok: true, phases: [{ phase: 'draft', status: 'ok' }], degraded: [], stopped: null, calls: 3 }, OUTCOME.complete],
  ['an edit result with no phases', { ok: true, article: 'x', calls: 1 }, OUTCOME.complete],
  ['a hook that finished fine', { ok: true }, OUTCOME.complete],
  ['a result with notes', { ok: true, degraded: ['the fact-check failed'] }, OUTCOME.degraded],
  ['a stop after the draft (402, the spend cap)', { ok: true, degraded: [], stopped: { status: 402, error: 'no credits' } }, OUTCOME.degraded],
  ['an early exit', { ok: false }, OUTCOME.failed],
  ['a failure with an error', { ok: false, error: 'no sources found' }, OUTCOME.failed],
  ['a provider refusal before the draft', { ok: false, fatal: true, status: 402, error: 'no credits' }, OUTCOME.failed],
  ['a stop by the user', { ok: false, fatal: true, status: 499, error: 'stopped: the request was closed' }, OUTCOME.stopped],
  ['an image run stopped with no image', { ok: false, status: STOPPED_STATUS }, OUTCOME.stopped],
  ['nothing at all', undefined, OUTCOME.failed],
];
for (const [name, result, outcome] of SHAPES) test(`outcomeOf: ${name} is ${outcome}`, () => assert.equal(outcomeOf(result), outcome));

test('isStopped: the status 499, an error or result with it, or a text that starts with "stopped:"', () => {
  for (const x of [499, { status: 499 }, new OpenRouterError('stopped: the run reached its time limit', 499), new Error('stopped: the request was closed'), 'stopped: x', { ok: false, error: 'stopped: y' }]) assert.equal(isStopped(x), true, String(x));
  for (const x of [402, { status: 402 }, new Error('fetch failed'), 'model: stopped: x', 'the 499 files', { ok: true, stopped: { status: 402 } }, null, undefined, 0, '']) assert.equal(isStopped(x), false, String(x));
});

test('phaseRecord: a PHASE status, the extra fields as given, and a refusal for any other word', () => {
  assert.deepEqual(phaseRecord('draft', PHASE.ok, { model: 'm', ms: 5, note: '' }), { phase: 'draft', status: 'ok', model: 'm', ms: 5, note: '' });
  assert.deepEqual(phaseRecord('fix', 'rejected'), { phase: 'fix', status: 'rejected' });
  assert.ok('file' in phaseRecord('generate', 'ok', { file: undefined })); // a field that is undefined stays a field
  for (const bad of ['done', 'OK', 'success', '', undefined]) assert.throws(() => phaseRecord('x', bad), /unknown phase status/);
});

test('runSummary logs the outcome, a degraded count and the old stopped key', () => {
  const log = (r) => JSON.parse(runlog.runSummary('article', r, { ms: 1 }));
  assert.deepEqual([log({ ok: true, phases: [] }).outcome, log({ ok: true, phases: [] }).degraded], ['complete', undefined]);
  const degraded = log({ ok: true, degraded: ['a', 'b'], stopped: { status: 402, error: 'x' }, phases: [] });
  assert.deepEqual([degraded.outcome, degraded.degraded, degraded.ok, degraded.stopped], ['degraded', 2, true, undefined]);
  const stopped = log({ ok: false, fatal: true, status: 499, phases: [] });
  assert.deepEqual([stopped.outcome, stopped.stopped, stopped.ok], ['stopped', true, false]);
  assert.deepEqual([log({ ok: false }).outcome, log({ ok: false }).phases], ['failed', []]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { STOPPED_STATUS, FATAL_STATUS, OpenRouterError, createOpenRouterClient, deadlineFromEnv, runSignal } from '../image/openrouter.mjs';
import { createRoleCaller } from '../write/llm.mjs';

const require = createRequire(import.meta.url);
const { planPatch } = require('../../patches/lib/apply-targets.js');
const { TARGETS } = require('../../patches/patch-pipeline-abort.js');

// A fetch that never answers on its own: it ends when its signal does.
const hangingFetch = (calls = []) => (url, { signal }) => new Promise((_, reject) => {
  calls.push(url);
  signal.addEventListener('abort', () => reject(signal.reason));
});

test('a client whose signal is already aborted makes no request and fails with the stop status', async () => {
  const calls = [];
  const client = createOpenRouterClient({ apiKey: 'k', fetchImpl: hangingFetch(calls), signal: AbortSignal.abort() });
  await assert.rejects(client.chat({}), (err) => err instanceof OpenRouterError && err.status === STOPPED_STATUS && /request was closed/.test(err.message));
  assert.equal(calls.length, 0);
});

test('a request in flight is aborted when the signal fires, and the call fails with the stop status', async () => {
  const calls = [];
  const controller = new AbortController();
  const client = createOpenRouterClient({ apiKey: 'k', fetchImpl: hangingFetch(calls), signal: controller.signal });
  const pending = client.chat({});
  controller.abort();
  await assert.rejects(pending, (err) => err.status === STOPPED_STATUS);
  assert.equal(calls.length, 1);
});

test('a signal that ended by its deadline says so', async () => {
  // AbortSignal.timeout's timer is unref'd: with a fetch that never settles, Node 22 ends the event loop and cancels the file
  const deadline = new AbortController();
  setTimeout(() => deadline.abort(new DOMException('The operation timed out.', 'TimeoutError')), 5);
  const client = createOpenRouterClient({ apiKey: 'k', fetchImpl: hangingFetch(), signal: deadline.signal });
  await assert.rejects(client.chat({}), (err) => err.status === STOPPED_STATUS && /time limit/.test(err.message));
});

test('a client without a signal keeps its own timeout only', async () => {
  const client = createOpenRouterClient({ apiKey: 'k', fetchImpl: async () => ({ ok: true, text: async () => '{"data":[]}' }) });
  assert.deepEqual(await client.models(), []);
});

test('a stopped run ends a role call at once: fatal, no other model is tried', async () => {
  const calls = [];
  const client = createOpenRouterClient({ apiKey: 'k', fetchImpl: hangingFetch(calls), signal: AbortSignal.abort() });
  const call = createRoleCaller({ client, sleep: async () => {} });
  const r = await call('draft', { system: 's', user: 'u' }, { chain: ['a/one', 'b/two', 'c/three'], maxTokens: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.fatal, true);
  assert.equal(r.status, STOPPED_STATUS);
  assert.equal(r.attempts.length, 1);
  assert.ok(FATAL_STATUS.has(STOPPED_STATUS));
});

test('FANE_DEADLINE_MIN: minutes, 30 by default, 0 means none', () => {
  assert.equal(deadlineFromEnv({}), 30 * 60_000);
  assert.equal(deadlineFromEnv({ FANE_DEADLINE_MIN: '' }), 30 * 60_000);
  assert.equal(deadlineFromEnv({ FANE_DEADLINE_MIN: '5' }), 5 * 60_000);
  assert.equal(deadlineFromEnv({ FANE_DEADLINE_MIN: '0' }), 0);
  assert.equal(deadlineFromEnv({ FANE_DEADLINE_MIN: 'abc' }), 30 * 60_000);
  assert.equal(deadlineFromEnv({ FANE_DEADLINE_MIN: '-3' }), 30 * 60_000);
});

test('runSignal: follows the request, ends at the deadline, and is absent when there is neither', async () => {
  assert.equal(runSignal(undefined, 0), undefined);
  const controller = new AbortController();
  const s = runSignal(controller.signal, 0);
  assert.equal(s.aborted, false);
  controller.abort();
  assert.equal(s.aborted, true);
  const timed = runSignal(undefined, 5);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(timed.aborted, true);
});

test('patch-pipeline-abort: the session keeps the signal and every installed hook receives it, once', () => {
  const file = TARGETS[0].file;
  const route = 'function f(){H.handleArticleRequest(b.followUp,{lastAnswer:async()=>1,mode:1});H.handleCodeRequest(b.followUp,{mode:1});H.handleImageRequest(b.followUp,{mode:1})}'
    + 'function g(){return n.searchAsync(o,{chatHistory:m,followUp:1})}';
  const first = planPatch({ [file]: route }, TARGETS);
  assert.deepEqual(first.errors, []);
  const out = first.next[file];
  assert.match(out, /return o\.faneSignal=a\.signal,n\.searchAsync\(o,/);
  for (const fn of ['handleArticleRequest', 'handleCodeRequest', 'handleImageRequest']) assert.ok(out.includes(`${fn}(b.followUp,{signal:a.faneSignal,`), fn);
  assert.ok(first.skipped.some(s => /handleBrainstormRequest/.test(s)), 'a hook that is not installed is skipped');
  const second = planPatch(first.next, TARGETS);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.applied, []);
});

// ---- run log (core/runlog.mjs) ----
import { beginRun, promptVersion, runSummary } from '../core/runlog.mjs';

test('runSummary: one JSON line with the feature, the end, the cost and each phase', () => {
  const line = runSummary('code', { ok: true, mode: 'balanced', calls: 7, cost: 0.123456, phases: [{ phase: 'spec', status: 'ok', ms: 1200 }, { phase: 'generate', file: 'a.js', status: 'fallback', ms: 3400 }] }, { id: 'ab12cd34', ms: 9000, prompts: { x: () => 1 } });
  const s = JSON.parse(line);
  assert.deepEqual({ run: s.run, feature: s.feature, ok: s.ok, mode: s.mode, ms: s.ms, calls: s.calls, cost: s.cost }, { run: 'ab12cd34', feature: 'code', ok: true, mode: 'balanced', ms: 9000, calls: 7, cost: 0.1235 });
  assert.deepEqual(s.phases, ['spec=ok/1200ms', 'generate:a.js=fallback/3400ms']);
  assert.match(s.prompts, /^[0-9a-f]{8}$/);
  assert.equal(s.stopped, undefined);
});

test('runSummary: a stopped run says so, and a bare failure still logs', () => {
  assert.equal(JSON.parse(runSummary('article', { ok: false, fatal: true, status: STOPPED_STATUS, phases: [] }, { ms: 5 })).stopped, true);
  const bare = JSON.parse(runSummary('image', { ok: false }, { ms: 1 }));
  assert.equal(bare.ok, false);
  assert.deepEqual(bare.phases, []);
});

test('promptVersion changes when a prompt does, and not otherwise', () => {
  const a = promptVersion({ draft: (t) => `write ${t}`, rule: 'be brief' });
  assert.equal(a, promptVersion({ draft: (t) => `write ${t}`, rule: 'be brief' }));
  assert.notEqual(a, promptVersion({ draft: (t) => `write ${t}`, rule: 'be long' }));
});

test('beginRun: every line carries the run id, and finish writes the summary under it', () => {
  const lines = [];
  const run = beginRun('brainstorm', (m) => lines.push(m));
  run.log('a model failed');
  run.finish({ ok: true, cost: 0.01, phases: [] });
  assert.equal(lines.length, 2);
  assert.ok(lines.every(l => l.startsWith(`[${run.id}] `)));
  assert.equal(JSON.parse(lines[1].slice(run.id.length + 3)).run, run.id);
});

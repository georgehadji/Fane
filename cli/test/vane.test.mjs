import { test } from 'node:test';
import assert from 'node:assert/strict';

// DEFAULTS read the environment at import time, so clear it first.
for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { parseCli, resolveModel, findOpenRouterProvider, autoRoute } = await import('../vane.mjs');

test('a query routed to images or articles has its options checked as if --image/--article was typed', () => {
  const route = (...argv) => autoRoute(parseCli(argv), argv);
  assert.deepEqual(route('make an image of a fox', '--image-model', 'a/x,b/y')['image-model'], ['a/x', 'b/y']);
  assert.throws(() => route('make an image of a fox', '-n', 'abc'), /Invalid --count/);
  assert.throws(() => route('make an image of a fox', '--tier', 'bogus'), /Invalid --tier/);
  assert.deepEqual(route('write an article about tides', '--article-model', 'a/x,b/y')['article-model'], ['a/x', 'b/y']);
  assert.throws(() => route('write an article about tides', '--lang', 'de'), /Invalid --lang/);
  assert.equal(route('write an article about tides').article, true);
  assert.equal(route('make an image of a fox', '--no-auto-image'), null);
  assert.equal(route('what is tidal power'), null);
});

const providers = [
  { id: 'p1', name: 'Anthropic', chatModels: [{ key: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }, { key: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }], embeddingModels: [] },
  { id: 'p2', name: 'Openrouter Fane', chatModels: [{ key: 'gpt-5', name: 'GPT 5' }, { key: 'gpt-5-mini', name: 'GPT 5 Mini' }], embeddingModels: [{ key: 'emb-small', name: 'Embedding Small' }] },
];

test('parseCli defaults', () => {
  const o = parseCli(['hello', 'world']);
  assert.equal(o.query, 'hello world');
  assert.deepEqual(o.sources, ['web']);
  assert.equal(o.mode, 'speed');
  assert.equal(o.modelExplicit, false);
  assert.equal(o.timeoutMs, 180_000);
});

test('parseCli timeout depends on mode unless given', () => {
  assert.equal(parseCli(['q', '-o', 'quality']).timeoutMs, 600_000);
  assert.equal(parseCli(['q', '-o', 'quality', '-t', '90']).timeoutMs, 90_000);
  assert.equal(parseCli(['q', '-o', 'balanced']).timeoutMs, 180_000);
});

test('parseCli: --tier premium researches in quality mode, so it gets the long timeout', () => {
  for (const flag of ['--article', '--code', '--brainstorm']) {
    assert.equal(parseCli([flag, '--tier', 'premium', 'x']).timeoutMs, 600_000, flag);
    assert.equal(parseCli([flag, '--tier', 'premium', '-t', '90', 'x']).timeoutMs, 90_000, flag);
    assert.equal(parseCli([flag, '--tier', 'value', 'x']).timeoutMs, 180_000, flag);
  }
});

test('parseCli marks -m as explicit', () => {
  const o = parseCli(['q', '-m', 'gpt-5']);
  assert.equal(o.model, 'gpt-5');
  assert.equal(o.modelExplicit, true);
});

test('parseCli rejects bad input', () => {
  assert.throws(() => parseCli(['q', '-s', 'web,bogus']), /Invalid source/);
  assert.throws(() => parseCli(['q', '-o', 'turbo']), /Invalid mode/);
  assert.throws(() => parseCli(['q', '-t', '0']), /Invalid timeout/);
  assert.throws(() => parseCli(['q', '--stream', '--json']), /cannot be combined/);
});

test('resolveModel: exact key, exact name, unique partial', () => {
  assert.equal(resolveModel(providers, 'chatModels', 'gpt-5').key, 'gpt-5');
  assert.equal(resolveModel(providers, 'chatModels', 'claude haiku 5.5').key, 'claude-haiku-5-5');
  assert.equal(resolveModel(providers, 'chatModels', 'sonnet').key, 'claude-sonnet-5-5');
  assert.equal(resolveModel(providers, 'chatModels', 'gpt-5').providerId, 'p2');
});

test('resolveModel: ambiguous vs no match', () => {
  assert.throws(() => resolveModel(providers, 'chatModels', 'claude'), (e) => /Ambiguous/.test(e.message) && e.noMatch === false);
  assert.throws(() => resolveModel(providers, 'chatModels', 'openai/gpt-4o'), (e) => /Unknown chat model/.test(e.message) && e.noMatch === true);
});

test('findOpenRouterProvider', () => {
  assert.equal(findOpenRouterProvider(providers).id, 'p2');
  assert.equal(findOpenRouterProvider(providers, 'anthropic').id, 'p1');
  assert.throws(() => findOpenRouterProvider(providers, 'nope'), /No Vane provider/);
  const two = [...providers, { id: 'p4', name: 'Openrouter', chatModels: [] }];
  assert.equal(findOpenRouterProvider(two, 'Openrouter').id, 'p4'); // exact name beats substring matches
  assert.throws(() => findOpenRouterProvider([...providers, { id: 'p3', name: 'OpenRouter 2', chatModels: [] }]), /More than one/);
});

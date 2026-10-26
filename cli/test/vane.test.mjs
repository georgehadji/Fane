import { test } from 'node:test';
import assert from 'node:assert/strict';

// DEFAULTS read the environment at import time, so clear it first.
for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { parseCli, resolveModel, findOpenRouterProvider } = await import('../vane.mjs');

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
  assert.throws(() => findOpenRouterProvider([...providers, { id: 'p3', name: 'OpenRouter 2', chatModels: [] }]), /More than one/);
});

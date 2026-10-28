import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FREE_MODEL, OpenRouterError, findFreeLlm, modelClientFor, openRouterClientFromVane, openRouterNeeded, withFreeLlm } from '../image/openrouter.mjs';
import { createRoleCaller } from '../write/llm.mjs';
import { handleArticleRequest } from '../write/vane-hook.mjs';
import { handleImageRequest } from '../image/vane-hook.mjs';

const OPENROUTER = { name: 'OpenRouter', config: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or' } };
const FREE = { name: 'Free', config: { baseURL: 'http://host.docker.internal:3001/v1/', apiKey: 'freellmapi-abc' } };
const reply = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });

// A fetch that records each call and answers with `answer(url, body)`; freellmapi names the model it routed to.
function fakeFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, auth: init.headers.Authorization });
    const out = await answer(url, body);
    return { ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'x-routed-via': 'groq/llama-3.3-70b' }), text: async () => JSON.stringify(out) };
  };
  return { calls, fetchImpl };
}

test('findFreeLlm: the Vane provider whose key starts with freellmapi-, its Base URL without the trailing slash', () => {
  assert.deepEqual(findFreeLlm([OPENROUTER, FREE]), { apiKey: 'freellmapi-abc', baseUrl: 'http://host.docker.internal:3001/v1' });
  assert.equal(findFreeLlm([OPENROUTER]), null);
  assert.equal(findFreeLlm([{ config: { apiKey: 'freellmapi-abc' } }]), null); // no Base URL
});

test('modelClientFor: null without providers, the plain OpenRouter client without freellmapi, else one that routes by free:', async () => {
  assert.equal(modelClientFor([]), null);
  assert.equal(modelClientFor([OPENROUTER]).freeLlm, undefined);
  assert.equal(modelClientFor([FREE]).freeLlm, 'only');
  assert.equal(modelClientFor([OPENROUTER, FREE]).freeLlm, 'fallback');
  assert.equal(modelClientFor([FREE], { apiKey: 'sk-env' }).freeLlm, 'fallback'); // an OpenRouter key from the environment

  const { calls, fetchImpl } = fakeFetch(() => reply('ok'));
  const client = modelClientFor([OPENROUTER, FREE], { fetchImpl });
  await client.chat({ model: 'free:auto:smart', usage: { include: true }, reasoning: { effort: 'low' }, messages: [] });
  await client.chat({ model: 'alpha/m1', usage: { include: true }, messages: [] });
  assert.equal(calls[0].url, 'http://host.docker.internal:3001/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer freellmapi-abc');
  assert.deepEqual(calls[0].body, { model: 'auto:smart', reasoning: { effort: 'low' }, messages: [] }); // no OpenRouter usage field
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[1].auth, 'Bearer sk-or');
  assert.deepEqual(calls[1].body.usage, { include: true });

  const host = fakeFetch(() => reply('ok'));
  await modelClientFor([FREE], { fetchImpl: host.fetchImpl, freeBaseUrl: (u) => u.replace('//host.docker.internal', '//127.0.0.1') }).complete('free:auto', 's', 'u');
  assert.equal(host.calls[0].url, 'http://127.0.0.1:3001/v1/chat/completions');
  assert.equal(host.calls[0].body.model, 'auto');
});

test('with freellmapi alone, an OpenRouter model fails like a missing model (the chain moves on) and images are refused', async () => {
  const client = modelClientFor([FREE], { fetchImpl: fakeFetch(() => reply('ok')).fetchImpl });
  await assert.rejects(client.chat({ model: 'alpha/m1', messages: [] }), (err) => err instanceof OpenRouterError && err.status === 404);
  await assert.rejects(client.images({ model: 'flux' }), /no OpenRouter provider/);
  assert.deepEqual(await client.models(), []);
});

test('openRouterClientFromVane finds freellmapi in Vane\'s config.json', async () => {
  const cfg = (providers) => async () => JSON.stringify({ modelProviders: providers });
  assert.equal((await openRouterClientFromVane({ readConfig: cfg([FREE]) })).freeLlm, 'only');
  assert.equal(await openRouterClientFromVane({ readConfig: cfg([]) }), null);
});

test('withFreeLlm: freellmapi alone serves every role, next to OpenRouter it ends every chain, and stands in when nothing passed the trial', async () => {
  const only = (models) => ({ draft: models, outline: models });
  const chosen = { chains: { draft: ['a/1', 'b/2'], outline: ['b/2'] }, prices: { 'a/1': { in: 1, out: 2 } } };
  assert.deepEqual(await withFreeLlm({ freeLlm: 'only' }, 'quality', () => { throw new Error('never asked'); }, only), { chains: { draft: ['free:auto:smart'], outline: ['free:auto:smart'] }, prices: {} });
  assert.deepEqual((await withFreeLlm({ freeLlm: 'fallback' }, 'speed', async () => chosen, only)).chains, { draft: ['a/1', 'b/2', 'free:auto:fast'], outline: ['b/2', 'free:auto:fast'] });
  assert.deepEqual((await withFreeLlm({ freeLlm: 'fallback' }, 'balanced', async () => null, only)).chains.draft, [FREE_MODEL.balanced]);
  assert.equal(await withFreeLlm({}, 'balanced', async () => chosen, only), chosen); // OpenRouter alone: unchanged
  assert.equal(await withFreeLlm({}, 'balanced', async () => null, only), null);
  assert.equal((await withFreeLlm({ freeLlm: 'only' }, 'turbo', null, only)).chains.draft[0], 'free:auto'); // an unknown mode is Balanced
});

test('createRoleCaller: no OpenRouter credits move the run to the free: models, which report the model freellmapi chose', async () => {
  const asked = [];
  const client = {
    chat: async (body) => {
      asked.push(body.model);
      if (!body.model.startsWith('free:')) throw new OpenRouterError('402 no credits', 402);
      return { ...reply('An answer.'), routedVia: 'groq/llama-3.3-70b' };
    },
  };
  const call = createRoleCaller({ client });
  const r = await call('draft', { system: 's', user: 'u' }, { chain: ['a/1', 'b/2', 'free:auto'], maxTokens: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'free:groq/llama-3.3-70b');
  assert.equal(r.cost, 0);
  const again = await call('polish', { system: 's', user: 'u' }, { chain: ['a/1', 'free:auto'], maxTokens: 100 });
  assert.equal(again.ok, true);
  assert.deepEqual(asked, ['a/1', 'free:auto', 'free:auto']); // b/2 and the second a/1 were not asked: OpenRouter is out for the run
  const paidOnly = await call('copy',{ system: 's', user: 'u' }, { chain: ['a/1'], maxTokens: 100 });
  assert.equal(paidOnly.fatal, true);
  assert.match(paidOnly.errors[0], /a\/1: 402 no credits/);
});

test('createRoleCaller: a 402 with no free: model left, or a stopped run, still stops', async () => {
  const client = { chat: async () => { throw new OpenRouterError('402 no credits', 402); } };
  assert.equal((await createRoleCaller({ client })('draft', { system: 's', user: 'u' }, { chain: ['a/1', 'b/2'], maxTokens: 100 })).fatal, true);
  const asked = [];
  const stopped = { chat: async (body) => { asked.push(body.model); throw new OpenRouterError('stopped', 499); } };
  assert.equal((await createRoleCaller({ client: stopped })('draft', { system: 's', user: 'u' }, { chain: ['a/1', 'free:auto'], maxTokens: 100 })).fatal, true);
  assert.deepEqual(asked, ['a/1']);
});

test('the article hook writes on freellmapi when Vane has no OpenRouter provider', async () => {
  const SOURCES = [
    { title: 'Tidal energy in Orkney', url: 'https://example.org/a', content: 'The Orkney site supplied 1,200 homes.' },
    { title: 'Costs of marine power', url: 'https://example.org/b', content: 'Costs fell by 40%.' },
    { title: 'Wind versus tide', url: 'https://example.org/c', content: 'Tides are predictable.' },
  ];
  const sentence = 'Tidal turbines in Orkney supplied about 1,200 homes last winter';
  const draft = `# Tides at work\n\n## Case\n\n${Array.from({ length: 30 }, (_, i) => `${sentence} and the crews learned the work [${(i % 3) + 1}].`).join(' ')}`;
  const { calls, fetchImpl } = fakeFetch((url, body) => {
    const sys = body.messages[0].content;
    if (sys.includes('planning a researched article')) return reply(JSON.stringify({ title: 'T', sections: [{ heading: 'h', points: [], sources: [1], words: 300 }] }));
    return reply(draft);
  });
  const blocks = new Map();
  const handled = await handleArticleRequest('write an article about tidal power', {
    emit: (x) => { blocks.set('b1', x); return 'b1'; }, update: (id, x) => blocks.set(id, x),
    mode: 'speed', client: modelClientFor([FREE], { fetchImpl }), trial: {}, research: async () => SOURCES, log: () => {},
  });
  assert.equal(handled, true);
  assert.ok(blocks.get('b1').startsWith('# Tides at work'));
  assert.ok(calls.length >= 2);
  assert.ok(calls.every(c => c.url.startsWith('http://host.docker.internal:3001/v1/') && c.body.model === 'auto:fast' && !('usage' in c.body)));
});

test('the image hook still asks for OpenRouter when Vane has only freellmapi; the text features name freellmapi', async () => {
  const blocks = new Map();
  await handleImageRequest('make an image of a red fox', {
    emit: (x) => { blocks.set('b1', x); return 'b1'; }, update: (id, x) => blocks.set(id, x),
    readConfig: async () => JSON.stringify({ modelProviders: [FREE] }), store: null, log: () => {},
  });
  assert.match(blocks.get('b1'), /Image generation needs an OpenRouter provider/);
  assert.doesNotMatch(blocks.get('b1'), /freellmapi/);
  assert.match(openRouterNeeded('Code writing', { free: true }), /freellmapi provider works too .*freellmapi-…/);
});

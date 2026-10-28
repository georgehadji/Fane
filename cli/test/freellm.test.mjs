import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FREE_MODEL, OpenRouterError, findFreeLlm, modelClientFor, openRouterClientFromVane, openRouterNeeded, withFreeLlm } from '../image/openrouter.mjs';
import { createRoleCaller } from '../write/llm.mjs';
import { freeTrialCandidates, selectFreeChains } from '../write/catalogue.mjs';
import { handleArticleRequest } from '../write/vane-hook.mjs';
import { handleImageRequest } from '../image/vane-hook.mjs';

const OPENROUTER = { name: 'OpenRouter', config: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or' } };
const FREE = { name: 'Free', config: { baseURL: 'http://host.docker.internal:3001/v1/', apiKey: 'freellmapi-abc' } };
const reply = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });

// A fetch that records each chat call and answers with `answer(url, body)`; freellmapi names the model it routed
// to, and lists `ready` as the models it can serve now.
function fakeFetch(answer, ready = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (!body) return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: ready.map(id => ({ id })) }) };
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

test('withFreeLlm: freellmapi alone serves every role, next to OpenRouter its chains follow, and stand in when nothing passed the trial', async () => {
  const only = (models) => ({ draft: models, outline: models });
  const none = () => null;
  const ranked = (ready, last) => ({ chains: { draft: ['free:g', last], outline: ['free:h', last] }, prices: {} });
  const client = (freeLlm, ready = []) => ({ freeLlm, freeReady: async () => ready });
  const chosen = { chains: { draft: ['a/1', 'b/2'], outline: ['b/2'] }, prices: { 'a/1': { in: 1, out: 2 } } };
  const never = () => { throw new Error('never asked'); };
  assert.deepEqual(await withFreeLlm(client('only'), 'quality', { select: never, free: none, only }), { chains: { draft: ['free:auto:smart'], outline: ['free:auto:smart'] }, prices: {} });
  assert.deepEqual((await withFreeLlm(client('only'), 'quality', { select: never, free: ranked, only })).chains.draft, ['free:g', 'free:auto:smart']);
  assert.deepEqual((await withFreeLlm(client('fallback'), 'speed', { select: async () => chosen, free: none, only })).chains, { draft: ['a/1', 'b/2', 'free:auto:fast'], outline: ['b/2', 'free:auto:fast'] });
  assert.deepEqual((await withFreeLlm(client('fallback'), 'speed', { select: async () => chosen, free: ranked, only })).chains.outline, ['b/2', 'free:h', 'free:auto:fast']);
  assert.deepEqual((await withFreeLlm(client('fallback'), 'balanced', { select: async () => null, free: none, only })).chains.draft, [FREE_MODEL.balanced]);
  // OpenRouter's catalogue down: the free chains serve alone
  assert.deepEqual((await withFreeLlm(client('fallback'), 'speed', { select: async () => { throw new Error('fetch failed'); }, free: ranked, only })).chains.draft, ['free:g', 'free:auto:fast']);
  assert.equal(await withFreeLlm({}, 'balanced', { select: async () => chosen, free: never, only }), chosen); // OpenRouter alone: unchanged
  assert.equal(await withFreeLlm({}, 'balanced', { select: async () => null, free: never, only }), null);
  assert.equal((await withFreeLlm(client('only'), 'turbo', { select: never, free: none, only })).chains.draft[0], 'free:auto'); // an unknown mode is Balanced
  // what freellmapi can serve reaches the free choice; a failing list is null (no filter)
  const seen = [];
  await withFreeLlm(client('only', ['free:g']), 'speed', { select: never, free: (ready) => { seen.push(ready); return null; }, only });
  await withFreeLlm({ freeLlm: 'only', freeReady: async () => { throw new Error('down'); } }, 'speed', { select: never, free: (ready) => { seen.push(ready); return null; }, only });
  assert.deepEqual(seen, [['free:g'], null]);
});

test('selectFreeChains: the free models that passed, best score first, each role from its own place, ending in the router entry', () => {
  const pass = (score, json = true) => ({ en: { ok: true, score }, el: { ok: false }, json: { ok: json } });
  const trial = {
    'free:a': pass(3), 'free:b': pass(1), 'free:c': pass(2, false), 'free:gone': pass(0),
    'free:bad': { en: { ok: false, score: 0 }, json: { ok: true } },
    'alpha/m1': pass(0), // an OpenRouter model of the same trial: not free
  };
  const ready = ['free:a', 'free:b', 'free:c', 'free:bad'];
  const r = selectFreeChains(trial, ready, { lang: 'en', roles: ['draft', 'critique'], jsonRoles: new Set(['critique', 'queries']), last: 'free:auto' });
  assert.equal(r.pool, 3); // free:gone is not ready now, free:bad failed, alpha/m1 is not free
  assert.deepEqual(r.chains.draft, ['free:b', 'free:c', 'free:a', 'free:auto']);
  assert.deepEqual(r.chains.critique, ['free:a', 'free:b', 'free:auto']); // JSON role: free:c failed the JSON check; second role starts one further
  assert.deepEqual(r.chains.queries, ['free:b', 'free:a', 'free:auto']);
  assert.deepEqual(r.prices, {});
  assert.equal(selectFreeChains(trial, null, { lang: 'en', last: 'free:auto' }).pool, 4); // no ready list: every free model that passed
  assert.equal(selectFreeChains(trial, ready, { lang: 'el', last: 'free:auto' }), null);
  assert.equal(selectFreeChains({}, ready, { last: 'free:auto' }), null);
});

test('freeTrialCandidates: no router entries or non-text models; code specialists only for the coding trial', () => {
  const ready = ['free:auto', 'free:fusion', 'free:iterative-critique', 'free:claude-opus-4-5', 'free:gemini-3.8-flash', 'free:mistral-code-fim', 'free:nemotron-3.5-content-safety', 'free:voxtral-small', 'free:north-mini-code', 'free:gemma-4-31b'];
  assert.deepEqual(freeTrialCandidates(ready), ['free:gemini-3.8-flash', 'free:gemma-4-31b']);
  assert.deepEqual(freeTrialCandidates(ready, { code: true }), ['free:gemini-3.8-flash', 'free:north-mini-code', 'free:gemma-4-31b']);
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

  // with free models that passed the trial and are ready, those write, best first, instead of the router entry
  const ranked = fakeFetch((url, body) => (body.messages[0].content.includes('planning a researched article')
    ? reply(JSON.stringify({ title: 'T', sections: [{ heading: 'h', points: [], sources: [1], words: 300 }] })) : reply(draft)), ['gemma-4-31b', 'gemini-3.8-flash']); // freellmapi's own ids
  const pass = (score) => ({ en: { ok: true, score }, json: { ok: true } });
  await handleArticleRequest('write an article about tidal power', {
    emit: () => 'b1', update: () => {}, mode: 'speed', client: modelClientFor([FREE], { fetchImpl: ranked.fetchImpl }),
    trial: { 'free:gemini-3.8-flash': pass(1), 'free:gemma-4-31b': pass(4), 'free:gone': pass(0) }, research: async () => SOURCES, log: () => {},
  });
  const draftCall = ranked.calls.find(c => c.body.messages[0].content.includes('senior journalist'));
  assert.equal(draftCall.body.model, 'gemini-3.8-flash');
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

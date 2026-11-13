// X posts through xAI's x_search (cli/write/xsearch.mjs) and the patch that adds them to Vane's Social source
// (patches/patch-x-search.js). The network is never touched: fetch and the config are injected, and the patched tool
// text is run against a stub module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_X_MODEL, MAX_POSTS, XAI_URL, createXSearch, findXaiKey, parseResponse, searchX, toResults, xRequest } from '../write/xsearch.mjs';

const require = createRequire(import.meta.url);

const body = (text, annotations = []) => ({ output: [{ type: 'custom_tool_call', name: 'x_keyword_search' }, { type: 'message', content: [{ type: 'output_text', text, annotations }] }] });
const post = (n, extra = {}) => ({ url: `https://x.com/user${n}/status/${1000 + n}`, text: `post ${n}`, date: '2026-11-12', ...extra });

// ---- the key ----

test('findXaiKey: the provider whose Base URL is api.x.ai, with a key; nothing else', () => {
  const providers = [
    { config: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'or-key' } },
    { config: { baseURL: 'https://api.x.ai/v1', apiKey: '' } },
    { config: { baseURL: 'https://api.x.ai/v1/', apiKey: 'xai-key' } },
  ];
  assert.equal(findXaiKey(providers), 'xai-key');
  assert.equal(findXaiKey([providers[0], providers[1]]), null);
  assert.equal(findXaiKey(undefined), null);
});

// ---- the request ----

test('xRequest: one x_search tool, the queries (three at most) in the prompt, nothing stored', () => {
  const r = xRequest(['solar power', 'solar power', 'heat pumps', 'a', 'b'], 'grok-test');
  assert.equal(r.model, 'grok-test');
  assert.deepEqual(r.tools, [{ type: 'x_search' }]);
  assert.equal(r.store, false);
  assert.match(r.input[0].content, /"solar power"; "heat pumps"; "a"\./); // deduplicated, three
  assert.doesNotMatch(r.input[0].content, /"b"/);
  assert.equal(xRequest(['q']).model, DEFAULT_X_MODEL);
});

// ---- the response ----

test('parseResponse: the JSON array of posts, trimmed and typed; HTML and control characters go', () => {
  const out = parseResponse(body(`Here you go:\n[${JSON.stringify(post(1, { text: '<b>bold</b>\u0007 text   here', date: '2026-11-12T10:00:00Z' }))}]`));
  assert.deepEqual(out, [{ url: 'https://x.com/user1/status/1001', text: 'bold text here', date: '2026-11-12' }]);
  assert.deepEqual(parseResponse(body('[]')), []);
  assert.deepEqual(parseResponse(undefined), []);
  assert.deepEqual(parseResponse({ output: 'nope' }), []);
});

test('parseResponse: only post URLs, deduplicated, at most MAX_POSTS, text cut', () => {
  const posts = [post(1), post(1, { url: 'https://twitter.com/user1/status/1001?s=20' }), { url: 'https://x.com/user1', text: 'a profile' }, { url: 'https://evil.example/x.com/a/status/1', text: 'x' }, ...Array.from({ length: 12 }, (_, i) => post(i + 10))];
  const out = parseResponse(body(JSON.stringify(posts)));
  assert.equal(out.length, MAX_POSTS);
  assert.deepEqual(out.map(p => p.url).slice(0, 2), ['https://x.com/user1/status/1001', 'https://x.com/user10/status/1010']); // the twitter.com copy and the profile are gone
  assert.ok(out.every(p => /^https:\/\/x\.com\/\w+\/status\/\d+$/.test(p.url)));
  assert.ok(parseResponse(body(JSON.stringify([post(99, { text: 'w'.repeat(900) })])))[0].text.length <= 400);
});

test('parseResponse: when the response cites its sources, a post it did not cite is dropped', () => {
  const cited = [{ type: 'url_citation', url: 'https://x.com/user1/status/1001' }];
  const out = parseResponse(body(JSON.stringify([post(1), post(2)]), cited));
  assert.deepEqual(out.map(p => p.url), ['https://x.com/user1/status/1001']);
  // no citations at all: nothing to check against, the posts stay
  assert.equal(parseResponse(body(JSON.stringify([post(1), post(2)]))).length, 2);
});

test('parseResponse: xAI cites x.com/i/status/<id> while the text links x.com/<handle>/status/<id>: posts match by id', () => {
  // the shape a live call returned on 2026-11-13: every post was dropped when the urls were compared as strings
  const cited = [{ type: 'url_citation', url: 'https://x.com/i/status/1001' }, { type: 'url_citation', url: 'https://x.com/i/status/1003' }];
  const out = parseResponse(body(JSON.stringify([post(1), post(2), post(3)]), cited));
  assert.deepEqual(out.map(p => p.url), ['https://x.com/user1/status/1001', 'https://x.com/user3/status/1003']); // post 2 was not cited
});

test('parseResponse: prose instead of JSON falls back to the status links in it, with no text (so no source)', () => {
  const out = parseResponse(body('I found https://x.com/ann/status/55 and (https://x.com/bob/status/56).'));
  assert.deepEqual(out.map(p => p.url), ['https://x.com/ann/status/55', 'https://x.com/bob/status/56']);
  assert.deepEqual(toResults(out), []); // a post with no text is not a source
});

test('toResults: Vane\'s result shape, labelled like the other social results', () => {
  assert.deepEqual(toResults([{ url: 'https://x.com/ann/status/55', text: 'hello', date: '2026-11-12' }, { url: 'https://x.com/bob/status/56', text: 'no date', date: '' }]), [
    { content: '[X | 2026-11-12] hello', metadata: { url: 'https://x.com/ann/status/55', title: 'X post by @ann' } },
    { content: '[X] no date', metadata: { url: 'https://x.com/bob/status/56', title: 'X post by @bob' } },
  ]);
});

// ---- the call ----

const okFetch = (posts) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => body(JSON.stringify(posts)) }; }; f.calls = calls; return f; };

test('createXSearch: one POST with the key, the model and the tool; the key never reaches the log', async () => {
  const fetchImpl = okFetch([post(1)]);
  const logs = [];
  const search = createXSearch({ fetchImpl, readKey: async () => 'xai-secret', model: 'grok-test', log: (m) => logs.push(m) });
  const out = await search({ queries: ['solar'], block: {} });
  assert.equal(out.length, 1);
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, XAI_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer xai-secret');
  const sent = JSON.parse(init.body);
  assert.deepEqual([sent.model, sent.tools, sent.store], ['grok-test', [{ type: 'x_search' }], false]);
  assert.ok(!logs.join('\n').includes('xai-secret') && logs.length === 1);
});

test('createXSearch: no key, no research block, or no query means no call and no cost', async () => {
  const fetchImpl = okFetch([post(1)]);
  const keyed = createXSearch({ fetchImpl, readKey: async () => 'k' });
  assert.deepEqual(await createXSearch({ fetchImpl, readKey: async () => null })({ queries: ['q'], block: {} }), []);
  assert.deepEqual(await createXSearch({ fetchImpl, readKey: async () => { throw new Error('no config'); } })({ queries: ['q'], block: {} }), []);
  assert.deepEqual(await keyed({ queries: ['q'] }), []);
  assert.deepEqual(await keyed({ queries: ['q'], block: 'text' }), []);
  assert.deepEqual(await keyed({ queries: ['', '  '], block: {} }), []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('createXSearch: at most maxCalls per research block, each block counted on its own', async () => {
  const fetchImpl = okFetch([post(1)]);
  const search = createXSearch({ fetchImpl, readKey: async () => 'k', maxCalls: 2 });
  const a = {}, b = {};
  for (let i = 0; i < 4; i++) await search({ queries: ['q'], block: a });
  assert.equal(fetchImpl.calls.length, 2);
  await search({ queries: ['q'], block: b });
  assert.equal(fetchImpl.calls.length, 3);
  const off = createXSearch({ fetchImpl, readKey: async () => 'k', maxCalls: 0 });
  assert.deepEqual(await off({ queries: ['q'], block: {} }), []);
  assert.equal(fetchImpl.calls.length, 3);
});

test('createXSearch: an HTTP error, a thrown fetch and a timeout are [] and a log line, never a throw', async () => {
  const logs = [];
  const log = (m) => logs.push(m);
  assert.deepEqual(await createXSearch({ fetchImpl: async () => ({ ok: false, status: 429 }), readKey: async () => 'k', log })({ queries: ['q'], block: {} }), []);
  assert.deepEqual(await createXSearch({ fetchImpl: async () => { throw new Error('offline'); }, readKey: async () => 'k', log })({ queries: ['q'], block: {} }), []);
  // a real fetch keeps the event loop alive while it waits; AbortSignal.timeout's own timer does not (Node 20), so the stub holds it
  const slow = (url, { signal }) => new Promise((_, reject) => { const hold = setTimeout(() => {}, 5000); signal.addEventListener('abort', () => { clearTimeout(hold); reject(signal.reason); }); });
  assert.deepEqual(await createXSearch({ fetchImpl: slow, readKey: async () => 'k', timeoutMs: 20, log })({ queries: ['q'], block: {} }), []);
  assert.deepEqual(logs, ['x_search: HTTP 429', 'x_search failed: offline', 'x_search failed: timed out']);
});

test('searchX: reads the key from the Vane config it is given', async () => {
  const fetchImpl = okFetch([post(1)]);
  const readConfig = async () => JSON.stringify({ modelProviders: [{ config: { baseURL: 'https://api.x.ai/v1', apiKey: 'from-config' } }] });
  const out = await searchX({ queries: ['q'], block: {}, readConfig, fetchImpl, log: () => {}, env: { FANE_X_MODEL: 'grok-env' } });
  assert.equal(out.length, 1);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer from-config');
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).model, 'grok-env');
  const none = await searchX({ queries: ['q'], block: {}, readConfig: async () => JSON.stringify({ modelProviders: [] }), fetchImpl, log: () => {} });
  assert.deepEqual(none, []);
  assert.equal(fetchImpl.calls.length, 1);
});

// ---- the patch ----

test('patch-x-search: the social tool gets the call in its Promise.all, in either order with patch-social-sources, twice, and a missing module changes nothing', async () => {
  const { planPatch } = require('../../patches/lib/apply-targets.js');
  const social = require('../../patches/patch-social-sources.js');
  const x = require('../../patches/patch-x-search.js');
  const { FILES } = require('../../patches/lib/vane.js');
  const target = social.TARGETS.find(t => t.name === 'forum engines + Reddit via site search');
  const fresh = target.alts[0].from; // Vane's own text, which patch-social-sources replaces
  const file = FILES.research;
  const bundle = `module.exports=async(a,b,c,e)=>{${fresh}};`;

  const s1 = planPatch({ [file]: bundle }, [target]);
  assert.deepEqual(s1.errors, []);
  const x1 = planPatch(s1.next, x.TARGETS);
  assert.deepEqual([x1.errors, x1.applied.length], [[], 2]);
  // file order twice: neither patch changes the other's finished text
  assert.deepEqual(planPatch(x1.next, [target]).applied, [], 'social-sources sees its own marker');
  assert.deepEqual(planPatch(x1.next, x.TARGETS).applied, [], 'x-search twice');
  assert.equal(planPatch({ [file]: bundle }, x.TARGETS).errors.length > 0, true, 'without the social patch there is nothing to extend');

  // run it, the module stubbed
  const dir = mkdtempSync(join(tmpdir(), 'fane-x-'));
  writeFileSync(join(dir, 'ok.mjs'), 'export const searchX = async ({ queries, block }) => [{ content: "[X | 2026-11-12] hi " + queries[0], metadata: { url: "https://x.com/u/status/9", title: "X post by @u" }, seen: block }];');
  const patched = x1.next[file];
  assert.ok(patched.includes('searchX({queries:a.queries,block:c'));
  const k = async ({ queries }) => [{ metadata: { url: queries[0].startsWith('site:reddit.com') ? 'https://reddit.com/r/a' : queries[0].startsWith('site:x.com') ? 'https://x.com/h/status/1' : 'https://news.ycombinator.com/item?id=1' } }];
  const toolWith = (src) => { const m = { exports: null }; new Function('module', src)(m); return m.exports; };
  const block = {};
  const withStub = patched.replace('file:///fane/write/xsearch.mjs', pathToFileURL(join(dir, 'ok.mjs')).href);
  const res = await toolWith(withStub)({ queries: ['solar'] }, { llm: 1 }, block, { k });
  assert.deepEqual(res.results.map(r => r.metadata.url), ['https://news.ycombinator.com/item?id=1', 'https://reddit.com/r/a', 'https://x.com/h/status/1', 'https://x.com/u/status/9']);
  assert.equal(res.results[3].seen, block); // the research block is what the cap counts against

  // the module is missing: the tool answers as before
  const res2 = await toolWith(patched)({ queries: ['solar'] }, { llm: 1 }, block, { k });
  assert.equal(res2.results.length, 3);
});

test('patch-x-search: injected code is ASCII with no backticks', () => {
  const { TARGETS } = require('../../patches/patch-x-search.js');
  for (const t of TARGETS) for (const s of [t.from, t.to]) assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(s) && !s.includes('`'), t.name);
});

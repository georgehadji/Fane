// patch-discover-stories: the Discover route's story cache, repeat filter and picture finder
// (patches/patch-discover-stories.js). Clock, fetch and the search client are fakes; no network.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planPatch } = require('../../patches/lib/apply-targets.js');
const { FILES } = require('../../patches/lib/vane.js');
const { GREEK } = require('../../patches/patch-discover-greek.js');
const stories = require('../../patches/patch-discover-stories.js');
const { TARGETS, STORIES_CACHE, DEDUPE_STORIES, FILL_THUMBNAILS, GREEK_HOSTS } = stories;

const quiet = () => mock.method(console, 'log', () => {});

// ---- STORIES_CACHE ----

function clock(start = 1_000_000) {
  let t = start;
  const c = { now: () => t, tick: (ms) => { t += ms; } };
  return c;
}
const MIN = 60_000;
const producer = (...lists) => {
  const p = { calls: 0 };
  p.fn = async () => { p.calls++; const l = lists[Math.min(p.calls, lists.length) - 1]; if (l instanceof Error) throw l; return l; };
  return p;
};
const settle = async (root, key) => { await root.faneStories[key].run; };

test('cache: empty entry waits for one refresh, fresh entry is served without the producer, concurrent requests share one run', async () => {
  const root = {}, c = clock(), p = producer([{ title: 'a' }]);
  const [x, y] = await Promise.all([STORIES_CACHE(root, 'k', p.fn, c), STORIES_CACHE(root, 'k', p.fn, c)]);
  assert.deepEqual([x, y, p.calls], [[{ title: 'a' }], [{ title: 'a' }], 1]);
  c.tick(9 * MIN);
  assert.deepEqual(await STORIES_CACHE(root, 'k', p.fn, c), [{ title: 'a' }]);
  assert.equal(p.calls, 1);
});

test('cache: a stale entry (10-60 min) is served at once and refreshed once in the background', async () => {
  const root = {}, c = clock(), p = producer([{ title: 'old' }], [{ title: 'new' }]);
  await STORIES_CACHE(root, 'k', p.fn, c);
  c.tick(11 * MIN);
  const [a, b] = [await STORIES_CACHE(root, 'k', p.fn, c), await STORIES_CACHE(root, 'k', p.fn, c)];
  assert.deepEqual([a, b], [[{ title: 'old' }], [{ title: 'old' }]]);
  assert.equal(p.calls, 2); // one background refresh, not two
  await settle(root, 'k');
  assert.deepEqual(await STORIES_CACHE(root, 'k', p.fn, c), [{ title: 'new' }]);
  assert.equal(p.calls, 2);
});

test('cache: a stale entry whose refresh fails or finds nothing keeps being served, and the next request tries again', async () => {
  const log = quiet();
  for (const bad of [new Error('bing down'), []]) {
    const root = {}, c = clock(), p = producer([{ title: 'old' }], bad, [{ title: 'new' }]);
    await STORIES_CACHE(root, 'k', p.fn, c);
    c.tick(11 * MIN);
    assert.deepEqual(await STORIES_CACHE(root, 'k', p.fn, c), [{ title: 'old' }]);
    await settle(root, 'k');
    assert.deepEqual(await STORIES_CACHE(root, 'k', p.fn, c), [{ title: 'old' }]); // still served; this request starts the third run
    await settle(root, 'k');
    assert.deepEqual(await STORIES_CACHE(root, 'k', p.fn, c), [{ title: 'new' }]);
    assert.equal(p.calls, 3);
  }
  log.mock.restore();
});

test('cache: an expired entry (over 60 min) waits for a refresh and is never served if that fails', async () => {
  const log = quiet();
  const root = {}, c = clock(), p = producer([{ title: 'old' }], new Error('down'), [{ title: 'new' }]);
  await STORIES_CACHE(root, 'k', p.fn, c);
  c.tick(61 * MIN);
  assert.deepEqual(await STORIES_CACHE(root, 'k', p.fn, c), []);
  assert.deepEqual(await STORIES_CACHE(root, 'k', p.fn, c), [{ title: 'new' }]);
  log.mock.restore();
});

test('cache: nothing is stored from an empty first run or a throw; keys are separate; the log line names the key', async () => {
  const log = quiet();
  const root = {}, c = clock(), p = producer([], new Error('boom'), [{ title: 'a' }]);
  assert.deepEqual(await STORIES_CACHE(root, 'tech', p.fn, c), []);
  assert.deepEqual(await STORIES_CACHE(root, 'tech', p.fn, c), []);
  assert.deepEqual(await STORIES_CACHE(root, 'tech', p.fn, c), [{ title: 'a' }]);
  const q = producer([{ title: 'b' }]);
  assert.deepEqual(await STORIES_CACHE(root, 'art', q.fn, c), [{ title: 'b' }]);
  assert.deepEqual(await STORIES_CACHE(root, 'tech', p.fn, c), [{ title: 'a' }]);
  assert.ok(log.mock.calls.every((x) => String(x.arguments[0]).startsWith('fane: discover tech: ')));
  log.mock.restore();
});

// ---- DEDUPE_STORIES ----

const s = (title, thumbnail, url = `https://x.test/${Math.random()}`) => ({ title, url, thumbnail });

test('dedupe: the same Greek story from two outlets (accents, case, one extra word) collapses; the first with a picture wins', () => {
  const a = s('Η Apple παρουσίασε το νέο iPhone: όλα όσα πρέπει να ξέρετε');
  const b = s('Η APPLE παρουσιασε το νεο iPhone όλα όσα πρέπει να ξέρετε σήμερα', 'https://img.test/b.jpg');
  const out = DEDUPE_STORIES([a, s('Αθλητικά νέα'), b]);
  assert.deepEqual(out.map((x) => x.title), [b.title, 'Αθλητικά νέα']); // b replaced a in a's place
  assert.equal(DEDUPE_STORIES([a, b]).length, 1);
});

test('dedupe: an English pair collapses, two different stories that share a name stay apart, empty titles are kept, and it is idempotent', () => {
  const a = s('Apple unveils iPhone 17 with a new camera', 'https://i/a.jpg');
  const b = s('Apple unveils the iPhone 17 with new camera!');
  const c = s('Apple unveils new iPad lineup');
  const d = s('Apple earnings beat estimates');
  assert.deepEqual(DEDUPE_STORIES([a, b]).map((x) => x.title), [a.title]);
  assert.equal(DEDUPE_STORIES([a, c, d]).length, 3);
  const blank = [s(''), s(''), { url: 'https://x.test/n' }];
  assert.equal(DEDUPE_STORIES(blank).length, 3);
  const once = DEDUPE_STORIES([a, b, c, d, ...blank]);
  assert.deepEqual(DEDUPE_STORIES(once), once);
  assert.deepEqual(DEDUPE_STORIES(undefined), []);
});

test('dedupe: a duplicate without a picture never replaces one with a picture, and order is kept', () => {
  const a = s('Greece wins the European basketball title', 'https://i/a.jpg');
  const b = s('Greece wins European basketball title');
  const z = s('Totally different topic here');
  assert.deepEqual(DEDUPE_STORIES([z, a, b]).map((x) => x.title), [z.title, a.title]);
});

// ---- FILL_THUMBNAILS ----

const page = (head, extra = {}) => ({ ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => `<html><head>${head}</head><body></body></html>`, ...extra });
const og = (u) => `<meta property="og:image" content="${u}">`;
function web(map) {
  const log = [];
  const fetchImpl = async (url, init) => { log.push([url, init]); const r = map[url]; if (r instanceof Error) throw r; return typeof r === 'function' ? r(init) : r; };
  return { fetchImpl, log };
}
const HOSTS = ['theatlantic.com', 'news247.gr'];
const bare = (url, title = 't') => ({ title, url });

test('fill: og:image is read (either attribute order, entities decoded), twitter:image is the fallback, a relative image becomes absolute', async () => {
  const w = web({
    'https://www.theatlantic.com/a': page('<meta content="https://cdn.test/a.jpg?x=1&amp;y=2" property="og:image">'),
    'https://news247.gr/b': page('<meta name="twitter:image" content="https://cdn.test/b.jpg"><meta property="og:title" content="x">'),
    'https://news247.gr/c': page("<meta property='og:image' content='/img/c.jpg'>"),
  });
  const items = [bare('https://www.theatlantic.com/a'), bare('https://news247.gr/b'), bare('https://news247.gr/c')];
  const out = await FILL_THUMBNAILS(items, { hosts: HOSTS, fetchImpl: w.fetchImpl });
  assert.deepEqual(out.map((x) => x.thumbnail), ['https://cdn.test/a.jpg?x=1&y=2', 'https://cdn.test/b.jpg', 'https://news247.gr/img/c.jpg']);
  // the page keeps origin + pathname only: a picture named in the query cannot load there, so the next candidate is used
  const q = web({
    'https://news247.gr/e': page(og('https://a2.espncdn.com/combiner/i?img=%2Fphoto%2F1.jpg') + '<meta name="twitter:image" content="https://cdn.test/e.jpg">'),
    'https://news247.gr/f': page(og('https://cdn.test/f.jpg?resize=1200,900')),
    'https://news247.gr/g': page(og('https://cdn.test/proxy?u=https://x.test/a.jpg')),
  });
  const got = await FILL_THUMBNAILS([bare('https://news247.gr/e'), bare('https://news247.gr/f'), bare('https://news247.gr/g')], { hosts: HOSTS, fetchImpl: q.fetchImpl });
  assert.deepEqual(got.map((x) => x.thumbnail), ['https://cdn.test/e.jpg', 'https://cdn.test/f.jpg?resize=1200,900', undefined]);
  assert.equal(items[0].thumbnail, undefined); // the input is not changed
});

test('fill: only https images, only the route\'s own sites, never a redirect, never a story that has a picture, at most `limit` pages', async () => {
  const w = web({
    'https://theatlantic.com/http-image': page(og('http://cdn.test/x.jpg')),
    'https://theatlantic.com/moved': { ok: false, status: 302, headers: { get: () => 'https://169.254.169.254/' }, text: async () => '' },
    'https://theatlantic.com/not-html': page(og('https://cdn.test/y.jpg'), { headers: { get: () => 'application/pdf' } }),
  });
  const items = [
    bare('https://theatlantic.com/http-image'), bare('https://theatlantic.com/moved'), { ...bare('https://theatlantic.com/has'), thumbnail: 'https://i/own.jpg' },
    bare('https://evil.test/x'), bare('https://theatlantic.com.evil.test/x'), bare('http://169.254.169.254/'), bare('https://nottheatlantic.com/x'),
    bare('https://theatlantic.com/not-html'), bare('not a url'),
  ];
  const out = await FILL_THUMBNAILS(items, { hosts: HOSTS, fetchImpl: w.fetchImpl });
  assert.deepEqual(out.map((x) => x.thumbnail), [undefined, undefined, 'https://i/own.jpg', undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(w.log.map(([u]) => u).sort(), ['https://theatlantic.com/http-image', 'https://theatlantic.com/moved', 'https://theatlantic.com/not-html']);
  assert.ok(w.log.every(([, init]) => init.redirect === 'manual'));

  const many = Array.from({ length: 30 }, (_, i) => bare(`https://theatlantic.com/p${i}`));
  const w2 = web(Object.fromEntries(many.map((m) => [m.url, page(og('https://cdn.test/z.jpg'))])));
  const out2 = await FILL_THUMBNAILS(many, { hosts: HOSTS, fetchImpl: w2.fetchImpl, limit: 12 });
  assert.deepEqual([w2.log.length, out2.filter((x) => x.thumbnail).length], [12, 12]);
});

test('fill: the page is read from a stream up to maxBytes only, and a meta tag after the cut is not seen', async () => {
  const enc = new TextEncoder();
  const body = (text) => {
    const chunks = [enc.encode(text.slice(0, 40)), enc.encode(text.slice(40))];
    let i = 0;
    return { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => {} }) };
  };
  const early = `<head>${og('https://cdn.test/early.jpg')}</head>`;
  const late = `<head>${'x'.repeat(200)}${og('https://cdn.test/late.jpg')}</head>`;
  const w = web({ 'https://theatlantic.com/a': page('', { body: body(early) }), 'https://theatlantic.com/b': page('', { body: body(late) }) });
  const out = await FILL_THUMBNAILS([bare('https://theatlantic.com/a'), bare('https://theatlantic.com/b')], { hosts: HOSTS, fetchImpl: w.fetchImpl, maxBytes: 120 });
  assert.deepEqual(out.map((x) => x.thumbnail), ['https://cdn.test/early.jpg', undefined]);
});

test('fill: a slow page is cut by the stage budget and gives nothing, a failing page gives nothing, the rest still land', async () => {
  const w = web({
    'https://theatlantic.com/fast': page(og('https://cdn.test/fast.jpg')),
    'https://theatlantic.com/slow': (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    'https://theatlantic.com/down': new Error('ECONNRESET'),
  });
  const t0 = Date.now();
  const out = await FILL_THUMBNAILS([bare('https://theatlantic.com/slow'), bare('https://theatlantic.com/down'), bare('https://theatlantic.com/fast')], { hosts: HOSTS, fetchImpl: w.fetchImpl, budgetMs: 60, concurrency: 3 });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(out.map((x) => x.thumbnail), [undefined, undefined, 'https://cdn.test/fast.jpg']);
  const deaf = web({ 'https://theatlantic.com/a': () => new Promise(() => {}) }); // a fetch that ignores the signal
  const late = await FILL_THUMBNAILS([bare('https://theatlantic.com/a')], { hosts: HOSTS, fetchImpl: deaf.fetchImpl, budgetMs: 30 });
  assert.equal(late[0].thumbnail, undefined);
});

test('fill: nothing to fetch returns the same list without a request', async () => {
  const w = web({});
  const items = [{ ...bare('https://theatlantic.com/a'), thumbnail: 'https://i/a.jpg' }, bare('https://evil.test/x')];
  assert.equal(await FILL_THUMBNAILS(items, { hosts: HOSTS, fetchImpl: w.fetchImpl }), items);
  assert.equal(w.log.length, 0);
});

// ---- the patch ----

// The route as Vane, patch-discover-greek, -kleon and -medium leave it (their `from` strings), with a fake search client.
const SEARCH = 'd.links.flatMap(a=>d.query.map(async b=>(await (0,v.n)(`site:${a} ${b}`,{engines:["bing news"],pageno:1,language:"en"})).results))';
const ROUTE = `(async (b, d, v, c) => { let e=[]; if("normal"===c){let a=new Set;e=(await Promise.all(${SEARCH})).flat().filter(b=>{let c=b.url?.toLowerCase().trim();return!a.has(c)&&(a.add(c),!0)}).sort(()=>Math.random()-.5)}else e=(await (0,v.n)("single",{engines:["bing news"],pageno:1,language:"en"})).results;return e })`;
const greek = require('../../patches/patch-discover-greek.js');
const kleon = require('../../patches/patch-discover-kleon.js');
const medium = require('../../patches/patch-discover-medium.js');
const CHAIN = [greek.TARGETS, kleon.TARGETS, medium.TARGETS, TARGETS];

test('patch: the Discover patches chain in file order, twice is a no-op, and the insertion carries its marker', () => {
  let files = { [FILES.discoverRoute]: ROUTE };
  for (let pass = 0; pass < 2; pass++) {
    for (const targets of CHAIN) {
      const r = planPatch(files, targets);
      assert.deepEqual(r.errors, [], `pass ${pass}`);
      assert.equal(r.applied.length, pass === 0 ? targets.length : 0, `pass ${pass}`);
      files = { ...files, ...r.next };
    }
  }
  assert.ok(TARGETS.every((t) => t.file === FILES.discoverRoute));
  assert.ok(TARGETS[1].to.includes(TARGETS[1].from) && TARGETS[1].marker, 'the second target is an insertion and has its marker');
  assert.ok(!TARGETS[0].to.includes(TARGETS[0].from));
});

test('patch: the patched route searches once per topic, shuffles per request without touching the cache, and leaves the home widget alone', async () => {
  const log = quiet();
  delete globalThis.faneStories; delete globalThis.faneMedium; delete globalThis.faneKleon;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
  try {
    let files = { [FILES.discoverRoute]: ROUTE };
    for (const targets of CHAIN) files = { ...files, ...planPatch(files, targets).next };
    const route = eval(files[FILES.discoverRoute]);
    let searches = 0;
    const v = { n: async (q, { language }) => { searches++; return { results: [{ title: `Story ${q} ${language}`, url: `https://theatlantic.com/${encodeURIComponent(q)}${language}`, thumbnail: 'https://i/x.jpg' }] }; } };
    const d = { links: ['theatlantic.com', 'wired.com'], query: ['AI', 'chips'] };
    const params = (topic) => new URLSearchParams({ topic });
    const first = await route(params('tech'), d, v, 'normal');
    const n = searches;
    assert.ok(n >= 4 + 2 * GREEK.tech.links.length);
    assert.ok(first.length >= 4);
    const second = await route(params('tech'), d, v, 'normal');
    assert.equal(searches, n); // served from the cache
    assert.deepEqual(second.map((x) => x.url).sort(), first.map((x) => x.url).sort());
    await route(params('art'), d, v, 'normal'); // another topic is its own entry
    assert.ok(searches > n);
    const m = searches;
    await route(params('tech'), d, v, 'preview'); // the home widget: one search each, not cached
    await route(params('tech'), d, v, 'preview');
    assert.equal(searches, m + 2);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.faneStories; delete globalThis.faneMedium; delete globalThis.faneKleon;
    log.mock.restore();
  }
});

test('patch: injected code is ASCII with no backticks, and the Greek host list equals patch-discover-greek\'s table', () => {
  for (const t of TARGETS) {
    assert.ok(/^[\x20-\x7e\n]*$/.test(t.to.replace(/\r/g, '')), t.name);
    assert.ok(!t.to.includes('`'), t.name);
  }
  assert.deepEqual(Object.keys(GREEK_HOSTS), Object.keys(GREEK));
  for (const topic of Object.keys(GREEK)) assert.deepEqual(GREEK_HOSTS[topic], GREEK[topic].links);
  assert.ok(TARGETS[1].to.includes(JSON.stringify(GREEK_HOSTS))); // what is written into the route is what the test compares
});

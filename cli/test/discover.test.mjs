// Discover's Medium stories (patches/patch-discover-medium.js): the tag feed the route reads, its cache, and the
// route statement the patch rewrites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MEDIUM, TARGETS } = require('../../patches/patch-discover-medium.js');
const { planPatch } = require('../../patches/lib/apply-targets.js');
const { FILES } = require('../../patches/lib/vane.js');

// Two usable stories (one with an entity and a tracking parameter), one without an image, one that is not Medium.
const FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title><![CDATA[Technology on Medium]]></title>
<item><title><![CDATA[Tokens, agents &amp; bills]]></title><link>https://medium.com/@a/tokens-1a2b?source=rss------technology-5</link>
<description><![CDATA[<div class="medium-feed-item"><p class="medium-feed-image"><a href="x"><img src="https://cdn-images-1.medium.com/max/1400/1*abc.png" width="1400"></a></p><p class="medium-feed-snippet">Half the transcript, every 30 seconds &#x2019;so&#x2019;&#x2026;</p></div>]]></description></item>
<item><title><![CDATA[Quan el pressupost arriba al carrer]]></title><link>https://warp3r.medium.com/quan-el-pressupost</link>
<description><![CDATA[<div class="medium-feed-item"><p class="medium-feed-image"><img src="https://cdn-images-1.medium.com/max/1254/1*def.jpeg"></p><p class="medium-feed-snippet">El cas de Fran&#231;a</p></div>]]></description></item>
<item><title><![CDATA[Text only]]></title><link>https://medium.com/@b/no-image</link>
<description><![CDATA[<p class="medium-feed-snippet">no picture</p>]]></description></item>
<item><title><![CDATA[Somewhere else]]></title><link>https://example.com/p/1</link>
<description><![CDATA[<p class="medium-feed-image"><img src="https://cdn-images-1.medium.com/max/800/0*x"></p>]]></description></item>
</channel></rss>`;

const reset = () => {
  delete globalThis.faneMedium;
};
const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 503, text: async () => body });

test('patch-discover-medium: a tag feed becomes Discover stories; a story without a picture or outside medium.com is dropped', async () => {
  reset();
  const asked = [];
  const items = await MEDIUM('tech', async (url) => {
    asked.push(url);
    return reply(FEED);
  });
  assert.deepEqual(asked, ['https://medium.com/feed/tag/technology']);
  assert.deepEqual(items, [
    {
      title: 'Tokens, agents & bills',
      url: 'https://medium.com/@a/tokens-1a2b',
      content: 'Half the transcript, every 30 seconds ’so’…',
      thumbnail: 'https://cdn-images-1.medium.com/max/1400/1*abc.png',
    },
    { title: 'Quan el pressupost arriba al carrer', url: 'https://warp3r.medium.com/quan-el-pressupost', content: 'El cas de França', thumbnail: 'https://cdn-images-1.medium.com/max/1254/1*def.jpeg' },
  ]);
});

test('patch-discover-medium: a topic Medium has no tag for asks for nothing', async () => {
  reset();
  let calls = 0;
  const items = await MEDIUM('bogus', async () => {
    calls += 1;
    return reply(FEED);
  });
  assert.deepEqual(items, []);
  assert.equal(calls, 0);
});

test('patch-discover-medium: the feed is read again only after ten minutes, a failure after one minute', async () => {
  reset();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return reply(FEED);
  };
  await MEDIUM('art', fetchImpl);
  await MEDIUM('art', fetchImpl);
  assert.equal(calls, 1);
  globalThis.faneMedium.art.at -= 10 * 60 * 1000 + 1;
  assert.equal((await MEDIUM('art', fetchImpl)).length, 2);
  assert.equal(calls, 2);

  reset();
  let failures = 0;
  const failing = async () => {
    failures += 1;
    return reply('', false);
  };
  assert.deepEqual(await MEDIUM('sports', failing), []);
  assert.deepEqual(await MEDIUM('sports', failing), []);
  assert.equal(failures, 1);
  globalThis.faneMedium.sports.at -= 60 * 1000 + 1;
  assert.deepEqual(await MEDIUM('sports', failing), []);
  assert.equal(failures, 2);
});

// The route as Vane writes it: `a` is the Set used for deduplication, `b` the request's searchParams. CHAIN is the
// exact statement the patch rewrites, so the prefix stops inside the `(await Promise.all(...))` parenthesised by it.
const CHAIN = ').flat().filter(b=>{let c=b.url?.toLowerCase().trim();return!a.has(c)&&(a.add(c),!0)}).sort(()=>Math.random()-.5)';
const PREFIX =
  `(async (v,a)=>{try{let b=new URL(a.url).searchParams,c=b.get("mode")||"normal",` +
  `d={query:["technology news"],links:["techcrunch.com"]},e=[];if("normal"===c){let a=new Set;` +
  `e=(await Promise.all([...d.links.flatMap(x=>d.query.map(async y=>(await (0,v.n)('site:'+x+' '+y,{engines:["bing news"],language:"en"})).results))])`;
const SUFFIX =
  `}else e=(await (0,v.n)('site:'+d.links[0]+' '+d.query[0],{engines:["bing news"],language:"en"})).results;` +
  `return Response.json({blogs:e},{status:200})}catch(err){return Response.json({message:"An error has occurred"},{status:500})}})`;
const ROUTE = PREFIX + CHAIN + SUFFIX;

test('patch-discover-medium: the route mixes the stories in before its shuffle, and only on the Discover page', async () => {
  const r = planPatch({ [FILES.discoverRoute]: ROUTE }, TARGETS);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(planPatch(r.next, TARGETS).applied, []); // twice is a no-op
  const handler = eval(r.next[FILES.discoverRoute]);
  const bing = { n: async () => ({ results: [{ title: 'Bing story', url: 'https://techcrunch.com/a', content: 'c', thumbnail: 'https://www.bing.com/th?id=1' }] }) };
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    return reply(FEED);
  };
  reset();
  try {
    const blogs = await (await handler(bing, { url: 'http://127.0.0.1:3000/api/discover?topic=tech' })).json();
    assert.deepEqual(asked, ['https://medium.com/feed/tag/technology']);
    assert.deepEqual(blogs.blogs.map((b) => b.url).sort(), ['https://medium.com/@a/tokens-1a2b', 'https://techcrunch.com/a', 'https://warp3r.medium.com/quan-el-pressupost']);
    // the home page's news card (mode preview) is left as it was
    asked.length = 0;
    const preview = await (await handler(bing, { url: 'http://127.0.0.1:3000/api/discover?mode=preview&topic=tech' })).json();
    assert.deepEqual(asked, []);
    assert.deepEqual(preview.blogs.map((b) => b.url), ['https://techcrunch.com/a']);
  } finally {
    globalThis.fetch = realFetch;
    reset();
  }
});

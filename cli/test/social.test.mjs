// Tests the code patches/patch-social-sources.js injects into Vane: the platform/date
// prefix and the reddit.com filter for site-search results. Both are imported from the
// patch module, so the test runs exactly what ends up in the bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SOCIAL, REDDIT_URL, TARGETS } = require('../../patches/patch-social-sources.js');
const { planPatch } = require('../../patches/lib/apply-targets.js');
const { FILES } = require('../../patches/lib/vane.js');
const social = eval(SOCIAL);
const redditRe = eval(REDDIT_URL);

test('non-forum results are untouched', () => {
  const r = { title: 'Page', url: 'https://example.com/reddit.com', engine: 'bing', content: 'text' };
  assert.equal(social(r), r);
});

test('forum result gets platform and date; ranking text stays original', () => {
  const out = social({ title: 'T', url: 'https://news.ycombinator.com/item?id=1', engine: 'hackernews', publishedDate: '2025-03-14T10:00:00', content: 'comment' });
  assert.equal(out.content, '[Hacker News | 2025-03-14] comment');
  assert.equal(out.fane_text, 'comment');
});

test('Reddit result from a web engine is labelled by host', () => {
  const out = social({ title: 'Thread', url: 'https://www.reddit.com/r/x/comments/1', engine: 'yandex', content: 'snippet' });
  assert.equal(out.content, '[Reddit] snippet');
});

test('existing fane_text (from the scholarly patch) is kept', () => {
  assert.equal(social({ title: 'T', url: 'https://lemmy.world/post/1', engine: 'lemmy posts', content: 'c', fane_text: 'orig' }).fane_text, 'orig');
});

test('site-search filter keeps only reddit.com hosts', () => {
  for (const u of ['https://www.reddit.com/r/x', 'https://old.reddit.com/r/x/', 'https://reddit.com']) assert.ok(redditRe.test(u), u);
  for (const u of ['https://notreddit.com/x', 'https://example.com/reddit.com', 'https://reddit.com.evil.io/x', 'https://www1.gsis.gr/']) assert.ok(!redditRe.test(u), u);
});

test('Reddit is searched on the Brave API, Tavily and Yandex; a container patched with the blocked engines is upgraded', async () => {
  const target = TARGETS.find(t => t.name === 'forum engines + Reddit via site search');
  const tool = (body) => ({ [FILES.research]: `var tool=async(a,b,c,e)=>{${body}};` });
  const fresh = planPatch(tool(target.alts[0].from), [target]);
  const upgraded = planPatch(tool(target.alts[1].from), [target]); // the first version's engine list
  assert.deepEqual([fresh.errors, upgraded.errors], [[], []]);
  assert.equal(upgraded.next[FILES.research], fresh.next[FILES.research]);

  const calls = [];
  const k = async (o) => {
    calls.push(o);
    return o.queries[0].startsWith('site:')
      ? [{ metadata: { url: 'https://www.reddit.com/r/x/comments/1' } }, { metadata: { url: 'https://example.com/' } }]
      : [{ metadata: { url: 'https://news.ycombinator.com/item?id=1' } }];
  };
  const run = eval(`${fresh.next[FILES.research]}tool`);
  const out = await run({ queries: ['ev batteries'] }, { mode: 'speed' }, 'block', { k });
  assert.deepEqual(calls[1].searchConfig.engines, ['brave api', 'tavily', 'yandex']);
  assert.deepEqual(calls[1].queries, ['site:reddit.com ev batteries']);
  assert.deepEqual(out.results.map(r => r.metadata.url), ['https://news.ycombinator.com/item?id=1', 'https://www.reddit.com/r/x/comments/1']);
});

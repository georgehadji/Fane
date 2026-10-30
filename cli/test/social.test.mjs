// Tests the code patches/patch-social-sources.js injects into Vane: the platform/date
// prefix and the reddit.com filter for site-search results. Both are imported from the
// patch module, so the test runs exactly what ends up in the bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SOCIAL, REDDIT_URL, X_URL, TARGETS } = require('../../patches/patch-social-sources.js');
const { planPatch } = require('../../patches/lib/apply-targets.js');
const { FILES } = require('../../patches/lib/vane.js');
const social = eval(SOCIAL);
const redditRe = eval(REDDIT_URL);
const xRe = eval(X_URL);

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

test('X post from a web engine is labelled by host', () => {
  const out = social({ title: 'Post', url: 'https://x.com/someone/status/123', engine: 'brave api', publishedDate: '2026-10-01', content: 'snippet' });
  assert.equal(out.content, '[X | 2026-10-01] snippet');
});

test('site-search filter keeps only X posts', () => {
  for (const u of ['https://x.com/a_b/status/1', 'https://twitter.com/a/status/99?s=20', 'https://mobile.x.com/a/status/1']) assert.ok(xRe.test(u), u);
  for (const u of ['https://x.com/someone', 'https://x.com/search?q=a', 'https://x.com/hashtag/ev', 'https://notx.com/a/status/1', 'https://x.com.evil.io/a/status/1']) assert.ok(!xRe.test(u), u);
});

test('a container patched before X results were labelled is upgraded, with or without the scholarly patch', () => {
  const CLIENT = 'async function search(a){let b=await a.json(),c=b.results,d=b.suggestions;return{results:c,suggestions:d}}';
  const target = { ...TARGETS.find(t => t.name === 'platform and date in results'), file: 'f' };
  const old = target.alts[3].from.slice('c=(b.results||[]).map('.length, -'),d=b.suggestions;'.length); // SOCIAL before X
  const scholarly = require('../../patches/patch-scholarly-sources.js').TARGETS.filter(t => t.name === 'paper metadata in results').map(t => ({ ...t, file: 'f' }));
  for (const first of [[], scholarly]) {
    const fresh = planPatch({ f: CLIENT }, [...first, target]).next.f;
    const out = planPatch({ f: fresh.replace(SOCIAL, old) }, [target]);
    assert.deepEqual([out.errors, out.applied.length], [[], 1]);
    assert.equal(out.next.f, fresh);
  }
});

test('existing fane_text (from the scholarly patch) is kept', () => {
  assert.equal(social({ title: 'T', url: 'https://lemmy.world/post/1', engine: 'lemmy posts', content: 'c', fane_text: 'orig' }).fane_text, 'orig');
});

test('site-search filter keeps only reddit.com hosts', () => {
  for (const u of ['https://www.reddit.com/r/x', 'https://old.reddit.com/r/x/', 'https://reddit.com']) assert.ok(redditRe.test(u), u);
  for (const u of ['https://notreddit.com/x', 'https://example.com/reddit.com', 'https://reddit.com.evil.io/x', 'https://www1.gsis.gr/']) assert.ok(!redditRe.test(u), u);
});

test('Reddit and X are searched on the Brave API, Tavily and Yandex; older containers are upgraded', async () => {
  const target = TARGETS.find(t => t.name === 'forum engines + Reddit via site search');
  const tool = (body) => ({ [FILES.research]: `var tool=async(a,b,c,e)=>{${body}};` });
  const fresh = planPatch(tool(target.alts[0].from), [target]);
  const upgraded = planPatch(tool(target.alts[1].from), [target]); // the first version's engine list
  const beforeX = planPatch(tool(target.alts[2].from), [target]); // Reddit only
  assert.deepEqual([fresh.errors, upgraded.errors, beforeX.errors], [[], [], []]);
  assert.equal(upgraded.next[FILES.research], fresh.next[FILES.research]);
  assert.equal(beforeX.next[FILES.research], fresh.next[FILES.research]);

  const calls = [];
  const k = async (o) => {
    calls.push(o);
    return o.queries[0].startsWith('site:')
      ? [{ metadata: { url: 'https://www.reddit.com/r/x/comments/1' } }, { metadata: { url: 'https://x.com/a/status/1' } }, { metadata: { url: 'https://example.com/' } }]
      : [{ metadata: { url: 'https://news.ycombinator.com/item?id=1' } }];
  };
  const run = eval(`${fresh.next[FILES.research]}tool`);
  const out = await run({ queries: ['ev batteries'] }, { mode: 'speed' }, 'block', { k });
  for (const c of calls.slice(1)) assert.deepEqual(c.searchConfig.engines, ['brave api', 'tavily', 'yandex']);
  assert.deepEqual(calls.slice(1).map(c => c.queries), [['site:reddit.com ev batteries'], ['site:x.com ev batteries']]);
  assert.deepEqual(out.results.map(r => r.metadata.url), ['https://news.ycombinator.com/item?id=1', 'https://www.reddit.com/r/x/comments/1', 'https://x.com/a/status/1']);
});

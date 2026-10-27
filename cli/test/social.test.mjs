// Tests the code patches/patch-social-sources.js injects into Vane: the platform/date
// prefix and the reddit.com filter for site-search results. Both are imported from the
// patch module, so the test runs exactly what ends up in the bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { SOCIAL, REDDIT_URL } = createRequire(import.meta.url)('../../patches/patch-social-sources.js');
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

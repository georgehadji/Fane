// The Ladder fallback (patches/patch-scrape-ladder.js): the injected function, the target anchors, and the guard edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LADDER_FALLBACK, TARGETS } = require('../../patches/patch-scrape-ladder.js');
const { planPatch } = require('../../patches/lib/apply-targets.js');
const { FILES } = require('../../patches/lib/vane.js');
const { TARGETS: GUARD_TARGETS } = require('../../patches/patch-scrape-guard.js');

// ---------- injected function unit tests ----------

const fake = (title, content, fail = false) => async (url) => {
  if (fail) throw new Error('simulated');
  return { title, content };
};

test('patch-scrape-ladder: a +good page returns as-is and Ladder is not asked', async () => {
  let calls = [];
  const r = await LADDER_FALLBACK('https://www.bbc.com/news/1', async (url) => {
    calls.push(url);
    return { title: 'BBC story', content: '\n        # BBC story - https://www.bbc.com/news/1\n        A long enough piece of text that really does exceed the threshold of seven hundred characters so Ladder will not be asked for it, good.\n        '.padEnd(800, ' x ') };
  }, { base: 'http://host.docker.internal:9081' });
  assert.deepEqual(calls, ['https://www.bbc.com/news/1']);
  assert.equal(r.title, 'BBC story');
});

test('patch-scrape-ladder: a failed scrape retries through Ladder and returns the longer version with the original url', async () => {
  let calls = [];
  const read = async (url) => {
    calls.push(url);
    if (url.startsWith('http://host.docker.internal:9081/')) return { title: 'Ladder article', content: '\n        # Ladder article - ' + url + '\n        ' + 'Much longer article body that came through the proxy. '.repeat(40) };
    return { title: 'Failed to scrape', content: '# https://example.com/paywalled\n\nError scraping content.' };
  };
  const r = await LADDER_FALLBACK('https://example.com/paywalled', read, { base: 'http://host.docker.internal:9081' });
  assert.deepEqual(calls, ['https://example.com/paywalled', 'http://host.docker.internal:9081/https://example.com/paywalled']);
  assert.equal(r.title, 'Ladder article');
  assert.ok(r.content.includes('https://example.com/paywalled'));
  assert.ok(!r.content.includes('http://host.docker.internal:9081')); // the Ladder URL should not be in the final content; the original URL is
  assert.ok(r.content.includes('Much longer article body'));
});

test('patch-scrape-ladder: a walled page is replaced', async () => {
  let called = false;
  const r = await LADDER_FALLBACK('https://example.com/paid', async (url) => {
    called = true;
    if (url.startsWith('http://host.docker.internal:9081/')) return { title: 'Real article', content: '\n        # Real article\n        ' + 'Here is the full text of the subscription article. '.repeat(45) };
    return { title: 'Paid site', content: '\n        # Paid site - https://example.com/paid\n        This article is for subscribers. Subscribe to continue reading.\n        '.padEnd(750, ' x ') };
  }, { base: 'http://host.docker.internal:9081' });
  assert.ok(r.content.includes('Here is the full text'));
  assert.ok(!r.content.includes('subscribers'));
  assert.ok(r.content.includes('https://example.com/paid'));
});

test('patch-scrape-ladder: when the text is long enough and not walled, Ladder is never asked', async () => {
  let calls = [];
  const read = async (url) => {
    calls.push(url);
    if (url.startsWith('http://host.docker.internal:9081/')) return { title: 'Short', content: '\n        # Short\n        Way too short. '.repeat(5) };
    return { title: 'Original', content: '\n        # Original - x\n        Already decent length of 800 characters. '.repeat(20).padEnd(820, ' x ') };
  };
  const r = await LADDER_FALLBACK('https://example.com/short', read, { base: 'http://host.docker.internal:9081' });
  assert.equal(calls.length, 1);
  assert.equal(r.title, 'Original');
});

test('patch-scrape-ladder: no base means Ladder is never called', async () => {
  let calls = [];
  const r = await LADDER_FALLBACK('https://example.com/x', async (url) => {
    calls.push(url);
    return { title: 'Failed to scrape', content: '# - x\n\nError scraping.' };
  }, { base: '' });
  assert.deepEqual(calls, ['https://example.com/x']);
});

test('patch-scrape-ladder: a non-http url is not sent to Ladder', async () => {
  let calls = [];
  const r = await LADDER_FALLBACK('file:///etc/passwd', async (url) => {
    calls.push(url);
    return { title: 'file', content: '# file\n\n' };
  }, { base: 'http://host.docker.internal:9081' });
  assert.deepEqual(calls, ['file:///etc/passwd']);
});

// ---------- target application: tested via planPatch against the real bundle in check-ladder.cjs,
// and target shapes are checked by patches.test.mjs ----------
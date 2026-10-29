// cli/image/translate.mjs: Discover summaries in Greek, with a fake model client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greekSummaries, _cache } from '../image/translate.mjs';

// Answers every batch with "ΕΛ:<text>", unless `reply` says otherwise.
function fakeClient(reply = (texts) => JSON.stringify(texts.map(t => `ΕΛ:${t}`))) {
  const calls = [];
  return { calls, complete: async (model, system, user) => { calls.push({ model, texts: JSON.parse(user) }); return reply(JSON.parse(user)); } };
}
const quiet = () => {};

test('English summaries are translated, Greek ones and titles are left alone, and a second load uses the cache', async () => {
  _cache.clear();
  const client = fakeClient();
  const items = [
    { title: 'Apple', content: 'Apple ships a phone.' },
    { title: 'Βουλή', content: 'Η Βουλή ψήφισε το νομοσχέδιο.' },
    { title: 'Same', content: 'Apple ships a phone.' },
    { title: 'none' },
  ];
  const out = await greekSummaries(items, { client, model: 'm', log: quiet });
  assert.deepEqual(out.map(b => b.content), ['ΕΛ:Apple ships a phone.', 'Η Βουλή ψήφισε το νομοσχέδιο.', 'ΕΛ:Apple ships a phone.', undefined]);
  assert.deepEqual(out.map(b => b.title), items.map(b => b.title));
  assert.deepEqual(client.calls.map(c => c.texts), [['Apple ships a phone.']]); // one call, the duplicate sent once
  assert.equal(items[0].content, 'Apple ships a phone.'); // the input is not changed
  await greekSummaries(items, { client, model: 'm', log: quiet });
  assert.equal(client.calls.length, 1);
});

test('a reply of the wrong shape keeps the English text and is asked again on the next load', async () => {
  _cache.clear();
  for (const reply of [() => '["one"]', () => 'not json', () => '["", "x"]']) {
    const client = fakeClient(reply);
    const items = [{ content: 'First story.' }, { content: 'Second story.' }];
    const out = await greekSummaries(items, { client, model: 'm', log: quiet });
    assert.deepEqual(out.map(b => b.content), ['First story.', 'Second story.'], reply());
    await greekSummaries(items, { client, model: 'm', log: quiet });
    assert.equal(client.calls.length, 2, reply());
  }
});

test('a failing call keeps the English text and is logged', async () => {
  _cache.clear();
  const lines = [];
  const client = { complete: async () => { throw new Error('402 no credits'); } };
  const out = await greekSummaries([{ content: 'A story.' }], { client, model: 'm', log: (l) => lines.push(l) });
  assert.equal(out[0].content, 'A story.');
  assert.match(lines.join('\n'), /Discover translation failed: 402 no credits/);
});

test('a model later than the deadline leaves this load English, and its answer is used by the next one', async () => {
  _cache.clear();
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = fakeClient();
  const slow = { complete: async (...a) => { await gate; return client.complete(...a); } };
  const items = [{ content: 'Late story.' }];
  const first = await greekSummaries(items, { client: slow, model: 'm', deadlineMs: 20, log: quiet });
  assert.equal(first[0].content, 'Late story.');
  release();
  await new Promise((r) => setTimeout(r, 0));
  const second = await greekSummaries(items, { client: slow, model: 'm', log: quiet });
  assert.equal(second[0].content, 'ΕΛ:Late story.');
  assert.equal(client.calls.length, 1); // the load in between did not ask again
});

test('stories are sent in batches of 12, and Greek output gets the homoglyph and final-ν repairs', async () => {
  _cache.clear();
  const client = fakeClient((texts) => JSON.stringify(texts.map(() => 'στη Αθήνα')));
  const items = Array.from({ length: 13 }, (_, i) => ({ content: `Story number ${i}.` }));
  const out = await greekSummaries(items, { client, model: 'm', log: quiet });
  assert.deepEqual(client.calls.map(c => c.texts.length), [12, 1]);
  assert.ok(out.every(b => b.content === 'στην Αθήνα'));
});

test('without a provider in Vane the summaries stay English', async () => {
  _cache.clear();
  const lines = [];
  const items = [{ content: 'No provider story.' }];
  const out = await greekSummaries(items, { readConfig: async () => JSON.stringify({ modelProviders: [] }), log: (l) => lines.push(l) });
  assert.equal(out[0].content, 'No provider story.');
  assert.match(lines.join('\n'), /stay English/);
  assert.equal(await greekSummaries('x', { log: quiet }), 'x');
});

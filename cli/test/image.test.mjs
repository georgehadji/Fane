import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pricePerImage, toModelInfo, buildCatalogue, capability, selectModels, emitsSvg } from '../image/catalogue.mjs';
import { classifyByRules, classifyIntent, parseClassification } from '../image/intent.mjs';
import { heuristicRewrite, shouldRetry, isPolicyError } from '../image/policy.mjs';
import { sniffMime, toDataUrl, collectImageCandidates, decodeDataUrl } from '../image/extract.mjs';
import { isPrivateAddress, safeDownload } from '../image/download.mjs';
import { slugify, fileNameFor, saveImages } from '../image/save.mjs';
import { createImageGenerator } from '../image/generate.mjs';

for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { parseCli } = await import('../vane.mjs');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`;

const entry = (id, { out = ['image'], inp = ['text', 'image'], pricing = { prompt: '0', image_output: '0.00001' } } = {}) =>
  ({ id, name: id, architecture: { input_modalities: inp, output_modalities: out }, pricing });

const ENTRIES = [
  entry('black-forest-labs/flux-3-image-klein', { pricing: { prompt: '0', image_output: '0.0000019' } }),
  entry('black-forest-labs/flux-3-image', { pricing: { prompt: '0', image_output: '0.0000098' } }),
  entry('google/gemini-3.1-flash-image', { out: ['image', 'text'], pricing: { prompt: '0.0000005', image: '0.0000005', image_output: '0.00006' } }),
  entry('google/gemini-3-pro-image', { out: ['image', 'text'], pricing: { prompt: '0.000002', image_output: '0.00012' } }),
  entry('openai/gpt-5-image-mini', { out: ['image', 'text'], pricing: { prompt: '0.0000025', image_output: '0.000008' } }),
  entry('x-ai/grok-imagine-image-2.0', { pricing: { prompt: '0', image: '0.01', image_output: '0.0000095' } }),
  entry('recraft/recraft-v4-styles-vector', { inp: ['text'], pricing: { prompt: '0', image_output: '0.000012' } }),
  entry('recraft/recraft-v4-styles-pro-vector', { inp: ['text'], pricing: { prompt: '0', image_output: '0.000029' } }),
  entry('openrouter/auto', { out: ['text', 'image'], pricing: { prompt: '-1' } }),
  entry('some/text-model', { out: ['text'] }),
];
const CAT = buildCatalogue(ENTRIES);

// ---- catalogue ----------------------------------------------------------

test('price: flat price for pure generators, token rate otherwise, routers excluded', () => {
  assert.equal(pricePerImage({ prompt: '0', image: '0.01', image_output: '0.0000095' }), 0.01);
  assert.equal(pricePerImage({ prompt: '0.0000005', image: '0.0000005', image_output: '0.00006' }), 0.00006 * 1290); // hybrid: `image` is the input price
  assert.equal(pricePerImage({ prompt: '-1' }), null);
  assert.equal(toModelInfo(ENTRIES.at(-1)), null);
  assert.equal(CAT.length, 8);
});

test('modalities follow the catalogue: hybrids also return text', () => {
  assert.deepEqual(CAT.find(m => m.id.startsWith('google/')).modalities, ['image', 'text']);
  assert.deepEqual(CAT.find(m => m.id.includes('flux')).modalities, ['image']);
});

test('capability: tier words and versions, whole-word match', () => {
  const by = (id) => capability(CAT.find(m => m.id === id));
  assert.ok(by('google/gemini-3-pro-image')[0] > by('google/gemini-3.1-flash-image')[0]); // pro > flash
  assert.equal(by('google/gemini-3.1-flash-image')[0], 7); // "flash", not "mini" inside "gemini"
});

test('budget picks cheapest from distinct labs; premium picks most capable', () => {
  const b = selectModels(CAT, { family: 'general', tier: 'budget', count: 2 });
  assert.equal(b.primaries[0].id, 'black-forest-labs/flux-3-image-klein');
  assert.notEqual(b.primaries[0].lab, b.primaries[1].lab);
  assert.ok(b.fallbacks.length >= 4);
  const p = selectModels(CAT, { family: 'general', tier: 'premium', count: 3 });
  assert.ok(p.primaries.some(m => m.id === 'google/gemini-3-pro-image'));
  assert.equal(new Set(p.primaries.map(m => m.lab)).size, 3);
});

test('SVG models only ever serve the vector family, which never widens', () => {
  const v = selectModels(CAT, { family: 'vector', count: 4 });
  assert.ok(v.primaries.length === 2 && v.primaries.every(emitsSvg));
  for (const fam of ['general', 'design', 'photoreal']) assert.ok(selectModels(CAT, { family: fam, count: 8 }).primaries.every(m => !emitsSvg(m)));
});

test('reference images need models that accept image input', () => {
  const r = selectModels(CAT, { family: 'reference_edit', count: 3, needsReference: true });
  assert.ok(r.primaries.length && r.primaries.every(m => m.acceptsImageInput));
});

test('style/edit models that require references are used only when references are given', () => {
  const cat = buildCatalogue([...ENTRIES, entry('recraft/recraft-v4-styles-vector-cheap', { pricing: { prompt: '0', image_output: '0.0000001' } }), entry('krea/k3-edit', { pricing: { prompt: '0', image: '0.0001' } })]);
  const ids = (sel) => [...sel.primaries, ...sel.fallbacks].map(m => m.id);
  assert.ok(!ids(selectModels(cat, { family: 'vector', count: 4 })).includes('recraft/recraft-v4-styles-vector-cheap'));
  assert.ok(!ids(selectModels(cat, { family: 'general', count: 8 })).includes('krea/k3-edit'));
  assert.ok(ids(selectModels(cat, { family: 'reference_edit', count: 8, needsReference: true })).includes('krea/k3-edit'));
});

// ---- intent -------------------------------------------------------------

test('rules classify family and tier', () => {
  assert.deepEqual(classifyByRules('minimal SVG logo for a coffee shop'), { family: 'vector', tier: 'budget', source: 'rules' });
  assert.equal(classifyByRules('poster that says "Open Late"').family, 'text_in_image');
  assert.equal(classifyByRules('cinematic photo of a fox, highly detailed').tier, 'premium');
  assert.equal(classifyByRules('a cat', { hasReference: true }).family, 'reference_edit');
});

test('model classification is parsed and validated; failures fall back to rules', async () => {
  assert.deepEqual(parseClassification('ok {"family":"design","tier_hint":"premium"}'), { family: 'design', tier: 'premium', source: 'model' });
  assert.equal(parseClassification('{"family":"nonsense"}'), null);
  assert.equal((await classifyIntent('SVG icon', { complete: async () => { throw new Error('402'); } })).source, 'rules');
  assert.deepEqual(await classifyIntent('anything', { family: 'photoreal', tier: 'premium' }), { family: 'photoreal', tier: 'premium', source: 'rules' });
});

// ---- policy -------------------------------------------------------------

test('policy rewrite replaces protected names and marks the scene original', () => {
  const r = heuristicRewrite('Mickey Mouse and Pikachu at the beach in the style of Studio Ghibli');
  assert.match(r, /original/);
  assert.doesNotMatch(r, /mickey|pikachu|ghibli/i);
  assert.equal(heuristicRewrite('a red fox in the snow'), null);
});

test('retry on refusals or repeated text-only replies, not on billing errors', () => {
  assert.ok(isPolicyError('400 Request moderated by safety system'));
  assert.ok(shouldRetry(['a: content policy violation']));
  assert.ok(shouldRetry(['a: no image in response', 'b: no image in response']));
  assert.ok(!shouldRetry(['a: 402 Insufficient credits']));
});

// ---- extract ------------------------------------------------------------

test('sniff and normalise image data', () => {
  assert.equal(sniffMime(PNG), 'image/png');
  assert.equal(sniffMime(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(sniffMime(Buffer.from('hello')), null);
  assert.equal(toDataUrl(PNG_URL), PNG_URL);
  assert.equal(toDataUrl('short text'), null);
});

test('candidates from the usual response shapes', () => {
  const msg = { content: 'here you go', images: [{ type: 'image_url', image_url: { url: PNG_URL } }] };
  assert.deepEqual(collectImageCandidates(msg).inline, [PNG_URL]);
  assert.equal(collectImageCandidates({ data: [{ b64_json: PNG.toString('base64') }] }).inline.length, 0); // under 200 chars: too short to trust as raw base64
  assert.deepEqual(collectImageCandidates({ content: [{ type: 'image_url', image_url: { url: 'https://cdn.example.com/x' } }] }).remote, ['https://cdn.example.com/x']);
  assert.deepEqual(collectImageCandidates({ content: 'see https://example.com/page' }).remote, []); // not image-like, not an url field
  const big = Buffer.concat([PNG, Buffer.alloc(300)]).toString('base64');
  assert.match(collectImageCandidates({ b64_json: big }).inline[0], /^data:image\/png;base64,/);
  assert.equal(decodeDataUrl(PNG_URL).mime, 'image/png');
});

// ---- download -----------------------------------------------------------

test('private and loopback addresses are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
  await assert.rejects(safeDownload('http://example.com/a.png'), /refusing http:/);
  await assert.rejects(safeDownload('https://internal.test/a.png', { resolve: async () => [{ address: '10.0.0.5' }] }), /private address/);
});

test('download follows redirects with a re-check and sniffs the bytes', async () => {
  const fetchImpl = async (url) => (url.includes('first')
    ? new Response(null, { status: 302, headers: { location: 'https://cdn.test/final.png' } })
    : new Response(PNG, { status: 200 }));
  const resolve = async (host) => [{ address: host === 'cdn.test' ? '93.184.216.34' : '93.184.216.35' }];
  assert.match(await safeDownload('https://img.test/first', { fetchImpl, resolve }), /^data:image\/png;base64,/);
  const toPrivate = async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/x.png' } });
  await assert.rejects(safeDownload('https://img.test/first', { fetchImpl: toPrivate, resolve }), /private address/);
  await assert.rejects(safeDownload('https://img.test/x', { fetchImpl: async () => new Response('not an image'), resolve }), /not an image/);
});

// ---- save ---------------------------------------------------------------

test('file names are safe and never overwrite', async () => {
  assert.equal(slugify('A Fox, in "Snow"! / ../etc'), 'a-fox-in-snow-etc');
  assert.equal(slugify('minimal SVG logo for a coffee shop called Fane'), 'minimal-svg-logo-for-a-coffee-shop'); // 40-char cap, cut at a word boundary
  assert.equal(slugify('x'.repeat(60)), 'x'.repeat(40));
  assert.equal(fileNameFor('fox', 0, 'black-forest-labs/flux', 'image/svg+xml'), 'fox-1-black-forest-labs.svg');
  const dir = mkdtempSync(join(tmpdir(), 'fane-img-'));
  try {
    const imgs = [{ dataUrl: PNG_URL, model: 'google/x' }];
    await saveImages(imgs, dir, 'fox');
    const again = await saveImages(imgs, dir, 'fox');
    assert.deepEqual(readdirSync(dir).sort(), ['fox-1-google-2.png', 'fox-1-google.png']);
    assert.deepEqual(readFileSync(again[0].path), PNG);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- pipeline -----------------------------------------------------------

// Fake OpenRouter: records every call as { endpoint, body }; pure generators answer on the
// Image API, hybrids on chat completions, like the real service.
function fakeClient({ fail = {}, refuseUnless, completeReply = 'an enhanced prompt' } = {}) {
  const calls = [];
  const guard = (endpoint, body, prompt) => {
    calls.push({ endpoint, body });
    if (fail[body.model]) { const e = new Error(fail[body.model].msg); e.status = fail[body.model].status; throw e; }
    if (refuseUnless && !prompt.includes(refuseUnless)) { const e = new Error('400 Request moderated: content policy'); e.status = 400; throw e; }
  };
  return {
    calls,
    imageModels: async () => ENTRIES,
    complete: async (model, system) => (system.startsWith('Classify') ? '{"family":"general","tier_hint":"budget"}' : completeReply),
    chat: async (body) => {
      guard('chat', body, body.messages[0].content[0].text);
      return { choices: [{ message: { content: '', images: [{ image_url: { url: PNG_URL } }] } }] };
    },
    images: async (body) => {
      guard('images', body, body.prompt);
      return { data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }] };
    },
  };
}

test('pipeline: enhance, two labs in parallel, Image API for pure generators', async () => {
  const client = fakeClient();
  const r = await createImageGenerator({ client, download: async () => null, textModel: 'x/cheap' })({ prompt: 'a fox', count: 2, aspect: '16:9', size: '2K' });
  assert.ok(r.ok && r.complete);
  assert.equal(r.enhancedPrompt, 'an enhanced prompt');
  assert.equal(r.images.length, 2);
  assert.notEqual(r.images[0].model.split('/')[0], r.images[1].model.split('/')[0]);
  const flux = client.calls.find(c => c.body.model === 'black-forest-labs/flux-3-image-klein');
  assert.equal(flux.endpoint, 'images');
  assert.deepEqual(flux.body, { model: 'black-forest-labs/flux-3-image-klein', prompt: 'an enhanced prompt', n: 1, aspect_ratio: '16:9', resolution: '2K' });
});

test('pipeline: hybrid models use chat completions with modalities and image_config', async () => {
  const client = fakeClient();
  const r = await createImageGenerator({ client, download: async () => null })({ prompt: 'a poster that says "Open"', count: 1, enhance: false, family: 'text_in_image' });
  assert.ok(r.ok);
  const call = client.calls[0];
  assert.equal(call.endpoint, 'chat');
  assert.equal(call.body.model, 'openai/gpt-5-image-mini');
  assert.deepEqual(call.body.modalities, ['image', 'text']);
  assert.deepEqual(call.body.image_config, { aspect_ratio: '1:1' });
});

test('pipeline: chat completions "use the Image API" error switches endpoint', async () => {
  const client = fakeClient();
  client.chat = async (body) => {
    client.calls.push({ endpoint: 'chat', body });
    throw Object.assign(new Error(`404 ${body.model} is an image generation model and cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead.`), { status: 404 });
  };
  const r = await createImageGenerator({ client, download: async () => null })({ prompt: 'a poster', count: 1, enhance: false, family: 'text_in_image' });
  assert.ok(r.ok);
  assert.deepEqual(client.calls.map(c => c.endpoint), ['chat', 'images']);
});

test('pipeline: vector requests ask the Image API for SVG', async () => {
  const client = fakeClient();
  await createImageGenerator({ client, download: async () => null })({ prompt: 'svg logo', count: 1, enhance: false, family: 'vector' });
  assert.equal(client.calls[0].body.output_format, 'svg');
});

test('pipeline: a failed primary is replaced by a fallback', async () => {
  const client = fakeClient({ fail: { 'black-forest-labs/flux-3-image-klein': { msg: '500 upstream error', status: 500 } } });
  const r = await createImageGenerator({ client, download: async () => null })({ prompt: 'a fox', count: 2, enhance: false });
  assert.ok(r.complete);
  assert.ok(!r.images.some(i => i.model === 'black-forest-labs/flux-3-image-klein'));
  assert.match(r.errors[0], /500 upstream error/);
});

test('pipeline: stops at once on 402 (no fallbacks, no retries)', async () => {
  const fail = Object.fromEntries(CAT.map(m => [m.id, { msg: '402 Insufficient credits', status: 402 }]));
  const client = fakeClient({ fail });
  const r = await createImageGenerator({ client, download: async () => null })({ prompt: 'Mickey Mouse surfing', count: 2, enhance: false });
  assert.equal(r.ok, false);
  assert.equal(client.calls.length, 2); // only the two primaries
});

test('pipeline: refusal triggers the rewrite chain', async () => {
  const client = fakeClient({ refuseUnless: 'original' });
  const r = await createImageGenerator({ client, download: async () => null })({ prompt: 'Mickey Mouse surfing a wave', count: 1, enhance: false });
  assert.ok(r.ok);
  assert.match(r.rewrittenPrompt, /original/);
});

test('pipeline: remote image URLs go through the downloader (both endpoints)', async () => {
  const client = fakeClient();
  client.images = async () => ({ data: [{ url: 'https://cdn.test/a' }] });
  client.chat = async () => ({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'https://cdn.test/b' } }] } }] });
  const seen = [];
  const gen = createImageGenerator({ client, download: async (u) => { seen.push(u); return PNG_URL; } });
  assert.ok((await gen({ prompt: 'x', count: 1, enhance: false })).ok);
  assert.ok((await gen({ prompt: 'x', count: 1, enhance: false, family: 'text_in_image' })).ok);
  assert.deepEqual(seen, ['https://cdn.test/a', 'https://cdn.test/b']);
});

// ---- CLI ----------------------------------------------------------------

test('--image options are validated', () => {
  const o = parseCli(['a fox', '--image', '-n', '3', '--tier', 'premium', '--aspect', '16:9', '--size', '2k', '--ref', 'a.png', '--ref', 'b.png']);
  assert.equal(o.count, 3);
  assert.equal(o.size, '2K');
  assert.deepEqual(o.ref, ['a.png', 'b.png']);
  assert.throws(() => parseCli(['x', '--image', '-n', '9']), /Invalid --count/);
  assert.throws(() => parseCli(['x', '--image', '--aspect', '5:4']), /Invalid --aspect/);
  assert.throws(() => parseCli(['x', '--image', '--family', 'anime']), /Invalid --family/);
});

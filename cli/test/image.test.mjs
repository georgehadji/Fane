import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pricePerImage, toModelInfo, buildCatalogue, capability, selectModels, emitsSvg, TIER_FOR_MODE } from '../image/catalogue.mjs';
import { classifyByRules, classifyIntent, parseClassification, isImageRequest, imageSubject, parseImageOptions, isImageEdit, pickReferenceIndex } from '../image/intent.mjs';
import { explainFailure, heuristicRewrite, shouldRetry, isPolicyError } from '../image/policy.mjs';
import { sniffMime, toDataUrl, collectImageCandidates, decodeDataUrl } from '../image/extract.mjs';
import { isPrivateAddress, safeDownload } from '../image/download.mjs';
import { slugify, fileNameFor, saveImages } from '../image/save.mjs';
import { createImageGenerator, nearestRatio } from '../image/generate.mjs';

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
  assert.deepEqual(b.primaries.map(m => m.id).sort(), ['black-forest-labs/flux-3-image-klein', 'x-ai/grok-imagine-image-2.0']);
  assert.notEqual(b.primaries[0].lab, b.primaries[1].lab);
  assert.ok(b.fallbacks.flat().length >= 4);
  const p = selectModels(CAT, { family: 'general', tier: 'premium', count: 3 });
  assert.ok(p.primaries.some(m => m.id === 'google/gemini-3-pro-image'));
  assert.equal(new Set(p.primaries.map(m => m.id)).size, 3);
});

test('value (default): the middle price band, borrowing from the nearest bands for the rest', () => {
  // general prices: klein 0.0025, grok 0.01 | gpt-mini 0.0103, flux-3 0.0126 | gemini flash 0.077, pro 0.155
  const v = selectModels(CAT, { family: 'general' });
  assert.deepEqual(v.primaries.map(m => m.id).slice(0, 2).sort(), ['black-forest-labs/flux-3-image', 'openai/gpt-5-image-mini']);
  assert.equal(new Set(v.primaries.map(m => m.lab)).size, 4);
});

test('the three tiers (Speed, Balanced, Quality) use different models, each with fallbacks', () => {
  const pick = (tier) => selectModels(CAT, { family: 'general', tier, count: 2 });
  const [speed, balanced, quality] = ['budget', 'value', 'premium'].map(pick);
  const ids = (s) => s.primaries.map(m => m.id);
  assert.deepEqual(ids(speed).sort(), ['black-forest-labs/flux-3-image-klein', 'x-ai/grok-imagine-image-2.0']);
  assert.deepEqual(ids(balanced).sort(), ['black-forest-labs/flux-3-image', 'openai/gpt-5-image-mini']);
  assert.deepEqual(ids(quality).sort(), ['google/gemini-3-pro-image', 'google/gemini-3.1-flash-image']);
  for (const s of [speed, balanced, quality]) assert.ok(s.fallbacks.length === 2 && s.fallbacks.every(chain => chain.length >= 1));
  assert.equal(new Set([...ids(speed), ...ids(balanced), ...ids(quality)]).size, 6);
  assert.deepEqual(TIER_FOR_MODE, { speed: 'budget', balanced: 'value', quality: 'premium' });
});

test('every image has its own fallback chain; no model is used twice', () => {
  const s = selectModels(CAT, { family: 'general', count: 2 });
  assert.equal(s.fallbacks.length, 2);
  assert.ok(s.fallbacks.every(chain => chain.length >= 1));
  const ids = [...s.primaries, ...s.fallbacks.flat()].map(m => m.id);
  assert.equal(new Set(ids).size, ids.length);
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
  const ids = (sel) => [...sel.primaries, ...sel.fallbacks.flat()].map(m => m.id);
  assert.ok(!ids(selectModels(cat, { family: 'vector', count: 4 })).includes('recraft/recraft-v4-styles-vector-cheap'));
  assert.ok(!ids(selectModels(cat, { family: 'general', count: 8 })).includes('krea/k3-edit'));
  assert.ok(ids(selectModels(cat, { family: 'reference_edit', count: 8, needsReference: true })).includes('krea/k3-edit'));
});

// ---- intent -------------------------------------------------------------

test('rules classify the family; the tier is always value', () => {
  assert.deepEqual(classifyByRules('minimal SVG logo for a coffee shop'), { family: 'vector', tier: 'value', source: 'rules' });
  assert.equal(classifyByRules('poster that says "Open Late"').family, 'text_in_image');
  assert.equal(classifyByRules('cinematic photo of a fox, highly detailed').tier, 'value');
  assert.equal(classifyByRules('a cat', { hasReference: true }).family, 'reference_edit');
});

test('image requests are recognised; questions are not', () => {
  for (const q of ['create an image of donald duck and his nieces in the playground', 'Draw me a logo for a bakery', 'please generate 2 pictures of a fox', 'Can you make a poster for a jazz night', 'paint a portrait of a cat', 'draw a fox', 'Sketch the Eiffel Tower at night']) assert.ok(isImageRequest(q), q);
  for (const q of ['draw a conclusion from this data', 'Draw some parallels between Rome and the US']) assert.ok(!isImageRequest(q), q);
  assert.equal(imageSubject('create an image of donald duck and his nieces in the playground'), 'donald duck and his nieces in the playground');
  assert.equal(imageSubject('draw me a fox'), 'a fox');
  assert.equal(imageSubject('a red fox'), 'a red fox');
  for (const q of ['What is the best image format for the web?', 'how do I create an image in Docker', 'Compare Rust and Go', 'images of the 2024 eclipse: where were they taken?', 'Make sure my photo backups are safe']) assert.ok(!isImageRequest(q), q);
});

test('model classification is parsed and validated; failures fall back to rules', async () => {
  assert.deepEqual(parseClassification('ok {"family":"design","tier_hint":"premium"}'), { family: 'design', tier: 'value', source: 'model' });
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
  // OpenRouter's moderation answers 403: a refused prompt, retried with a rewrite, not a key problem
  const flagged = ['a: 403 Your input was flagged for "violence/graphic"'];
  assert.ok(shouldRetry(flagged));
  assert.equal(explainFailure(flagged).summary, 'The image models refused this prompt.');
  assert.equal(explainFailure(['a: 401 No auth credentials found']).summary, 'OpenRouter did not accept the API key.');
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
  // new URL() turns [::ffff:127.0.0.1] into ::ffff:7f00:1; other IPv6 forms embed IPv4 too
  for (const ip of ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe']) assert.ok(isPrivateAddress(ip), ip);
  assert.ok(!isPrivateAddress('::ffff:808:808'));
  const never = async () => { throw new Error('fetched'); };
  for (const u of ['https://[::ffff:127.0.0.1]/x.png', 'https://[::7f00:1]/x.png', 'https://[64:ff9b::7f00:1]/x.png', 'https://[2002:7f00:1::]/x.png']) await assert.rejects(safeDownload(u, { fetchImpl: never }), /private address/, u);
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

test('download caps the size, declared or streamed, and the number of redirects', async () => {
  const resolve = async () => [{ address: '93.184.216.34' }];
  const declared = async () => new Response(PNG, { headers: { 'content-length': '999' } });
  await assert.rejects(safeDownload('https://img.test/x', { fetchImpl: declared, resolve, maxBytes: 100 }), /size cap/);
  const streamed = async () => new Response(new Uint8Array(200)); // no content-length
  await assert.rejects(safeDownload('https://img.test/x', { fetchImpl: streamed, resolve, maxBytes: 100 }), /size cap/);
  let hops = 0;
  const loop = async () => { hops++; return new Response(null, { status: 302, headers: { location: 'https://img.test/again' } }); };
  await assert.rejects(safeDownload('https://img.test/x', { fetchImpl: loop, resolve, maxRedirects: 2 }), /too many redirects/);
  assert.equal(hops, 3);
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
    complete: async (model, system) => (system.startsWith('Classify') ? '{"family":"general"}' : completeReply),
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
  const r = await createImageGenerator({ client, download: async () => null, textModel: 'x/cheap' })({ prompt: 'a fox', count: 2, tier: 'budget', aspect: '16:9', size: '2K' });
  assert.ok(r.ok && r.complete);
  assert.equal(r.enhancedPrompt, 'an enhanced prompt');
  assert.equal(r.images.length, 2);
  assert.notEqual(r.images[0].model.split('/')[0], r.images[1].model.split('/')[0]);
  const flux = client.calls.find(c => c.body.model === 'black-forest-labs/flux-3-image-klein');
  assert.equal(flux.endpoint, 'images');
  assert.deepEqual(flux.body, { model: 'black-forest-labs/flux-3-image-klein', prompt: 'an enhanced prompt', n: 1, aspect_ratio: '16:9', resolution: '2K' });
});

test('pipeline: an edit that ignored the reference is rejected and the chain moves on; a failed check keeps the image', async () => {
  const REF = 'data:image/png;base64,REF';
  const client = fakeClient();
  const draw = client.chat;
  let verdicts = ['no', 'yes'];
  client.chat = async (body) => {
    if (body.model !== 'x/cheap') return draw(body);
    client.calls.push({ endpoint: 'check', body });
    return { choices: [{ message: { content: verdicts.shift() } }] };
  };
  const r = await createImageGenerator({ client, download: async () => null, textModel: 'x/cheap' })({ prompt: 'make it a pencil sketch', count: 1, enhance: false, references: [REF] });
  assert.ok(r.ok);
  const checks = client.calls.filter(c => c.endpoint === 'check');
  assert.equal(checks.length, 2);
  assert.deepEqual(checks[0].body.messages[0].content.slice(1).map(p => p.image_url.url), [REF, PNG_URL]);
  assert.match(r.errors[0], /ignored the reference image/);
  assert.notEqual(r.images[0].model, r.models[0]); // the primary's picture was rejected, a fallback's kept
  client.chat = async (body) => { if (body.model === 'x/cheap') throw new Error('503'); return draw(body); };
  const kept = await createImageGenerator({ client, download: async () => null, textModel: 'x/cheap' })({ prompt: 'make it blue', count: 1, enhance: false, references: [REF] });
  assert.equal(kept.images[0].model, kept.models[0]);
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

test('selection: via limits the choice to chat models or to Image API models', () => {
  const chat = selectModels(CAT, { family: 'general', count: 4, via: 'chat' });
  assert.ok(chat.primaries.length >= 2 && [...chat.primaries, ...chat.fallbacks.flat()].every(m => m.modalities.includes('text')));
  const img = selectModels(CAT, { family: 'photoreal', count: 4, via: 'images' });
  assert.ok([...img.primaries, ...img.fallbacks.flat()].every(m => !m.modalities.includes('text')));
});

test('pipeline: --via chat draws with chat models and keeps their text reply', async () => {
  const client = fakeClient();
  client.chat = async (body) => {
    client.calls.push({ endpoint: 'chat', body });
    return { choices: [{ message: { content: 'Here is a fox in the snow.', images: [{ type: 'image_url', image_url: { url: PNG_URL } }] } }] };
  };
  const r = await createImageGenerator({ client, download: async () => null })({ prompt: 'a fox', count: 2, enhance: false, via: 'chat' });
  assert.ok(r.complete);
  assert.ok(client.calls.every(c => c.endpoint === 'chat'));
  assert.deepEqual(r.images.map(i => [i.via, i.text]), [['chat', 'Here is a fox in the snow.'], ['chat', 'Here is a fox in the snow.']]);
});

test('nearestRatio picks the closest accepted ratio, ignoring auto', () => {
  assert.equal(nearestRatio('16:9', ['1:1', '3:2', '2:3', 'auto']), '3:2');
  assert.equal(nearestRatio('9:16', ['1:1', '3:2', '2:3']), '2:3');
  assert.equal(nearestRatio('1:1', ['auto']), null);
});

test('pipeline: chat models take the Image API first for non-square ratios', async () => {
  const client = fakeClient();
  const r = await createImageGenerator({ client, download: async () => null })({ prompt: 'x', enhance: false, models: ['google/gemini-3.1-flash-image'], aspect: '16:9' });
  assert.ok(r.ok);
  assert.deepEqual(client.calls.map(c => c.endpoint), ['images']);
  assert.equal(r.images[0].endpoint, 'images');
  assert.equal(r.images[0].via, 'chat');
});

test('pipeline: "Accepted: ..." aspect errors retry once with the nearest ratio', async () => {
  const client = fakeClient();
  const images = client.images;
  client.images = async (body) => {
    if (body.aspect_ratio === '16:9') throw Object.assign(new Error('400 No provider supports aspect_ratio "16:9". Provider rejections: OpenAI: aspect_ratio: not supported. Accepted: 1:1, 3:2, 2:3, auto'), { status: 400 });
    return images(body);
  };
  const r = await createImageGenerator({ client, download: async () => null })({ prompt: 'x', enhance: false, models: ['openai/gpt-5-image-mini'], aspect: '16:9' });
  assert.ok(r.ok);
  assert.equal(r.images[0].aspect, '3:2');
  assert.equal(client.calls.at(-1).body.aspect_ratio, '3:2');
});

test('pipeline: a chat model that answers only in words is a failure that names the reply', async () => {
  const client = fakeClient();
  client.chat = async () => ({ choices: [{ message: { content: 'I cannot draw that.' } }] });
  client.images = async () => { throw Object.assign(new Error('400 model not available on the Image API'), { status: 400 }); };
  const r = await createImageGenerator({ client, download: async () => null })({ prompt: 'x', count: 1, enhance: false, models: ['google/gemini-3.1-flash-image'] });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /no image in response \(model replied: I cannot draw that\.\)/);
});

test('pipeline: explicit models are used as given, cycled for -n, no substitution', async () => {
  const client = fakeClient();
  const gen = createImageGenerator({ client, download: async () => null });
  const r = await gen({ prompt: 'x', enhance: false, models: ['google/gemini-3-pro-image', 'openai/gpt-5-image-mini'] });
  assert.deepEqual(r.models, ['google/gemini-3-pro-image', 'openai/gpt-5-image-mini']); // count defaults to the list length
  assert.equal(r.intent.source, 'explicit');
  assert.deepEqual((await gen({ prompt: 'x', enhance: false, count: 3, models: ['google/gemini-3-pro-image'] })).models.length, 3);
  const bad = await gen({ prompt: 'x', enhance: false, models: ['some/text-model'] });
  assert.match(bad.errors[0], /not an image model/);
});

test('pipeline: vector requests ask the Image API for SVG', async () => {
  const client = fakeClient();
  await createImageGenerator({ client, download: async () => null })({ prompt: 'svg logo', count: 1, enhance: false, family: 'vector' });
  assert.equal(client.calls[0].body.output_format, 'svg');
});

test('pipeline: a failed primary is replaced by its own fallback, in its slot', async () => {
  const client = fakeClient({ fail: { 'black-forest-labs/flux-3-image': { msg: '500 upstream error', status: 500 } } });
  const r = await createImageGenerator({ client, download: async () => null })({ prompt: 'a fox', count: 2, enhance: false });
  assert.ok(r.complete);
  assert.deepEqual(r.models, ['black-forest-labs/flux-3-image', 'openai/gpt-5-image-mini']);
  assert.equal(r.images[1].model, 'openai/gpt-5-image-mini');
  assert.ok(!['black-forest-labs/flux-3-image', 'openai/gpt-5-image-mini'].includes(r.images[0].model));
  assert.match(r.errors[0], /500 upstream error/);
});

test('pipeline: 4 images from 4 different models by default', async () => {
  const r = await createImageGenerator({ client: fakeClient(), download: async () => null })({ prompt: 'a fox', enhance: false });
  assert.equal(r.images.length, 4);
  assert.equal(new Set(r.images.map(i => i.model)).size, 4);
});

test('pipeline: a rewrite retries only the missing images', async () => {
  const client = fakeClient();
  const images = client.images;
  client.images = async (body) => {
    if (body.model !== 'black-forest-labs/flux-3-image-klein' && !body.prompt.includes('original')) throw Object.assign(new Error('400 Request moderated: content policy'), { status: 400 });
    return images(body);
  };
  // images-API models by value: grok, klein, flux-3. Chains: [grok, flux-3] (both refuse) and [klein]
  const r = await createImageGenerator({ client, download: async () => null })({ prompt: 'Mickey Mouse surfing', count: 2, enhance: false, via: 'images' });
  assert.ok(r.complete);
  assert.equal(client.calls.filter(c => c.body.model === 'black-forest-labs/flux-3-image-klein').length, 1); // its image was kept
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

// ---- Vane web UI hook ---------------------------------------------------

const { handleImageRequest } = await import('../image/vane-hook.mjs');

test('once the hook has answered, a failure stays in its answer and never reaches Vane', async () => {
  let shown = '';
  const io = { emit: () => 'b1', update: (id, md) => { shown = md; }, log: () => {} };
  assert.equal(await handleImageRequest('draw a fox', { ...io, generator: async () => { throw new Error('boom'); } }), true);
  assert.match(shown, /The images could not be made: boom/);
  // an update that throws (Vane's block gone) is logged, not thrown
  const broken = { emit: () => 'b1', update: () => { throw new Error('no block'); }, log: () => {} };
  const generator = async ({ onProgress }) => { onProgress({ ready: 1, total: 1, slot: 0, image: { dataUrl: PNG_URL, model: 'm' } }); return { images: [], requested: 1, complete: false, errors: [], rewrittenPrompt: null }; };
  assert.equal(await handleImageRequest('draw a fox', { ...broken, generator }), true);
});

test('hook ignores questions and answers image requests with markdown images', async () => {
  const blocks = new Map();
  let n = 0;
  const io = { emit: (md) => { const id = `b${++n}`; blocks.set(id, md); return id; }, update: (id, md) => blocks.set(id, md) };
  assert.equal(await handleImageRequest('What is the best image format?', io), false);
  assert.equal(blocks.size, 0);
  const seen = [];
  const generator = async (args) => { seen.push(args); return { images: [{ dataUrl: PNG_URL, model: 'black-forest-labs/flux', name: 'Black Forest Labs: FLUX.2 Pro', pricePerImage: 0.002, text: null }], requested: 2, complete: false, errors: [], rewrittenPrompt: null }; };
  assert.equal(await handleImageRequest('create an image of donald duck in a playground', { ...io, generator }), true);
  assert.equal(seen[0].prompt, 'create an image of donald duck in a playground');
  assert.equal(seen[0].format, 'jpeg');
  assert.equal(typeof seen[0].onProgress, 'function');
  assert.equal('count' in seen[0] || 'aspect' in seen[0], false);
  const md = blocks.get('b1');
  assert.match(md, /<img src="data:image\/png;base64,[^"]+" alt="Image 1 of 1: donald duck in a playground"/);
  assert.match(md, /<span style="font-weight:500;margin-right:0\.4em">FLUX\.2 Pro<\/span><span>≈ \$0\.002<\/span>/);
  assert.match(md, /Made 1 of 2 images\./);
});

test('hook shows progress while images land, then the grid; words in the prompt set count and shape', async () => {
  const shown = [];
  let n = 0;
  let firstEmit = null;
  const io = { emit: (md) => { firstEmit = md; return 'b'; }, update: (id, md) => shown.push(md) };
  const generator = async (args) => {
    args.onProgress({ ready: 1, total: 2, slot: 0, model: 'a/one', name: 'A: One', image: { dataUrl: PNG_URL, model: 'a/one', name: 'A: One' } });
    args.onProgress({ ready: 2, total: 2, slot: 1, model: 'b/two', name: 'B: Two', image: { dataUrl: PNG_URL, model: 'b/two', name: 'B: Two' } });
    seen.push(args);
    return { images: [{ dataUrl: PNG_URL, model: 'a/one', pricePerImage: 0.01 }], requested: 2, complete: false, errors: [] };
  };
  const seen = [];
  await handleImageRequest('create 2 images of a fox, widescreen', { ...io, generator });
  assert.equal(seen[0].count, 2);
  assert.equal(seen[0].aspect, '16:9');
  assert.equal(shown[0], '<p role="status" style="font-size:14px;opacity:0.7">Generating images… 1 of 2 ready<br>✓ One</p>\n\n<!--fane:image-answer-->');
  assert.equal(shown[1], '<p role="status" style="font-size:14px;opacity:0.7">Generating images… 2 of 2 ready<br>✓ One · ✓ Two</p>\n\n<!--fane:image-answer-->');
  assert.match(shown[2], /^<div style="display:grid/);
  assert.ok(shown.every(md => md.endsWith('<!--fane:image-answer-->')) && firstEmit.endsWith('<!--fane:image-answer-->')); // every answer carries the marker
});

test('hook links stored images, and embeds one that cannot be stored', async () => {
  const shown = [];
  const io = { emit: () => 'b', update: (id, md) => shown.push(md), log: () => {} };
  const link = `/api/uploads?fane-image=${'e'.repeat(64)}.png`;
  const generator = async () => ({ images: [{ dataUrl: PNG_URL, model: 'a/one' }, { dataUrl: PNG_URL, model: 'b/two' }], requested: 2, complete: true, errors: [] });
  let n = 0;
  const store = { put: async () => { if (++n === 2) throw new Error('disk full'); return link; } };
  await handleImageRequest('draw a fox', { ...io, generator, store });
  const md = shown.at(-1);
  assert.equal(md.split(`<img src="${link}"`).length - 1, 1);
  assert.equal(md.split('<img src="data:image/png;base64,').length - 1, 1);
});

test('hook: finished images are stored on arrival, shown at once, and linked once in the final answer', async () => {
  const shown = [];
  const stored = [];
  const store = { put: async (u) => { stored.push(u); return `/api/uploads?fane-image=${String(stored.length).repeat(64)}.png`; }, get: async () => '' };
  const generator = async (args) => {
    args.onProgress({ ready: 1, total: 2, slot: 1, model: 'b/two', name: 'B: Two', image: { dataUrl: PNG_URL, model: 'b/two', name: 'B: Two' } });
    args.onProgress({ ready: 2, total: 2, slot: 0, model: 'a/one', name: 'A: One', image: { dataUrl: PNG_URL, model: 'a/one', name: 'A: One' } });
    return { images: [{ dataUrl: PNG_URL, model: 'a/one', name: 'A: One' }, { dataUrl: PNG_URL, model: 'b/two', name: 'B: Two' }], requested: 2, complete: true, errors: [] };
  };
  await handleImageRequest('draw a fox', { emit: () => 'b', update: (id, md) => shown.push(md), log: () => {}, generator, store });
  assert.equal(stored.length, 2); // once per image, not again for the final answer
  assert.match(shown[0], /^<div style="display:grid[^]*1 of 2 ready<\/p>\n\n<!--fane:image-answer-->$/);
  assert.equal(shown[0].split('<img ').length - 1, 1);
  assert.equal(shown[1].split('<img ').length - 1, 2);
  assert.ok(shown[1].indexOf('/api/uploads?fane-image=2') < shown[1].indexOf('/api/uploads?fane-image=1')); // slot order, not arrival order
  assert.ok(!shown.at(-1).includes('base64'));
  assert.equal(shown.at(-1).split('<img ').length - 1, 2);
});

test('isImageEdit reads edits, not questions; pickReferenceIndex finds "the second one"', () => {
  for (const q of ['make it a watercolour', 'Now at night', 'ok, add a red hat', 'can you make the second one darker', 'in the style of Monet', 'with a blue sky', 'more contrast']) assert.ok(isImageEdit(q), q);
  for (const q of ['what is this fox called?', 'why is it orange', 'explain the lighting', 'thanks', 'draw a cat']) assert.ok(!isImageEdit(q), q);
  // other tasks and questions after an image answer are not edits
  for (const q of ['In which year was the Parthenon built?', 'In which year was the Parthenon built', 'Make a list of the 10 tallest buildings', 'Give me a summary of the war', 'Use Python to sort a list', 'with whom did he work?', 'can you make it brighter?']) assert.ok(!isImageEdit(q), q);
  for (const q of ['give it a vintage look', 'use a warmer palette', 'try a darker background', 'make a version with snow', 'make the sky darker']) assert.ok(isImageEdit(q), q);
  assert.equal(pickReferenceIndex('make it darker', 4), 0);
  assert.equal(pickReferenceIndex('make the second one darker', 4), 1);
  assert.equal(pickReferenceIndex('change image 3 to blue', 4), 2);
  assert.equal(pickReferenceIndex('make #4 bigger', 4), 3);
  assert.equal(pickReferenceIndex('make the fourth one red', 2), 0); // not there: the first
  assert.equal(pickReferenceIndex('constructor toString', 4), 0);
});

test('isImageEdit: questions behind a lead-in word are not edits; an ordinal about the scene picks no image', () => {
  for (const q of ['during which century was it built', 'under which king was it built', 'again, who built it', 'same question for Rome', 'keep it short: who built this castle', 'as which character is he dressed']) assert.ok(!isImageEdit(q), q);
  for (const q of ['again, but at sunset', 'keep the colours, add a moon', 'during the night']) assert.ok(isImageEdit(q), q);
  assert.equal(pickReferenceIndex('add a second moon to the sky', 4), 0);
  assert.equal(pickReferenceIndex('give it a third eye', 4), 0);
  assert.equal(pickReferenceIndex('add a second person next to her', 4), 0);
  assert.equal(pickReferenceIndex('use the second image, add snow', 4), 1);
  assert.equal(pickReferenceIndex('edit the third.', 4), 2);
});

test('hook: an edit keeps the earlier shape, refuses an SVG, and a stopped run says so and is logged as stopped', async () => {
  const link = (c, ext = 'jpg') => `/api/uploads?fane-image=${c.repeat(64)}.${ext}`;
  const calls = [];
  const shown = [];
  const lines = [];
  let errors = [];
  const generator = async (args) => { calls.push(args); return { images: errors.length ? [] : [{ dataUrl: PNG_URL, model: 'a/one' }], requested: 1, complete: !errors.length, errors }; };
  const store = { get: async () => PNG_URL, put: async () => link('c') };
  const io = { emit: () => 'b', update: (id, md) => shown.push(md), log: (m) => lines.push(m), generator, store };
  const wide = `<img src="${link('a')}" style="display:block;aspect-ratio:auto 16/9">`;
  await handleImageRequest('make it a watercolour', { ...io, lastAnswer: async () => wide });
  assert.equal(calls[0].aspect, '16:9');
  await handleImageRequest('make it a square image', { ...io, lastAnswer: async () => wide });
  assert.equal(calls[1].aspect, '1:1'); // the new message wins
  calls.length = 0;
  assert.equal(await handleImageRequest('make it blue', { ...io, lastAnswer: async () => `<img src="${link('a', 'svg')}">` }), true);
  assert.equal(calls.length, 0);
  assert.match(shown.at(-1), /Vector images \(SVG\) cannot be edited/);
  errors = ['a/one: stopped: the run reached its time limit'];
  await handleImageRequest('create an image of a fox', io);
  assert.match(shown.at(-1), /The run was stopped/);
  assert.match(lines.at(-1), /"stopped":true/);
});

test('hook: a follow-up edit after Fane images uses the earlier image as the reference', async () => {
  const link = (c) => `/api/uploads?fane-image=${c.repeat(64)}.jpg`;
  const history = [{ role: 'user', content: 'draw a fox' }, { role: 'assistant', content: `<img src="${link('a')}"><img src="${link('b')}">` }];
  const shown = [];
  const calls = [];
  const generator = async (args) => { calls.push(args); return { images: [{ dataUrl: PNG_URL, model: 'a/one' }], requested: 1, complete: true, errors: [] }; };
  const store = { get: async (u) => `data:image/png;base64,FROM-${u.slice(-9)}`, put: async () => link('c') };
  const io = { emit: () => 'b', update: (id, md) => shown.push(md), log: () => {}, generator, store };

  assert.equal(await handleImageRequest('make the second one a watercolour', { ...io, history }), true);
  assert.deepEqual(calls[0].references, [`data:image/png;base64,FROM-${link('b').slice(-9)}`]);
  assert.equal(calls[0].enhance, false);
  assert.match(shown.at(-1), /Edited image 2 of the previous answer\./);

  // the browser's history can hold a partial copy of the answer: Vane's database copy wins, and
  // the history is used only when lastAnswer is missing, fails or has nothing
  const partial = [{ role: 'assistant', content: `<img src="${link('a')}">` }];
  const full = async () => `<img src="${link('a')}"><img src="${link('b')}">`;
  calls.length = 0;
  await handleImageRequest('change image 2 to darker', { ...io, history: partial, lastAnswer: full });
  assert.deepEqual(calls[0].references, [`data:image/png;base64,FROM-${link('b').slice(-9)}`]);
  for (const lastAnswer of [async () => { throw new Error('db down'); }, async () => null, undefined]) {
    calls.length = 0;
    await handleImageRequest('change image 2 to darker', { ...io, history: partial, lastAnswer });
    assert.deepEqual(calls[0].references, [`data:image/png;base64,FROM-${link('a').slice(-9)}`]); // image 2 is not there: the first
  }
  assert.equal(await handleImageRequest('make it blue', { ...io, lastAnswer: async () => 'a plain text answer' }), false);

  // not an edit: a question, a fresh image request, no earlier images, an earlier text answer
  assert.equal(await handleImageRequest('why is it orange?', { ...io, history }), false);
  assert.equal(await handleImageRequest('make it blue', { ...io, history: [{ role: 'assistant', content: 'a plain text answer' }] }), false);
  assert.equal(await handleImageRequest('make it blue', { ...io, history: [] }), false);
  assert.equal(await handleImageRequest('make it blue', { ...io }), false);
  assert.equal(await handleImageRequest('make it blue', { ...io, store: null, history }), false);
  const before = calls.length;
  assert.equal(await handleImageRequest('create an image of a dog', { ...io, history }), true);
  assert.equal(calls[before].references, undefined);
  assert.equal(calls[before].enhance, undefined);
});

test('hook: an earlier image that is gone is explained, not guessed', async () => {
  const history = [{ role: 'assistant', content: `<img src="/api/uploads?fane-image=${'a'.repeat(64)}.jpg">` }];
  const shown = [];
  const store = { get: async () => { throw new Error('ENOENT'); }, put: async () => '' };
  let ran = false;
  const generator = async () => { ran = true; return { images: [], requested: 1, complete: false, errors: [] }; };
  assert.equal(await handleImageRequest('make it blue', { emit: () => 'b', update: (id, md) => shown.push(md), log: () => {}, generator, store, history }), true);
  assert.equal(ran, false);
  assert.match(shown.at(-1), /no longer stored/);
});

test("hook maps Vane's optimization mode to the price tier", async () => {
  const seen = [];
  const generator = async (args) => { seen.push(args.tier); return { images: [], requested: 4, complete: false, errors: [] }; };
  const io = { emit: () => 'b', update: () => {}, generator };
  for (const mode of ['speed', 'balanced', 'quality', undefined, 'other']) await handleImageRequest('draw a fox', { ...io, mode });
  assert.deepEqual(seen, ['budget', 'value', 'premium', undefined, undefined]);
});

test('generate calls onProgress per image, and a throwing listener does not fail the run', async () => {
  const events = [];
  const gen = createImageGenerator({ client: fakeClient(), download: async () => PNG_URL });
  const r = await gen({ prompt: 'x', count: 3, enhance: false, onProgress: (p) => events.push(p) });
  assert.equal(r.images.length, 3);
  assert.deepEqual(events.map(e => e.ready).sort(), [1, 2, 3]);
  assert.ok(events.every(e => e.total === 3 && e.model && e.name));
  const bad = await createImageGenerator({ client: fakeClient(), download: async () => PNG_URL })({ prompt: 'x', count: 2, enhance: false, onProgress: () => { throw new Error('boom'); } });
  assert.equal(bad.images.length, 2);
});

test('isImageRequest accepts counts and shape words, not coding questions', () => {
  for (const q of ['create 2 widescreen images of a lighthouse', 'make three different pictures of a fox', 'generate a high-res wallpaper of a beach', 'create a new square logo for a bakery']) assert.ok(isImageRequest(q), q);
  for (const q of ['make the image responsive', 'create a React image carousel', 'create a user icon component', 'how do I resize an image in CSS']) assert.ok(!isImageRequest(q), q);
  // the word after the noun decides: these are about software or figures of speech
  for (const q of ['Generate an image classifier in PyTorch', 'Create an image gallery component in React', 'make a drawing app in JavaScript', 'Create a render pipeline in three.js', 'Make a picture-perfect itinerary for Rome', 'paint a picture of how inflation works']) assert.ok(!isImageRequest(q), q);
  for (const q of ['create an image', 'make a logo: a fox', 'generate a photo showing a harbour', 'create a picture in the style of Monet', 'make an image that says hello']) assert.ok(isImageRequest(q), q);
});

test('parseImageOptions reads count and shape from the prompt, ignoring scene words', () => {
  assert.deepEqual(parseImageOptions('make 2 images of a fox'), { count: 2 });
  assert.deepEqual(parseImageOptions('create 2 widescreen images of a lighthouse'), { count: 2, aspect: '16:9' });
  assert.deepEqual(parseImageOptions('Create three different pictures of a fox in a 16:9 format'), { count: 3, aspect: '16:9' });
  assert.deepEqual(parseImageOptions('a widescreen photo of a beach'), { aspect: '16:9' });
  assert.deepEqual(parseImageOptions('a tall image of a tree'), { aspect: '9:16' });
  assert.deepEqual(parseImageOptions('a square image of a cat'), { aspect: '1:1' });
  assert.deepEqual(parseImageOptions('a wide shot of 3 cats on a square table at 10:30'), {});
  assert.deepEqual(parseImageOptions('a poster at 5:4'), {});
  assert.deepEqual(parseImageOptions(''), {});
});

test('hook reads the OpenRouter key from Vane config and explains when it is missing', async () => {
  const blocks = new Map();
  const io = { emit: (md) => { blocks.set('x', md); return 'x'; }, update: (id, md) => blocks.set(id, md) };
  await handleImageRequest('draw a fox', { ...io, readConfig: async () => JSON.stringify({ modelProviders: [{ name: 'Anthropic', config: { apiKey: 'k' } }] }) });
  assert.match(blocks.get('x'), /needs an OpenRouter provider/);
});

test('generate reports model names and elapsed time', async () => {
  let t = 1000;
  const gen = createImageGenerator({ client: fakeClient(), download: async () => PNG_URL, now: () => (t += 500) });
  const r = await gen({ prompt: 'x', count: 1, enhance: false });
  assert.equal(r.elapsedMs, 500);
  assert.ok(r.images[0].name);
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
  assert.equal(parseCli(['x', '--image']).count, undefined); // generate() decides: 2, or one per --image-model
  assert.deepEqual(parseCli(['x', '--image', '--image-model', 'a/b,c/d', '--image-model', 'e/f'])['image-model'], ['a/b', 'c/d', 'e/f']);
  assert.throws(() => parseCli(['x', '--image', '--via', 'fax']), /Invalid --via/);
  assert.throws(() => parseCli(['x', '--image', '--via', 'chat', '--image-model', 'a/b']), /cannot be combined/);
});

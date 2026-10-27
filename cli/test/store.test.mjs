import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createImageStore, serveImage, isStoredUrl, imageUrl, storeDirFor, IMAGE_NAME, MAX_STORED_BYTES } from '../image/store.mjs';
import { renderResult } from '../image/present.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const fakeFs = () => { const files = new Map(); return { files, mkdir: async () => {}, writeFile: async (p, b) => files.set(p.split(String.fromCharCode(92)).join('/'), b) }; };

test('put stores the bytes under their sha256 and returns a link', async () => {
  const fs = fakeFs();
  const url = await createImageStore({ dir: '/data/fane-images', fs }).put(PNG_URL);
  const name = `${createHash('sha256').update(PNG).digest('hex')}.png`;
  assert.equal(url, `/api/uploads?fane-image=${name}`);
  assert.ok(isStoredUrl(url));
  assert.deepEqual([...fs.files.keys()], [`/data/fane-images/${name}`]);
  assert.deepEqual(fs.files.get(`/data/fane-images/${name}`), PNG);
  assert.equal(await createImageStore({ dir: '/data/fane-images', fs }).put(PNG_URL), url); // same image, same file
  assert.equal(fs.files.size, 1);
});

test('put refuses what is not a storable image', async () => {
  const store = createImageStore({ dir: '/d', fs: fakeFs() });
  await assert.rejects(store.put('data:text/html;base64,PGI+'), /not a storable image/);
  await assert.rejects(store.put('not a url'), /not a storable image/);
  const big = `data:image/png;base64,${Buffer.alloc(MAX_STORED_BYTES + 1).toString('base64')}`;
  await assert.rejects(store.put(big), /too large/);
});

test('isStoredUrl accepts only names the store writes', () => {
  const name = `${'a'.repeat(64)}.jpg`;
  assert.ok(isStoredUrl(imageUrl(name)));
  for (const bad of ['/api/uploads?fane-image=../../config.json', `/api/uploads?fane-image=${'a'.repeat(64)}.html`, `/api/uploads?fane-image=${'a'.repeat(63)}.png`, `/other?fane-image=${name}`, '', null]) assert.ok(!isStoredUrl(bad), String(bad));
  assert.ok(!IMAGE_NAME.test(`${'g'.repeat(64)}.png`));
});

test('serveImage returns the file with safe headers, and 404 for anything else', async () => {
  const name = `${'b'.repeat(64)}.png`;
  const seen = [];
  const read = async (p) => { seen.push(p.split(String.fromCharCode(92)).join('/')); if (!p.includes(name)) throw new Error('ENOENT'); return PNG; };
  const ok = await serveImage(new Request(`http://localhost:3000/api/uploads?fane-image=${name}`), { dir: '/data/fane-images', read });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.match(ok.headers.get('content-security-policy'), /sandbox/);
  assert.match(ok.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);
  for (const q of ['', '?fane-image=', '?fane-image=../../config.json', `?fane-image=${'c'.repeat(64)}.png`, '?other=1']) {
    assert.equal((await serveImage(new Request(`http://localhost:3000/api/uploads${q}`), { dir: '/data/fane-images', read })).status, 404, q);
  }
  assert.deepEqual(seen, [`/data/fane-images/${name}`, `/data/fane-images/${'c'.repeat(64)}.png`]); // traversal never reaches the disk
});

test('the answer links stored images and no longer embeds them', () => {
  const url = imageUrl(`${'d'.repeat(64)}.jpg`);
  const md = renderResult({ images: [{ dataUrl: PNG_URL, url, model: 'a/b', name: 'A: B', pricePerImage: 0.01 }], requested: 1, complete: true, errors: [] }, 'draw a fox');
  assert.ok(md.includes(`<a href="${url}"`) && md.includes(`<img src="${url}"`));
  assert.ok(!md.includes('base64'));
  const bad = renderResult({ images: [{ dataUrl: PNG_URL, url: '/api/uploads?fane-image=../x', model: 'a/b' }], requested: 1, complete: true, errors: [] }, 'draw a fox');
  assert.doesNotMatch(bad, /<img/);
});

test('storeDirFor puts the images next to the config file', () => {
  assert.equal(storeDirFor('/home/vane/data/config.json').split(String.fromCharCode(92)).join('/'), '/home/vane/data/fane-images');
});

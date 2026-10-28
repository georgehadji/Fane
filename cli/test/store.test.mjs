import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { createImageStore, serveImage, isStoredUrl, imageUrl, storeDirFor, IMAGE_NAME, MAX_STORED_BYTES, maxStoreBytesFromEnv, pruneStore } from '../image/store.mjs';
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

test('storedUrlsIn finds the links of an earlier answer, in order, once each', async () => {
  const { storedUrlsIn } = await import('../image/store.mjs');
  const a = imageUrl(`${'a'.repeat(64)}.jpg`), b = imageUrl(`${'b'.repeat(64)}.png`);
  const html = `<a href="${a}"><img src="${a}"></a><a href="${b}"><img src="${b}"></a> and /api/uploads?fane-image=../x.png`;
  assert.deepEqual(storedUrlsIn(html), [a, b]);
  assert.deepEqual(storedUrlsIn('no images here'), []);
  assert.deepEqual(storedUrlsIn(undefined), []);
});

test('get turns a stored link back into a data URL, and refuses anything else', async () => {
  const name = `${'a'.repeat(64)}.png`;
  const store = createImageStore({ dir: '/d', fs: fakeFs(), read: async (p) => { assert.ok(p.includes(name)); return PNG; } });
  assert.equal(await store.get(imageUrl(name)), PNG_URL);
  await assert.rejects(store.get('/api/uploads?fane-image=../../etc/passwd'), /not a stored image link/);
  await assert.rejects(store.get(PNG_URL), /not a stored image link/);
});

const hex = (c) => c.repeat(64);
const fakeDir = (files) => ({
  readdir: async () => Object.keys(files),
  stat: async (p) => files[basename(p)],
  unlink: async (p) => { delete files[basename(p)]; },
});

test('pruneStore removes the oldest images until the folder fits, and keeps the one just written', async () => {
  const files = {
    [`${hex('a')}.png`]: { size: 40, mtimeMs: 1 },
    [`${hex('b')}.png`]: { size: 40, mtimeMs: 2 },
    [`${hex('c')}.png`]: { size: 40, mtimeMs: 3 },
    'notes.txt': { size: 999, mtimeMs: 0 },
  };
  const removed = await pruneStore('/d', { maxBytes: 100, keep: `${hex('a')}.png`, fs: fakeDir(files) });
  assert.deepEqual(removed, [`${hex('b')}.png`]); // a is kept although oldest; one removal brings 120 to 80
  assert.ok(files[`${hex('a')}.png`] && files[`${hex('c')}.png`] && files['notes.txt'], 'other files are never touched');
});

test('pruneStore does nothing while the folder is within its limit', async () => {
  const files = { [`${hex('a')}.png`]: { size: 10, mtimeMs: 1 } };
  assert.deepEqual(await pruneStore('/d', { maxBytes: 10, fs: fakeDir(files) }), []);
});

test('FANE_IMAGE_STORE_MB: megabytes, 1024 by default', () => {
  assert.equal(maxStoreBytesFromEnv({}), 1024 * 1024 * 1024);
  assert.equal(maxStoreBytesFromEnv({ FANE_IMAGE_STORE_MB: '50' }), 50 * 1024 * 1024);
  for (const v of ['', '0', '-5', 'abc']) assert.equal(maxStoreBytesFromEnv({ FANE_IMAGE_STORE_MB: v }), 1024 * 1024 * 1024, v);
});

test('put prunes after writing, and a failing clean-up does not fail the image', async () => {
  const kept = [];
  const ok = createImageStore({ dir: '/d', fs: { mkdir: async () => {}, writeFile: async () => {} }, prune: async (name) => { kept.push(name); } });
  const png = 'data:image/png;base64,' + Buffer.from('png-bytes').toString('base64');
  const url = await ok.put(png);
  assert.deepEqual(kept, [url.split('=')[1]]);
  const broken = createImageStore({ dir: '/d', fs: { mkdir: async () => {}, writeFile: async () => {} }, prune: async () => { throw new Error('disk'); } });
  assert.equal(await broken.put(png), url);
});

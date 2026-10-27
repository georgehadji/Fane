// Generated images as files, so an answer holds a short link instead of megabytes of base64
// (which Vane would also send back to the model with every follow-up).
// put() writes `<sha256 of the bytes>.<ext>` next to Vane's config.json (the persistent data
// volume): the name never comes from the prompt, and the same image is stored once.
// serveImage() is the other half: patches/patch-image-serve.js adds a GET to Vane's
// /api/uploads route that calls it, because Vane does not serve files added to public/
// after it started. File system functions are injectable for tests.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decodeDataUrl } from './extract.mjs';

export const IMAGE_ROUTE = '/api/uploads';
export const IMAGE_PARAM = 'fane-image';
export const MAX_STORED_BYTES = 30 * 1024 * 1024;

const EXT_OF = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const MIME_OF = Object.fromEntries(Object.entries(EXT_OF).map(([mime, ext]) => [ext, mime]));
export const IMAGE_NAME = /^[a-f0-9]{64}\.(?:jpg|png|webp|gif|svg)$/;

// Where the images live, from the path of Vane's config.json. patches/lib/vane.js holds the same
// path for the patch; a test keeps the two equal.
export const storeDirFor = (configPath) => join(dirname(configPath), 'fane-images');

export const imageUrl = (name) => `${IMAGE_ROUTE}?${IMAGE_PARAM}=${name}`;
export const isStoredUrl = (url) => typeof url === 'string' && url.startsWith(`${IMAGE_ROUTE}?${IMAGE_PARAM}=`) && IMAGE_NAME.test(url.slice(IMAGE_ROUTE.length + IMAGE_PARAM.length + 2));

// The stored-image links in a piece of text (an earlier answer), in order, without repeats.
export function storedUrlsIn(text) {
  const prefix = `${IMAGE_ROUTE}?${IMAGE_PARAM}=`;
  const found = String(text ?? '').match(new RegExp(prefix.replace('?', '[?]') + IMAGE_NAME.source.slice(1, -1), 'g')) || [];
  return [...new Set(found)];
}

// put(dataUrl) -> link to the stored image; get(link) -> data URL again (for an edit that uses
// the image as a reference). put rejects what is not a storable image; get what is not a link.
export function createImageStore({ dir, fs = { mkdir, writeFile }, read = readFile }) {
  return {
    async get(url) {
      if (!isStoredUrl(url)) throw new Error('not a stored image link');
      const name = url.slice(IMAGE_ROUTE.length + IMAGE_PARAM.length + 2);
      const bytes = await read(join(dir, name));
      return `data:${MIME_OF[name.slice(name.lastIndexOf('.') + 1)]};base64,${Buffer.from(bytes).toString('base64')}`;
    },
    async put(dataUrl) {
      const image = decodeDataUrl(dataUrl);
      const ext = image && EXT_OF[image.mime];
      if (!ext) throw new Error('not a storable image');
      if (image.bytes.length > MAX_STORED_BYTES) throw new Error('image too large to store');
      const name = `${createHash('sha256').update(image.bytes).digest('hex')}.${ext}`;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, name), image.bytes);
      return imageUrl(name);
    },
  };
}

// GET handler body: Request -> Response. Only names this module wrote are served, from `dir`.
// The headers make a stored SVG harmless when opened directly (no scripts, no sniffing).
export async function serveImage(request, { dir, read = readFile } = {}) {
  const name = new URL(request.url).searchParams.get(IMAGE_PARAM);
  if (!name || !IMAGE_NAME.test(name)) return new Response('Not found', { status: 404 });
  let bytes;
  try { bytes = await read(join(dir, name)); } catch { return new Response('Not found', { status: 404 }); }
  return new Response(bytes, {
    headers: {
      'Content-Type': MIME_OF[name.slice(name.lastIndexOf('.') + 1)],
      'Cache-Control': 'public, max-age=31536000, immutable', // the name is the hash of the content
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

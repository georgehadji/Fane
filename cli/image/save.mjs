// Write generated images to disk: <out-dir>/<prompt-slug>-<n>-<lab>.<ext>. Never
// overwrites: an existing name gets a numeric suffix.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeDataUrl } from './extract.mjs';

export const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

export function slugify(text, max = 40) {
  const s = String(text).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/[\s_-]+/g, '-');
  if (s.length <= max) return s || 'image';
  const cut = s.slice(0, max + 1);
  return (cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : s.slice(0, max)) || 'image'; // whole words only
}

export const fileNameFor = (prompt, index, modelId, mime) =>
  `${slugify(prompt)}-${index + 1}-${slugify(String(modelId).split('/')[0], 20)}.${EXTENSIONS[mime] || 'png'}`;

function freePath(dir, name) {
  let path = join(dir, name);
  for (let k = 2; existsSync(path); k++) path = join(dir, name.replace(/(\.\w+)$/, `-${k}$1`));
  return path;
}

// images: [{ dataUrl, model }] -> [{ path, model, mime, bytes }]
export async function saveImages(images, dir, prompt) {
  await mkdir(dir, { recursive: true });
  const saved = [];
  for (const [i, img] of images.entries()) {
    const decoded = decodeDataUrl(img.dataUrl);
    if (!decoded) continue;
    const path = freePath(dir, fileNameFor(prompt, i, img.model, decoded.mime));
    await writeFile(path, decoded.bytes);
    saved.push({ path, model: img.model, mime: decoded.mime, bytes: decoded.bytes.length });
  }
  return saved;
}

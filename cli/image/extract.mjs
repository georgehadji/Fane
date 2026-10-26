// Find the image in a provider response. Providers return images in different places
// (message.images[].image_url.url, content parts, b64_json fields, plain URLs, or base64
// pasted into text), so walk the whole payload like reasoner's _collect_image_candidates.

const SIGNATURES = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
];

export function sniffMime(buf) {
  for (const [sig, mime] of SIGNATURES) if (sig.every((b, i) => buf[i] === b)) return mime;
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

const DATA_URL = /^data:(image\/[\w+.-]+);base64,([A-Za-z0-9+/=\s]+)$/;
const DATA_URL_IN_TEXT = /data:image\/[\w+.-]+;base64,[A-Za-z0-9+/=]{100,}/;

// A string that is a data URL, or long raw base64 of a known image format -> data URL.
export function toDataUrl(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (DATA_URL.test(s)) return s.replace(/\s+/g, '');
  const compact = s.replace(/\s+/g, '');
  if (compact.length < 200 || !/^[A-Za-z0-9+/]+=*$/.test(compact)) return null;
  const mime = sniffMime(Buffer.from(compact.slice(0, 64), 'base64'));
  return mime ? `data:${mime};base64,${compact}` : null;
}

export function looksLikeImageUrl(value, { anyHttps = false } = {}) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return false;
  return anyHttps || /\.(png|jpe?g|gif|webp|svg)(\?|$)|\/image|[?&](format|fm)=(png|jpe?g|webp)/i.test(value);
}

// -> { inline: [dataUrl...], remote: [url...] }, order kept, duplicates dropped.
export function collectImageCandidates(node) {
  const inline = [], remote = [];
  const seen = new Set();
  const visit = (v, key) => {
    if (v == null) return;
    if (typeof v === 'string') {
      const d = toDataUrl(v) || v.match(DATA_URL_IN_TEXT)?.[0];
      if (d) return void inline.push(d);
      if (looksLikeImageUrl(v, { anyHttps: ['url', 'image_url', 'source'].includes(key) })) remote.push(v.trim());
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return v.forEach(x => visit(x, key));
    for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(node);
  return { inline: [...new Set(inline)], remote: [...new Set(remote)] };
}

export function decodeDataUrl(dataUrl) {
  const m = String(dataUrl).match(DATA_URL);
  if (!m) return null;
  const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  return { mime: sniffMime(bytes) || m[1], bytes };
}

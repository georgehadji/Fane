// Fetch a provider-hosted image URL (some models return a link instead of inline data).
// The URL comes from a third party, so: https only, no private/loopback/link-local hosts,
// every redirect re-checked, a byte cap, and the bytes must sniff as an image.
// shortcut: the host is resolved, then fetched, so DNS rebinding between the two is not
// prevented; upgrade to a pinned-address agent if this ever runs as a shared service.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sniffMime } from './extract.mjs';

export function isPrivateAddress(ip) {
  const v = String(ip).toLowerCase().replace(/^::ffff:/, '');
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

export async function safeDownload(url, { fetchImpl = fetch, resolve = lookup, maxBytes = 20_000_000, maxRedirects = 3 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:') throw new Error(`refusing ${u.protocol} image URL`);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
    if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) throw new Error(`refusing image URL on a private address: ${host}`);
    const res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) throw new Error('image download exceeds the size cap');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('image download exceeds the size cap');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const mime = sniffMime(bytes);
    if (!mime) throw new Error('downloaded file is not an image');
    return `data:${mime};base64,${bytes.toString('base64')}`;
  }
  throw new Error('image download: too many redirects');
}

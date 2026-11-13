// X (Twitter) posts through xAI's `x_search` tool, for Vane's Social source (patches/patch-x-search.js calls
// searchX() from the social_search tool, next to the forum and site:x.com searches). x_search is a Grok server-side
// tool on the Responses API, not a search endpoint: one request asks Grok to search X and answer with the posts.
// Pure functions plus one factory whose fetch is injected. Rules:
//  - The key is the API key of the Vane provider whose Base URL is api.x.ai (Settings -> Models, an OpenAI-compatible
//    provider), like OpenRouter's and freellmapi's. No such provider, no call, no cost. The key is never logged.
//  - It costs money ($5 per 1,000 posts fetched, plus Grok tokens, docs.x.ai), so one call per social_search at most,
//    and at most `maxCalls` (2) per research (the research block is the key). A failure or a timeout is [].
//  - Posts are untrusted text. Only x.com / twitter.com status URLs are kept; when the response cites its sources
//    (annotations), a post whose URL is not among them is dropped, because the model could have written the link itself.
//  - Checked live 2026-11-13: the reply is a `message` item whose `output_text` holds the JSON array, and its `annotations`
//    are `url_citation`s of the form x.com/i/status/<id> (not the handle form the text uses), so posts are matched by id.

export const XAI_HOST = 'api.x.ai';
export const XAI_URL = `https://${XAI_HOST}/v1/responses`;
export const DEFAULT_X_MODEL = 'grok-4.7'; // the model docs.x.ai uses in its x_search examples; FANE_X_MODEL overrides
export const X_MAX_CALLS = 2; // per research block
export const MAX_POSTS = 8;
export const POST_CHARS = 400;
const TIMEOUT_MS = 90_000; // a live call took 39 s (three server-side searches); 45 s timed out

// An X post URL (profiles, searches and hashtag pages say little on their own).
export const X_POST = /^https?:\/\/(?:(?:www|mobile)\.)?(?:x|twitter)\.com\/\w+\/status\/\d+/;
const X_POST_ANYWHERE = /https?:\/\/(?:(?:www|mobile)\.)?(?:x|twitter)\.com\/\w+\/status\/\d+/g;

// The key of the Vane provider that points at xAI ({ name, type, config: { baseURL, apiKey } } from config.json).
export const findXaiKey = (modelProviders) =>
  (modelProviders || []).find(p => String(p.config?.baseURL || '').includes(XAI_HOST) && p.config?.apiKey)?.config.apiKey || null;

export function xPrompt(queries) {
  const topics = [...new Set((queries || []).map(q => String(q).trim()).filter(Boolean))].slice(0, 3);
  return `Search X (Twitter) for posts about: ${topics.map(t => `"${t}"`).join('; ')}.\n\nReply with only a JSON array (no prose, no code fence) of at most ${MAX_POSTS} objects with the keys "url", "text" and "date". "url" is the post's own link (https://x.com/<handle>/status/<id>) exactly as the search returned it; "text" is the post's text, shortened to ${POST_CHARS} characters; "date" is YYYY-MM-DD. Include only posts the search returned and never write a link you did not get from it. Reply [] when nothing relevant was found.`;
}

export const xRequest = (queries, model = DEFAULT_X_MODEL) => ({
  model,
  input: [{ role: 'user', content: xPrompt(queries) }],
  tools: [{ type: 'x_search' }],
  max_turns: 2,
  store: false,
});

const strip = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
// A post is its status id: the live response cites x.com/i/status/<id> while the text links x.com/<handle>/status/<id>.
const canon = (u) => /\/status\/(\d+)/.exec(String(u))?.[1] || '';

// A Responses API body -> [{ url, text, date }]. The text is the "output_text" of the message items; citations are the
// urls of their annotations and of content items typed "cite" or "url". Posts come from the JSON array in the text; when
// that does not parse, from the status URLs in it, with no text.
export function parseResponse(body) {
  const items = Array.isArray(body?.output) ? body.output : [];
  let text = '';
  const cited = new Set();
  for (const item of items) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') text += `${part.text}\n`;
      if ((part?.type === 'cite' || part?.type === 'url') && typeof part.url === 'string') cited.add(part.url);
      for (const a of Array.isArray(part?.annotations) ? part.annotations : []) if (typeof a?.url === 'string') cited.add(a.url);
    }
    if (typeof item?.text === 'string' && item.type === 'message') text += `${item.text}\n`;
  }
  const citedPosts = new Set([...cited].filter(u => X_POST.test(u)).map(canon));
  let posts = [];
  const open = text.indexOf('['), close = text.lastIndexOf(']');
  if (open >= 0 && close > open) {
    try { posts = JSON.parse(text.slice(open, close + 1)); } catch { /* the URLs below */ }
  }
  if (!Array.isArray(posts)) posts = [];
  if (!posts.length) posts = (text.match(X_POST_ANYWHERE) || []).map(url => ({ url }));
  const seen = new Set(), out = [];
  for (const p of posts) {
    const url = typeof p?.url === 'string' ? p.url.trim().replace(/[)\].,;]+$/, '') : '';
    if (!X_POST.test(url) || seen.has(canon(url))) continue;
    if (citedPosts.size && !citedPosts.has(canon(url))) continue; // not a source the response itself named
    seen.add(canon(url));
    const date = /^\d{4}-\d{2}-\d{2}/.exec(String(p.date ?? ''))?.[0] || '';
    out.push({ url, text: strip(p.text).slice(0, POST_CHARS), date });
    if (out.length >= MAX_POSTS) break;
  }
  return out;
}

// Posts -> the shape Vane's search results have ({ content, metadata: { url, title } }), labelled like patch-social-sources
// labels its own: "[X | 2026-11-12] text". A post with no text is not a source.
export const toResults = (posts) => posts.filter(p => p.text).map(p => {
  const handle = /\/(\w+)\/status\//.exec(p.url)?.[1];
  return { content: `[${['X', p.date].filter(Boolean).join(' | ')}] ${p.text}`, metadata: { url: p.url, title: handle ? `X post by @${handle}` : 'X post' } };
});

// readKey() -> the xAI key or null (read at every call: a key added in Vane's settings needs no restart).
export function createXSearch({ fetchImpl = fetch, readKey, model = DEFAULT_X_MODEL, maxCalls = X_MAX_CALLS, timeoutMs = TIMEOUT_MS, log = () => {} } = {}) {
  const used = new WeakMap();
  return async function search({ queries, block }) {
    if (!block || typeof block !== 'object') return []; // no research to count the cost against: no call
    let key = null;
    try { key = await readKey(); } catch { /* no key */ }
    if (!key) return [];
    const n = used.get(block) || 0;
    if (n >= maxCalls) return [];
    if (!(queries || []).some(q => String(q).trim())) return [];
    used.set(block, n + 1);
    try {
      const res = await fetchImpl(XAI_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(xRequest(queries, model)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { log(`x_search: HTTP ${res.status}`); return []; }
      const posts = parseResponse(await res.json());
      log(`x_search: ${posts.length} post(s) for ${(queries || []).length} query(ies)`);
      return toResults(posts);
    } catch (err) {
      log(`x_search failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
      return [];
    }
  };
}

// What the patched social_search tool calls: the key from Vane's config.json (`configPath`), the model and the cap from
// the environment (FANE_X_MODEL, FANE_X_MAX_CALLS). One searcher per process, so its per-research count lasts.
// `fetchImpl`/`readConfig` are for tests and get a searcher of their own.
let shared = null;
export async function searchX({ queries, block, configPath, readConfig, env = process.env, fetchImpl, log = (m) => console.log(`fane: ${m}`) } = {}) {
  const readKey = async () => {
    const { readFile } = await import('node:fs/promises');
    return findXaiKey(JSON.parse(readConfig ? await readConfig() : await readFile(configPath, 'utf8')).modelProviders);
  };
  const model = env.FANE_X_MODEL || DEFAULT_X_MODEL;
  if (fetchImpl || readConfig) return createXSearch({ fetchImpl, readKey, log, model })({ queries, block });
  const max = Number(env.FANE_X_MAX_CALLS);
  shared ??= createXSearch({ readKey, log, model, maxCalls: Number.isInteger(max) && max >= 0 ? max : X_MAX_CALLS });
  return shared({ queries, block });
}

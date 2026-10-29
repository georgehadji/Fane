// Talking to Vane and OpenRouter for the CLI: defaults, Vane's providers and models, adding OpenRouter models, and the search call.
// Split out of vane.mjs so the feature runners (runners.mjs) and the command line (vane.mjs) share it without importing each other.
import { execFileSync } from 'node:child_process';
import { OPENROUTER_BASE_URL, OPENROUTER_HOST, createOpenRouterClient } from './image/openrouter.mjs';

// The defaults for every Fane tool (scripts/ import this object).
export const DEFAULTS = {
  // 127.0.0.1, not localhost: Vane is published on 127.0.0.1 only, and "localhost" resolves to ::1 first, where
  // another dev server on port 3000 answered every call with 404 in the middle of a benchmark run.
  url: process.env.VANE_URL || 'http://127.0.0.1:3000',
  model: process.env.VANE_CHAT_MODEL || 'google/gemini-3.8-flash',
  embedding: process.env.VANE_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
  container: process.env.VANE_CONTAINER || 'vane',
  sources: process.env.VANE_SOURCES || 'web',
  // speed is the default: works with every model tested. Balanced + Claude
  // Sonnet via OpenRouter returns finish_reason=content_filter (0 sources),
  // and balanced + Gemini 3.1 Pro exceeded 180s.
  mode: process.env.VANE_MODE || 'speed',
};
export const VALID_SOURCES = ['web', 'academic', 'discussions'];
export const VALID_MODES = ['speed', 'balanced', 'quality'];
const STARTUP_WAIT_MS = 90_000;
const SEARCH_RETRIES = 1; // retried only on HTTP 5xx / connection reset, never on timeout (that would double the wait)
const SLUG_RE = /^[\w.~-]+\/[\w.:~-]+$/; // vendor/model[:variant], the OpenRouter id shape

export class UsageError extends Error {}

export async function getProviders(url) {
  const res = await fetch(`${url}/api/providers`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET /api/providers failed: HTTP ${res.status}`);
  return (await res.json()).providers;
}

// Vane runs in Docker; if it is unreachable, try to start the container once and wait.
export async function getProvidersStartingVane(url, container) {
  try {
    return await getProviders(url);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    process.stderr.write(`Vane not reachable at ${url}; starting container "${container}"...\n`);
    try {
      execFileSync('docker', ['start', container], { stdio: 'ignore', timeout: 60_000 });
    } catch {
      throw new Error(`Could not start Docker container "${container}". Is Docker Desktop running?`);
    }
    const deadline = Date.now() + STARTUP_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      try { return await getProviders(url); } catch { /* still starting */ }
    }
    throw new Error(`Vane did not become ready within ${STARTUP_WAIT_MS / 1000}s`);
  }
}

function isConnectionError(err) {
  const code = err?.cause?.code;
  return ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(code) || err?.name === 'TimeoutError';
}

// Match a model by exact key, then exact name, then unique substring (case-insensitive).
export function resolveModel(providers, kind, wanted) {
  const all = providers.flatMap(p => (p[kind] || []).map(m => ({ providerId: p.id, provider: p.name, ...m })));
  const w = wanted.toLowerCase();
  const exact = all.find(m => m.key.toLowerCase() === w) || all.find(m => m.name.toLowerCase() === w);
  if (exact) return exact;
  const partial = all.filter(m => m.key.toLowerCase().includes(w) || m.name.toLowerCase().includes(w));
  if (partial.length === 1) return partial[0];
  const label = kind === 'chatModels' ? 'chat' : 'embedding';
  const keys = (list) => list.slice(0, 15).map(m => m.key).join(', ') + (list.length > 15 ? `, ... (${list.length} total)` : '');
  const hint = partial.length ? `Ambiguous, matches: ${keys(partial)}` : `Available: ${keys(all)}. Run \`vane --list-models\` for all.`;
  const err = new UsageError(`Unknown ${label} model "${wanted}". ${hint}`);
  err.noMatch = partial.length === 0;
  throw err;
}

// ---- OpenRouter ----------------------------------------------------------

const fetchOpenRouterCatalog = () => createOpenRouterClient().models();

// Vane has no "provider type" in /api/providers, so find the OpenRouter one by name.
export function findOpenRouterProvider(providers, wanted) {
  const w = (wanted || 'openrouter').toLowerCase();
  const exact = providers.filter(p => p.name.toLowerCase() === w);
  if (exact.length === 1) return exact[0];
  const hits = providers.filter(p => p.name.toLowerCase().includes(w));
  if (hits.length === 1) return hits[0];
  const names = providers.map(p => p.name).join(', ');
  throw new UsageError(hits.length
    ? `More than one provider matches "${w}": ${hits.map(p => p.name).join(', ')}. Use --provider.`
    : `No Vane provider named like "${w}" (have: ${names}). Add an OpenRouter provider in Vane Settings -> Models, or use --provider.`);
}

// Vane's model providers from /api/config, API keys included: hand them to a client and nowhere else (never log or keep them).
export async function getModelProviders(url) {
  const res = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(10_000) });
  return (await res.json()).values?.modelProviders || [];
}

// Returns a warning string if the provider's Base URL is not OpenRouter, else null.
// Reads only baseURL from the providers (which also contain API keys: never keep or print them).
export async function openRouterBaseUrlWarning(url, provider) {
  try {
    const cfg = (await getModelProviders(url)).find(p => p.id === provider.id);
    const base = cfg?.config?.baseURL;
    if (!cfg || (base && base.includes(OPENROUTER_HOST))) return null;
    return `provider "${provider.name}" (${cfg.type}) uses Base URL ${base || '(default)'}, not OpenRouter. Models will fail until you set Base URL ${OPENROUTER_BASE_URL} and an OpenRouter API key in Vane Settings -> Models.`;
  } catch { return null; }
}

export async function vaneModelRequest(url, providerId, method, body) {
  const res = await fetch(`${url}/api/providers/${providerId}/models`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method} /api/providers/${providerId}/models failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// Registers an OpenRouter chat model in Vane after checking the slug exists in the public catalog,
// so a typo is never persisted to Vane's config. Returns the refreshed provider list.
export async function addOpenRouterModel(url, providers, slug, providerName) {
  if (!SLUG_RE.test(slug)) throw new UsageError(`"${slug}" is not an OpenRouter slug (expected vendor/model, e.g. anthropic/claude-haiku-4.5)`);
  const provider = findOpenRouterProvider(providers, providerName);
  if ((provider.chatModels || []).some(m => m.key === slug)) return { providers, provider, name: slug, added: false };
  const entry = (await fetchOpenRouterCatalog()).find(m => m.id === slug);
  if (!entry) throw new UsageError(`"${slug}" is not in the OpenRouter catalog. Search with: vane --list-openrouter <text>`);
  await vaneModelRequest(url, provider.id, 'POST', { type: 'chat', key: slug, name: entry.name || slug });
  const warning = await openRouterBaseUrlWarning(url, provider);
  if (warning) process.stderr.write(`vane: warning: ${warning}\n`);
  return { providers: await getProviders(url), provider, name: entry.name || slug, added: true };
}

export async function listOpenRouter(filter, asJson) {
  const f = filter.toLowerCase();
  const rows = (await fetchOpenRouterCatalog())
    .filter(m => !f || m.id.toLowerCase().includes(f) || (m.name || '').toLowerCase().includes(f))
    .map(m => ({ id: m.id, name: m.name, contextLength: m.context_length, promptUsdPerM: m.pricing?.prompt != null ? Number(m.pricing.prompt) * 1e6 : null }));
  if (asJson) return console.log(JSON.stringify(rows, null, 2));
  for (const r of rows.slice(0, 40)) {
    const price = r.promptUsdPerM == null ? '?' : `$${r.promptUsdPerM.toFixed(2)}`;
    console.log(`${r.id.padEnd(48)}  ${String(r.contextLength ?? '?').padStart(8)} ctx  ${price.padStart(8)}/M in`);
  }
  if (rows.length > 40) console.log(`... ${rows.length - 40} more (narrow the filter)`);
  if (!rows.length) console.log('No matching models.');
}

// ---- model selection -----------------------------------------------------

// The built-in default model may not exist in a given Vane install. Order:
// 1. known to Vane; 2. an OpenRouter slug in the public catalog -> register it;
// 3. user gave no model and exactly one chat model exists -> use it; 4. error.
// Returns { model, providers } (providers is refreshed if a model was registered).
export async function resolveChatModel(providers, opts) {
  try {
    return { model: resolveModel(providers, 'chatModels', opts.model), providers };
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    if (err.noMatch && SLUG_RE.test(opts.model)) {
      try {
        const added = await addOpenRouterModel(opts.url, providers, opts.model, opts.provider);
        process.stderr.write(`vane: registered OpenRouter model "${opts.model}" in Vane provider "${added.provider.name}".\n`);
        return { model: resolveModel(added.providers, 'chatModels', opts.model), providers: added.providers };
      } catch (regErr) {
        // Explicit request: the registration error is the useful one. Default: fall through to the generic hint.
        if (opts.modelExplicit) throw regErr;
      }
    }
    if (opts.modelExplicit) throw err;
    const all = providers.flatMap(p => (p.chatModels || []).map(m => ({ providerId: p.id, provider: p.name, ...m })));
    if (all.length === 1) {
      process.stderr.write(`vane: default model "${opts.model}" not found; using the only chat model "${all[0].key}".\n`);
      return { model: all[0], providers };
    }
    throw new UsageError(`Default model not found (no -m or VANE_CHAT_MODEL given). ${err.message}`);
  }
}

// ---- search --------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// content is kept for --verify only; it is not printed.
const mapSources = (list) => (list || []).map(s => ({ title: s.metadata?.title || '', url: s.metadata?.url || '', content: s.content || '' }));

async function postSearch(opts, body, chatKey) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${opts.url}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        throw new Error(`Search timed out after ${opts.timeoutMs / 1000}s (model ${chatKey}). Try --mode speed, another --model, or check \`docker logs ${DEFAULTS.container}\`.`);
      }
      if (attempt < SEARCH_RETRIES && isConnectionError(err)) { await sleep(2000); continue; }
      throw err;
    }
    if (res.status >= 500 && attempt < SEARCH_RETRIES) { await res.arrayBuffer().catch(() => {}); await sleep(2000); continue; }
    if (!res.ok) throw new Error(`Search failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }
}

// Vane streams NDJSON: {type:'init'|'sources'|'response'|'done'|'error', data}.
async function readStream(res, onToken) {
  const decoder = new TextDecoder();
  let buf = '';
  let message = '';
  let sources = [];
  const handle = (line) => {
    if (!line.trim()) return;
    const ev = JSON.parse(line);
    if (ev.type === 'sources') sources = ev.data;
    else if (ev.type === 'response') { message += ev.data; onToken(ev.data); }
    else if (ev.type === 'error') throw new Error(`Vane error: ${typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)}`);
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  // what is left is a line the stream ended in the middle of (Vane restarted, the connection dropped): say that,
  // not "Unexpected end of JSON input"; the tokens already printed stay on the screen
  try { handle(buf); } catch (err) {
    if (err instanceof SyntaxError) throw new Error('Vane closed the stream in the middle of the answer');
    throw err;
  }
  return { message, sources };
}

export async function search(opts, providers) {
  const { model: chat, providers: current } = await resolveChatModel(providers, opts);
  const emb = resolveModel(current, 'embeddingModels', opts.embedding);
  const body = {
    chatModel: { providerId: chat.providerId, key: chat.key },
    embeddingModel: { providerId: emb.providerId, key: emb.key },
    sources: opts.sources,
    optimizationMode: opts.mode,
    query: opts.query,
    stream: opts.stream,
    ...(opts.instructions ? { systemInstructions: opts.instructions } : {}),
  };
  const res = await postSearch(opts, body, chat.key);
  if (opts.stream) {
    const data = await readStream(res, (t) => process.stdout.write(t)).catch(err => {
      // The request signal also aborts the body read once the timeout passes.
      if (err?.name === 'TimeoutError') throw new Error(`Search timed out after ${opts.timeoutMs / 1000}s while streaming (model ${chat.key}). Try --mode speed or another --model.`);
      throw err;
    });
    process.stdout.write('\n');
    return { model: chat.key, message: data.message, sources: mapSources(data.sources), streamed: true };
  }
  const data = JSON.parse(await res.text());
  return { model: chat.key, message: data.message || '', sources: mapSources(data.sources) };
}


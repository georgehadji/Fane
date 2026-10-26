#!/usr/bin/env node
// Headless CLI for a local Vane instance (https://github.com/ItzCrazyKns/Vane).
// Sends a question to Vane's /api/search and prints the cited answer + sources.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULTS = {
  url: process.env.VANE_URL || 'http://localhost:3000',
  model: process.env.VANE_CHAT_MODEL || 'google/gemini-3.8-flash',
  embedding: process.env.VANE_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
  container: process.env.VANE_CONTAINER || 'vane',
  sources: process.env.VANE_SOURCES || 'web',
  // speed is the default: works with every model tested. Balanced + Claude
  // Sonnet via OpenRouter returns finish_reason=content_filter (0 sources),
  // and balanced + Gemini 3.1 Pro exceeded 180s.
  mode: process.env.VANE_MODE || 'speed',
};
const VALID_SOURCES = ['web', 'academic', 'discussions'];
const VALID_MODES = ['speed', 'balanced', 'quality'];
const STARTUP_WAIT_MS = 90_000;
const SEARCH_RETRIES = 1; // retried only on HTTP 5xx / connection reset, never on timeout (that would double the wait)
const OPENROUTER_CATALOG = 'https://openrouter.ai/api/v1/models';
const SLUG_RE = /^[\w.~-]+\/[\w.:~-]+$/; // vendor/model[:variant], the OpenRouter id shape

const USAGE = `Usage: vane "<question>" [options]
       vane --list-models [--json]
       vane --list-openrouter [filter] [--json]
       vane --add-model <openrouter-slug> [--provider <name>]
       vane --remove-model <slug> [--provider <name>]
       vane --doctor

Options:
  -m, --model <id>       Chat model key or name (default: ${DEFAULTS.model}).
                         An OpenRouter slug (vendor/model) that Vane does not know yet is
                         registered in Vane's OpenRouter provider automatically.
  -e, --embedding <id>   Embedding model key or name (default: ${DEFAULTS.embedding})
  -s, --sources <list>   Comma list of: ${VALID_SOURCES.join(', ')} (default: ${DEFAULTS.sources}, env VANE_SOURCES)
  -o, --mode <mode>      ${VALID_MODES.join(' | ')} (default: ${DEFAULTS.mode}, env VANE_MODE)
  -i, --instructions <t> Extra system instructions (style, focus)
  -t, --timeout <sec>    Request timeout in seconds (default: 180, 600 with --mode quality)
  -j, --json             Print raw JSON {message, sources}
      --stream           Print the answer as it is generated (not with --json)
      --require-sources  Exit 1 if the answer has no sources
      --list-models      List available chat and embedding models
      --list-openrouter  List/search OpenRouter's public model catalog
      --add-model <slug> Register an OpenRouter model in Vane
      --remove-model <s> Remove a model registered in Vane
      --provider <name>  Vane provider to use for --add-model/--remove-model (default: the one named like "openrouter")
      --doctor           Check Docker, container, patches and SearXNG health
      --url <url>        Vane URL (default: ${DEFAULTS.url}, env VANE_URL)
  -h, --help             Show this help

Env: VANE_URL, VANE_CHAT_MODEL, VANE_EMBEDDING_MODEL, VANE_CONTAINER, VANE_SOURCES, VANE_MODE
Exit codes: 0 ok, 1 runtime error (or no sources with --require-sources), 2 usage error`;

class UsageError extends Error {}

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      // no parseArgs default: we need to know whether -m was given (see resolveChatModel)
      model: { type: 'string', short: 'm' },
      embedding: { type: 'string', short: 'e', default: DEFAULTS.embedding },
      sources: { type: 'string', short: 's', default: DEFAULTS.sources },
      mode: { type: 'string', short: 'o', default: DEFAULTS.mode },
      instructions: { type: 'string', short: 'i' },
      // default depends on mode: quality runs a multi-iteration research loop with page scraping
      timeout: { type: 'string', short: 't' },
      json: { type: 'boolean', short: 'j', default: false },
      stream: { type: 'boolean', default: false },
      'require-sources': { type: 'boolean', default: false },
      'list-models': { type: 'boolean', default: false },
      'list-openrouter': { type: 'boolean', default: false },
      'add-model': { type: 'string' },
      'remove-model': { type: 'string' },
      provider: { type: 'string' },
      doctor: { type: 'boolean', default: false },
      url: { type: 'string', default: DEFAULTS.url },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const sources = values.sources.split(',').map(s => s.trim()).filter(Boolean);
  const bad = sources.filter(s => !VALID_SOURCES.includes(s));
  if (bad.length) throw new UsageError(`Invalid source(s): ${bad.join(', ')}. Use: ${VALID_SOURCES.join(', ')}`);
  if (!VALID_MODES.includes(values.mode)) throw new UsageError(`Invalid mode "${values.mode}". Use: ${VALID_MODES.join(', ')}`);
  values.timeout ??= values.mode === 'quality' ? '600' : '180';
  const timeoutSec = Number(values.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new UsageError(`Invalid timeout "${values.timeout}"`);
  if (values.stream && values.json) throw new UsageError('--stream cannot be combined with --json');
  const modelExplicit = values.model !== undefined || !!process.env.VANE_CHAT_MODEL;
  return { ...values, model: values.model ?? DEFAULTS.model, modelExplicit, sources, timeoutMs: timeoutSec * 1000, query: positionals.join(' ').trim() };
}

async function getProviders(url) {
  const res = await fetch(`${url}/api/providers`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET /api/providers failed: HTTP ${res.status}`);
  return (await res.json()).providers;
}

// Vane runs in Docker; if it is unreachable, try to start the container once and wait.
async function getProvidersStartingVane(url, container) {
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

async function fetchOpenRouterCatalog() {
  const res = await fetch(OPENROUTER_CATALOG, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenRouter catalog: HTTP ${res.status}`);
  return (await res.json()).data || [];
}

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

// Returns a warning string if the provider's Base URL is not OpenRouter, else null.
// Reads only baseURL from /api/config (which also contains API keys: never keep or print them).
async function openRouterBaseUrlWarning(url, provider) {
  try {
    const res = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(10_000) });
    const cfg = (await res.json()).values?.modelProviders?.find(p => p.id === provider.id);
    const base = cfg?.config?.baseURL;
    if (!cfg || (base && base.includes('openrouter.ai'))) return null;
    return `provider "${provider.name}" (${cfg.type}) uses Base URL ${base || '(default)'}, not OpenRouter. Models will fail until you set Base URL https://openrouter.ai/api/v1 and an OpenRouter API key in Vane Settings -> Models.`;
  } catch { return null; }
}

async function vaneModelRequest(url, providerId, method, body) {
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
async function addOpenRouterModel(url, providers, slug, providerName) {
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

async function listOpenRouter(filter, asJson) {
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
async function resolveChatModel(providers, opts) {
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
const mapSources = (list) => (list || []).map(s => ({ title: s.metadata?.title || '', url: s.metadata?.url || '' }));

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
  handle(buf);
  return { message, sources };
}

async function search(opts, providers) {
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

function printResult(result, opts) {
  if (!result.sources.length) {
    const tail = opts['require-sources'] ? ' Failing (--require-sources).' : ' Try --mode speed or another --model.';
    process.stderr.write(`vane: warning: no sources returned (model ${result.model}); answer is not grounded in search.${tail}\n`);
    if (opts['require-sources']) process.exitCode = 1;
  }
  if (opts.json) return console.log(JSON.stringify({ model: result.model, message: result.message, sources: result.sources }, null, 2));
  if (!result.streamed) console.log(result.message.trim());
  if (!result.sources.length) return;
  console.log('\nSources:');
  result.sources.forEach((s, i) => console.log(`[${i + 1}] ${s.title}${s.url ? ` - ${s.url}` : ''}`));
}

function printModels(providers, asJson) {
  const rows = providers.flatMap(p => [
    ...(p.chatModels || []).map(m => ({ type: 'chat', provider: p.name, key: m.key, name: m.name })),
    ...(p.embeddingModels || []).map(m => ({ type: 'embedding', provider: p.name, key: m.key, name: m.name })),
  ]);
  if (asJson) return console.log(JSON.stringify(rows, null, 2));
  for (const r of rows) console.log(`${r.type.padEnd(9)}  ${r.provider.padEnd(12)}  ${r.key.padEnd(34)}  ${r.name}`);
}

// ---- doctor --------------------------------------------------------------

// Fragments the patches in ../patches write (their `to` strings). Keep in sync.
const PATCH_MARKERS = [
  { name: 'patch-toolcall-empty-args', file: '/home/vane/.next/server/chunks/136.js', marker: 'arguments:(0,n.parse)(b.arguments.trim()||"{}")' },
  { name: 'patch-always-search (search)', file: '/home/vane/.next/server/app/api/search/route.js', marker: '(c.classification.skipSearch=!1)||(j=new g.A().research(' },
  { name: 'patch-always-search (chat)', file: '/home/vane/.next/server/app/api/chat/route.js', marker: '(d.classification.skipSearch=!1)||(m=new f.A().research(' },
  { name: 'patch-quality-mode', file: '/home/vane/.next/server/chunks/641.js', marker: 'p[P]={...b,content:d||b.content}' },
  { name: 'patch-scholarly-sources', file: '/home/vane/.next/server/chunks/641.js', marker: '/*fane:academic-toggle*/' },
];

function dockerOut(args, timeout = 30_000) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();
}

// Prints one line per check. Returns the number of failed checks (warnings do not count).
async function doctor(opts) {
  const container = DEFAULTS.container;
  let failures = 0;
  const report = (level, msg) => {
    if (level === 'FAIL') failures++;
    console.log(`${level.padEnd(4)}  ${msg}`);
  };

  let dockerUp = false;
  try { dockerOut(['info', '--format', '{{.ServerVersion}}']); dockerUp = true; report('ok', 'Docker daemon reachable'); }
  catch { report('FAIL', 'Docker daemon not reachable. Start Docker Desktop.'); }

  let running = false;
  if (dockerUp) {
    try {
      running = dockerOut(['inspect', '-f', '{{.State.Running}}', container]) === 'true';
      report(running ? 'ok' : 'FAIL', running ? `container "${container}" running` : `container "${container}" exists but is stopped (docker start ${container})`);
    } catch { report('FAIL', `container "${container}" not found (see README, Requirements)`); }
  }

  try {
    const providers = await getProviders(opts.url);
    const count = (k) => providers.reduce((n, p) => n + (p[k] || []).length, 0);
    report('ok', `Vane API ${opts.url} (${count('chatModels')} chat, ${count('embeddingModels')} embedding models)`);
    if (!count('chatModels')) report('FAIL', 'no chat model configured (Vane Settings -> Models)');
    else if (!opts.modelExplicit) {
      try { resolveModel(providers, 'chatModels', opts.model); }
      catch { report('warn', `default chat model "${opts.model}" not found; pass -m, set VANE_CHAT_MODEL, or use an OpenRouter slug`); }
    }
    try {
      const provider = findOpenRouterProvider(providers, opts.provider);
      const warning = await openRouterBaseUrlWarning(opts.url, provider);
      if (warning) report('warn', warning);
      else report('ok', `OpenRouter provider "${provider.name}" found (-m vendor/model works)`);
    } catch (err) { report('warn', err.message); }
  } catch (err) { report('FAIL', `Vane API ${opts.url} not reachable: ${err.message}`); }

  if (!running) return failures;

  try {
    const script = `const fs=require('fs');console.log(JSON.stringify(${JSON.stringify(PATCH_MARKERS)}.map(x=>{try{return fs.readFileSync(x.file,'utf8').includes(x.marker)}catch{return null}})))`;
    const states = JSON.parse(dockerOut(['exec', container, 'node', '-e', script]));
    PATCH_MARKERS.forEach((p, i) => {
      if (states[i]) report('ok', `${p.name} applied`);
      else report('FAIL', `${p.name} ${states[i] === null ? 'target file missing (different Vane build?)' : 'not applied (run node scripts/apply.mjs)'}`);
    });
  } catch (err) { report('FAIL', `could not inspect patches: ${err.message.split('\n')[0]}`); }

  try {
    const script = `fetch('http://localhost:8080/search?q=test&format=json').then(r=>r.json()).then(j=>console.log(JSON.stringify({n:j.results.length,down:j.unresponsive_engines})))`;
    const { n, down } = JSON.parse(dockerOut(['exec', container, 'node', '-e', script], 60_000));
    report(n > 0 ? 'ok' : 'FAIL', n > 0 ? `SearXNG returns results (${n} for "test")` : 'SearXNG returned 0 results (engines blocked? see README section 2)');
    if (down.length) report('warn', `SearXNG engines down: ${down.map(([e, why]) => `${e} (${why})`).join(', ')}`);
  } catch (err) { report('FAIL', `SearXNG check failed: ${err.message.split('\n')[0]}`); }

  return failures;
}

// ---- main ----------------------------------------------------------------

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) return console.log(USAGE);
  if (opts.doctor) { if (await doctor(opts)) process.exitCode = 1; return; }
  if (opts['list-openrouter']) return listOpenRouter(opts.query, opts.json);
  if (opts['add-model'] !== undefined) {
    const providers = await getProvidersStartingVane(opts.url, DEFAULTS.container);
    const r = await addOpenRouterModel(opts.url, providers, opts['add-model'], opts.provider);
    return console.log(r.added ? `Added "${opts['add-model']}" (${r.name}) to Vane provider "${r.provider.name}".` : `"${opts['add-model']}" is already in Vane provider "${r.provider.name}".`);
  }
  if (opts['remove-model'] !== undefined) {
    const providers = await getProvidersStartingVane(opts.url, DEFAULTS.container);
    const provider = findOpenRouterProvider(providers, opts.provider);
    if (!(provider.chatModels || []).some(m => m.key === opts['remove-model'])) throw new UsageError(`"${opts['remove-model']}" is not in provider "${provider.name}"`);
    await vaneModelRequest(opts.url, provider.id, 'DELETE', { type: 'chat', key: opts['remove-model'] });
    return console.log(`Removed "${opts['remove-model']}" from Vane provider "${provider.name}".`);
  }
  if (!opts['list-models'] && !opts.query) throw new UsageError('Missing question.\n\n' + USAGE);
  const providers = await getProvidersStartingVane(opts.url, DEFAULTS.container);
  if (opts['list-models']) return printModels(providers, opts.json);
  printResult(await search(opts, providers), opts);
}

// Run only when executed (also through the npm bin symlink), not when imported by tests.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(err => {
    const isUsage = err instanceof UsageError || err?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || err?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE';
    process.stderr.write(`vane: ${err.message}\n`);
    process.exit(isUsage ? 2 : 1);
  });
}

#!/usr/bin/env node
// Headless CLI for a local Vane instance (https://github.com/ItzCrazyKns/Vane).
// Sends a question to Vane's /api/search and prints the cited answer + sources.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';

const DEFAULTS = {
  url: process.env.VANE_URL || 'http://localhost:3000',
  model: process.env.VANE_CHAT_MODEL || 'google/gemini-3.8-flash',
  embedding: process.env.VANE_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
  container: process.env.VANE_CONTAINER || 'vane',
};
const VALID_SOURCES = ['web', 'academic', 'discussions'];
const VALID_MODES = ['speed', 'balanced', 'quality'];
const STARTUP_WAIT_MS = 90_000;

const USAGE = `Usage: vane "<question>" [options]
       vane --list-models [--json]

Options:
  -m, --model <id>       Chat model key or name (default: ${DEFAULTS.model})
  -e, --embedding <id>   Embedding model key or name (default: ${DEFAULTS.embedding})
  -s, --sources <list>   Comma list of: ${VALID_SOURCES.join(', ')} (default: web)
  -o, --mode <mode>      ${VALID_MODES.join(' | ')} (default: speed)
  -i, --instructions <t> Extra system instructions (style, focus)
  -t, --timeout <sec>    Request timeout in seconds (default: 180)
  -j, --json             Print raw JSON {message, sources}
      --list-models      List available chat and embedding models
      --url <url>        Vane URL (default: ${DEFAULTS.url}, env VANE_URL)
  -h, --help             Show this help

Env: VANE_URL, VANE_CHAT_MODEL, VANE_EMBEDDING_MODEL, VANE_CONTAINER
Exit codes: 0 ok, 1 runtime error, 2 usage error`;

class UsageError extends Error {}

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      model: { type: 'string', short: 'm', default: DEFAULTS.model },
      embedding: { type: 'string', short: 'e', default: DEFAULTS.embedding },
      sources: { type: 'string', short: 's', default: 'web' },
      // speed is the default: works with every model tested. Balanced + Claude
      // Sonnet via OpenRouter returns finish_reason=content_filter (0 sources),
      // and balanced + Gemini 3.1 Pro exceeded 180s.
      mode: { type: 'string', short: 'o', default: 'speed' },
      instructions: { type: 'string', short: 'i' },
      timeout: { type: 'string', short: 't', default: '180' },
      json: { type: 'boolean', short: 'j', default: false },
      'list-models': { type: 'boolean', default: false },
      url: { type: 'string', default: DEFAULTS.url },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const sources = values.sources.split(',').map(s => s.trim()).filter(Boolean);
  const bad = sources.filter(s => !VALID_SOURCES.includes(s));
  if (bad.length) throw new UsageError(`Invalid source(s): ${bad.join(', ')}. Use: ${VALID_SOURCES.join(', ')}`);
  if (!VALID_MODES.includes(values.mode)) throw new UsageError(`Invalid mode "${values.mode}". Use: ${VALID_MODES.join(', ')}`);
  const timeoutSec = Number(values.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new UsageError(`Invalid timeout "${values.timeout}"`);
  return { ...values, sources, timeoutMs: timeoutSec * 1000, query: positionals.join(' ').trim() };
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
function resolveModel(providers, kind, wanted) {
  const all = providers.flatMap(p => (p[kind] || []).map(m => ({ providerId: p.id, provider: p.name, ...m })));
  const w = wanted.toLowerCase();
  const exact = all.find(m => m.key.toLowerCase() === w) || all.find(m => m.name.toLowerCase() === w);
  if (exact) return exact;
  const partial = all.filter(m => m.key.toLowerCase().includes(w) || m.name.toLowerCase().includes(w));
  if (partial.length === 1) return partial[0];
  const label = kind === 'chatModels' ? 'chat' : 'embedding';
  const hint = partial.length ? `Ambiguous, matches: ${partial.map(m => m.key).join(', ')}` : 'Run `vane --list-models` to see options.';
  throw new UsageError(`Unknown ${label} model "${wanted}". ${hint}`);
}

async function search(opts, providers) {
  const chat = resolveModel(providers, 'chatModels', opts.model);
  const emb = resolveModel(providers, 'embeddingModels', opts.embedding);
  const body = {
    chatModel: { providerId: chat.providerId, key: chat.key },
    embeddingModel: { providerId: emb.providerId, key: emb.key },
    sources: opts.sources,
    optimizationMode: opts.mode,
    query: opts.query,
    stream: false,
    ...(opts.instructions ? { systemInstructions: opts.instructions } : {}),
  };
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
      throw new Error(`Search timed out after ${opts.timeoutMs / 1000}s (model ${chat.key}). Try --mode speed, another --model, or check \`docker logs ${DEFAULTS.container}\`.`);
    }
    throw err;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return { model: chat.key, message: data.message || '', sources: (data.sources || []).map(s => ({ title: s.metadata?.title || '', url: s.metadata?.url || '' })) };
}

function printResult(result, asJson) {
  if (!result.sources.length) {
    process.stderr.write(`vane: warning: no sources returned (model ${result.model}); answer is not grounded in search. Try --mode speed or another --model.\n`);
  }
  if (asJson) return console.log(JSON.stringify(result, null, 2));
  console.log(result.message.trim());
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

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) return console.log(USAGE);
  if (!opts['list-models'] && !opts.query) throw new UsageError('Missing question.\n\n' + USAGE);
  const providers = await getProvidersStartingVane(opts.url, DEFAULTS.container);
  if (opts['list-models']) return printModels(providers, opts.json);
  printResult(await search(opts, providers), opts.json);
}

main().catch(err => {
  const isUsage = err instanceof UsageError || err?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || err?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE';
  process.stderr.write(`vane: ${err.message}\n`);
  process.exit(isUsage ? 2 : 1);
});

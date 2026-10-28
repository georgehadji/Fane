#!/usr/bin/env node
// Headless CLI for a local Vane instance (https://github.com/ItzCrazyKns/Vane).
// Sends a question to Vane's /api/search and prints the cited answer + sources.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILIES, TIERS, TIER_FOR_MODE, VIAS } from './image/catalogue.mjs';
import { imageSubject, isImageRequest } from './image/intent.mjs';
import { ASPECT_RATIOS, DEFAULT_IMAGES, IMAGE_SIZES, IMAGE_TEXT_MODEL, MAX_IMAGES } from './image/generate.mjs';
import { parseImageOptions } from './image/intent.mjs';
import { articleTopic, isArticleRequest, parseArticleOptions, postPlatform, postTopic } from './write/intent.mjs';
import { POSTS, POST_PLATFORMS } from './write/formats.mjs';
import { buildTextCatalogue, selectChains } from './write/catalogue.mjs';
import { LANGUAGES, detectLanguage } from './write/language.mjs';
import { DEFAULT_WORDS, MAX_WORDS, MIN_WORDS } from './write/models.mjs';
import { isCodeRequest } from './code/intent.mjs';
import { isBrainstormRequest } from './brainstorm/intent.mjs';
import { OPENROUTER_BASE_URL, OPENROUTER_HOST, createOpenRouterClient, findOpenRouterKey } from './image/openrouter.mjs';

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
const VALID_SOURCES = ['web', 'academic', 'discussions'];
const VALID_MODES = ['speed', 'balanced', 'quality'];
const STARTUP_WAIT_MS = 90_000;
const SEARCH_RETRIES = 1; // retried only on HTTP 5xx / connection reset, never on timeout (that would double the wait)
const SLUG_RE = /^[\w.~-]+\/[\w.:~-]+$/; // vendor/model[:variant], the OpenRouter id shape

const USAGE = `Usage: vane "<question>" [options]
       vane --list-models [--json]
       vane --list-openrouter [filter] [--json]
       vane --add-model <openrouter-slug> [--provider <name>]
       vane --remove-model <slug> [--provider <name>]
       vane --doctor
       vane --article "<topic>" [-o speed|balanced|quality] [--lang el|en] [--words ${DEFAULT_WORDS}] [--out article.md]
       vane --edit-article article.md "<change>" [-o speed|balanced|quality] [--out new.md]
       vane --post ${POST_PLATFORMS.join('|')} "<topic>" [-o speed|balanced|quality] [--lang el|en] [--words n] [--out post.txt]
       vane --image "<prompt>" [-n ${DEFAULT_IMAGES}] [--tier ${TIERS.join('|')}] [--family <f>] [--aspect 1:1] [--out-dir dir]
       vane --code "<request>" [-o speed|balanced|quality] [--out-dir dir]
       vane --brainstorm "<problem>" [-o speed|balanced|quality] [--lang el|en] [--out ideas.md]

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
      --verify           Check every cited sentence against its cited sources and report
                         weakly supported sentences, numbers not found, bad citation numbers
      --min-support <r>  With --verify: exit 1 if the supported share of cited sentences is below r (0-1)
      --list-models      List available chat and embedding models
      --list-openrouter  List/search OpenRouter's public model catalog
      --add-model <slug> Register an OpenRouter model in Vane
      --remove-model <s> Remove a model registered in Vane
      --provider <name>  Vane provider to use for --add-model/--remove-model (default: the one named like "openrouter")
      --doctor           Check Docker, container, patches and SearXNG health
      --url <url>        Vane URL (default: ${DEFAULTS.url}, env VANE_URL)
  -h, --help             Show this help

Image generation (OpenRouter, needs OPENROUTER_API_KEY or --key-from-vane):
      --image            Generate images from the prompt instead of searching. Questions that
                         start like "create/draw/generate an image of ..." do this automatically
      --no-auto-image    Search even when the question asks for an image
  -n, --count <n>        Images to make, each from a different model (labs differ where possible), each
                         with its own fallback models (default ${DEFAULT_IMAGES}, max ${MAX_IMAGES})
      --via <v>          chat (models that draw inside a chat reply: Gemini, GPT) | images (pure image
                         generators: Flux, Recraft, Seedream, ...); default: whichever fits best
      --image-model <id> Use exactly these models (repeatable or comma list); see --list-image-models
      --list-image-models [filter]  List image models with price, kind (chat/images) and families
      --tier <t>         value (default) | budget | premium: the middle, cheapest and dearest third of
                         the family's models by price, so each tier uses different models. In Vane's
                         web UI the mode picks it: Speed = budget, Balanced = value, Quality = premium
      --family <f>       ${FAMILIES.join(' | ')}; default from the prompt
      --aspect <r>       ${ASPECT_RATIOS.join(' | ')} (default 1:1, or as the prompt says: "widescreen", "16:9")
      --size <s>         ${IMAGE_SIZES.join(' | ')} (models that support it)
      --ref <file>       Reference image to edit or follow (repeatable)
      --out-dir <dir>    Where to save images (default: ./vane-images)
      --no-enhance       Send the prompt as written (skip the prompt-enhancement call)
      --key-from-vane    Use the API key of Vane's OpenRouter provider (read from ${DEFAULTS.url}/api/config)

Articles (OpenRouter, needs OPENROUTER_API_KEY or --key-from-vane; sources come from Vane's own research):
      --article          Write a cited article on the topic instead of answering. Requests that start like
                         "write an article about ..." or "γράψε ένα άρθρο για ..." do this automatically
      --no-auto-article  Search even when the question asks for an article
  -o, --mode <m>         speed (outline, draft) | balanced (+ fact-check, critique, revision, polish) |
                         quality (+ separate style and copy edit, final audit with one retry)
      --tier <t>         budget | value | premium, the same as --mode speed | balanced | quality
      --lang <l>         ${LANGUAGES.join(' | ')}; default from the topic's script (Greek letters mean el)
      --words <n>        Target length (${MIN_WORDS}-${MAX_WORDS}, default ${DEFAULT_WORDS}), or write "800 words" / "800 λέξεις" in the topic
      --article-model <id>  Models for every phase, first one primary and the rest its fallbacks (comma list).
                         Default: per phase, models that passed the trial (scripts/article-trial.mjs) in the
                         price band of the mode: Speed the cheapest third, Balanced the middle, Quality the dearest
      --list-article-models  Show the models each phase would use for -o <mode> and --lang <l>
      --out <file>       Write the article (Markdown) to a file instead of printing it
      --edit-article <f> Change an article written by --article: "make it shorter", "translate it to Greek",
                         "add a paragraph about costs" (requests that add something search with Vane first)
      --post <p>         ${POST_PLATFORMS.join(' | ')}: a social post instead of an article (same research and
                         fact-check, no outline or audit). Plain text with the point in the first line; the [n]
                         markers are removed and the sources printed as the first comment. Requests like
                         "write a LinkedIn post about ..." or «γράψε μια ανάρτηση για ...» do this automatically.
                         --words: ${POST_PLATFORMS.map(p => `${POSTS[p].name} ${POSTS[p].minWords}-${POSTS[p].maxWords}, default ${POSTS[p].words}`).join('; ')}

Code (OpenRouter, needs OPENROUTER_API_KEY or --key-from-vane; documentation comes from Vane's own research):
      --code             Write code for the request: a spec, one file at a time, a hostile review, fixes and tests.
                         Requests like "write a Python script that ..." or «γράψε ένα πρόγραμμα που ...» do this
                         automatically. Files are parsed (node --check, Python's ast.parse), never run
      --no-auto-code     Search even when the question asks for code
  -o, --mode <m>         speed (spec, files) | balanced (+ documentation, review, fixes, tests) |
                         quality (+ known vulnerabilities of the stack for the review)
      --code-model <id>  Models for every phase, first one primary and the rest its fallbacks (comma list).
                         Default: models that passed scripts/code-trial.mjs, in the price band of the mode
      --list-code-models Show the models each phase would use for -o <mode>
      --out-dir <dir>    Where to write the files (default: ./vane-code/<request>); must be new or empty

Brainstorm (OpenRouter, needs OPENROUTER_API_KEY or --key-from-vane; existing work comes from Vane's own research):
      --brainstorm       Ideas for the problem: rounds of rare-on-purpose ideas, merged, themed and scored, the best
                         developed, then one recommendation and a plan. "brainstorm ...", "give me 10 ideas for ..."
                         or «δώσε μου ιδέες για ...» do this automatically
      --no-auto-brainstorm  Search even when the question asks for ideas
  -o, --mode <m>         speed (2 rounds, no development) | balanced (+ existing work, 3 rounds, 3 developed) |
                         quality (4 rounds, 4 developed)
      --brainstorm-model <id>  Models for every phase (comma list). Default: models that passed the article trial
      --lang <l>         ${LANGUAGES.join('|')} (default: the request's language)
      --out <file>       Also save the Markdown to a file

Env: VANE_URL, VANE_CHAT_MODEL, VANE_EMBEDDING_MODEL, VANE_CONTAINER, VANE_SOURCES, VANE_MODE,
     OPENROUTER_API_KEY, VANE_IMAGE_TEXT_MODEL (prompt enhancement/intent, default ${IMAGE_TEXT_MODEL})
Exit codes: 0 ok, 1 runtime error (or no sources with --require-sources, or support below --min-support), 2 usage error`;

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
      verify: { type: 'boolean', default: false },
      'min-support': { type: 'string' },
      'list-models': { type: 'boolean', default: false },
      'list-openrouter': { type: 'boolean', default: false },
      'add-model': { type: 'string' },
      'remove-model': { type: 'string' },
      provider: { type: 'string' },
      doctor: { type: 'boolean', default: false },
      image: { type: 'boolean', default: false },
      count: { type: 'string', short: 'n' }, // default: DEFAULT_IMAGES, or one per --image-model
      via: { type: 'string' },
      'image-model': { type: 'string', multiple: true, default: [] },
      'list-image-models': { type: 'boolean', default: false },
      tier: { type: 'string' },
      family: { type: 'string' },
      aspect: { type: 'string' },
      size: { type: 'string' },
      ref: { type: 'string', multiple: true, default: [] },
      'out-dir': { type: 'string' }, // default: vane-images for --image, vane-code/<request> for --code
      'no-enhance': { type: 'boolean', default: false },
      'key-from-vane': { type: 'boolean', default: false },
      'no-auto-image': { type: 'boolean', default: false },
      article: { type: 'boolean', default: false },
      'list-article-models': { type: 'boolean', default: false },
      'no-auto-article': { type: 'boolean', default: false },
      lang: { type: 'string' },
      words: { type: 'string' },
      'article-model': { type: 'string', multiple: true, default: [] },
      out: { type: 'string' },
      'edit-article': { type: 'string' },
      post: { type: 'string' },
      code: { type: 'boolean', default: false },
      'code-model': { type: 'string', multiple: true, default: [] },
      'list-code-models': { type: 'boolean', default: false },
      'no-auto-code': { type: 'boolean', default: false },
      brainstorm: { type: 'boolean', default: false },
      'brainstorm-model': { type: 'string', multiple: true, default: [] },
      'no-auto-brainstorm': { type: 'boolean', default: false },
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
  if (values.image) {
    if (values.count !== undefined) {
      const n = Number(values.count);
      if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) throw new UsageError(`Invalid --count "${values.count}" (1-${MAX_IMAGES})`);
      values.count = n;
    }
    values['image-model'] = values['image-model'].flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean);
    if (values.via && !VIAS.includes(values.via)) throw new UsageError(`Invalid --via "${values.via}". Use: ${VIAS.join(', ')}`);
    if (values.via && values['image-model'].length) throw new UsageError('--via and --image-model cannot be combined');
    if (values.tier && !TIERS.includes(values.tier)) throw new UsageError(`Invalid --tier "${values.tier}". Use: ${TIERS.join(', ')}`);
    if (values.family && !FAMILIES.includes(values.family)) throw new UsageError(`Invalid --family "${values.family}". Use: ${FAMILIES.join(', ')}`);
    if (values.aspect !== undefined && !ASPECT_RATIOS.includes(values.aspect)) throw new UsageError(`Invalid --aspect "${values.aspect}". Use: ${ASPECT_RATIOS.join(', ')}`);
    if (values.size && !IMAGE_SIZES.includes(values.size.toUpperCase())) throw new UsageError(`Invalid --size "${values.size}". Use: ${IMAGE_SIZES.join(', ')}`);
    if (values.size) values.size = values.size.toUpperCase();
    if (values.stream) throw new UsageError('--stream does not apply to --image');
  }
  if (values.post !== undefined) {
    values.post = values.post.toLowerCase();
    if (!POST_PLATFORMS.includes(values.post)) throw new UsageError(`Invalid --post "${values.post}". Use: ${POST_PLATFORMS.join(', ')}`);
    values.article = true; // a post is the article pipeline with another format
  }
  if (values.article || values['list-article-models'] || values['edit-article'] !== undefined) {
    values['article-model'] = values['article-model'].flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean);
    if (values.lang && !LANGUAGES.includes(values.lang)) throw new UsageError(`Invalid --lang "${values.lang}". Use: ${LANGUAGES.join(', ')}`);
    if (values.tier && !TIERS.includes(values.tier)) throw new UsageError(`Invalid --tier "${values.tier}". Use: ${TIERS.join(', ')}`);
    if (values.words !== undefined) {
      const n = Number(values.words);
      const [min, max] = values.post ? [POSTS[values.post].minWords, POSTS[values.post].maxWords] : [MIN_WORDS, MAX_WORDS];
      if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`Invalid --words "${values.words}" (${min}-${max})`);
      values.words = n;
    }
    if (values.stream) throw new UsageError('--stream does not apply to --article');
  }
  if (values.code || values['list-code-models']) {
    values['code-model'] = values['code-model'].flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean);
    if (values.tier && !TIERS.includes(values.tier)) throw new UsageError(`Invalid --tier "${values.tier}". Use: ${TIERS.join(', ')}`);
    if (values.stream) throw new UsageError('--stream does not apply to --code');
  }
  if (values.brainstorm) {
    values['brainstorm-model'] = values['brainstorm-model'].flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean);
    if (values.lang && !LANGUAGES.includes(values.lang)) throw new UsageError(`Invalid --lang "${values.lang}". Use: ${LANGUAGES.join(', ')}`);
    if (values.tier && !TIERS.includes(values.tier)) throw new UsageError(`Invalid --tier "${values.tier}". Use: ${TIERS.join(', ')}`);
    if (values.stream) throw new UsageError('--stream does not apply to --brainstorm');
  }
  if (values['min-support'] !== undefined) {
    const r = Number(values['min-support']);
    if (!(r >= 0 && r <= 1)) throw new UsageError(`Invalid --min-support "${values['min-support']}" (use 0-1)`);
    values['min-support'] = r;
    values.verify = true;
  }
  const modelExplicit = values.model !== undefined || !!process.env.VANE_CHAT_MODEL;
  return { ...values, model: values.model ?? DEFAULTS.model, modelExplicit, sources, timeoutMs: timeoutSec * 1000, query: positionals.join(' ').trim() };
}

// A query that asks for an image, code or an article goes there without --image/--code/--article. The arguments
// are parsed again with that flag, so its options are checked as when it is typed (-n abc, --tier bogus).
// -> the options for runImage / runCode / runArticle, or null for a search.
export function autoRoute(opts, argv) {
  if (opts['list-models']) return null;
  if (!opts['no-auto-image'] && isImageRequest(opts.query)) return parseCli(['--image', ...argv]);
  if (!opts['no-auto-brainstorm'] && isBrainstormRequest(opts.query)) return parseCli(['--brainstorm', ...argv]);
  if (!opts['no-auto-code'] && isCodeRequest(opts.query)) return parseCli(['--code', ...argv]);
  // a post before an article: «ανάρτηση» matches both
  const platform = opts['no-auto-article'] ? null : postPlatform(opts.query);
  if (platform) return parseCli(['--post', platform, ...argv]);
  if (!opts['no-auto-article'] && isArticleRequest(opts.query)) return parseCli(['--article', ...argv]);
  return null;
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

// Returns a warning string if the provider's Base URL is not OpenRouter, else null.
// Reads only baseURL from /api/config (which also contains API keys: never keep or print them).
async function openRouterBaseUrlWarning(url, provider) {
  try {
    const res = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(10_000) });
    const cfg = (await res.json()).values?.modelProviders?.find(p => p.id === provider.id);
    const base = cfg?.config?.baseURL;
    if (!cfg || (base && base.includes(OPENROUTER_HOST))) return null;
    return `provider "${provider.name}" (${cfg.type}) uses Base URL ${base || '(default)'}, not OpenRouter. Models will fail until you set Base URL ${OPENROUTER_BASE_URL} and an OpenRouter API key in Vane Settings -> Models.`;
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

// ---- citation verification -----------------------------------------------
// Lexical check, no model calls: a cited sentence counts as supported when enough of its
// content words appear in at least one cited source and every multi-digit number in it
// appears in a cited source. It catches citations to the wrong source, invented numbers
// and citation numbers with no source; it cannot judge paraphrase or meaning.

const CITE_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
const THRESHOLD = 0.3; // share of a sentence's content words found in a cited source
const STOP = new Set(('the and for are but not you all any can had her was one our out has have this that with from they will would there their what which when your into than then them these some such only also more most other about after over very just like been were being does did how its may many much made make per via within without upon each both between while where who whom whose why yet own same so too use used using well even still could should might must shall here those because before during through against among across along around however therefore thus often less least few'
).split(' '));
const ABBREV_END = /\b(?:et al|e\.g|i\.e|vs|cf|approx|Fig|No|Dr|Mr|Mrs|Ms|St)\.$/i;
const stem = (w) => (w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w);

export function tokenize(text) {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return new Set(words.filter(w => w.length >= 3 && !STOP.has(w)).map(stem));
}

// Markdown answer -> sentence-ish units (list items and table rows count as one each).
export function splitSentences(md) {
  const units = [];
  for (let line of String(md).replace(/```[\s\S]*?```/g, ' ').split('\n')) {
    line = line.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^\|?[\s:|-]+\|?$/.test(line)) continue;
    line = line.replace(/^([-*+]|\d+\.)\s+/, '').replace(/\*\*|__|`/g, '');
    if (line.startsWith('|')) { units.push(line); continue; }
    // split after . ! ? (a citation may sit before or after the stop) when a new sentence starts,
    // then re-join pieces that ended in an abbreviation ("Chen et al. (2025) ...")
    const pieces = [];
    for (const piece of line.split(/(?<=[.!?](?:\[\d+(?:\s*,\s*\d+)*\])*)\s+(?=[A-Z0-9"“(\[])/)) {
      if (pieces.length && ABBREV_END.test(pieces[pieces.length - 1])) pieces[pieces.length - 1] += ` ${piece}`;
      else pieces.push(piece);
    }
    units.push(...pieces);
  }
  return units.filter(Boolean);
}

export function verifyCitations(message, sources, { threshold = THRESHOLD } = {}) {
  const srcText = sources.map(s => `${s.title || ''} ${s.content || ''}`);
  const srcTok = srcText.map(tokenize);
  // lookahead, so "1,250,000" loses both commas (consuming the digit left "1250,000")
  const srcNum = srcText.map(t => t.replace(/(\d),(?=\d{3})/g, '$1'));
  const r = { sentences: 0, cited: 0, supported: 0, uncited: 0, supportRate: null, weak: [], numbersMissing: [], invalidCitations: [] };
  for (const sentence of splitSentences(message)) {
    const cites = [...sentence.matchAll(CITE_RE)].flatMap(m => m[1].split(',').map(Number));
    const body = sentence.replace(CITE_RE, ' ');
    const tok = tokenize(body);
    if (tok.size < 4) continue; // headings, labels, fragments
    r.sentences++;
    if (!cites.length) { r.uncited++; continue; }
    r.cited++;
    const valid = [...new Set(cites)].filter(n => n >= 1 && n <= sources.length);
    const invalid = [...new Set(cites)].filter(n => !(n >= 1 && n <= sources.length));
    if (invalid.length) r.invalidCitations.push({ sentence, cites: invalid });
    let overlap = 0;
    for (const n of valid) {
      let hit = 0;
      for (const w of tok) if (srcTok[n - 1].has(w)) hit++;
      overlap = Math.max(overlap, hit / tok.size);
    }
    const numbers = [...new Set((body.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(x => x.replace(/,(?=\d{3})/g, '').replace(/[.,]$/, '')))].filter(x => x.replace(/\D/g, '').length >= 2);
    const missing = numbers.filter(x => !valid.some(n => srcNum[n - 1].includes(x)));
    if (missing.length) r.numbersMissing.push({ sentence, numbers: missing, cites: valid });
    if (valid.length && overlap >= threshold && !missing.length) r.supported++;
    else if (overlap < threshold) r.weak.push({ sentence, cites, overlap: Math.round(overlap * 100) / 100 });
  }
  r.supportRate = r.cited ? Math.round((r.supported / r.cited) * 1000) / 1000 : null;
  return r;
}

function printVerification(v) {
  const pct = v.supportRate == null ? 'n/a' : `${Math.round(v.supportRate * 100)}%`;
  console.log(`\nVerification: ${v.supported}/${v.cited} cited sentences supported (${pct}); ${v.uncited} uncited, ${v.weak.length} weak, ${v.numbersMissing.length} with numbers not in their sources, ${v.invalidCitations.length} with citation numbers that have no source.`);
  const short = (s) => (s.length > 140 ? `${s.slice(0, 137)}...` : s);
  for (const w of v.weak.slice(0, 5)) console.log(`  weak (${Math.round(w.overlap * 100)}% overlap) ${short(w.sentence)}`);
  for (const m of v.numbersMissing.slice(0, 5)) console.log(`  number ${m.numbers.join(', ')} not in [${m.cites.join('][')}]: ${short(m.sentence)}`);
  for (const c of v.invalidCitations.slice(0, 5)) console.log(`  no source [${c.cites.join('][')}]: ${short(c.sentence)}`);
}

function printResult(result, opts) {
  if (!result.sources.length) {
    const tail = opts['require-sources'] ? ' Failing (--require-sources).' : ' Try --mode speed or another --model.';
    process.stderr.write(`vane: warning: no sources returned (model ${result.model}); answer is not grounded in search.${tail}\n`);
    if (opts['require-sources']) process.exitCode = 1;
  }
  const verification = opts.verify ? verifyCitations(result.message, result.sources) : undefined;
  if (verification && opts['min-support'] !== undefined && !((verification.supportRate ?? 0) >= opts['min-support'])) {
    process.stderr.write(`vane: support ${verification.supportRate ?? 'n/a'} is below --min-support ${opts['min-support']}.\n`);
    process.exitCode = 1;
  }
  const sources = result.sources.map(({ title, url }) => ({ title, url }));
  if (opts.json) return console.log(JSON.stringify({ model: result.model, message: result.message, sources, ...(verification ? { verification } : {}) }, null, 2));
  if (!result.streamed) console.log(result.message.trim());
  if (sources.length) {
    console.log('\nSources:');
    sources.forEach((s, i) => console.log(`[${i + 1}] ${s.title}${s.url ? ` - ${s.url}` : ''}`));
  }
  if (verification) printVerification(verification);
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

// Patch definitions are read from ../patches (their single source); available when the CLI
// runs from the repo, which `npm install -g ./cli` links to. null when not found.
export function loadPatchDefinitions() {
  const dir = join(dirname(realpathSync(fileURLToPath(import.meta.url))), '..', 'patches');
  if (!existsSync(join(dir, 'lib', 'apply-targets.js'))) return null;
  const require = createRequire(import.meta.url);
  const { appliedNeedles } = require(join(dir, 'lib', 'apply-targets.js'));
  return readdirSync(dir).filter(f => /^patch-.*\.js$/.test(f)).sort().map(f => ({
    name: f.replace(/\.js$/, ''),
    targets: require(join(dir, f)).TARGETS.map(t => ({ name: t.name, file: t.file, optional: !!t.optional, needles: appliedNeedles(t) })),
  }));
}

function dockerOut(args, timeout = 30_000, input) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout, input }).trim();
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

  const patches = loadPatchDefinitions();
  if (!patches) report('warn', 'patch definitions not found next to this CLI (install it with npm install -g ./cli from the repo); skipping patch checks');
  else {
    try {
      // Every target of every patch, checked in the container. The needles are large, so they go in on stdin.
      const targets = patches.flatMap(p => p.targets);
      const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const fs=require('fs'),c={};console.log(JSON.stringify(JSON.parse(s).map(t=>{try{c[t.file]??=fs.readFileSync(t.file,'utf8')}catch{return null}return t.needles.some(n=>c[t.file].includes(n))})))})";
      const states = JSON.parse(dockerOut(['exec', '-i', container, 'node', '-e', script], 30_000, JSON.stringify(targets.map(t => ({ file: t.file, needles: t.needles })))));
      let i = 0;
      for (const p of patches) {
        const rows = p.targets.map(t => ({ ...t, state: states[i++] }));
        const missing = rows.filter(r => r.state === false && !r.optional);
        const skipped = rows.filter(r => r.state === false && r.optional);
        if (rows.some(r => r.state === null)) report('FAIL', `${p.name}: target file missing (different Vane build?)`);
        else if (missing.length) report('FAIL', `${p.name}: ${missing.length} of ${rows.length} targets not applied (${missing.map(r => r.name).join(', ')}); run node scripts/apply.mjs`);
        else report('ok', `${p.name} applied (${rows.length - skipped.length}/${rows.length} targets${skipped.length ? `; optional skipped: ${skipped.map(r => r.name).join(', ')}` : ''})`);
      }
    } catch (err) { report('FAIL', `could not inspect patches: ${err.message.split('\n')[0]}`); }
    // patch-image-chat imports Fane's image modules from inside the container.
    const { FANE_IMAGE_DIR } = createRequire(import.meta.url)(join(dirname(realpathSync(fileURLToPath(import.meta.url))), '..', 'patches', 'lib', 'vane.js'));
    try {
      dockerOut(['exec', container, 'test', '-f', `${FANE_IMAGE_DIR}/vane-hook.mjs`]);
      report('ok', `image modules present in ${FANE_IMAGE_DIR} (web UI image requests work)`);
    } catch { report('warn', `image modules missing in ${FANE_IMAGE_DIR}; web UI image requests fall back to text (run node scripts/apply.mjs)`); }
    // patch-article-chat imports the article modules (and trial.json, the models that passed the trial) the same way.
    const { FANE_WRITE_DIR, FANE_CODE_DIR, FANE_BRAINSTORM_DIR } = createRequire(import.meta.url)(join(dirname(realpathSync(fileURLToPath(import.meta.url))), '..', 'patches', 'lib', 'vane.js'));
    try {
      dockerOut(['exec', container, 'test', '-f', `${FANE_WRITE_DIR}/vane-hook.mjs`]);
      dockerOut(['exec', container, 'test', '-f', `${FANE_WRITE_DIR}/trial.json`]);
      report('ok', `article modules present in ${FANE_WRITE_DIR} (web UI article requests work)`);
    } catch { report('warn', `article modules missing in ${FANE_WRITE_DIR}; web UI article requests fall back to a normal answer (run node scripts/apply.mjs)`); }
    // patch-code-chat: the coding modules and their trial.json (scripts/code-trial.mjs).
    try {
      dockerOut(['exec', container, 'test', '-f', `${FANE_CODE_DIR}/vane-hook.mjs`]);
      dockerOut(['exec', container, 'test', '-f', `${FANE_CODE_DIR}/trial.json`]);
      report('ok', `code modules present in ${FANE_CODE_DIR} (web UI coding requests work)`);
    } catch { report('warn', `code modules or their trial.json missing in ${FANE_CODE_DIR}; web UI coding requests say so (run node scripts/code-trial.mjs, then node scripts/apply.mjs)`); }
    // patch-brainstorm-chat: the brainstorming modules (their models come from the article trial checked above).
    try {
      dockerOut(['exec', container, 'test', '-f', `${FANE_BRAINSTORM_DIR}/vane-hook.mjs`]);
      report('ok', `brainstorm modules present in ${FANE_BRAINSTORM_DIR} (web UI brainstorm requests work)`);
    } catch { report('warn', `brainstorm modules missing in ${FANE_BRAINSTORM_DIR}; web UI brainstorm requests fall back to a normal answer (run node scripts/apply.mjs)`); }
  }

  try {
    const script = `fetch('http://localhost:8080/search?q=test&format=json').then(r=>r.json()).then(j=>console.log(JSON.stringify({n:j.results.length,down:j.unresponsive_engines})))`;
    const { n, down } = JSON.parse(dockerOut(['exec', container, 'node', '-e', script], 60_000));
    report(n > 0 ? 'ok' : 'FAIL', n > 0 ? `SearXNG returns results (${n} for "test")` : 'SearXNG returned 0 results (engines blocked? see README section 2)');
    if (down.length) report('warn', `SearXNG engines down: ${down.map(([e, why]) => `${e} (${why})`).join(', ')}`);
  } catch (err) { report('FAIL', `SearXNG check failed: ${err.message.split('\n')[0]}`); }

  // CORE is optional: SearXNG loads it only with an API key (searxng/settings.yml), and /config lists loaded engines.
  try {
    const script = `fetch('http://localhost:8080/config').then(r=>r.json()).then(c=>c.engines.some(e=>e.name==='core.ac.uk')?fetch('http://localhost:8080/search?q=symplectic+integrator&format=json&engines=core.ac.uk').then(r=>r.json()).then(j=>({on:true,n:j.results.length,down:j.unresponsive_engines})):{on:false}).then(o=>console.log(JSON.stringify(o)))`;
    const core = JSON.parse(dockerOut(['exec', container, 'node', '-e', script], 60_000));
    if (!core.on) report('ok', 'CORE academic engine off (optional: set CORE_API_KEY, then run node scripts/apply.mjs)');
    else report(core.n > 0 ? 'ok' : 'warn', core.n > 0 ? `CORE academic engine returns results (${core.n} for "symplectic integrator")` : `CORE academic engine returned 0 results${core.down.length ? `: ${core.down.map(([, why]) => why).join(', ')}` : ''} (check the key)`);
  } catch (err) { report('warn', `CORE check failed: ${err.message.split('\n')[0]}`); }

  return failures;
}

// ---- image generation ----------------------------------------------------

// OPENROUTER_API_KEY, or with --key-from-vane the key of Vane's OpenRouter provider.
// The key is passed to the OpenRouter client and nowhere else (never printed or saved).
async function resolveOpenRouterKey(opts) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (!opts['key-from-vane']) throw new UsageError('This needs an OpenRouter key: set OPENROUTER_API_KEY, or pass --key-from-vane to use the one configured in Vane.');
  const res = await fetch(`${opts.url}/api/config`, { signal: AbortSignal.timeout(10_000) });
  const key = findOpenRouterKey((await res.json()).values?.modelProviders);
  if (!key) throw new UsageError(`No Vane provider with Base URL ${OPENROUTER_BASE_URL} and an API key at ${opts.url}.`);
  return key;
}

// ---- articles ------------------------------------------------------------

const MODE_FOR_TIER = Object.fromEntries(Object.entries(TIER_FOR_MODE).map(([mode, tier]) => [tier, mode]));

function printArticleReport(r) {
  const say = (s) => process.stderr.write(`${s}\n`);
  const cost = r.cost ? ` · ≈ $${r.cost.toFixed(4)}` : '';
  const post = POSTS[r.format] ? `${POSTS[r.format].name} post, ${[...r.post].length} characters, ` : '';
  say(`\nvane: ${post}${r.words} words${r.targetWords ? ` (target ${r.targetWords})` : ''}, ${r.language === 'el' ? 'Greek' : 'English'}, ${r.mode} · ${r.sources.length} sources cited · ${r.calls} model calls${cost} · ${Math.round(r.ms / 1000)} s`);
  for (const p of r.phases || []) say(`  ${p.status.padEnd(9)}${p.phase.padEnd(10)}${p.model || ''}${p.words ? `  ${p.words} words` : ''}${p.note && p.status !== 'ok' ? `  (${p.note})` : ''}`);
  if (r.claimSupport != null) say(`  claims supported by their sources: ${Math.round(r.claimSupport * 100)}% of ${r.ledger.length} checked`);
  if (r.audit) say(`  audit: ${r.audit.score} (${r.audit.passes ? 'passed' : 'failed'}${r.audit.retried ? ', after a retry' : ''})`);
  if (r.repaired) say(`  repaired ${r.repaired} Greek spelling slip${r.repaired === 1 ? '' : 's'} (Latin look-alike letters, a dropped final ν)`);
  for (const i of r.checks.items) if (i.level !== 'ok') say(`  ${i.level === 'fail' ? 'FAIL' : 'warn'}  ${i.name}: ${i.detail}`);
  for (const d of r.degraded) say(`  degraded: ${d}`);
}

// Models that passed scripts/article-trial.mjs, from cli/write/trial.json ({} when the file is missing).
async function loadTrial() {
  const { readFile } = await import('node:fs/promises');
  try { return JSON.parse(await readFile(new URL('./write/trial.json', import.meta.url), 'utf8')); } catch { return { models: {} }; }
}

// Chains of the mode's price band, from the models that passed the trial for this language.
async function defaultChains({ mode, lang, client }) {
  const trial = await loadTrial();
  const chosen = selectChains(buildTextCatalogue(await client.models()), trial.models || {}, { mode, lang });
  if (!chosen) throw new UsageError(`No text model has passed the trial for ${lang === 'el' ? 'Greek' : 'English'}. Pass --article-model <id>[,<fallback>...], or run node scripts/article-trial.mjs.`);
  return { ...chosen, trialDate: trial.updated };
}

async function listArticleModels(opts) {
  const mode = opts.tier ? MODE_FOR_TIER[opts.tier] : opts.mode;
  const lang = opts.lang ?? (opts.query ? detectLanguage(opts.query) : 'en');
  const client = createOpenRouterClient();
  const chosen = await defaultChains({ mode, lang, client });
  const price = new Map(buildTextCatalogue(await client.models()).map(m => [m.id, m]));
  const show = (id) => `${id} ($${price.get(id)?.priceIn}/${price.get(id)?.priceOut})`;
  if (opts.json) return console.log(JSON.stringify({ mode, language: lang, trialDate: chosen.trialDate, pool: chosen.pool, band: chosen.band, chains: chosen.chains }, null, 2));
  console.log(`${mode}, ${lang === 'el' ? 'Greek' : 'English'}: ${chosen.pool} models passed the trial (${chosen.trialDate || 'undated'}); this mode's price band: ${chosen.band.join(', ')}`);
  for (const [role, chain] of Object.entries(chosen.chains)) console.log(`  ${role.padEnd(10)}${chain.map(show).join('  >  ')}`);
}

async function runArticle(opts) {
  if (!opts.query) throw new UsageError('Missing topic. Example: vane --article "tidal power in Greece"');
  const apiKey = await resolveOpenRouterKey(opts);
  const [{ createOpenRouterClient }, { createArticlePipeline }] = await Promise.all([import('./image/openrouter.mjs'), import('./write/pipeline.mjs')]);
  const providers = await getProvidersStartingVane(opts.url, DEFAULTS.container);
  const mode = opts.tier ? MODE_FOR_TIER[opts.tier] : opts.mode;
  // Sources are Vane's own research; its answer text is not used. Vane sometimes returns none for a query that worked a minute ago.
  const retrieve = async (query) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { sources } = await search({ ...opts, query, stream: false, mode }, providers);
      if (sources.length) return sources;
    }
    return [];
  };
  const client = createOpenRouterClient({ apiKey });
  const write = createArticlePipeline({ client, retrieve, log: (m) => { if (!opts.json) process.stderr.write(`vane: ${m}\n`); } });
  const post = opts.post; // a platform of formats.mjs, or undefined for an article
  const topic = post ? postTopic(opts.query) : articleTopic(opts.query);
  // the whole request, not the topic: "γράψε ένα άρθρο για το iPhone 17" is Greek although its topic is mostly Latin letters
  const lang = opts.lang ?? detectLanguage(opts.query);
  const explicit = opts['article-model'].length > 0;
  const chosen = explicit ? null : await defaultChains({ mode, lang, client });
  const r = await write({
    topic,
    mode,
    lang,
    format: post || 'article',
    words: opts.words ?? parseArticleOptions(opts.query, { post: !!post }).words,
    models: opts['article-model'],
    chains: chosen?.chains,
    prices: chosen?.prices,
    onProgress: (e) => { if (!opts.json && e.status !== 'running') process.stderr.write(`vane: ${e.phase} ${e.status}${e.model ? ` (${e.model}, ${(e.ms / 1000).toFixed(0)} s)` : ''}${e.phase === 'sources' && e.note ? `: ${e.note}` : ''}\n`); },
  });
  await writeArticleResult(r, opts);
}

async function writeArticleResult(r, opts) {
  if (!r.ok) throw new Error(r.error);
  if (opts.out) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(opts.out, r.article);
    if (!opts.json) process.stderr.write(`vane: saved ${opts.out}\n`);
  }
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else {
    if (!opts.out) console.log(r.article);
    printArticleReport(r);
  }
}

// vane --edit-article article.md "make it shorter": the follow-up edit of Vane's chat, on a file from --article.
async function runArticleEdit(opts) {
  const file = opts['edit-article'];
  if (!opts.query) throw new UsageError(`Missing the change. Example: vane --edit-article ${file || 'article.md'} "make it shorter"`);
  const { readFile } = await import('node:fs/promises');
  const [{ createArticleEditor, parseArticleAnswer, targetLanguage }, { chainsFor }] = await Promise.all([import('./write/edit.mjs'), import('./write/models.mjs')]);
  let text;
  try { text = await readFile(file, 'utf8'); } catch (err) { throw new UsageError(`Cannot read ${file}: ${err.message}`); }
  const earlier = parseArticleAnswer(text);
  if (!earlier?.sources.length) throw new UsageError(`${file} does not look like an article from vane --article (a "# " title, at least 80 words, a Sources list).`);
  const apiKey = await resolveOpenRouterKey(opts);
  const client = createOpenRouterClient({ apiKey });
  const mode = opts.tier ? MODE_FOR_TIER[opts.tier] : opts.mode;
  const lang = opts.lang ?? targetLanguage(opts.query, earlier.lang);
  const explicit = opts['article-model'].length > 0;
  const chosen = explicit ? { chains: chainsFor(opts['article-model']) } : await defaultChains({ mode, lang, client });
  // Vane is started only when the change needs a search.
  const retrieve = async (query) => {
    const providers = await getProvidersStartingVane(opts.url, DEFAULTS.container);
    for (let attempt = 0; attempt < 2; attempt++) {
      const { sources } = await search({ ...opts, query, stream: false, mode }, providers);
      if (sources.length) return sources;
    }
    return [];
  };
  const log = (m) => { if (!opts.json) process.stderr.write(`vane: ${m}\n`); };
  const edit = createArticleEditor({ client, log });
  const r = await edit({ body: earlier.body, sources: earlier.sources, instruction: opts.query, lang, mode, chains: chosen.chains, prices: chosen.prices, retrieve, onProgress: (e) => { if (e.status !== 'running') log(`${e.phase} ${e.status}${e.note ? `: ${e.note}` : ''}`); } });
  await writeArticleResult(r, opts);
}

// ---- code ----------------------------------------------------------------

// Models that passed scripts/code-trial.mjs, in the mode's price band.
async function defaultCodeChains({ mode, client }) {
  const { readFile } = await import('node:fs/promises');
  const { buildCodeCatalogue, selectCodeChains } = await import('./code/catalogue.mjs');
  let trial = {};
  try { trial = JSON.parse(await readFile(new URL('./code/trial.json', import.meta.url), 'utf8')); } catch { /* none yet */ }
  const chosen = selectCodeChains(buildCodeCatalogue(await client.models()), trial.models || {}, { mode });
  if (!chosen) throw new UsageError('No model has passed the coding trial. Pass --code-model <id>[,<fallback>...], or run node scripts/code-trial.mjs.');
  return { ...chosen, trialDate: trial.updated };
}

async function listCodeModels(opts) {
  const mode = opts.tier ? MODE_FOR_TIER[opts.tier] : opts.mode;
  const client = createOpenRouterClient();
  const chosen = await defaultCodeChains({ mode, client });
  const show = (id) => `${id} ($${chosen.prices[id]?.in}/${chosen.prices[id]?.out})`;
  if (opts.json) return console.log(JSON.stringify({ mode, trialDate: chosen.trialDate, pool: chosen.pool, band: chosen.band, chains: chosen.chains }, null, 2));
  console.log(`${mode}: ${chosen.pool} models passed the coding trial (${chosen.trialDate || 'undated'}); this mode's price band: ${chosen.band.join(', ')}`);
  for (const [role, chain] of Object.entries(chosen.chains)) console.log(`  ${role.padEnd(10)}${chain.map(show).join('  >  ')}`);
}

// The files go to a new or empty folder only, so nothing of the user's is ever overwritten.
async function codeDir(opts) {
  const { readdir } = await import('node:fs/promises');
  const empty = async (d) => { try { return (await readdir(d)).length === 0; } catch (err) { if (err.code === 'ENOENT') return true; throw err; } };
  if (opts['out-dir'] !== undefined) {
    if (!(await empty(opts['out-dir']))) throw new UsageError(`--out-dir ${opts['out-dir']} is not empty: pick a new folder.`);
    return opts['out-dir'];
  }
  const slug = opts.query.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'code';
  for (let n = 1; ; n++) {
    const d = join('vane-code', n === 1 ? slug : `${slug}-${n}`);
    if (await empty(d)) return d;
  }
}

async function writeCodeFiles(dir, r) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { resolve, sep } = await import('node:path');
  const root = resolve(dir);
  const all = [...r.files, ...r.tests];
  if (!all.some(f => /^readme\.md$/i.test(f.path))) all.push({ path: 'README.md', content: r.readme });
  for (const f of all) {
    const target = resolve(root, f.path);
    if (!target.startsWith(root + sep)) throw new Error(`refused to write outside ${dir}: ${f.path}`); // safePath already refuses these
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.content, { flag: 'wx' });
  }
  return all.map(f => f.path);
}

function printCodeReport(r, dir) {
  const say = (s) => process.stderr.write(`${s}\n`);
  const cost = r.cost ? ` · ≈ $${r.cost.toFixed(4)}` : '';
  say(`\nvane: ${r.files.length} files, ${r.tests.length} test files in ${dir} (${r.spec.language}${r.spec.framework ? `, ${r.spec.framework}` : ''}), ${r.mode} · ${r.calls} model calls${cost} · ${Math.round(r.ms / 1000)} s`);
  for (const p of r.phases) say(`  ${p.status.padEnd(9)}${p.phase.padEnd(9)}${p.file ? `${p.file}  ` : ''}${p.model || ''}${p.note && p.status !== 'ok' ? `  (${p.note})` : ''}`);
  for (const f of [...r.files, ...r.tests]) say(`  ${(f.syntax?.status || 'unchecked').padEnd(9)}syntax   ${f.path}${f.syntax?.detail ? `  (${f.syntax.detail})` : ''}`);
  if (r.review) say(`  review: ${r.review.verdict}, ${r.fixes.reduce((n, f) => n + f.issues.length, 0)} issues fixed, ${r.open.length} open${r.review.posture ? ` · ${r.review.posture}` : ''}`);
  for (const i of r.open) say(`  open    ${i.file || i.named || '?'} (${i.severity}): ${i.issue}`);
  for (const c of r.checks) if (c.level === 'warn') say(`  warn    ${c.name}: ${c.detail}`);
  for (const d of r.degraded) say(`  degraded: ${d}`);
}

async function runCode(opts) {
  if (!opts.query) throw new UsageError('Missing request. Example: vane --code "a Python script that renames photos by the date they were taken"');
  const dir = await codeDir(opts); // before any paid call
  const apiKey = await resolveOpenRouterKey(opts);
  const [{ createCodePipeline }, { createSyntaxChecker }, { codeChainsFor }] = await Promise.all([import('./code/pipeline.mjs'), import('./code/syntax.mjs'), import('./code/models.mjs')]);
  const mode = opts.tier ? MODE_FOR_TIER[opts.tier] : opts.mode;
  const client = createOpenRouterClient({ apiKey });
  const chosen = opts['code-model'].length ? { chains: codeChainsFor(opts['code-model']) } : await defaultCodeChains({ mode, client });
  // Documentation is Vane's own research (Balanced, Quality); Vane is started only then.
  let providers;
  const retrieve = async (query) => {
    providers ??= await getProvidersStartingVane(opts.url, DEFAULTS.container);
    for (let attempt = 0; attempt < 2; attempt++) {
      const { sources } = await search({ ...opts, query, stream: false, mode }, providers);
      if (sources.length) return sources;
    }
    return [];
  };
  const log = (m) => { if (!opts.json) process.stderr.write(`vane: ${m}\n`); };
  const write = createCodePipeline({ client, retrieve, checkSyntax: createSyntaxChecker(), log });
  const r = await write({
    request: opts.query,
    mode,
    lang: opts.lang,
    chains: chosen.chains,
    prices: chosen.prices,
    onProgress: (e) => { if (!opts.json && e.status !== 'running' && e.status !== 'preview' && e.phase !== 'done') log(`${e.phase} ${e.status}${e.file ? ` ${e.file}` : ''}${e.model ? ` (${e.model}, ${(e.ms / 1000).toFixed(0)} s)` : ''}${e.note && e.status === 'done' ? `: ${e.note}` : ''}`); },
  });
  if (!r.ok) throw new Error(r.error);
  const written = await writeCodeFiles(dir, r);
  if (opts.json) return console.log(JSON.stringify({ ...r, dir, written }, null, 2));
  console.log(written.map(p => join(dir, p)).join('\n'));
  printCodeReport(r, dir);
  if (r.checks.some(c => c.level === 'fail')) process.exitCode = 1;
}

// ---- brainstorm ----------------------------------------------------------

async function runBrainstorm(opts) {
  if (!opts.query) throw new UsageError('Missing problem. Example: vane --brainstorm "ways a small bookshop can win back readers"');
  const apiKey = await resolveOpenRouterKey(opts);
  const { createBrainstormPipeline, chainsFor, selectBrainstormChains } = await import('./brainstorm/pipeline.mjs');
  const { renderBrainstorm } = await import('./brainstorm/present.mjs');
  const mode = opts.tier ? MODE_FOR_TIER[opts.tier] : opts.mode;
  const lang = opts.lang ?? detectLanguage(opts.query);
  const client = createOpenRouterClient({ apiKey });
  let chosen = { chains: chainsFor(opts['brainstorm-model']) };
  if (!opts['brainstorm-model'].length) {
    chosen = selectBrainstormChains(buildTextCatalogue(await client.models()), (await loadTrial()).models || {}, { mode, lang });
    if (!chosen) throw new UsageError('No text model has passed the article trial. Pass --brainstorm-model <id>[,<fallback>...], or run node scripts/article-trial.mjs.');
  }
  // Existing work is Vane's own research (Balanced, Quality); Vane is started only then.
  let providers;
  const retrieve = async (query) => {
    providers ??= await getProvidersStartingVane(opts.url, DEFAULTS.container);
    for (let attempt = 0; attempt < 2; attempt++) {
      const { sources } = await search({ ...opts, query, stream: false, mode }, providers);
      if (sources.length) return sources;
    }
    return [];
  };
  const log = (m) => { if (!opts.json) process.stderr.write(`vane: ${m}\n`); };
  const run = createBrainstormPipeline({ client, retrieve, log });
  const r = await run({
    request: opts.query, mode, lang, chains: chosen.chains, prices: chosen.prices,
    onProgress: (e) => { if (!opts.json && e.status !== 'running' && e.status !== 'preview' && e.phase !== 'done') log(`${e.phase}${e.note ? ` ${e.note}` : ''} ${e.status}${e.model ? ` (${e.model}, ${(e.ms / 1000).toFixed(0)} s)` : ''}`); },
  });
  if (!r.ok) throw new Error(r.error);
  const markdown = renderBrainstorm(r);
  if (opts.out) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(opts.out, `${markdown}\n`);
    log(`saved ${opts.out}`);
  }
  if (opts.json) return console.log(JSON.stringify(r, null, 2));
  if (!opts.out) console.log(markdown);
  const cost = r.cost ? ` · ≈ $${r.cost.toFixed(4)}` : '';
  log(`${r.ideas.length} ideas in ${r.themes.length} themes, ${r.picked.length} picked, ${r.mode} · ${r.calls} model calls${cost} · ${Math.round(r.ms / 1000)} s`);
  for (const d of r.degraded) log(`degraded: ${d}`);
}

async function readReference(file) {
  const { readFile } = await import('node:fs/promises');
  const { sniffMime } = await import('./image/extract.mjs');
  const bytes = await readFile(file);
  const mime = sniffMime(bytes);
  if (!mime || mime === 'image/svg+xml') throw new UsageError(`--ref ${file} is not a PNG, JPEG, WebP or GIF image`);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

async function runImage(opts) {
  if (!opts.query) throw new UsageError('Missing image prompt. Example: vane --image "a red fox in fresh snow, morning light"');
  const references = await Promise.all(opts.ref.map(readReference));
  const apiKey = await resolveOpenRouterKey(opts);
  const [{ createOpenRouterClient }, { createImageGenerator }, { safeDownload }, { saveImages }] = await Promise.all([
    import('./image/openrouter.mjs'), import('./image/generate.mjs'), import('./image/download.mjs'), import('./image/save.mjs'),
  ]);
  const generate = createImageGenerator({
    client: createOpenRouterClient({ apiKey }),
    download: (url) => safeDownload(url),
    textModel: IMAGE_TEXT_MODEL,
    log: (m) => { if (!opts.json) process.stderr.write(`vane: ${m}\n`); },
  });
  // Flags win; a count or shape written in the prompt ("2 images", "widescreen") fills what is unset.
  const words = parseImageOptions(opts.query);
  const aspect = opts.aspect ?? words.aspect ?? '1:1';
  const r = await generate({ prompt: opts.query, count: opts.count ?? words.count, tier: opts.tier, family: opts.family, aspect, size: opts.size, references, enhance: !opts['no-enhance'], models: opts['image-model'], via: opts.via });
  const saved = r.images.length ? await saveImages(r.images, opts['out-dir'] ?? 'vane-images', imageSubject(opts.query)) : [];
  if (opts.json) {
    console.log(JSON.stringify({ prompt: opts.query, intent: r.intent, models: r.models, enhancedPrompt: r.enhancedPrompt, rewrittenPrompt: r.rewrittenPrompt, requested: r.requested, images: saved, errors: r.errors }, null, 2));
  } else {
    if (r.intent) console.log(`Intent: ${r.intent.family} / ${r.intent.tier} (${r.intent.source}); models: ${r.models.join(', ') || 'none'}`);
    if (r.enhancedPrompt) console.log(`Enhanced prompt: ${r.enhancedPrompt}`);
    if (r.rewrittenPrompt) console.log(`Rewritten prompt: ${r.rewrittenPrompt}`);
    for (const s of saved) {
      const how = `${s.via} model${s.endpoint !== s.via ? `, via the ${s.endpoint === 'images' ? 'Image API' : 'chat endpoint'}` : ''}${s.aspect !== aspect ? `, ${s.aspect} (nearest supported)` : ''}`;
      console.log(`Saved ${s.path} (${s.model}, ${how}, ${Math.round(s.bytes / 1024)} KB, ~$${(s.pricePerImage ?? 0).toFixed(3)})`);
      if (s.text) console.log(`  ${s.model.split('/')[0]} said: ${s.text.length > 300 ? `${s.text.slice(0, 297)}...` : s.text}`);
    }
    if (!r.complete) console.error(`vane: made ${saved.length} of ${r.requested} images.${r.errors.length ? `\n  ${r.errors.slice(0, 6).join('\n  ')}` : ''}`);
  }
  if (!saved.length) process.exitCode = 1;
}

async function listImageModels(filter, asJson) {
  const [{ createOpenRouterClient }, { buildCatalogue, viaOf }] = await Promise.all([import('./image/openrouter.mjs'), import('./image/catalogue.mjs')]);
  const f = String(filter || '').toLowerCase();
  const rows = buildCatalogue(await createOpenRouterClient().imageModels())
    .filter(m => !f || m.id.toLowerCase().includes(f) || viaOf(m) === f)
    .sort((a, b) => a.price - b.price)
    .map(m => ({ id: m.id, via: viaOf(m), usdPerImage: Math.round(m.price * 10000) / 10000, families: [...m.families], acceptsImageInput: m.acceptsImageInput, requiresReference: m.requiresReference }));
  if (asJson) return console.log(JSON.stringify(rows, null, 2));
  for (const r of rows) console.log(`${r.id.padEnd(44)} ${r.via.padEnd(7)} $${r.usdPerImage.toFixed(4)}  ${r.families.filter(x => x !== 'general').join(',')}${r.requiresReference ? '  (needs --ref)' : ''}`);
  if (!rows.length) console.log('No matching image models.');
}

// ---- main ----------------------------------------------------------------

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) return console.log(USAGE);
  if (opts.doctor) { if (await doctor(opts)) process.exitCode = 1; return; }
  if (opts.image) return runImage(opts);
  if (opts.code) return runCode(opts);
  if (opts.brainstorm) return runBrainstorm(opts);
  if (opts['list-code-models']) return listCodeModels(opts);
  if (opts['edit-article'] !== undefined) return runArticleEdit(opts);
  if (opts.article) return runArticle(opts);
  if (opts['list-article-models']) return listArticleModels(opts);
  if (opts['list-image-models']) return listImageModels(opts.query, opts.json);
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
  const routed = autoRoute(opts, process.argv.slice(2));
  if (routed?.image) {
    process.stderr.write('vane: this asks for an image, so it goes to image generation (same as --image; --no-auto-image to search instead).\n');
    return runImage(routed);
  }
  if (routed?.brainstorm) {
    process.stderr.write('vane: this asks for ideas, so it goes to brainstorming (same as --brainstorm; --no-auto-brainstorm to search instead).\n');
    return runBrainstorm(routed);
  }
  if (routed?.code) {
    process.stderr.write('vane: this asks for code, so it goes to code writing (same as --code; --no-auto-code to search instead).\n');
    return runCode(routed);
  }
  if (routed) {
    process.stderr.write(routed.post
      ? `vane: this asks for a ${POSTS[routed.post].name} post, so it goes to post writing (same as --post ${routed.post}; --no-auto-article to search instead).\n`
      : 'vane: this asks for an article, so it goes to article writing (same as --article; --no-auto-article to search instead).\n');
    return runArticle(routed);
  }
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

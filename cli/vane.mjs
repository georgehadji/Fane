#!/usr/bin/env node
// Headless CLI for a local Vane instance (https://github.com/ItzCrazyKns/Vane).
// Sends a question to Vane's /api/search and prints the cited answer + sources.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILIES, TIERS, VIAS } from './image/catalogue.mjs';
import { isImageRequest } from './image/intent.mjs';
import { ASPECT_RATIOS, DEFAULT_IMAGES, IMAGE_SIZES, IMAGE_TEXT_MODEL, MAX_IMAGES } from './image/generate.mjs';
import { isArticleRequest, postPlatform } from './core/intent-article.mjs';
import { POSTS, POST_PLATFORMS } from './core/formats.mjs';
import { LANGUAGES } from './core/language.mjs';
import { DEFAULT_WORDS, MAX_WORDS, MIN_WORDS } from './write/models.mjs';
import { isCodeRequest } from './core/intent-code.mjs';
import { isBrainstormRequest } from './core/intent-brainstorm.mjs';
import { DEFAULTS, UsageError, VALID_MODES, VALID_SOURCES, addOpenRouterModel, findOpenRouterProvider, getProviders, getProvidersStartingVane, listOpenRouter, openRouterBaseUrlWarning, resolveModel, search, vaneModelRequest } from './client.mjs';
import { MODE_FOR_TIER, listArticleModels, listCodeModels, listImageModels, runArticle, runArticleEdit, runBrainstorm, runCode, runImage } from './runners.mjs';
export { DEFAULTS, findOpenRouterProvider, resolveModel } from './client.mjs';

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
  values.timeout ??= (MODE_FOR_TIER[values.tier] ?? values.mode) === 'quality' ? '600' : '180'; // --tier premium researches in quality mode
  const timeoutSec = Number(values.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new UsageError(`Invalid timeout "${values.timeout}"`);
  if (values.stream && values.json) throw new UsageError('--stream cannot be combined with --json');
  // model lists: repeated flags or commas
  for (const key of ['image-model', 'article-model', 'code-model', 'brainstorm-model']) values[key] = values[key].flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean);
  if (values.post !== undefined) {
    values.post = values.post.toLowerCase();
    if (!POST_PLATFORMS.includes(values.post)) throw new UsageError(`Invalid --post "${values.post}". Use: ${POST_PLATFORMS.join(', ')}`);
    values.article = true; // a post is the article pipeline with another format
  }
  const article = values.article || values['list-article-models'] || values['edit-article'] !== undefined;
  const feature = values.image ? 'image' : article ? 'article' : values.code || values['list-code-models'] ? 'code' : values.brainstorm ? 'brainstorm' : null;
  if (feature) {
    if (values.tier && !TIERS.includes(values.tier)) throw new UsageError(`Invalid --tier "${values.tier}". Use: ${TIERS.join(', ')}`);
    if (values.stream) throw new UsageError(`--stream does not apply to --${feature}`);
  }
  if ((article || values.brainstorm) && values.lang && !LANGUAGES.includes(values.lang)) throw new UsageError(`Invalid --lang "${values.lang}". Use: ${LANGUAGES.join(', ')}`);
  if (values.image) {
    if (values.count !== undefined) {
      const n = Number(values.count);
      if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) throw new UsageError(`Invalid --count "${values.count}" (1-${MAX_IMAGES})`);
      values.count = n;
    }
    if (values.via && !VIAS.includes(values.via)) throw new UsageError(`Invalid --via "${values.via}". Use: ${VIAS.join(', ')}`);
    if (values.via && values['image-model'].length) throw new UsageError('--via and --image-model cannot be combined');
    if (values.family && !FAMILIES.includes(values.family)) throw new UsageError(`Invalid --family "${values.family}". Use: ${FAMILIES.join(', ')}`);
    if (values.aspect !== undefined && !ASPECT_RATIOS.includes(values.aspect)) throw new UsageError(`Invalid --aspect "${values.aspect}". Use: ${ASPECT_RATIOS.join(', ')}`);
    if (values.size && !IMAGE_SIZES.includes(values.size.toUpperCase())) throw new UsageError(`Invalid --size "${values.size}". Use: ${IMAGE_SIZES.join(', ')}`);
    if (values.size) values.size = values.size.toUpperCase();
  }
  if (article && values.words !== undefined) {
    const n = Number(values.words);
    const [min, max] = values.post ? [POSTS[values.post].minWords, POSTS[values.post].maxWords] : [MIN_WORDS, MAX_WORDS];
    if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`Invalid --words "${values.words}" (${min}-${max})`);
    values.words = n;
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
  // --stream is a streamed search: routed, it would be refused ("--stream does not apply to --article")
  if (opts['list-models'] || opts.stream) return null;
  if (!opts['no-auto-image'] && isImageRequest(opts.query)) return parseCli(['--image', ...argv]);
  if (!opts['no-auto-brainstorm'] && isBrainstormRequest(opts.query)) return parseCli(['--brainstorm', ...argv]);
  if (!opts['no-auto-code'] && isCodeRequest(opts.query)) return parseCli(['--code', ...argv]);
  // a post before an article: «ανάρτηση» matches both
  const platform = opts['no-auto-article'] ? null : postPlatform(opts.query);
  if (platform) return parseCli(['--post', platform, ...argv]);
  if (!opts['no-auto-article'] && isArticleRequest(opts.query)) return parseCli(['--article', ...argv]);
  return null;
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
    // then re-join pieces that ended in an abbreviation ("Chen et al. (2025) ...");
    // the Greek question mark is a `;`, so it ends a sentence only before a Greek capital
    const pieces = [];
    for (const piece of line.split(/(?<=[.!?](?:\[\d+(?:\s*,\s*\d+)*\])*)\s+(?=[\p{Lu}0-9"“«(\[])|(?<=[;;](?:\[\d+(?:\s*,\s*\d+)*\])*)\s+(?=\p{Script=Greek})(?=\p{Lu})/u)) {
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
    // The modules each hook imports (every hook imports ../core too), and the trial.json of the models that passed.
    const { FANE_CORE_DIR, FANE_IMAGE_DIR, FANE_WRITE_DIR, FANE_CODE_DIR, FANE_BRAINSTORM_DIR } = createRequire(import.meta.url)(join(dirname(realpathSync(fileURLToPath(import.meta.url))), '..', 'patches', 'lib', 'vane.js'));
    const MODULES = [
      [FANE_CORE_DIR, ['language.mjs'], 'shared modules', '', 'every web UI feature (articles, code, brainstorming, images) falls back to a normal answer (run node scripts/apply.mjs)'],
      [FANE_IMAGE_DIR, ['vane-hook.mjs'], 'image modules', 'web UI image requests work', 'web UI image requests fall back to text (run node scripts/apply.mjs)'],
      [FANE_WRITE_DIR, ['vane-hook.mjs', 'trial.json'], 'article modules', 'web UI article requests work', 'web UI article requests fall back to a normal answer (run node scripts/apply.mjs)'],
      [FANE_WRITE_DIR, ['quality-check.mjs'], 'Quality answer check', 'Quality answers are checked against their sources', 'Quality answers are shown unchecked (run node scripts/apply.mjs)'],
      [FANE_CODE_DIR, ['vane-hook.mjs', 'trial.json'], 'code modules', 'web UI coding requests work', 'web UI coding requests say so (run node scripts/code-trial.mjs, then node scripts/apply.mjs)'],
      // the brainstorm models come from the article trial checked above
      [FANE_BRAINSTORM_DIR, ['vane-hook.mjs'], 'brainstorm modules', 'web UI brainstorm requests work', 'web UI brainstorm requests fall back to a normal answer (run node scripts/apply.mjs)'],
    ];
    for (const [dir, files, what, works, otherwise] of MODULES) {
      try {
        for (const f of files) dockerOut(['exec', container, 'test', '-f', `${dir}/${f}`]);
        report('ok', `${what} present in ${dir}${works ? ` (${works})` : ''}`);
      } catch { report('warn', `${what}${files.length > 1 ? ` or their ${files[1]}` : ''} missing in ${dir}; ${otherwise}`); }
    }
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

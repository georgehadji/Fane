// What each command does once the command line is parsed: image generation, articles and posts, code and brainstorming.
// They run Fane's pipelines (cli/image, cli/write, cli/code, cli/brainstorm); Vane itself is needed only for their research.
import { dirname, join } from 'node:path';
import { TIER_FOR_MODE } from './image/catalogue.mjs';
import { imageSubject } from './image/intent.mjs';
import { IMAGE_TEXT_MODEL } from './image/generate.mjs';
import { parseImageOptions } from './image/intent.mjs';
import { articleTopic, parseArticleOptions, postTopic } from './core/intent-article.mjs';
import { POSTS } from './core/formats.mjs';
import { buildTextCatalogue, selectChains } from './write/catalogue.mjs';
import { detectLanguage } from './core/language.mjs';
import { OPENROUTER_BASE_URL, createOpenRouterClient, findOpenRouterKey } from './image/openrouter.mjs';
import { DEFAULTS, UsageError, getProviders, getProvidersStartingVane, search } from './client.mjs';

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

export async function listArticleModels(opts) {
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

export async function runArticle(opts) {
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
export async function runArticleEdit(opts) {
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

export async function listCodeModels(opts) {
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

export async function runCode(opts) {
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

export async function runBrainstorm(opts) {
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

export async function runImage(opts) {
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

export async function listImageModels(filter, asJson) {
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


// Image generation pipeline, after reasoner's generate_images():
//   catalogue -> intent -> model selection -> prompt enhancement -> one chain per image
//   (primary, then its own fallbacks), all chains in parallel -> retry chain for the images
//   still missing (model rewrite, then local rewrite).
// Dependencies (OpenRouter client, URL downloader) are injected, so the pipeline is
// tested with fakes. Failures are returned as values; only programming errors throw.
import { ASPECT_RATIOS, ASPECT_WORDS, DEFAULT_TIER, buildCatalogue, emitsSvg, selectModels, viaOf } from './catalogue.mjs';
import { classifyIntent } from './intent.mjs';
import { REWRITE_SYSTEM, hasRiskTerms, heuristicRewrite, shouldRetry } from './policy.mjs';
import { collectImageCandidates, sniffMime } from './extract.mjs';
import { DEFAULT_TEXT_MODEL, FATAL_STATUS } from './openrouter.mjs';

// Closest ratio from a provider's accepted list ("auto" ignored), compared on a log scale.
export function nearestRatio(want, accepted) {
  const val = (r) => { const [w, h] = String(r).split(':').map(Number); return w > 0 && h > 0 ? w / h : null; };
  const target = val(want);
  const options = accepted.filter(r => val(r));
  if (!target || !options.length) return null;
  return options.reduce((best, r) => (Math.abs(Math.log(val(r) / target)) < Math.abs(Math.log(val(best) / target)) ? r : best));
}

export { ASPECT_RATIOS };
export const IMAGE_SIZES = ['1K', '2K', '4K'];
export const MAX_IMAGES = 8; // every image is a paid call, fanned out in parallel
export const DEFAULT_IMAGES = 4; // one per model, from different labs where possible
// Cheap text model for prompt enhancement and intent classification (CLI and Vane hook).
export const IMAGE_TEXT_MODEL = process.env.VANE_IMAGE_TEXT_MODEL || DEFAULT_TEXT_MODEL;

const ENHANCE_SYSTEM = 'You are an image-prompt engineer. Expand the description into one detailed prompt for an image model: subject, setting, composition, lighting, colour palette, medium or style, and mood. Keep every element the user asked for; add no text, logos or artist names they did not ask for. Reply with the prompt only, under 120 words.';
const unquote = (s) => String(s || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();

const toResultImage = (i) => ({ dataUrl: i.dataUrl, model: i.model.id, name: i.model.name, via: viaOf(i.model), endpoint: i.endpoint, aspect: i.aspect, pricePerImage: i.model.price, text: i.text });

export function createImageGenerator({ client, download, textModel = null, log = () => {}, now = Date.now }) {
  const complete = textModel ? (system, user) => client.complete(textModel, system, user) : null;

  // Pure generators use OpenRouter's Image API; chat models that also write text (Gemini,
  // GPT) draw through chat completions (viaOf decides, from catalogue data), with a switch
  // to the Image API if chat completions says the model needs it. -> { dataUrl, text }
  async function viaImagesApi(model, prompt, { aspect, size, references, format }, retried = false) {
    let res;
    try {
      res = await client.images({
        model: model.id,
        prompt,
        n: 1,
        aspect_ratio: aspect,
        ...(size ? { resolution: size } : {}),
        // jpeg keeps embedded images small (the Vane hook puts them inside the answer)
        ...(emitsSvg(model) ? { output_format: 'svg' } : format === 'jpeg' ? { output_format: 'jpeg', output_compression: 85 } : {}),
        ...(references.length ? { input_references: references.map(url => ({ type: 'image_url', image_url: { url } })) } : {}),
      });
    } catch (err) {
      // e.g. OpenAI: "aspect_ratio: not supported. Accepted: 1:1, 3:2, 2:3, auto" -> retry with the nearest
      const accepted = !retried && err.message.match(/aspect_ratio[^.]*\. Accepted: ([\d:, a-z]+)/i)?.[1];
      const near = accepted && nearestRatio(aspect, accepted.split(',').map(s => s.trim()));
      if (near && near !== aspect) {
        log(`${model.id} does not support ${aspect}; using ${near}`);
        return viaImagesApi(model, prompt, { aspect: near, size, references, format }, true);
      }
      throw err;
    }
    const item = res?.data?.[0];
    if (item?.b64_json) {
      const bytes = Buffer.from(item.b64_json, 'base64');
      const mime = sniffMime(bytes) || item.media_type;
      if (mime?.startsWith('image/')) return { dataUrl: `data:${mime};base64,${item.b64_json}`, text: null, endpoint: 'images', aspect };
    }
    if (item?.url) return { dataUrl: await download(item.url), text: null, endpoint: 'images', aspect };
    throw new Error('no image in response');
  }

  // Endpoint order per model. Pure generators: Image API only. Chat models: chat completions
  // for square images (their native path), the Image API first for any other ratio because
  // chat completions drops it silently for some providers (GPT returned 1024x1024 for 16:9).
  // Any non-fatal failure moves on to the next endpoint.
  async function generateOne(model, prompt, opts) {
    const order = viaOf(model) === 'images' ? [viaImagesApi] : opts.aspect === '1:1' ? [viaChat, viaImagesApi] : [viaImagesApi, viaChat];
    const failures = [];
    for (const call of order) {
      try { return await call(model, prompt, opts); } catch (err) {
        if (FATAL_STATUS.has(err.status)) throw err;
        failures.push(err);
      }
    }
    if (failures.length === 1) throw failures[0];
    const names = order.map(f => (f === viaChat ? 'chat' : 'images'));
    throw Object.assign(new Error(failures.map((e, i) => `${names[i]}: ${e.message}`).join('; ')), { status: failures.at(-1).status });
  }

  async function viaChat(model, prompt, { aspect, size, references }) {
    // image_config is provider-specific: Gemini honours aspect_ratio, GPT image models ignore
    // it (live check: 16:9 came back 1024x1024), so a non-square ratio is also stated in words.
    const asked = aspect === '1:1' ? prompt : `${prompt}\n\nAspect ratio ${aspect} (${ASPECT_WORDS[aspect]}).`;
    const res = await client.chat({
      model: model.id,
      modalities: model.modalities,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: asked }, ...references.map(url => ({ type: 'image_url', image_url: { url } }))],
      }],
      image_config: { aspect_ratio: aspect, ...(size ? { image_size: size } : {}) },
    });
    const message = res?.choices?.[0]?.message;
    // Chat models may answer with words beside (or instead of) the picture; keep them.
    const c = message?.content;
    const text = (Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text).join(' ') : typeof c === 'string' ? c : '').trim() || null;
    const { inline, remote } = collectImageCandidates(message?.images ?? message ?? res);
    if (inline.length) return { dataUrl: inline[0], text, endpoint: 'chat', aspect };
    for (const url of remote) {
      try { return { dataUrl: await download(url), text, endpoint: 'chat', aspect }; } catch (err) { log(`${model.id}: ${err.message}`); }
    }
    throw new Error(`no image in response${text ? ` (model replied: ${text.slice(0, 120)})` : ''}`);
  }

  // An edit from a model that ignored the reference is a new picture, not an edit (a live run: the primaries
  // timed out, FLUX.2 Pro and Grok Imagine drew a new oak tree for "make it a pencil sketch", and the catalogue
  // lists both as taking image input). The text model sees the original beside each edited image; "no" rejects
  // it and the chain moves on. Without a text model, or when the check itself fails, the image is kept.
  async function keepsReference(reference, dataUrl, prompt) {
    if (!textModel || !/^data:image\/(?:png|jpeg|webp|gif)/.test(dataUrl)) return true;
    try {
      const res = await client.chat({
        model: textModel,
        max_tokens: 10,
        temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'text', text: `The first image is an original; the second should be an edit of it, as asked: "${prompt}". Answer with one word: yes if the second keeps the original's main subject and composition (its style, colours or details may change as asked), no if it shows a different scene or subject.` },
          { type: 'image_url', image_url: { url: reference } },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] }],
      }, 30_000);
      const c = res?.choices?.[0]?.message?.content;
      return !/^\W*no\b/i.test(Array.isArray(c) ? c.map(p => p?.text || '').join('') : String(c ?? ''));
    } catch (err) { log(`edit check failed, keeping the image: ${err.message}`); return true; }
  }

  // Runs the chains whose slot in `images` is still empty, all in parallel; each chain tries
  // its models in order until one draws. A key/credit error stops every chain.
  async function attempt(prompt, chains, images, opts, onImage) {
    const errors = [];
    let fatal = null;
    await Promise.all(chains.map(async (chain, slot) => {
      for (const m of images[slot] ? [] : chain) {
        if (fatal) return;
        try {
          const drawn = await generateOne(m, prompt, opts);
          if (opts.references.length && !(await keepsReference(opts.references[0], drawn.dataUrl, prompt))) throw new Error('ignored the reference image (drew a different picture)');
          images[slot] = { ...drawn, model: m }; onImage(slot); return;
        } catch (err) {
          errors.push(`${m.id}: ${err.message}`);
          if (FATAL_STATUS.has(err.status)) fatal ||= err;
        }
      }
    }));
    return { errors, fatal };
  }

  async function policyRewrite(prompt) {
    if (complete) {
      try {
        const r = unquote(await complete(REWRITE_SYSTEM, prompt));
        const safe = heuristicRewrite(r) || r;
        if (safe && safe !== prompt && !hasRiskTerms(safe)) return safe;
      } catch (err) { log(`policy rewrite failed: ${err.message}`); }
    }
    return heuristicRewrite(prompt);
  }

  // onProgress({ready, total, slot, model, name, image}) is called each time an image lands; image is
  // the same object result.images will hold.
  // models: exact catalogue ids to use (no substitution); via: 'chat' | 'images' limits the
  // automatic choice to one kind of model. count defaults to one image per listed model.
  return async function generate({ prompt, count, tier, family, aspect = '1:1', size, references = [], enhance = true, models, via, format, onProgress }) {
    count = Math.min(Math.max(1, Math.trunc(count ?? (models?.length || DEFAULT_IMAGES))), MAX_IMAGES);
    const started = now();
    const result = { ok: false, complete: false, requested: count, intent: null, models: [], enhancedPrompt: null, rewrittenPrompt: null, images: [], errors: [] };

    let catalogue;
    try { catalogue = buildCatalogue(await client.imageModels()); } catch (err) { result.errors.push(`catalogue: ${err.message}`); return result; }
    const hasReference = references.length > 0;
    let primaries, fallbacks;
    if (models?.length) {
      const picked = models.map(id => catalogue.find(m => m.id === id));
      const unknown = models.filter((id, i) => !picked[i]);
      if (unknown.length) { result.errors.push(`not an image model in the OpenRouter catalogue: ${unknown.join(', ')} (see vane --list-image-models)`); return result; }
      result.intent = { family: family || 'general', tier: tier || DEFAULT_TIER, source: 'explicit' };
      primaries = Array.from({ length: count }, (_, i) => picked[i % picked.length]); // cycle when -n exceeds the list
      fallbacks = primaries.map(() => []);
    } else {
      result.intent = await classifyIntent(prompt, { complete, hasReference, family, tier });
      ({ primaries, fallbacks } = selectModels(catalogue, { family: result.intent.family, tier: result.intent.tier, count, needsReference: hasReference, via }));
    }
    result.models = primaries.map(m => m.id);
    if (!primaries.length) { result.errors.push(`no ${via ? `${via} ` : ''}image model for family "${result.intent.family}"`); return result; }
    // Only a few models emit SVG, so a vector request may legitimately return fewer.
    const want = result.intent.family === 'vector' ? primaries.length : count;
    result.requested = want;
    const chains = primaries.map((m, i) => [m, ...fallbacks[i]]);

    let finalPrompt = prompt;
    if (enhance && complete) {
      try {
        const e = unquote(await complete(ENHANCE_SYSTEM, `Original description: ${prompt}`));
        if (e) result.enhancedPrompt = finalPrompt = e;
      } catch (err) { log(`prompt enhancement failed, using the original: ${err.message}`); }
    }

    const opts = { aspect, size, references, format };
    const slots = chains.map(() => null);
    const drawn = () => slots.filter(Boolean).length;
    // Progress is cosmetic: a throwing listener must never fail an image run.
    const onImage = (slot) => { try { onProgress?.({ ready: drawn(), total: want, slot, model: slots[slot].model.id, name: slots[slot].model.name, image: toResultImage(slots[slot]) }); } catch (err) { log(`progress listener failed: ${err.message}`); } };
    let run = await attempt(finalPrompt, chains, slots, opts, onImage);
    result.errors.push(...run.errors);

    // Retry chain for the images still missing: a model-written rewrite after a refusal,
    // then the local rewrite when the prompt names protected works. Skipped entirely after
    // a key/credit error.
    const retries = [
      async () => (shouldRetry(run.errors) ? (result.rewrittenPrompt = await policyRewrite(finalPrompt)) : null),
      async () => heuristicRewrite(finalPrompt),
    ];
    const tried = new Set([finalPrompt]);
    for (const next of retries) {
      if (drawn() >= want || run.fatal) break;
      const p = await next();
      if (!p || tried.has(p)) continue;
      tried.add(p);
      log('retrying with a rewritten prompt');
      run = await attempt(p, chains, slots, opts, onImage);
      result.errors.push(...run.errors.map(e => `after rewrite: ${e}`));
    }

    const images = slots.filter(Boolean);
    result.images = images.map(toResultImage);
    result.ok = images.length > 0;
    result.complete = images.length >= want;
    result.elapsedMs = now() - started;
    return result;
  };
}

// Image generation pipeline, after reasoner's generate_images():
//   catalogue -> intent -> model selection -> prompt enhancement -> parallel generation
//   -> fallbacks until `count` -> retry chain (model rewrite, then local rewrite).
// Dependencies (OpenRouter client, URL downloader) are injected, so the pipeline is
// tested with fakes. Failures are returned as values; only programming errors throw.
import { buildCatalogue, emitsSvg, selectModels } from './catalogue.mjs';
import { classifyIntent } from './intent.mjs';
import { REWRITE_SYSTEM, hasRiskTerms, heuristicRewrite, shouldRetry } from './policy.mjs';
import { collectImageCandidates, sniffMime } from './extract.mjs';

export const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];
export const IMAGE_SIZES = ['1K', '2K', '4K'];
export const MAX_IMAGES = 8; // every image is a paid call, fanned out in parallel

const ENHANCE_SYSTEM = 'You are an image-prompt engineer. Expand the description into one detailed prompt for an image model: subject, setting, composition, lighting, colour palette, medium or style, and mood. Keep every element the user asked for; add no text, logos or artist names they did not ask for. Reply with the prompt only, under 120 words.';
const unquote = (s) => String(s || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
const FATAL = new Set([401, 402]); // bad key or no credits: every model fails the same way

export function createImageGenerator({ client, download, textModel = null, log = () => {} }) {
  const complete = textModel ? (system, user) => client.complete(textModel, system, user) : null;

  // Pure generators (output modality "image" only) use OpenRouter's Image API; models that
  // also write text (Gemini, GPT) use chat completions. Chosen from catalogue data, with a
  // switch to the Image API if chat completions says the model needs it.
  async function viaImagesApi(model, prompt, { aspect, size, references }) {
    const res = await client.images({
      model: model.id,
      prompt,
      n: 1,
      aspect_ratio: aspect,
      ...(size ? { resolution: size } : {}),
      ...(emitsSvg(model) ? { output_format: 'svg' } : {}),
      ...(references.length ? { input_references: references.map(url => ({ type: 'image_url', image_url: { url } })) } : {}),
    });
    const item = res?.data?.[0];
    if (item?.b64_json) {
      const bytes = Buffer.from(item.b64_json, 'base64');
      const mime = sniffMime(bytes) || item.media_type;
      if (mime?.startsWith('image/')) return `data:${mime};base64,${item.b64_json}`;
    }
    if (item?.url) return download(item.url);
    throw new Error('no image in response');
  }

  async function generateOne(model, prompt, opts) {
    if (!model.modalities.includes('text')) return viaImagesApi(model, prompt, opts);
    try {
      return await viaChat(model, prompt, opts);
    } catch (err) {
      if (/\/images\b.*endpoint|images endpoint/i.test(err.message)) return viaImagesApi(model, prompt, opts);
      throw err;
    }
  }

  async function viaChat(model, prompt, { aspect, size, references }) {
    const res = await client.chat({
      model: model.id,
      modalities: model.modalities,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: prompt }, ...references.map(url => ({ type: 'image_url', image_url: { url } }))],
      }],
      image_config: { aspect_ratio: aspect, ...(size ? { image_size: size } : {}) },
    });
    const { inline, remote } = collectImageCandidates(res?.choices?.[0]?.message ?? res);
    if (inline.length) return inline[0];
    for (const url of remote) {
      try { return await download(url); } catch (err) { log(`${model.id}: ${err.message}`); }
    }
    throw new Error('no image in response');
  }

  // Primaries in parallel, then fallbacks one at a time until `count` images exist.
  async function attempt(prompt, primaries, fallbacks, count, opts) {
    const images = [], errors = [];
    let fatal = null;
    const record = (model, err) => {
      errors.push(`${model.id}: ${err.message}`);
      if (FATAL.has(err.status)) fatal ||= err;
    };
    const settled = await Promise.allSettled(primaries.map(m => generateOne(m, prompt, opts)));
    settled.forEach((r, i) => (r.status === 'fulfilled' ? images.push({ dataUrl: r.value, model: primaries[i] }) : record(primaries[i], r.reason)));
    for (const m of fallbacks) {
      if (images.length >= count || fatal) break;
      try { images.push({ dataUrl: await generateOne(m, prompt, opts), model: m }); } catch (err) { record(m, err); }
    }
    return { images: images.slice(0, count), errors, fatal };
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

  return async function generate({ prompt, count = 2, tier, family, aspect = '1:1', size, references = [], enhance = true }) {
    count = Math.min(Math.max(1, Math.trunc(count)), MAX_IMAGES);
    const result = { ok: false, complete: false, requested: count, intent: null, models: [], enhancedPrompt: null, rewrittenPrompt: null, images: [], errors: [] };

    let catalogue;
    try { catalogue = buildCatalogue(await client.imageModels()); } catch (err) { result.errors.push(`catalogue: ${err.message}`); return result; }
    const hasReference = references.length > 0;
    result.intent = await classifyIntent(prompt, { complete, hasReference, family, tier });
    const { primaries, fallbacks } = selectModels(catalogue, { family: result.intent.family, tier: result.intent.tier, count, needsReference: hasReference });
    result.models = primaries.map(m => m.id);
    if (!primaries.length) { result.errors.push(`no image model for family "${result.intent.family}"`); return result; }
    // Only a few models emit SVG, so a vector request may legitimately return fewer.
    const want = result.intent.family === 'vector' ? Math.min(count, primaries.length + fallbacks.length) : count;
    result.requested = want;

    let finalPrompt = prompt;
    if (enhance && complete) {
      try {
        const e = unquote(await complete(ENHANCE_SYSTEM, `Original description: ${prompt}`));
        if (e) result.enhancedPrompt = finalPrompt = e;
      } catch (err) { log(`prompt enhancement failed, using the original: ${err.message}`); }
    }

    const opts = { aspect, size, references };
    let run = await attempt(finalPrompt, primaries, fallbacks, want, opts);
    let { images } = run;
    result.errors.push(...run.errors);

    // Retry chain: a model-written rewrite after a refusal, then the local rewrite when
    // the prompt names protected works. Skipped entirely after a key/credit error.
    const retries = [
      async () => (shouldRetry(run.errors) ? (result.rewrittenPrompt = await policyRewrite(finalPrompt)) : null),
      async () => heuristicRewrite(finalPrompt),
    ];
    const tried = new Set([finalPrompt]);
    for (const next of retries) {
      if (images.length >= want || run.fatal) break;
      const p = await next();
      if (!p || tried.has(p)) continue;
      tried.add(p);
      log('retrying with a rewritten prompt');
      const r = await attempt(p, primaries, fallbacks, want, opts);
      if (r.images.length >= images.length) images = r.images;
      result.errors.push(...r.errors.map(e => `after rewrite: ${e}`));
      run = r;
    }

    result.images = images.map(i => ({ dataUrl: i.dataUrl, model: i.model.id, pricePerImage: i.model.price }));
    result.ok = images.length > 0;
    result.complete = images.length >= want;
    return result;
  };
}

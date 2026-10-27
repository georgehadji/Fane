// Image generation inside Vane's web UI. patches/patch-image-chat.js calls handleImageRequest()
// from Vane's chat route before research starts: an image request ("create an image of ...")
// is answered with generated images instead of a text answer, using the same pipeline as
// `vane --image` and the OpenRouter key from Vane's own provider settings.
import { readFile } from 'node:fs/promises';
import { TIER_FOR_MODE } from './catalogue.mjs';
import { isImageRequest, parseImageOptions } from './intent.mjs';
import { renderProgress, renderResult } from './present.mjs';
import { DEFAULT_TEXT_MODEL, createImageGenerator } from './generate.mjs';
import { createImageStore, storeDirFor } from './store.mjs';
import { createOpenRouterClient, findOpenRouterKey } from './openrouter.mjs';
import { safeDownload } from './download.mjs';

// store.put(dataUrl) -> link (default: files next to Vane's config.json, served by patch-image-serve).
// mode is Vane's optimization mode (speed | balanced | quality), which picks the price tier.
// emit(markdown) -> blockId, update(blockId, markdown). Returns false when the query is not an
// image request (Vane then answers as usual). Dependencies are injectable for tests.
export async function handleImageRequest(query, { emit, update, configPath, mode, store = configPath ? createImageStore({ dir: storeDirFor(configPath) }) : null, log = (m) => console.log(`fane: ${m}`), readConfig, generator } = {}) {
  if (!isImageRequest(query)) return false;
  const id = emit('_Generating images…_');
  let apiKey = null;
  try {
    const raw = readConfig ? await readConfig() : await readFile(configPath, 'utf8');
    apiKey = findOpenRouterKey(JSON.parse(raw).modelProviders);
  } catch (err) { log(`could not read Vane config: ${err.message}`); }
  if (!apiKey && !generator) {
    update(id, "Image generation needs an OpenRouter provider: in Settings → Models, add an OpenAI-compatible provider with Base URL https://openrouter.ai/api/v1 and your OpenRouter API key.");
    return true;
  }
  const generate = generator || createImageGenerator({
    client: createOpenRouterClient({ apiKey }),
    download: (url) => safeDownload(url),
    textModel: process.env.VANE_IMAGE_TEXT_MODEL || DEFAULT_TEXT_MODEL,
    log,
  });
  const done = [];
  const onProgress = (p) => { done.push(p); update(id, renderProgress(done, p.total)); };
  const result = await generate({ prompt: query, format: 'jpeg', ...(TIER_FOR_MODE[mode] && { tier: TIER_FOR_MODE[mode] }), ...parseImageOptions(query), onProgress });
  // Stored images are linked, not embedded; one that cannot be stored is embedded as before.
  const images = await Promise.all(result.images.map(async (i) => {
    try { return store ? { ...i, url: await store.put(i.dataUrl) } : i; } catch (err) { log(`image not stored, embedding it: ${err.message}`); return i; }
  }));
  update(id, renderResult({ ...result, images }, query));
  return true;
}

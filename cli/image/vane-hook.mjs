// Image generation inside Vane's web UI. patches/patch-image-chat.js calls handleImageRequest()
// from Vane's chat route before research starts: an image request ("create an image of ...")
// is answered with generated images instead of a text answer, using the same pipeline as
// `vane --image` and the OpenRouter key from Vane's own provider settings. A follow-up that
// edits the images of the previous answer ("make it a watercolour") is answered the same way,
// with the earlier image as the reference.
import { readFile } from 'node:fs/promises';
import { TIER_FOR_MODE } from './catalogue.mjs';
import { isImageEdit, isImageRequest, parseImageOptions, pickReferenceIndex } from './intent.mjs';
import { renderProgress, renderResult } from './present.mjs';
import { DEFAULT_TEXT_MODEL, createImageGenerator } from './generate.mjs';
import { createImageStore, storeDirFor, storedUrlsIn } from './store.mjs';
import { createOpenRouterClient, findOpenRouterKey } from './openrouter.mjs';
import { safeDownload } from './download.mjs';

// The text of the previous answer: from Vane's database when the patch provides lastAnswer(), else
// from the chat history the browser sent (which can hold an older, partial version of it).
async function previousAnswer(history, lastAnswer) {
  try { const text = await lastAnswer?.(); if (typeof text === 'string') return text; } catch { /* use the history */ }
  const last = history?.at(-1);
  return last?.role === 'assistant' ? String(last.content ?? '') : '';
}

// The links of the earlier images when this message edits them: the previous turn was Fane's
// images and the message reads like an edit. A fresh image request is a new picture, not an edit.
async function earlierImages(query, { history, lastAnswer, store }) {
  if (!store || isImageRequest(query) || !isImageEdit(query)) return null;
  const links = storedUrlsIn(await previousAnswer(history, lastAnswer));
  return links.length ? links : null;
}

// lastAnswer() -> text of the previous answer (from Vane's database); history is the chat history
// the browser sent ([{role, content}]), used when lastAnswer is missing. store.put(dataUrl) -> link and
// store.get(link) -> data URL (default: files next to Vane's config.json, served by
// patch-image-serve). mode is Vane's optimization mode (speed | balanced | quality), which picks
// the price tier. emit(markdown) -> blockId, update(blockId, markdown). Returns false when the
// query is neither an image request nor an edit of earlier images (Vane then answers as usual).
// Dependencies are injectable for tests.
export async function handleImageRequest(query, { emit, update, configPath, mode, history, lastAnswer, store = configPath ? createImageStore({ dir: storeDirFor(configPath) }) : null, log = (m) => console.log(`fane: ${m}`), readConfig, generator } = {}) {
  const earlier = await earlierImages(query, { history, lastAnswer, store });
  if (!earlier && !isImageRequest(query)) return false;
  const id = emit(earlier ? '_Editing the image…_' : '_Generating images…_');
  let apiKey = null;
  try {
    const raw = readConfig ? await readConfig() : await readFile(configPath, 'utf8');
    apiKey = findOpenRouterKey(JSON.parse(raw).modelProviders);
  } catch (err) { log(`could not read Vane config: ${err.message}`); }
  if (!apiKey && !generator) {
    update(id, "Image generation needs an OpenRouter provider: in Settings → Models, add an OpenAI-compatible provider with Base URL https://openrouter.ai/api/v1 and your OpenRouter API key.");
    return true;
  }
  let references = [];
  let editedImage = null;
  if (earlier) {
    const index = pickReferenceIndex(query, earlier.length);
    try { references = [await store.get(earlier[index])]; editedImage = index + 1; } catch (err) {
      log(`earlier image not readable: ${err.message}`);
      update(id, 'The earlier image is no longer stored, so I cannot edit it. Describe the picture you want and I will make new images.');
      return true;
    }
  }
  const generate = generator || createImageGenerator({
    client: createOpenRouterClient({ apiKey }),
    download: (url) => safeDownload(url),
    textModel: process.env.VANE_IMAGE_TEXT_MODEL || DEFAULT_TEXT_MODEL,
    log,
  });
  // Each image is stored the moment it lands and shown at once; the queue keeps the updates in order.
  const done = [];
  let queue = Promise.resolve();
  const keep = async (image) => {
    try { return store ? await store.put(image.dataUrl) : undefined; } catch (err) { log(`image not stored, embedding it: ${err.message}`); return undefined; }
  };
  const onProgress = (p) => {
    queue = queue.then(async () => {
      done.push({ ...p.image, slot: p.slot, url: await keep(p.image) });
      update(id, renderProgress(done, p.total, query));
    });
  };
  // An edit instruction is sent as written: the prompt enhancer would turn "make it blue" into a new scene.
  const result = await generate({ prompt: query, format: 'jpeg', ...(references.length && { references, enhance: false }), ...(TIER_FOR_MODE[mode] && { tier: TIER_FOR_MODE[mode] }), ...parseImageOptions(query), onProgress });
  await queue;
  // Stored images are linked, not embedded; one that could not be stored is embedded as before.
  const images = await Promise.all(result.images.map(async (i) => ({ ...i, url: done.find(d => d.model === i.model)?.url ?? await keep(i) })));
  update(id, renderResult({ ...result, images, editedImage }, query));
  return true;
}

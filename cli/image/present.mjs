// How an image result looks in Vane's answer view. Pure functions: a result in, markdown out.
// Vane renders raw HTML in answers and keeps data:image URLs, but drops `width` from inline
// styles, so the image width is the HTML attribute. Everything that came from a prompt or a
// model is escaped before it goes into HTML.
import { imageSubject } from './intent.mjs';
import { explainFailure } from './policy.mjs';

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const altText = (subject, i, n, name) => `Image ${i} of ${n}: ${subject}${name ? ` (${name})` : ''}`;

// OpenRouter names are "Provider: Model"; the reader wants the model.
export const modelLabel = (img) => (img.name ? img.name.replace(/^[^:]+:\s*/, '') : img.model);

const isImageUrl = (u) => /^data:image\/[a-z0-9.+-]+;base64,/i.test(u) && !/["'<>\s]/.test(u);

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const figure = (img, subject, i, n) => {
  const price = img.pricePerImage ? ` · ~$${img.pricePerImage.toFixed(3)}` : '';
  const words = img.text ? ` — ${escapeHtml(img.text)}` : '';
  return `<figure style="margin:0"><a href="${img.dataUrl}" target="_blank" rel="noopener"><img src="${img.dataUrl}" alt="${escapeHtml(altText(subject, i, n, modelLabel(img)))}" width="100%" loading="lazy" style="height:auto;border-radius:8px"></a><figcaption><em>${escapeHtml(modelLabel(img))}${price}</em>${words}</figcaption></figure>`;
};

function failure(errors) {
  const { summary, next } = explainFailure(errors);
  const raw = errors.slice(0, 6).map(e => `<li>${escapeHtml(e)}</li>`).join('');
  return { text: `${summary} ${next}`, details: raw ? `<details><summary>Details</summary><ul>${raw}</ul></details>` : '' };
}

// Shown while the models work: finished images are only added to the answer at the end, because
// every answer update re-sends the whole answer, and each embedded image is megabytes.
export function renderProgress(done, total) {
  const names = done.map(modelLabel).map(n => `✓ ${escapeHtml(n)}`);
  return [`_Generating images… ${done.length} of ${total} ready_`, names.join(' · ')].filter(Boolean).join('\n\n');
}

export function renderResult(result, prompt) {
  const subject = imageSubject(prompt);
  const images = result.images.filter(i => isImageUrl(i.dataUrl));
  if (!images.length) {
    const f = failure(result.errors);
    return [`**No images this time.** ${f.text}`, f.details].filter(Boolean).join('\n\n');
  }
  const grid = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">${images.map((img, i) => figure(img, subject, i + 1, images.length)).join('')}</div>`;
  const total = images.reduce((sum, i) => sum + (i.pricePerImage || 0), 0);
  const summary = [`${images.length} image${images.length > 1 ? 's' : ''}`, total ? `~$${total.toFixed(3)}` : null, result.elapsedMs ? formatDuration(result.elapsedMs) : null].filter(Boolean).join(' · ');
  const notes = [
    result.rewrittenPrompt ? `Rewritten after a refusal: ${escapeHtml(result.rewrittenPrompt)}` : null,
    !result.complete ? `Made ${images.length} of ${result.requested} images. ${failure(result.errors).text}` : null,
  ].filter(Boolean).map(n => `> ${n}`);
  return [grid, summary, ...notes].join('\n\n');
}

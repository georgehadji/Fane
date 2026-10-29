// How an image result looks in Vane's answer view. Pure functions: a result in, markdown out.
// Vane renders raw HTML in answers and keeps data:image URLs, but drops `width` from inline
// styles, so the image width is the HTML attribute. Everything that came from a prompt or a
// model is escaped before it goes into HTML.
// Typography: the answer keeps Vane's body text; everything Fane adds around it (captions, status,
// summary, notes, raw errors) is smaller and dimmed with `opacity` (so it suits both themes), in
// regular or medium weight, never italic (italic sans barely stands out) and never quoted.
import { imageSubject } from './intent.mjs';
import { explainFailure } from './policy.mjs';
import { openRouterNeeded } from './openrouter.mjs';
import { isStoredUrl } from './store.mjs';

// Ends every answer the hook writes. An HTML comment shows nothing; patches/patch-image-ui.js uses
// it to leave Vane's "Search images / Search videos" buttons out of these answers
// (patches/lib/vane.js holds the same string; a test keeps the two equal).
export const ANSWER_MARKER = '<!--fane:image-answer-->';
export const tagged = (markdown) => `${markdown}\n\n${ANSWER_MARKER}`;

const NBSP = ' ';
const DIM = 'opacity:0.7';
const PLACEHOLDER = 'rgba(127,127,127,0.12)'; // a grey that shows on both themes
const ratio = (aspect) => (/^\d+:\d+$/.test(aspect || '') ? aspect.replace(':', '/') : '1/1');

// The text of the previous answer: from Vane's database when the patch provides lastAnswer(), else
// from the chat history the browser sent (which can hold an older, partial version of it). The image and
// article hooks use it to find what a follow-up edits.
export async function previousAnswer(history, lastAnswer) {
  try { const text = await lastAnswer?.(); if (typeof text === 'string') return text; } catch { /* use the history */ }
  const last = history?.at(-1);
  return last?.role === 'assistant' ? String(last.content ?? '') : '';
}

// Status, summary and notes: one small dimmed block, one line each. Lines are already escaped.
// role="status": a screen reader announces progress and the final summary politely.
export const quiet = (lines) => `<p role="status" style="font-size:14px;${DIM}">${lines.filter(Boolean).join('<br>')}</p>`;

// A run that produced nothing: the whole answer, so body size with a bold lead, not a dimmed quiet() line.
// HTML, not Markdown, so an error message's * or _ stays text. Both arguments are already escaped.
export const failed = (head, why) => `<p role="status"><strong>${head}</strong> ${why}</p>`;

// No provider set up, so nothing ran: the whole answer, like any failure. The lead is the first clause of
// openRouterNeeded(), the setup steps follow it.
export const providerMissing = (what, opts) => {
  const [lead, steps = ''] = openRouterNeeded(what, opts).split(/:\s(.*)/s);
  return failed(escapeHtml(`${lead}.`), escapeHtml(steps.charAt(0).toUpperCase() + steps.slice(1)));
};

// Why a text run (article, post, code, brainstorm) stopped: the two OpenRouter answers that need the user, else
// the error as it came.
export const failureReason = (result) => (result.status === 402 ? 'OpenRouter has no credits left (402). Add credits at openrouter.ai and ask again.'
  : result.status === 401 ? "OpenRouter refused the API key (401). Check the key of the OpenRouter provider in Vane's Settings."
    : result.error);

// Under the running step while a text run works: how many are done, not their names, so the line stays one line.
export const stepsDone = (n, lang = 'en') => (!n ? '' : lang === 'el' ? `${n} ${n === 1 ? 'βήμα έγινε' : 'βήματα έγιναν'}` : `${n} ${n === 1 ? 'step' : 'steps'} done`);

// & < > " are escaped. An apostrophe needs no escape (Vane shows &#39; literally), and one inside a
// word is the curly one: don't -> don’t.
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]).replace(/(\w)'(\w)/g, '$1’$2');

// Text for an attribute (alt): Vane does not decode entities there, so none are used. A pair of straight
// quotes becomes curly ones, the rest of the characters that could end the attribute or open a tag are
// replaced by look-alikes.
export const attr = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/"([^"]*)"/g, '“$1”').replace(/"/g, '”').replace(/</g, '‹').replace(/>/g, '›').replace(/(\w)'(\w)/g, '$1’$2');

export const altText = (subject, i, n, name) => `Image ${i} of ${n}: ${subject}${name ? ` (${name})` : ''}`;

// OpenRouter names are "Provider: Model"; the reader wants the model.
export const modelLabel = (img) => (img.name ? img.name.replace(/^[^:]+:\s*/, '') : img.model);

// An image is shown from its stored link when it has one, else embedded as a data URL.
const src = (img) => img.url || img.dataUrl;
const isImageUrl = (u) => isStoredUrl(u) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(u) && !/["'<>\s]/.test(u);

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// The alt text leaves the model out: the caption (the figure's name) says it, and a screen reader would
// read it twice.
// Caption: the model in medium weight, its price dimmed; the model's own words, if any, on the next
// line. The gap to the image (6px) is smaller than the gap between rows (20px), so a caption
// belongs to the image above it.
const figure = (img, subject, i, n) => {
  // Vane's HTML parser trims the space at the edge of a span, so the gap after the name is a margin.
  // No "·" before the price: weight, opacity and the margin separate them, and a dot left at a line end dangles.
  const price = img.pricePerImage ? `≈${NBSP}$${img.pricePerImage.toFixed(3)}` : '';
  const words = img.text ? `<br><span>${escapeHtml(img.text.replace(/\s+/g, ' ').trim())}</span>` : ''; // a blank line would end Vane's raw-HTML block
  // The tile keeps its place (the asked ratio, then the picture's own) while a large original loads.
  return `<figure style="margin:0"><a href="${src(img)}" target="_blank" rel="noopener" title="Open full size in a new tab"><img src="${src(img)}" alt="${attr(altText(subject, i, n))}" width="100%" loading="lazy" style="display:block;margin:0;height:auto;aspect-ratio:auto ${ratio(img.aspect)};background:${PLACEHOLDER};border-radius:8px"></a><figcaption style="font-size:14px;margin-top:6px"><span style="font-weight:500;margin-right:0.4em">${escapeHtml(modelLabel(img))}</span><span>${price}</span>${words}</figcaption></figure>`;
};

// The raw provider errors are code-like: small and in code type.
function failure(errors) {
  const { summary, next } = explainFailure(errors);
  const raw = errors.slice(0, 6).map(e => `<li><code style="font-size:inherit;font-weight:400">${escapeHtml(e)}</code></li>`).join('');
  return { text: `${summary} ${next}`, details: raw ? `<details><summary>Details</summary><ul style="font-size:13px">${raw}</ul></details>` : '' };
}

const grid = (images, subject, n = images.length) => `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:20px 12px">${images.map((img, i) => figure(img, subject, i + 1, n)).join('')}</div>`;

// Shown while the models work. A finished image is stored the moment it lands, so it appears in
// the answer at once (a link is tiny). One that could not be stored is only named: every answer
// update re-sends the whole answer, and an embedded image is megabytes. Vane's browser keeps this
// text as the earlier answer until the page is reloaded, so the links in it are what a follow-up
// edit finds.
export function renderProgress(done, total, prompt = '') {
  const sorted = [...done].sort((x, y) => x.slot - y.slot);
  const shown = sorted.filter(i => isStoredUrl(i.url));
  const named = sorted.filter(i => !isStoredUrl(i.url)).map(i => `✓ ${escapeHtml(modelLabel(i))}`).join(' · ');
  return [shown.length ? grid(shown, imageSubject(prompt), total) : null, quiet([`Generating images… ${done.length} of ${total} ready`, named])].filter(Boolean).join('\n\n');
}

export function renderResult(result, prompt) {
  const subject = imageSubject(prompt);
  const images = result.images.filter(i => isImageUrl(src(i)));
  if (!images.length) {
    const f = failure(result.errors);
    return [`**No images this time.** ${f.text}`, f.details].filter(Boolean).join('\n\n');
  }
  const total = images.reduce((sum, i) => sum + (i.pricePerImage || 0), 0);
  const stay = (s) => s.replace(/ /g, NBSP); // a number and its unit stay on one line
  const summary = [stay(`${images.length} image${images.length > 1 ? 's' : ''}`), total ? `≈${NBSP}$${total.toFixed(3)}` : null, result.elapsedMs ? stay(formatDuration(result.elapsedMs)) : null].filter(Boolean).join(' · ');
  const notes = [
    result.editedImage ? `Edited image ${result.editedImage} of the previous answer.` : null,
    result.rewrittenPrompt ? `Rewritten after a refusal: “${escapeHtml(result.rewrittenPrompt)}”` : null,
    !result.complete ? `Made ${images.length} of ${result.requested} images. ${failure(result.errors).text}` : null,
  ];
  return [grid(images, subject), quiet([summary, ...notes])].join('\n\n');
}

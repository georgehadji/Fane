import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderResult, renderProgress, quiet, altText, escapeHtml, modelLabel, formatDuration, providerMissing } from '../image/present.mjs';
import { explainFailure } from '../image/policy.mjs';

const URL = 'data:image/png;base64,AAAA';
const img = (n, price, text = null) => ({ dataUrl: URL, model: `lab/m${n}`, name: `Lab: Model ${n}`, pricePerImage: price, text });

test('grid, captions, summary line, escaped text', () => {
  const md = renderResult({ images: [img(1, 0.01), img(2, 0.02, '<b>hi</b>')], requested: 2, complete: true, errors: [], elapsedMs: 105000 }, 'draw a "fox" <script>');
  assert.match(md, /^<div style="display:grid;grid-template-columns:repeat\(2,1fr\);gap:20px 12px"/);
  assert.equal(md.match(/<figure /g).length, 2);
  assert.equal(md.match(/aspect-ratio:auto 1\/1;/g).length, 2); // the tile keeps its place while the image loads
  assert.match(renderResult({ images: [{ ...img(1, 0.01), aspect: '16:9' }], requested: 1, complete: true, errors: [] }, 'x'), /aspect-ratio:auto 16\/9;/);
  assert.match(md, /alt="Image 2 of 2: a “fox” ‹script›"/); // the model is in the caption, not read twice; no entities in an attribute
  assert.doesNotMatch(md, /alt="[^"]*&/);
  assert.match(md, /&lt;b&gt;hi&lt;\/b&gt;/);
  assert.doesNotMatch(md, /<script>|<b>hi/);
  assert.match(md, /\n\n<p role="status" style="font-size:14px;opacity:0\.7">2 images · ≈ \$0\.030 · 1m 45s<\/p>$/);
});

test('typography: captions, notes and summary are quiet, never italic, quoted or spaced-dash', () => {
  const md = renderResult({ images: [img(1, 0.01, 'A lighthouse at dawn.'), img(2, 0.02)], requested: 4, complete: false, errors: ['a: 503 upstream'], rewrittenPrompt: 'a fox', editedImage: 1, elapsedMs: 9000 }, 'draw a fox');
  assert.doesNotMatch(md, /<em>|<i>|font-style|^> |\n> | — |~\$/); // no italics, no blockquotes, no spaced em dash, no tilde
  assert.match(md, /<figcaption style="font-size:14px;margin-top:6px"><span style="font-weight:500;margin-right:0\.4em">Model 1<\/span><span>≈ \$0\.010<\/span><br><span>A lighthouse at dawn\.<\/span><\/figcaption>/);
  // no opacity on caption text: Vane already greys figcaptions, and dimming again fell to 2.8:1 (light) and 4.2:1 (dark)
  assert.doesNotMatch(md.slice(md.indexOf('<figcaption'), md.indexOf('</figcaption>')), /opacity/);
  assert.match(providerMissing('Code writing'), /^<p role="status"><strong>Code writing needs an OpenRouter provider\.<\/strong> In Settings/);
  const quiet = md.slice(md.lastIndexOf('<p role='));
  assert.match(quiet, /^<p role="status" style="font-size:14px;opacity:0\.7">2 images · ≈ \$0\.030 · 9s<br>Edited image 1 of the previous answer\.<br>Rewritten after a refusal: “a fox”<br>Made 2 of 4 images\./);
  assert.equal(quiet.split('<p ').length - 1, 1); // one quiet block, not one paragraph per line
});

test('accessibility: names, status role, link purpose', () => {
  const md = renderResult({ images: [img(1, 0.01), img(2, 0.02)], requested: 2, complete: true, errors: [], elapsedMs: 5000 }, 'draw a fox');
  for (const m of md.match(/<img [^>]*>/g)) assert.match(m, /alt="Image [12] of 2: a fox"/); // every image has a name without the model
  assert.equal(md.match(/<figcaption /g).length, 2); // the model is named once, in the caption
  assert.ok(md.match(/<a [^>]*>/g).every(a => a.includes('target="_blank"') && a.includes('rel="noopener"') && a.includes('title="Open full size in a new tab"')));
  assert.match(md, /<p role="status"/); // the summary is announced
  assert.match(quiet(['x']), /^<p role="status"/);
  assert.match(renderProgress([{ ...img(1, 0.01), slot: 0 }], 2, 'draw a fox'), /<p role="status"[^>]*>Generating images… 1 of 2 ready/); // so is progress
  assert.doesNotMatch(md, /aria-hidden|tabindex/); // nothing focusable is hidden
});

test('a URL that is not an image data URL never reaches the HTML', () => {
  const bad = [{ dataUrl: 'javascript:alert(1)', model: 'a/b' }, { dataUrl: 'data:image/png;base64,AA" onerror="x', model: 'a/c' }];
  const md = renderResult({ images: bad, requested: 2, complete: false, errors: ['a/b: 500 boom'] }, 'draw a fox');
  assert.doesNotMatch(md, /<img|onerror/);
  assert.match(md, /No images this time/);
});

test('an incomplete set says how many and why', () => {
  const md = renderResult({ images: [img(1, 0.01)], requested: 4, complete: false, errors: ['a: 503 upstream'], rewrittenPrompt: 'a <b>fox</b>' }, 'draw a fox');
  assert.match(md, /Rewritten after a refusal: “a &lt;b&gt;fox&lt;\/b&gt;”/);
  assert.match(md, /Made 1 of 4 images\. The image models were busy or unreachable\. Try again in a minute\./);
});

test('failures are explained in words, raw errors folded away', () => {
  const credits = renderResult({ images: [], errors: ['a: 402 Insufficient credits'], requested: 2 }, 'draw a fox');
  assert.match(credits, /^\*\*No images this time\.\*\* Your OpenRouter account is out of credits\. Add credits at https:\/\/openrouter\.ai\/credits/);
  assert.match(credits, /<details><summary>Details<\/summary><ul style="font-size:13px"><li><code style="font-size:inherit;font-weight:400">a: 402 Insufficient credits<\/code><\/li>/);
  assert.match(explainFailure(['x: 401 bad key']).next, /Vane’s Settings/); // curly apostrophe
  for (const e of [['402 x'], ['401 x'], ['content policy'], ['503 x'], []]) assert.doesNotMatch(Object.values(explainFailure(e)).join(' '), /'/);
});

test('explainFailure picks the cause, credits before anything else', () => {
  assert.match(explainFailure(['x: 401 bad key']).summary, /did not accept the API key/);
  assert.match(explainFailure(['x: content policy violation']).summary, /refused this prompt/);
  assert.match(explainFailure(['x: 503 upstream']).summary, /busy or unreachable/);
  assert.match(explainFailure(['x: 401 bad', 'y: 402 Insufficient credits']).summary, /out of credits/);
  assert.match(explainFailure([]).summary, /No image model returned a picture/);
});

test('helpers', () => {
  assert.equal(altText('a fox', 2, 4, 'Seedream'), 'Image 2 of 4: a fox (Seedream)');
  assert.equal(modelLabel({ name: 'Recraft: Recraft V4.1', model: 'recraft/x' }), 'Recraft V4.1');
  assert.equal(modelLabel({ model: 'recraft/x' }), 'recraft/x');
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;\'');
  assert.equal(escapeHtml("don't stop 'now'"), "don’t stop 'now'"); // curly only inside a word
  assert.match(renderResult({ images: [img(1, 0.01)], requested: 1, complete: true, errors: [] }, "draw a duck's nest").replace(/\n/g, ' '), /Image 1 of 1: a duck’s nest/);
  assert.match(renderResult({ images: [img(1, 0.01)], requested: 1, complete: false, errors: [], rewrittenPrompt: "don't" }, 'draw').replace(/\n/g, ' '), /“don’t”/);
  assert.doesNotMatch(renderResult({ images: [img(1, 0.01, "it's")], requested: 1, complete: true, errors: [] }, 'draw'), /&#39;/);
  assert.equal(formatDuration(12400), '12s');
  assert.equal(formatDuration(61000), '1m 1s');
});

test('attr: alt text has no entities, no way out of the attribute, curly quotes', async () => {
  const { attr } = await import('../image/present.mjs');
  assert.equal(attr('a "calm" sea'), 'a “calm” sea');
  assert.equal(attr('say "hi'), 'say ”hi'); // an unpaired quote cannot end the attribute
  assert.equal(attr('<img onerror=x>'), '‹img onerror=x›');
  assert.equal(attr("a duck's nest"), 'a duck’s nest');
  assert.equal(attr(undefined), '');
  const md = renderResult({ images: [img(1, 0.01)], requested: 1, complete: true, errors: [] }, 'draw "><img src=x onerror=alert(1)>');
  assert.equal(md.match(/<img /g).length, 1); // the prompt cannot add an element
});

test('a prompt or caption with blank lines stays on one line, so Vane does not end the HTML block', () => {
  const md = renderResult({ images: [img(1, 0.01, 'A fox.\n\nIn the snow.\n')], requested: 1, complete: true, errors: [] }, 'draw a fox\n\nin the snow\r\n');
  assert.match(md, /alt="Image 1 of 1: a fox in the snow"/);
  assert.match(md, /<span>A fox\. In the snow\.<\/span>/);
  assert.doesNotMatch(md.split('<figcaption')[0], /\n\s*\n/); // no blank line inside the tile
});

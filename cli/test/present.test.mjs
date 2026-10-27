import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderResult, altText, escapeHtml, modelLabel, formatDuration } from '../image/present.mjs';
import { explainFailure } from '../image/policy.mjs';

const URL = 'data:image/png;base64,AAAA';
const img = (n, price, text = null) => ({ dataUrl: URL, model: `lab/m${n}`, name: `Lab: Model ${n}`, pricePerImage: price, text });

test('grid, captions, summary line, escaped text', () => {
  const md = renderResult({ images: [img(1, 0.01), img(2, 0.02, '<b>hi</b>')], requested: 2, complete: true, errors: [], elapsedMs: 105000 }, 'draw a "fox" <script>');
  assert.match(md, /^<div style="display:grid;grid-template-columns:repeat\(2,1fr\)/);
  assert.equal(md.match(/<figure /g).length, 2);
  assert.match(md, /alt="Image 2 of 2: a &quot;fox&quot; &lt;script&gt; \(Model 2\)"/);
  assert.match(md, /&lt;b&gt;hi&lt;\/b&gt;/);
  assert.doesNotMatch(md, /<script>|<b>hi/);
  assert.match(md, /\n\n2 images · ~\$0\.030 · 1m 45s$/);
});

test('a URL that is not an image data URL never reaches the HTML', () => {
  const bad = [{ dataUrl: 'javascript:alert(1)', model: 'a/b' }, { dataUrl: 'data:image/png;base64,AA" onerror="x', model: 'a/c' }];
  const md = renderResult({ images: bad, requested: 2, complete: false, errors: ['a/b: 500 boom'] }, 'draw a fox');
  assert.doesNotMatch(md, /<img|onerror/);
  assert.match(md, /No images this time/);
});

test('an incomplete set says how many and why', () => {
  const md = renderResult({ images: [img(1, 0.01)], requested: 4, complete: false, errors: ['a: 503 upstream'], rewrittenPrompt: 'a <b>fox</b>' }, 'draw a fox');
  assert.match(md, /> Rewritten after a refusal: a &lt;b&gt;fox&lt;\/b&gt;/);
  assert.match(md, /> Made 1 of 4 images\. The image models were busy or unreachable\. Try again in a minute\./);
});

test('failures are explained in words, raw errors folded away', () => {
  const credits = renderResult({ images: [], errors: ['a: 402 Insufficient credits'], requested: 2 }, 'draw a fox');
  assert.match(credits, /^\*\*No images this time\.\*\* Your OpenRouter account is out of credits\. Add credits at https:\/\/openrouter\.ai\/credits/);
  assert.match(credits, /<details><summary>Details<\/summary><ul><li>a: 402 Insufficient credits<\/li>/);
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
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(formatDuration(12400), '12s');
  assert.equal(formatDuration(61000), '1m 1s');
});

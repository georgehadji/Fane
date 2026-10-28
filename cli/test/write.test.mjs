import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LANGUAGES, countTells, detectLanguage, findHomoglyphs, fold, greekTypography, repairFinalNu, repairHomoglyphs, wordCount } from '../write/language.mjs';
import { articleTopic, isArticleRequest, parseArticleOptions } from '../write/intent.mjs';
import { checkCitations, renumber, rhythm, runChecks, sentences, sourcesSection } from '../write/checks.mjs';
import { AUDIT_DIMENSIONS, auditResult, claimLedger, claimSupportRatio } from '../write/gate.mjs';
import { DEFAULT_WORDS, PHASES, chainsFor, clampWords, tokensFor } from '../write/models.mjs';
import { createRoleCaller, extractJson } from '../write/llm.mjs';
import { createArticlePipeline } from '../write/pipeline.mjs';
import { parseArticleAnswer } from '../write/edit.mjs';
import { prompts, sourceBlock } from '../write/prompts.mjs';
import { OpenRouterError } from '../image/openrouter.mjs';

for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { parseCli } = await import('../vane.mjs');

// ---- language ----

test('detectLanguage: Greek letters decide, a quoted Greek word in an English prompt does not', () => {
  assert.equal(detectLanguage('Γράψε ένα άρθρο για την ενέργεια'), 'el');
  assert.equal(detectLanguage('Γράψε ένα άρθρο για AI'), 'el');
  assert.equal(detectLanguage('write an article about the word "άρθρο"'), 'en');
  assert.equal(detectLanguage(''), 'en');
  assert.deepEqual(LANGUAGES, ['en', 'el']);
});

test('fold ignores accents, case and final sigma', () => {
  assert.equal(fold('Αναδεικνύοντας'), fold('αναδεικνυοντασ'));
  assert.equal(fold('ΚΑΘΟΡΙΣΤΙΚΌ'), 'καθοριστικο');
});

test('countTells finds Greek stock phrases whatever the accents or case', () => {
  const text = 'Η ενέργεια παίζει καθοριστικό ρόλο, αναδεικνύοντας τη σημασία της. Αξίζει να σημειωθεί ότι η μέθοδος είναι μοναδική. ΣΕ ΤΕΛΙΚΗ ΑΝΑΛΥΣΗ, το μέλλον προμηνύεται λαμπρό. Έρευνες δείχνουν πολλά.';
  const t = countTells(text, 'el');
  const labels = Object.fromEntries(t.hits.map(h => [h.label, h.count]));
  assert.ok(labels['significance'] >= 1 && labels['participle-tail'] === 1 && labels['filler'] >= 2 && labels['promotional'] === 1 && labels['generic-conclusion'] === 1 && labels['vague-attribution'] === 1, JSON.stringify(labels));
  assert.ok(t.perThousand > 100);
});

test('countTells: the noun-heavy Greek style and "διαδραματίζει ... ρόλο" count; the plain verb does not', () => {
  assert.equal(countTells('Η μονάδα διαδραματίζει καθοριστικό ρόλο. Σημειώθηκε αύξηση κατά 40%. Το έργο πραγματοποιήθηκε το 2016· αξιοποιώντας τις παλίρροιες. Μόνο ο χρόνος θα δείξει.', 'el').total, 5);
  assert.equal(countTells('Η παραγωγή αυξήθηκε κατά 40% το 2023. Το έργο έγινε το 2016.', 'el').total, 0);
});

test('repairFinalNu puts back the final ν of την, στην, μην where Greek keeps it, and nowhere else', () => {
  const r = repairFinalNu('Οι επιδράσεις στη ξηρά. Τη πόλη. Μη ανησυχείς. ΣΤΗ ΑΘΗΝΑ. Στη θάλασσα, τη Λέσβο, μη λες. Το παιδί, το κόστος.');
  assert.equal(r.text, 'Οι επιδράσεις στην ξηρά. Την πόλη. Μην ανησυχείς. ΣΤΗΝ ΑΘΗΝΑ. Στη θάλασσα, τη Λέσβο, μη λες. Το παιδί, το κόστος.');
  assert.deepEqual(r.fixed, ['στη ξηρά', 'Τη πόλη', 'Μη ανησυχείς', 'ΣΤΗ ΑΘΗΝΑ']);
  assert.equal(repairFinalNu('μητέρα στήθος τηλέφωνο').fixed.length, 0); // only the whole words
});

test('countTells: an article talking about its sources counts, in both languages; a cited fact does not', () => {
  const en = countTells('None of these sources show the two methods tested together. The source does not give a year. Costs fell by 40% [2].', 'en');
  assert.equal(en.hits.find(h => h.label === 'source-talk')?.count, 2);
  const el = countTells('Η πηγή δεν δίνει σαφές έτος. Ούτε προκύπτει από τις πηγές ότι ο στόχος είναι δεσμευτικός. Οι πηγές δεν συμφωνούν.', 'el');
  assert.equal(el.hits.find(h => h.label === 'source-talk')?.count, 3);
  assert.equal(countTells('Η παραγωγή αυξήθηκε κατά 40% το 2023 [1]. Οι πηγές ενέργειας του νησιού είναι δύο.', 'el').total, 0);
});

test('countTells: plain Greek and plain English have none; English stock phrases are found', () => {
  assert.equal(countTells('Το φως του ήλιου ζεσταίνει τη θάλασσα. Τα κύματα φτάνουν στην ακτή το απόγευμα.', 'el').total, 0);
  assert.equal(countTells('The tide comes in twice a day. Boats leave at six.', 'en').total, 0);
  const t = countTells('It is important to note that the vibrant tapestry of the region stands as a testament to its pivotal role, highlighting growth.', 'en');
  assert.ok(t.total >= 5, JSON.stringify(t));
});

test('a Greek word that merely contains "οντας" is not a tell unless it follows a comma', () => {
  assert.equal(countTells('Ο παίκτης έχασε τον χρόνο του κρατώντας την μπάλα.', 'el').hits.find(h => h.label === 'participle-tail'), undefined);
});

test('findHomoglyphs flags Greek words with Latin letters, not units or pure scripts', () => {
  assert.deepEqual(findHomoglyphs('Η eνέργεια της θάλασσας και το GPT-4 σε 5 μm'), ['eνέργεια']);
  assert.deepEqual(findHomoglyphs('Καθαρά ελληνικά και pure English'), []);
});

test('repairHomoglyphs fixes look-alike letters and leaves words it cannot map', () => {
  const r = repairHomoglyphs('Η eνέργεια και ο ιοs των δεδομένων');
  assert.equal(r.text.includes('eνέργεια'), false);
  assert.ok(r.text.startsWith('Η ενέργεια'));
  assert.deepEqual(r.fixed, ['eνέργεια']); // "ιοs": s has no look-alike mapping, so it stays and is still reported
  assert.deepEqual(findHomoglyphs(r.text), ['ιοs']);
});

test('greekTypography reports straight quotes, a "?" and polytonic accents', () => {
  const t = greekTypography('Είπε "καλημέρα" σε όλους. Τι κάνεις? Ἀθῆναι');
  assert.deepEqual(t.map(x => x.name.split(' ')[0]), ['straight', '"?"', 'polytonic']);
  assert.deepEqual(greekTypography('Είπε «καλημέρα». Τι κάνεις;'), []);
});

// ---- intent ----

test('isArticleRequest: English and Greek requests, with a writing verb', () => {
  for (const q of ['write an article about tidal power', 'Please draft a 800-word blog post on AI', 'Can you write me an essay on why sleep matters', 'write a short, well researched report about bees',
    'γράψε ένα άρθρο για την τεχνητή νοημοσύνη', 'Γράψε μου ένα εκτενές άρθρο σχετικά με την ενέργεια', 'συντάξτε μια έκθεση για το διάστημα', 'Δημιούργησε μια ανάρτηση για το blog μου', 'ΓΡΆΨΕ ΈΝΑ ΔΟΚΊΜΙΟ για τη μνήμη']) {
    assert.equal(isArticleRequest(q), true, q);
  }
});

test('isArticleRequest: questions, searches and other writing stay searches', () => {
  for (const q of ['article about space', 'what is the weather', 'write a poem about tea', 'write a function that sorts', 'γράψε ένα κείμενο', 'τι είναι ένα άρθρο;', 'εξήγησε την κβαντική μηχανική', 'is this article about AI accurate?']) {
    assert.equal(isArticleRequest(q), false, q);
  }
});

test('articleTopic strips the request words and keeps the original spelling', () => {
  assert.equal(articleTopic('write an article about tidal power'), 'tidal power');
  assert.equal(articleTopic('Please draft a 800-word blog post on AI'), 'AI');
  assert.equal(articleTopic('Γράψε μου ένα εκτενές άρθρο σχετικά με την ενέργεια'), 'την ενέργεια');
  assert.equal(articleTopic('γράψε ένα άρθρο για την Τεχνητή Νοημοσύνη'), 'την Τεχνητή Νοημοσύνη');
  assert.equal(articleTopic('tidal power in Greece'), 'tidal power in Greece');
});

test('parseArticleOptions reads a length in either language', () => {
  assert.deepEqual(parseArticleOptions('write a 1200-word article on bees'), { words: 1200 });
  assert.deepEqual(parseArticleOptions('άρθρο 800 λέξεων για τις μέλισσες'), { words: 800 });
  assert.deepEqual(parseArticleOptions('write about 2023 trends'), {});
});

// ---- checks ----

const SOURCES = [
  { title: 'Tidal energy in Orkney', url: 'https://example.org/a', content: 'The Orkney site supplied 1,200 homes and produced 2 TWh in 2023.' },
  { title: 'Costs of marine power', url: 'https://example.org/b', content: 'Costs fell by 40% between 2015 and 2023.' },
  { title: 'Wind versus tide', url: 'https://example.org/c', content: 'Tides are predictable; wind is not. Onshore wind costs less per kilowatt hour.' },
  { title: 'Seabed noise', url: 'https://example.org/d', content: 'Noise from turbines is low.' },
  { title: 'Grid links', url: 'https://example.org/e', content: 'New cables reach the isles.' },
];

test('checkCitations: valid and invalid numbers, uncited sentences, numbers missing from the cited source', () => {
  const c = checkCitations('Tidal arrays supplied 1,200 homes last winter [1]. Costs fell by 55% in two years [2]. The sea looks calm and the boats come home at night. A ninth source says this [9, 2].', SOURCES);
  assert.deepEqual(c.invalid, [9]);
  assert.deepEqual(c.used, [1, 2]);
  assert.equal(c.cited, 3);
  assert.equal(c.uncited, 1);
  assert.deepEqual(c.numbersMissing.map(m => m.numbers), [['55']]); // 1,200 is in source 1; 40% is not 55%
});

test('checkCitations compares numbers across languages: Greek 1.200 and 3,5 equal English 1,200 and 3.5', () => {
  const src = [{ title: 't', url: 'https://x.org', content: 'Supplied 1,200 homes and 3.5 percent more.' }];
  assert.deepEqual(checkCitations('Παρείχε ρεύμα σε 1.200 σπίτια και κατά 3,5 τοις εκατό περισσότερα [1].', src).numbersMissing, []);
});

test('renumber numbers cited sources by first appearance and drops numbers that name no source', () => {
  const r = renumber('A claim [3]. Another [1, 3]. A bad one [9]. Then [4,1] stays.', SOURCES);
  assert.equal(r.text, 'A claim [1]. Another [1, 2]. A bad one. Then [2, 3] stays.');
  assert.deepEqual(r.used.map(s => s.url), ['https://example.org/c', 'https://example.org/a', 'https://example.org/d']);
});

test('renumber and checkCitations read ranges like [2–3]', () => {
  const r = renumber('Built in 2023 [2–3]. Costs fell [3]. Both [1-2].', SOURCES);
  assert.equal(r.text, 'Built in 2023 [1, 2]. Costs fell [2]. Both [1, 3].');
  assert.deepEqual(r.used.map(s => s.url), ['https://example.org/b', 'https://example.org/c', 'https://example.org/a']);
  assert.deepEqual(checkCitations('The isles had five arrays by then [2–4].', SOURCES).used, [2, 3, 4]);
});

test('checkCitations does not flag numbers when the cited source has no text (an article read back for an edit)', () => {
  const bare = SOURCES.map(s => ({ ...s, content: '' }));
  assert.deepEqual(checkCitations('Tidal arrays supplied 1,200 homes in 2023 [1].', bare).numbersMissing, []);
});

test('sourcesSection is written from real sources, in the article language', () => {
  assert.match(sourcesSection(SOURCES.slice(0, 2), 'en'), /## Sources\n\n1\. \[Tidal energy in Orkney\]\(https:\/\/example\.org\/a\)\n2\./);
  assert.match(sourcesSection(SOURCES.slice(0, 1), 'el'), /## Πηγές/);
  assert.equal(sourcesSection([], 'en'), '');
  assert.match(sourcesSection([{ title: 'a [b]\nc', url: 'https://x.org' }], 'en'), /\[a b c\]/);
  const junk = sourcesSection([{ title: 'sample', url: 'https://www.aspete.gr/a.pdf' }, { title: 'Microsoft Word - fulltext096113.docx', url: 'https://jestr.org/f.pdf' }, { title: '', url: 'not a url' }], 'en');
  assert.match(junk, /1\. \[aspete\.gr\]\(https:\/\/www\.aspete\.gr\/a\.pdf\)\n2\. \[jestr\.org\]/);
  assert.match(junk, /3\. not a url\n/); // not a web link: named, not linked
  const odd = sourcesSection([{ title: 'Tides', url: 'https://x.org/a b/(c)' }, { title: 'Jabber', url: 'javascript:alert(1)' }], 'en');
  assert.match(odd, /1\. \[Tides\]\(https:\/\/x\.org\/a%20b\/%28c%29\)/);
  assert.match(odd, /2\. Jabber\n/); // not a web link: named, never linked
});

test('sentences skips headings and fragments; rhythm needs enough sentences', () => {
  assert.deepEqual(sentences('# Title\n\nShort one. This sentence has enough words to count here.'), ['This sentence has enough words to count here.']);
  assert.equal(rhythm('One two three four five six. ').cv, null);
});

const prose = (words, { cite = true } = {}) => {
  const lines = ['Tidal turbines in Orkney supplied about 1,200 homes last winter', 'The first arrays were small, noisy and expensive to maintain far out at sea', 'Costs fell by 40% once the designs settled and the crews learned the work', 'Critics point to the price per kilowatt hour, which still sits above wind on land', 'Engineers answer that a tide arrives on schedule, twice a day, for decades to come'];
  const out = [];
  for (let i = 0; wordCount(out.join(' ')) < words; i++) out.push(`${lines[i % lines.length]}${cite ? ` [${(i % 3) + 1}]` : ''}.`);
  return out.join(' ');
};
const article = (words = 300, extra = '') => `# Tides at work\n\n## The case\n\n${prose(words)}${extra}`;

test('runChecks: a clean article passes; a model that printed its thinking, or a wrong length, fails', () => {
  const ok = runChecks(article(300), { sources: SOURCES, targetWords: 300 });
  assert.equal(ok.ok, true, JSON.stringify(ok.items));
  const leak = runChecks(`Thinking Process:\n1. Analyze the request\n${article(300)}`, { sources: SOURCES, targetWords: 300 });
  assert.equal(leak.ok, false);
  assert.ok(leak.items.some(i => i.name === 'thinking-leak' && i.level === 'fail'));
  assert.equal(runChecks(article(300), { sources: SOURCES, targetWords: 1200 }).ok, false); // far too short
  assert.equal(runChecks(`${article(300)} Late claim [8].`, { sources: SOURCES, targetWords: 300 }).ok, false); // source 8 does not exist
  assert.equal(runChecks(article(300).replace(/ \[\d\]/g, ''), { sources: SOURCES, targetWords: 300 }).ok, false); // sources given, none cited
});

test('runChecks on Greek: Latin letters in a Greek word fail, typography only warns', () => {
  const el = `# Τίτλος\n\n${'Η παλιρροϊκή ενέργεια τροφοδοτεί σπίτια στις Ορκάδες [1]. '.repeat(40)}`;
  assert.equal(runChecks(el, { lang: 'el', sources: SOURCES, targetWords: 300 }).ok, true);
  const bad = runChecks(`${el} Η eνέργεια "αλλάζει"; Τι κάνεις?`, { lang: 'el', sources: SOURCES, targetWords: 300 });
  assert.equal(bad.ok, false);
  assert.equal(bad.items.find(i => i.name === 'greek-typography').level, 'warn');
});

// ---- gate, models, prompts ----

test('auditResult applies the floors and the weighted mean', () => {
  const good = Object.fromEntries(AUDIT_DIMENSIONS.map(d => [d, 0.9]));
  assert.equal(auditResult(good).passes, true);
  const low = auditResult({ ...good, claim_support: 0.4 });
  assert.equal(low.passes, false);
  assert.match(low.failures[0], /claim_support 0\.40 < 0\.6/);
  assert.equal(auditResult({}).passes, false); // missing scores count as 0
  assert.equal(auditResult({ ...good, claim_support: 7 }).passes, false); // out of range is not a score
});

test('claimLedger keeps valid claims; the support ratio counts only "supported"', () => {
  const ledger = claimLedger({ claims: [{ claim: 'a', source: 1, verdict: 'supported' }, { claim: 'b', source: 2, verdict: 'partial' }, { claim: 'c', verdict: 'unsupported' }, { claim: 'd', verdict: 'maybe' }, null] });
  assert.equal(ledger.length, 3);
  assert.equal(claimSupportRatio(ledger), 0.333);
  assert.equal(claimSupportRatio([]), null);
});

test('phases per mode: Speed 2 model calls, Balanced 6, Quality 8 (sources are free; queries only for non-English)', () => {
  const calls = (mode) => PHASES[mode].filter(r => r !== 'queries').length;
  assert.deepEqual([calls('speed'), calls('balanced'), calls('quality')], [2, 6, 8]);
  assert.ok(PHASES.balanced.includes('polish') && !PHASES.balanced.includes('style'));
  assert.ok(PHASES.quality.includes('style') && PHASES.quality.includes('copy') && PHASES.quality.includes('audit'));
});

test('token budgets: Greek needs more than English, nothing falls back to a 2048 default', () => {
  assert.ok(tokensFor('draft', 900, 'el') - tokensFor('draft', 900, 'en') > 900 * 2); // the answer part, on top of the same thinking headroom
  assert.ok(tokensFor('outline', 900, 'el') >= 7000); // the first live run: an outline cut off at 3880 tokens by three models
  for (const role of ['queries', 'outline', 'draft', 'factcheck', 'critique', 'revise', 'polish', 'style', 'copy', 'audit']) assert.ok(tokensFor(role, 900, 'en') >= 1400, role);
  assert.equal(clampWords(10), 300);
  assert.equal(clampWords(99999), 2500);
  assert.equal(clampWords(undefined), DEFAULT_WORDS);
});

test('chainsFor gives every role the same ordered chain', () => {
  const c = chainsFor(['a/x', 'b/y']);
  assert.deepEqual(c.draft, ['a/x', 'b/y']);
  assert.deepEqual(Object.keys(c).sort(), Object.keys(chainsFor()).sort());
  assert.equal(chainsFor([]).draft.length, 1);
});

test('prompts: sources are marked untrusted, the draft carries the language rules, Greek rules are in Greek', () => {
  const en = prompts.draft({ topic: 'tides', lang: 'en', words: 900, sources: SOURCES, outline: null });
  assert.match(en.system, /untrusted data/);
  assert.match(en.system, /Write in English/);
  assert.match(en.system, /testament/);
  const el = prompts.draft({ topic: 'παλίρροια', lang: 'el', words: 900, sources: SOURCES, outline: null });
  assert.match(el.system, /Modern Greek/);
  assert.match(el.system, /αναδεικνύοντας/);
  assert.match(el.system, /« »/);
  assert.match(sourceBlock(SOURCES), /\[1\] Tidal energy in Orkney \(https:\/\/example\.org\/a\)/);
  assert.match(prompts.outline({ topic: 't', lang: 'en', words: 900, sources: SOURCES }).system, /one JSON object/);
});

// ---- llm: one role call ----

const reply = (content, extra = {}) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { cost: 0.001 }, ...extra });
const stub = (script) => ({ chat: async (body) => { const out = script.shift(); if (out instanceof Error) throw out; return typeof out === 'function' ? out(body) : out; } });

test('extractJson reads fenced and surrounded JSON, and refuses the rest', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":1} Done.'), { a: 1 });
  assert.equal(extractJson('no json'), null);
  assert.equal(extractJson('{broken'), null);
});

test('role call: a cut-off, an empty answer and leaked reasoning each move on to the next model', async () => {
  const client = stub([
    reply('half an arti', { choices: [{ message: { content: 'half an arti' }, finish_reason: 'length' }] }),
    reply(''),
    reply('Thinking Process:\n1. Analyze the request'),
    reply('A good answer.'),
  ]);
  const r = await createRoleCaller({ client })('draft', { system: 's', user: 'u' }, { chain: ['m1', 'm2', 'm3', 'm4'], maxTokens: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'm4');
  assert.equal(r.fallback, true);
  assert.deepEqual(r.attempts.map(a => a.problem), ['cut off at 100 tokens', 'empty answer', 'reasoning in place of an answer', null]);
  assert.ok(Math.abs(r.cost - 0.004) < 1e-9);
});

test('role call: after a network failure the next model waits, longer each time; an HTTP error does not wait', async () => {
  const net = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const waits = [];
  const r = await createRoleCaller({ client: stub([net(), net(), reply('An answer.')]), sleep: async (ms) => { waits.push(ms); } })('draft', { system: 's', user: 'u' }, { chain: ['m1', 'm2', 'm3'], maxTokens: 100 });
  assert.equal(r.model, 'm3');
  assert.deepEqual(waits, [10_000, 20_000]);
  assert.match(r.attempts[0].problem, /fetch failed \(ECONNRESET\)/);
  const none = [];
  await createRoleCaller({ client: stub([new OpenRouterError('503 busy', 503), reply('ok')]), sleep: async (ms) => { none.push(ms); } })('draft', { system: 's', user: 'u' }, { chain: ['m1', 'm2'], maxTokens: 100 });
  assert.deepEqual(none, []);
});

test('role call: a 429 waits before the next model, longer each time', async () => {
  const waits = [];
  const r = await createRoleCaller({ client: stub([new OpenRouterError('429 slow down', 429), new OpenRouterError('429 slow down', 429), reply('An answer.')]), sleep: async (ms) => { waits.push(ms); } })('draft', { system: 's', user: 'u' }, { chain: ['m1', 'm2', 'm3'], maxTokens: 100 });
  assert.equal(r.model, 'm3');
  assert.deepEqual(waits, [10_000, 20_000]);
  assert.match(r.attempts[0].problem, /429/);
});

test('role call: a model that reports no cost is priced from its token counts', async () => {
  const r = await createRoleCaller({ client: stub([reply('An answer.', { usage: { prompt_tokens: 2000, completion_tokens: 1000 } })]) })('draft', { system: 's', user: 'u' }, { chain: ['m'], maxTokens: 100, prices: { m: { in: 0.15, out: 0.6 } } });
  assert.ok(Math.abs(r.cost - 0.0009) < 1e-12);
  const reported = await createRoleCaller({ client: stub([reply('An answer.', { usage: { cost: 0.002, prompt_tokens: 2000, completion_tokens: 1000 } })]) })('draft', { system: 's', user: 'u' }, { chain: ['m'], maxTokens: 100, prices: { m: { in: 0.15, out: 0.6 } } });
  assert.equal(reported.cost, 0.002); // the provider's own figure wins
});

test('role call: <think> blocks are removed from a good answer', async () => {
  const r = await createRoleCaller({ client: stub([reply('<think>hmm</think>The answer.')]) })('draft', { system: 's', user: 'u' }, { chain: ['m'], maxTokens: 100 });
  assert.equal(r.text, 'The answer.');
});

test('role call: JSON roles must return JSON; response_format is dropped when the model refuses it', async () => {
  const seen = [];
  const client = { chat: async (body) => { seen.push(body); if (body.response_format) throw new OpenRouterError('400 response_format is not supported', 400); return reply('{"claims": []}'); } };
  const r = await createRoleCaller({ client })('factcheck', { system: 's', user: 'u' }, { chain: ['m'], maxTokens: 100 });
  assert.deepEqual(r.data, { claims: [] });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].response_format, undefined);
  assert.deepEqual(seen[0].reasoning, { effort: 'low' }); // thinking models must not spend the whole budget thinking
  const bad = await createRoleCaller({ client: stub([reply('not json at all')]) })('critique', { system: 's', user: 'u' }, { chain: ['m'], maxTokens: 100 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /not JSON/);
});

test('role call: 401 and 402 stop the chain at once, other errors move on', async () => {
  const fatal = await createRoleCaller({ client: stub([new OpenRouterError('402 no credits', 402)]) })('draft', { system: 's', user: 'u' }, { chain: ['m1', 'm2'], maxTokens: 100 });
  assert.equal(fatal.fatal, true);
  assert.equal(fatal.attempts.length, 1);
  const moved = await createRoleCaller({ client: stub([new OpenRouterError('503 busy', 503), reply('ok text')]) })('draft', { system: 's', user: 'u' }, { chain: ['m1', 'm2'], maxTokens: 100 });
  assert.equal(moved.ok, true);
  assert.equal(moved.model, 'm2');
});

// ---- pipeline, with a fake client ----

const ROLE_OF = [
  ['web search queries', 'queries'], ['planning a researched article', 'outline'], ['senior journalist', 'draft'], ['adversarial fact-checker', 'factcheck'],
  ["devil's advocate", 'critique'], ['developmental editor', 'revise'], ['style and copy editor', 'polish'], ['You are a style editor', 'style'],
  ['You are a copy editor', 'copy'], ['final editorial auditor', 'audit'], ['revising a finished article', 'rewrite'],
];
const roleOf = (body) => ROLE_OF.find(([needle]) => body.messages[0].content.includes(needle))?.[1];

const OUTLINE = { title: 'Tides at work', central_question: 'q', thesis: 't', sections: [{ heading: 'The case', points: ['p'], sources: [1], words: 300 }], counterarguments: ['c'], ending: 'e' };
const GOOD_AUDIT = { scores: Object.fromEntries(AUDIT_DIMENSIONS.map(d => [d, 0.9])), issues: [] };
const BAD_AUDIT = { scores: Object.fromEntries(AUDIT_DIMENSIONS.map(d => [d, 0.3])), issues: [{ section: 'The case', severity: 'high', description: 'weak', fix: 'strengthen' }] };

// handlers: role -> content | (n, body) => content | Error. Unlisted roles answer with a sensible default.
function fake(handlers = {}) {
  const calls = [];
  const defaults = {
    queries: JSON.stringify({ queries: ['tidal power', 'marine energy costs', 'παλιρροϊκή ενέργεια'] }),
    outline: JSON.stringify(OUTLINE),
    draft: article(320),
    factcheck: JSON.stringify({ claims: [{ claim: 'a', source: 1, verdict: 'supported' }, { claim: 'b', source: 2, verdict: 'supported' }] }),
    critique: JSON.stringify({ assumptions: [], ignored_counterarguments: [], gaps: [{ text: 'g', severity: 'low' }], speculative: [], rigor: 0.8 }),
    revise: article(330), polish: article(330), style: article(330), copy: article(330),
    audit: JSON.stringify(GOOD_AUDIT),
  };
  return {
    calls,
    chat: async (body) => {
      const role = roleOf(body);
      calls.push({ role, model: body.model, body });
      const n = calls.filter(c => c.role === role).length;
      const h = role in handlers ? handlers[role] : defaults[role];
      const out = typeof h === 'function' ? h(n, body) : h;
      if (out instanceof Error) throw out;
      if (out && typeof out === 'object' && out.choices) return out;
      return reply(out);
    },
  };
}

const run = (client, opts = {}, retrieve) => {
  const queries = [];
  const pipeline = createArticlePipeline({ client, retrieve: retrieve || (async (q) => { queries.push(q); return SOURCES; }) });
  return pipeline({ topic: 'tidal power', words: 300, ...opts }).then(r => Object.assign(r, { queries }));
};

test('Speed: outline and draft only; sources list written by code; cited sources numbered from 1', async () => {
  const c = fake();
  const r = await run(c, { mode: 'speed' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(c.calls.map(x => x.role), ['outline', 'draft']);
  assert.equal(r.calls, 2);
  assert.deepEqual(r.queries, ['tidal power']); // English topic: one query, no query-writing call
  assert.match(r.article, /^# Tides at work/);
  assert.match(r.article, /## Sources\n\n1\. \[Tidal energy in Orkney\]\(https:\/\/example\.org\/a\)\n2\. \[Costs of marine power\]/);
  assert.equal(r.sources.length, 3); // the draft cites [1], [2], [3]
  assert.equal(r.title, 'Tides at work');
  assert.equal(r.checks.ok, true);
  assert.deepEqual(r.degraded, []);
  assert.ok(r.cost > 0 && r.ms >= 0);
});

test('Balanced: fact-check, critique, revision and one polish call', async () => {
  const c = fake();
  const r = await run(c, { mode: 'balanced' });
  assert.deepEqual(c.calls.map(x => x.role), ['outline', 'draft', 'factcheck', 'critique', 'revise', 'polish']);
  assert.equal(r.claimSupport, 1);
  assert.equal(r.ledger.length, 2);
  assert.equal(r.audit, null);
});

test('the fact-check and the critique run at the same time, and both reach the revision', async () => {
  const base = fake();
  let inflight = 0, most = 0;
  const client = {
    chat: async (body) => {
      const slow = ['factcheck', 'critique'].includes(roleOf(body));
      if (slow) { most = Math.max(most, ++inflight); await new Promise(r => setTimeout(r, 20)); inflight--; }
      return base.chat(body);
    },
  };
  const r = await run(client, { mode: 'quality' });
  assert.equal(r.ok, true, r.error);
  assert.equal(most, 2);
  assert.ok(r.phases.some(p => p.phase === 'factcheck' && p.status === 'ok') && r.phases.some(p => p.phase === 'critique' && p.status === 'ok'));
  const revise = base.calls.find(x => x.role === 'revise').body.messages[1].content;
  assert.match(revise, /"rigor":0\.8/); // the critique
});

test("today's date reaches the outline, draft, critique and revision prompts", async () => {
  const c = fake();
  const t = Date.UTC(2026, 9, 28, 12);
  await createArticlePipeline({ client: c, retrieve: async () => SOURCES, now: () => t })({ topic: 'tidal power', words: 300, mode: 'quality' });
  for (const role of ['outline', 'draft', 'critique', 'revise']) assert.match(c.calls.find(x => x.role === role).body.messages[1].content, /Today is 2026-10-28\./, role);
  assert.doesNotMatch(c.calls.find(x => x.role === 'copy').body.messages[1].content, /Today is/);
});

test('every writing prompt forbids talking about the sources, in both languages', () => {
  for (const lang of ['en', 'el']) {
    const { system } = prompts.draft({ topic: 't', lang, words: 300, sources: SOURCES });
    assert.match(system, lang === 'en' ? /never about the sources/ : /ποτέ για τις πηγές/, lang);
  }
});

test('Quality: separate style and copy edit and a final audit', async () => {
  const c = fake();
  const r = await run(c, { mode: 'quality' });
  assert.deepEqual(c.calls.map(x => x.role), ['outline', 'draft', 'factcheck', 'critique', 'revise', 'style', 'copy', 'audit']);
  assert.equal(r.audit.passes, true);
  assert.equal(r.audit.retried, undefined);
});

test('Quality: a failed audit gets exactly one retry (revise, style, copy, audit), and a second failure is reported', async () => {
  const c = fake({ audit: () => JSON.stringify(BAD_AUDIT) });
  const r = await run(c, { mode: 'quality' });
  assert.equal(c.calls.length, 12);
  assert.deepEqual(c.calls.slice(8).map(x => x.role), ['revise', 'style', 'copy', 'audit']);
  assert.equal(r.ok, true);
  assert.equal(r.audit.passes, false);
  assert.ok(r.degraded.some(d => /failed twice/.test(d)));
  const c2 = fake({ audit: (n) => JSON.stringify(n === 1 ? BAD_AUDIT : GOOD_AUDIT) });
  const r2 = await run(c2, { mode: 'quality' });
  assert.equal(r2.audit.passes, true);
  assert.equal(r2.audit.retried, true);
  assert.equal(r2.degraded.length, 0);
  assert.match(c2.calls[8].body.messages[1].content, /strengthen/); // the retry revision sees the audit issues
});

test('a draft far over the target is cut back by one extra call, and the report shows the words per phase', async () => {
  const c = fake({ draft: article(500), rewrite: article(310) });
  const r = await run(c, { mode: 'speed' });
  assert.deepEqual(c.calls.map(x => x.role), ['outline', 'draft', 'rewrite']);
  assert.match(c.calls[2].body.messages[1].content, /Cut it to about 300 words/);
  assert.deepEqual(r.phases.filter(p => p.words).map(p => [p.phase, p.words]), [['draft', wordCount(article(500))], ['rewrite', wordCount(article(310))]]);
  assert.ok(r.words < 350 && r.degraded.length === 0);
});

test('a trim that lands over the cap gets one more pass, and no more than that', async () => {
  const c = fake({ draft: article(500), rewrite: (n) => article(n === 1 ? 420 : 300) });
  const r = await run(c, { mode: 'speed' });
  assert.deepEqual(c.calls.map(x => x.role), ['outline', 'draft', 'rewrite', 'rewrite']);
  assert.match(c.calls[3].body.messages[1].content, new RegExp(`it is ${wordCount(article(420))} words, so remove about ${wordCount(article(420)) - 300}`));
  assert.ok(r.words <= 330 && r.degraded.length === 0);
  const stuck = fake({ draft: article(500), rewrite: (n) => article(460 - n * 40) });
  await run(stuck, { mode: 'speed' });
  assert.equal(stuck.calls.filter(x => x.role === 'rewrite').length, 2);
});

test('an edit that grows the text past the target is cut back; a draft within a quarter of the target is not touched', async () => {
  const c = fake({ revise: article(480), rewrite: article(300) });
  const r = await run(c, { mode: 'balanced' });
  assert.deepEqual(c.calls.map(x => x.role), ['outline', 'draft', 'factcheck', 'critique', 'revise', 'rewrite', 'polish']);
  assert.ok(r.words < 350);
  const near = await run(fake({ draft: article(370) }), { mode: 'speed' }); // 370 words for 300: within 25%
  assert.equal(near.calls, 2);
});

test('a trim that is not shorter, loses the title or fails keeps the longer text and says so', async () => {
  for (const rewrite of [article(500), 'Short text without a title or any sources at all, nothing like an article.', new OpenRouterError('400 bad', 400)]) {
    const r = await run(fake({ draft: article(500), rewrite }), { mode: 'speed' });
    assert.equal(r.ok, true);
    assert.ok(r.degraded.some(d => /trimming from \d+ words to the target of 300 failed/.test(d)), JSON.stringify(r.degraded));
    assert.ok(r.words > 450);
  }
});

test('every editing prompt carries the length target', () => {
  const ctx = { lang: 'en', article: article(400), sources: SOURCES, words: 500, critique: {}, ledger: [] };
  for (const role of ['revise', 'polish', 'style', 'copy']) assert.match(prompts[role](ctx).user, /the article is \d+ words and the target is about 500\. Do not make it longer than 550 words/, role);
});

test('the models of a chain are tried in order and a fallback is recorded', async () => {
  const c = fake({ draft: (n) => (n === 1 ? new OpenRouterError('503 busy', 503) : article(320)) });
  const r = await run(c, { mode: 'speed', models: ['m/one', 'm/two'] });
  assert.equal(r.ok, true);
  const d = r.phases.find(p => p.phase === 'draft');
  assert.equal(d.model, 'm/two');
  assert.equal(d.status, 'fallback');
  assert.match(d.note, /m\/one/);
});

test('a draft that no model can write fails the run with the reasons; a 402 stops everything', async () => {
  const r = await run(fake({ draft: new OpenRouterError('503 busy', 503) }), { mode: 'speed' });
  assert.equal(r.ok, false);
  assert.match(r.error, /the draft failed/);
  const f = await run(fake({ outline: new OpenRouterError('402 insufficient credits', 402) }), { mode: 'speed' });
  assert.equal(f.ok, false);
  assert.equal(f.fatal, true);
  assert.match(f.error, /insufficient credits/);
});

test('no sources means no article; one failing search does not', async () => {
  const none = await run(fake(), { mode: 'speed' }, async () => []);
  assert.equal(none.ok, false);
  assert.match(none.error, /no sources/);
  let n = 0;
  const some = await run(fake(), { mode: 'speed', lang: 'el', topic: 'tides' }, async () => { if (n++ === 0) throw new Error('search down'); return SOURCES; });
  assert.equal(some.ok, true);
});

test('few sources are reported as thin; sources are deduplicated and capped', async () => {
  const thin = await run(fake(), { mode: 'speed' }, async () => SOURCES.slice(0, 2));
  assert.ok(thin.degraded.some(d => /only 2 sources/.test(d)));
  const many = Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, url: `https://example.org/${i % 25}`, content: 'x' }));
  const c = fake();
  await run(c, { mode: 'speed' }, async () => many);
  assert.equal((c.calls[1].body.messages[1].content.match(/^\[\d+\] /gm) || []).length, 16);
});

test('a failed outline, critique or fact-check is skipped and listed, never hidden', async () => {
  const r = await run(fake({ outline: 'not json', critique: 'not json', factcheck: new OpenRouterError('500 x', 500) }), { mode: 'balanced' });
  assert.equal(r.ok, true);
  assert.ok(r.degraded.some(d => /outline failed/.test(d)));
  assert.ok(r.degraded.some(d => /critique failed/.test(d)));
  assert.ok(r.degraded.some(d => /fact-check failed/.test(d)));
  assert.equal(r.phases.find(p => p.phase === 'outline').status, 'failed');
});

test('an edit that returns a fraction of the article is rejected and the previous text kept', async () => {
  const r = await run(fake({ revise: '# Tides at work\n\nToo short.', polish: article(330) }), { mode: 'balanced' });
  assert.equal(r.phases.find(p => p.phase === 'revise').status, 'rejected');
  assert.ok(r.degraded.some(d => /revise was rejected \(much shorter/.test(d)));
  assert.ok(r.words >= 300);
  const stripped = await run(fake({ polish: article(330).replace(/ \[\d\]/g, '') }), { mode: 'balanced' });
  assert.ok(stripped.degraded.some(d => /polish was rejected \(dropped most citations/.test(d)));
});

test('thin evidence is reported: fewer than half of the checked claims supported', async () => {
  const claims = [{ claim: 'a', source: 1, verdict: 'unsupported' }, { claim: 'b', source: 2, verdict: 'partial' }, { claim: 'c', source: 2, verdict: 'supported' }];
  const r = await run(fake({ factcheck: JSON.stringify({ claims }) }), { mode: 'balanced' });
  assert.ok(r.degraded.some(d => /thinly sourced: only 33%/.test(d)));
});

test('failed claims go to the revision, and stock phrases found by the check go to the polish', async () => {
  const claims = [{ claim: 'the invented figure', source: 1, verdict: 'unsupported', note: 'not in source' }, { claim: 'fine', source: 2, verdict: 'supported' }];
  const tells = ' It is important to note that this stands as a testament to the vibrant region [1].';
  const c = fake({ factcheck: JSON.stringify({ claims }), draft: article(300, tells), revise: article(310, tells) });
  await run(c, { mode: 'balanced' });
  const revise = c.calls.find(x => x.role === 'revise').body.messages[1].content;
  assert.match(revise, /the invented figure/);
  assert.doesNotMatch(revise, /"claim":"fine"/);
  assert.match(c.calls.find(x => x.role === 'polish').body.messages[1].content, /stock phrases to remove: .*significance/);
});

test('a citation to a source that does not exist is removed and reported', async () => {
  const r = await run(fake({ draft: article(300, ' A claim from nowhere [9].') }), { mode: 'speed' });
  assert.ok(r.degraded.some(d => /removed citations to sources that do not exist: \[9\]/.test(d)));
  assert.doesNotMatch(r.article, /\[9\]/);
  assert.equal(r.checks.ok, true);
});

test('a draft that cites nothing fails the citation check instead of passing clean', async () => {
  const r = await run(fake({ draft: `# Tides at work\n\n## The case\n\n${prose(300, { cite: false })}` }), { mode: 'speed' });
  assert.equal(r.ok, true);
  assert.equal(r.checks.ok, false);
  assert.ok(r.degraded.some(d => /check "citations" failed: no citations/.test(d)), r.degraded.join(' | '));
});

test('Greek: English search queries are written, Latin look-alikes are repaired, the sources list is headed Πηγές', async () => {
  const el = `# Η παλίρροια εργάζεται\n\n${'Η παλιρροϊκή ενέργεια τροφοδοτεί σπίτια στις Ορκάδες και η eνέργεια της θάλασσας μένει σταθερή [1]. Το κόστος έπεσε μετά από χρόνια δοκιμών στο νησί [2]. '.repeat(12)}`;
  const c = fake({ draft: el });
  const r = await run(c, { mode: 'speed', topic: 'η παλιρροϊκή ενέργεια' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.language, 'el');
  assert.deepEqual(c.calls.map(x => x.role), ['queries', 'outline', 'draft']);
  assert.deepEqual(r.queries, ['η παλιρροϊκή ενέργεια', 'tidal power']); // the topic and one English query: each is a full Vane research
  assert.equal(r.repaired, 1);
  assert.doesNotMatch(r.article, /eνέργεια/);
  assert.match(r.article, /## Πηγές/);
  assert.match(c.calls[2].body.messages[0].content, /Modern Greek/);
  assert.ok(c.calls[2].body.max_tokens > tokensFor('draft', 300, 'en')); // Greek budget, not an English one
});

test('progress events report each phase and a throwing listener is ignored', async () => {
  const events = [];
  const pipeline = createArticlePipeline({ client: fake(), retrieve: async () => SOURCES });
  const r = await pipeline({ topic: 'tides', words: 300, mode: 'speed', onProgress: (e) => { events.push(`${e.phase}:${e.status}`); throw new Error('listener'); } });
  assert.equal(r.ok, true);
  assert.deepEqual(events, ['sources:running', 'sources:done', 'outline:running', 'outline:ok', 'draft:running', 'draft:ok', 'draft:preview', 'done:done']);
});

test('an unknown mode is a programming error', async () => {
  await assert.rejects(createArticlePipeline({ client: fake(), retrieve: async () => SOURCES })({ topic: 't', mode: 'turbo' }), /unknown mode/);
});

// ---- CLI ----

test('parseCli: article options are validated', () => {
  const o = parseCli(['--article', 'tides', '--lang', 'el', '--words', '1200', '--article-model', 'a/x,b/y', '--out', 'a.md', '--tier', 'premium']);
  assert.deepEqual([o.article, o.lang, o.words, o['article-model'], o.out, o.tier], [true, 'el', 1200, ['a/x', 'b/y'], 'a.md', 'premium']);
  assert.throws(() => parseCli(['--article', 'x', '--lang', 'fr']), /Invalid --lang/);
  assert.throws(() => parseCli(['--article', 'x', '--words', '50']), /Invalid --words/);
  assert.throws(() => parseCli(['--article', 'x', '--tier', 'gold']), /Invalid --tier/);
  assert.throws(() => parseCli(['--article', 'x', '--stream']), /--stream does not apply/);
  assert.equal(parseCli(['write an article about tides']).article, false); // routing happens in main(), by isArticleRequest
  const e = parseCli(['--edit-article', 'a.md', 'make it shorter', '--article-model', 'a/x,b/y']);
  assert.deepEqual([e['edit-article'], e.query, e['article-model']], ['a.md', 'make it shorter', ['a/x', 'b/y']]);
  assert.throws(() => parseCli(['--edit-article', 'a.md', 'x', '--lang', 'fr']), /Invalid --lang/);
});

test('a file written by vane --article reads back for an edit', () => {
  const body = `# Tides\n\n${'Tides move water twice a day near the coast [1]. '.repeat(12)}Costs fell [2].`;
  const p = parseArticleAnswer(`${body}${sourcesSection([{ title: 'A, b', url: 'https://example.org/a' }, { title: 'Beta', url: 'https://example.org/b' }], 'en')}`);
  assert.equal(p.body, body);
  assert.deepEqual(p.sources.map(s => [s.title, s.url]), [['A, b', 'https://example.org/a'], ['Beta', 'https://example.org/b']]);
});

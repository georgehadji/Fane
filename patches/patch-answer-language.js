// Vane: the answer is written in the language of the question, and a summary has a fixed shape.
// Vane's writer prompt says nothing about language, so the model followed its sources: "Περίληψη στα ελληνικά: <url>"
// (the Discover link, patch-discover-summary-greek) came back in English when the page was English. One rule at the top
// of its formatting instructions. A second rule is for questions that start with «Περίληψη»: Vane's writer would
// otherwise answer with a long blog post, so the summary gets a short "Σύνοψη" first, then the key points, then the
// source, in Greek, and a Greek article is kept in its own wording, not translated. A server chunk: the change needs
// Vane restarted. The Greek is written as \u escapes (ascii), so the bundle stays ASCII.
const { run } = require('./lib/apply-targets');
const { FILES, ascii } = require('./lib/vane');

const FROM = '### Formatting Instructions\n    - **Structure**:';
const LANGUAGE = "- **Language**: Write the whole answer, headings included, in the language of the user's question, even when the sources are in another language. A question in Greek gets an answer in Greek.";
// The common tail of both versions of the summary rule.
const SUMMARY_TAIL = '      Use only what the page says, and add outside context only if the page is too thin to summarize. If the article is in Greek, keep its own wording, names, titles and quotes exactly; never translate it or re-word it into translated-sounding Greek. If the article is in another language, write natural Greek and keep names and terms in their original form. Stay under 300 words.';
// V2: cited every bullet and let the model make «Πηγή» a heading; a one-source summary ended every bullet with the same chip.
const SUMMARY_V2 = [
  '- **Summary requests**: A question that starts with «Περίληψη» asks for a summary of the page or article named in it. Always write it in Greek. These rules replace the Structure, Length and Depth and Conclusion rules below.',
  '      1. Start with «## Σύνοψη»: one paragraph of 2-3 sentences with the main point and the most important fact or figure.',
  '      2. Then «## Βασικά σημεία»: 4-6 bullets, each one fact, with its [number] citation.',
  '      3. End with one line «Πηγή:» naming the site and the article\'s date if the page gives one.',
  SUMMARY_TAIL,
].join('\n');
// V3: cite once, plain «Πηγή» line; models still put a "---" line in front of it, which rendered as a rule.
const SUMMARY_V3 = [
  '- **Summary requests**: A question that starts with «Περίληψη» asks for a summary of the page or article named in it. Always write it in Greek. These rules replace the Structure, Length and Depth and Conclusion rules below.',
  '      1. Start with «## Σύνοψη»: one paragraph of 2-3 sentences with the main point and the most important fact or figure. End this paragraph with the [number] citation of the page.',
  '      2. Then «## Βασικά σημεία»: 4-6 bullets, each one fact. When the page is the only source, do not repeat the citation in the bullets (the Σύνοψη already cites it); with several sources, cite each bullet.',
  '      3. End with one plain line «Πηγή: site name, date» in a paragraph, never as a heading.',
  SUMMARY_TAIL,
].join('\n');
const SUMMARY = [
  '- **Summary requests**: A question that starts with «Περίληψη» asks for a summary of the page or article named in it. Always write it in Greek. These rules replace the Structure, Length and Depth and Conclusion rules below.',
  '      1. Start with «## Σύνοψη»: one paragraph of 2-3 sentences with the main point and the most important fact or figure. End this paragraph with the [number] citation of the page.',
  '      2. Then «## Βασικά σημεία»: 4-6 bullets, each one fact. When the page is the only source, do not repeat the citation in the bullets (the Σύνοψη already cites it); with several sources, cite each bullet.',
  '      3. End with one plain line «Πηγή: site name, date» in a paragraph, never as a heading. Do not write horizontal rules (---) anywhere in a summary.',
  SUMMARY_TAIL,
].join('\n');

const TO_V1 = `### Formatting Instructions\n    ${LANGUAGE}\n    - **Structure**:`; // before the summary rule
const TO_V2 = `### Formatting Instructions\n    ${LANGUAGE}\n    ${ascii(SUMMARY_V2)}\n    - **Structure**:`;
const TO_V3 = `### Formatting Instructions\n    ${LANGUAGE}\n    ${ascii(SUMMARY_V3)}\n    - **Structure**:`;
const TO = `### Formatting Instructions\n    ${LANGUAGE}\n    ${ascii(SUMMARY)}\n    - **Structure**:`;

const TARGETS = [{
  name: 'writer answers in the language of the question',
  file: FILES.research,
  alts: [{ from: FROM, to: TO }, { from: TO_V1, to: TO }, { from: TO_V2, to: TO }, { from: TO_V3, to: TO }],
  ladder: ['fresh', 'V1', 'V2', 'V3'],
}];

module.exports = { TARGETS, SUMMARY };
if (require.main === module) run('patch-answer-language', TARGETS);

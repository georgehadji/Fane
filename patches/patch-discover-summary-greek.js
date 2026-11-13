// Vane: a Discover story opens a summary in Greek.
// A Discover card (and the home page's news card) links to a new chat asking "Summary: <url>", and Vane's writer
// answers in the language of the question, so the summary came out in English even for a Greek reader. The links now
// ask "Περίληψη: <url>" (patch-answer-language gives the writer a rule for it: Greek, a Σύνοψη first). The cards
// themselves stay as the news feeds wrote them. "Περίληψη στα ελληνικά: " (V1) said "in Greek" even for a Greek article,
// which read as a translation; the V1 links are upgraded in place.
// Server-rendered pages and their browser chunks both carry the link (the browser chunks are served with max-age=0;
// the server pages need Vane restarted). Greek is written as \u escapes, so the bundles stay ASCII.
const { run } = require('./lib/apply-targets');
const { FILES, ascii } = require('./lib/vane');

const ASK = 'Περίληψη: ';
const ASK_V1 = 'Περίληψη στα ελληνικά: ';

// `v` is the story's variable in that bundle; `rest` tells apart two links in one file.
const at = (ask, v, rest) => `q=${ask}\${${v}.url}\`,className:"${rest}`;
const link = (name, file, v, rest) => ({
  name,
  file,
  alts: [{ from: at('Summary: ', v, rest), to: at(ascii(ASK), v, rest) }, { from: at(ascii(ASK_V1), v, rest), to: at(ascii(ASK), v, rest) }],
  ladder: ['fresh', 'V1'],
});

const TARGETS = [
  link('Discover card asks in Greek (server)', FILES.discoverPage, 'a', 'rounded-3xl'),
  link('Discover row asks in Greek (server)', FILES.discoverPage, 'a', 'w-full group'),
  link('Discover card asks in Greek (browser)', FILES.discoverClient, 'e', 'rounded-3xl'),
  link('Discover row asks in Greek (browser)', FILES.discoverClient, 'e', 'w-full group'),
  link('home news card asks in Greek (server)', FILES.homeNews, 'a', 'flex flex-row'),
  link('home news card asks in Greek (browser)', FILES.messageClient, 'e', 'flex flex-row'),
];

module.exports = { TARGETS, ASK };
if (require.main === module) run('patch-discover-summary-greek', TARGETS);

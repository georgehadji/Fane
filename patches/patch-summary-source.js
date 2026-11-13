// Vane: a summary reads only its page.
// A Discover story opens a chat whose question is «Περίληψη: <title>\n<address>» (patch-discover-summary-greek). Vane
// answered it with its whole research: the classifier, then 2 (Speed) to 10 (Quality) rounds of researcher-model calls and
// web searches, then the writer, so a summary took a minute and cited pages about other things. The question already
// names the one page that matters.
// `research(a,b)` (the research class, module 87044 in FILES.research) now starts with a short cut: when the question is
// of that shape (SUMMARY_QUESTION, patches/lib/vane.js), it reads the address through Vane's own scraper class
// (module 96227, already wrapped by patch-scrape-guard and patch-scrape-ladder, so a private address is refused and a
// paywalled page is tried through Ladder), shows one "reading" step and returns that page as the only source. The
// writer's summary rule (patch-answer-language) already treats a one-source page as the only source.
// The fallback is the normal path: a scrape that fails, takes longer than SUMMARY_READ.timeoutMs, returns Vane's failure
// title or has under SUMMARY_READ.minChars of text returns null, and the research runs as before, so a summary never ends
// with nothing. Any other question never reaches the scraper. The classifier call before research is untouched.
// A server file (the research chunk): Vane must be restarted.
// The scraper handle is taken at module level (`FANE_SUMMARY_SCRAPE=c(96227)`), because the single letters inside
// research() are Vane's own.
const { run } = require('./lib/apply-targets');
const { FILES, SCRAPE_FAILED_TITLE, SUMMARY_READ, SUMMARY_QUESTION } = require('./lib/vane');

// Injected as source text: no imports, no closure, ASCII, no backticks. `a` is Vane's session (emitBlock), `b` the
// research input (followUp), `d` the handles: { parse, scrape, failedTitle, chars, minChars, timeoutMs }.
// Returns Vane's research result for one page, or null to let Vane research.
async function SUMMARY_SOURCE(a, b, d) {
  var q = d.parse(b && b.followUp);
  if (!q) return null;
  var timer, page = null, why = '';
  try {
    page = await Promise.race([
      Promise.resolve().then(function () { return d.scrape(q.url); }),
      new Promise(function (resolve, reject) { timer = setTimeout(function () { reject(new Error('timed out after ' + d.timeoutMs + ' ms')); }, d.timeoutMs); }),
    ]);
  } catch (err) {
    why = String((err && err.message) || err);
  }
  clearTimeout(timer);
  var text = page && typeof page.content === 'string' ? page.content.replace(/<\/?(scraped_data|result)\b[^>]*>/gi, '').trim() : '';
  if (!why && (!page || page.title === d.failedTitle)) why = 'the scrape failed';
  if (!why && text.length < d.minChars) why = 'only ' + text.length + ' characters of text';
  if (why) {
    console.log('fane: summary source: ' + q.url + ' not read (' + why + '), Vane researches');
    return null;
  }
  var title = String(page.title || q.title || q.url);
  var finding = { content: text.slice(0, d.chars), metadata: { title: title, url: q.url } };
  a.emitBlock({ id: crypto.randomUUID(), type: 'research', data: { subSteps: [{ id: crypto.randomUUID(), type: 'reading', reading: [{ content: '', metadata: { url: q.url, title: title } }] }] } });
  a.emitBlock({ id: crypto.randomUUID(), type: 'source', data: [finding] });
  console.log('fane: summary source: read ' + q.url + ' (' + finding.content.length + ' of ' + text.length + ' characters), no search');
  return { findings: [], searchFindings: [finding] };
}

const HANDLES = `FANE_SUMMARY_SCRAPE=c(96227),FANE_SUMMARY_SOURCE=${SUMMARY_SOURCE},FANE_SUMMARY_DEPS={parse:${SUMMARY_QUESTION},scrape:u=>FANE_SUMMARY_SCRAPE.A.scrape(u),failedTitle:${JSON.stringify(SCRAPE_FAILED_TITLE)},chars:${SUMMARY_READ.chars},minChars:${SUMMARY_READ.minChars},timeoutMs:${SUMMARY_READ.timeoutMs}}`;

// Not an insertion into one place: the handles go before `h=a([e,f])` and the call right after `research(a,b){`, so `to`
// does not contain `from` and the marker is the call itself (a second run finds it and skips).
const FROM = 'g=c(80202),h=a([e,f]);[e,f]=h.then?(await h)():h;class i{async research(a,b){';
const TO = `g=c(80202),${HANDLES},h=a([e,f]);[e,f]=h.then?(await h)():h;class i{async research(a,b){{let S=await FANE_SUMMARY_SOURCE(a,b,FANE_SUMMARY_DEPS);if(S)return S}`;

const TARGETS = [
  { name: 'a summary question reads only its page', file: FILES.research, from: FROM, to: TO, marker: 'await FANE_SUMMARY_SOURCE(a,b,FANE_SUMMARY_DEPS)' },
];

module.exports = { TARGETS, SUMMARY_SOURCE };
if (require.main === module) run('patch-summary-source', TARGETS);

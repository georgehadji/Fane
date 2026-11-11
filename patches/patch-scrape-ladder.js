// Vane: read a paywalled or blocked page through Ladder (https://github.com/everywall/ladder).
// Vane's scraper is headless Chromium that reads the rendered page with Readability. Some pages never load that way
// (washingtonpost.com answers ERR_HTTP2_PROTOCOL_ERROR from the container) and others load only the wall ("this
// article is for subscribers", "security verification", a member-only Medium story). Ladder is a self-hosted HTTP
// proxy whose ruleset overrides request headers (referer, user-agent, cookies, CSP) and injects a script that removes
// paid-content overlays. Its injections only run in a browser, so this patch does not fetch Ladder with Node: it
// scrapes <ladder>/<url> through the same Chromium path as any other page, which is what made the difference in the
// container on 2026-11-02 (Washington Post article: direct scrape failed, through Ladder 8,936 characters of text;
// the same Ladder URL read with fetch() returned the page shell, not the article).
// The fallback runs only when the direct scrape failed, came back thinner than 700 characters or carries a wall
// phrase, and its text replaces the direct one only when it is at least 1.5x longer (and 600+ characters). The caller
// still sees the page's own URL and title, so citations and source cards point at the article.
// FANE_LADDER_URL sets the proxy (default http://host.docker.internal:9081, where `weebot-ladder` publishes 8080);
// empty turns the fallback off. The guard (patch-scrape-guard) still applies: a Ladder URL is unwrapped and its own
// target checked against PRIVATE_ADDRESS, so a scraped page cannot reach Vane's config API through the proxy.
// Runs after patch-scrape-guard (file order), whose guard text it edits.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// Injected as-is into the bundle (no imports, no closure, ASCII only): `read` scrapes one URL and returns Vane's
// {title, content}. Everything it needs is written inside it, because the bundle has none of this file's names.
async function LADDER_FALLBACK(url, read, opts) {
  const thin = 700;
  const failed = 'Failed to scrape';
  let first = null;
  try {
    first = await read(url);
  } catch (err) {
    first = null;
  }
  if (!first || typeof first !== 'object') first = { title: failed, content: '' };
  const base = opts && typeof opts.base === 'string' ? opts.base.replace(/\/+$/, '') : '';
  if (!base || !/^https?:\/\//i.test(String(url))) return first;
  const have = String(first.content || '');
  // Readability drops navigation and footers, so these are the wall's own words, not a site menu item.
  const walled = /subscribe to (continue|read)|already a subscriber|this (article|story) is (for|only|exclusive)|members?[- ]only|sign in to (continue|read)|create a free account|security verification|enable javascript/i.test(have);
  if (first.title !== failed && have.length >= thin && !walled) return first;
  let second = null;
  try {
    second = await read(base + '/' + String(url).replace(/^\/+/, ''));
  } catch (err) {
    second = null;
  }
  if (!second || second.title === failed) return first;
  const got = String(second.content || '');
  if (got.length < Math.max(600, Math.round(have.length * 1.5))) return first;
  const title = (first.title && first.title !== failed ? first.title : second.title) || 'No title';
  const body = got.replace(/^\s*#[\s\S]*?\n/, '').trim();
  return { title: title, content: '\n        # ' + title + ' - ' + url + '\n        ' + body + '\n        ' };
}

// The proxy, read once at module load. `process` is the container's own environment: the bundle is patched after the
// build, so nothing inlined this name.
const CONFIG =
  'var FANE_LADDER=(function(){var e="undefined"!=typeof process&&process.env?process.env.FANE_LADDER_URL:void 0,u="string"==typeof e?e:"http://host.docker.internal:9081",h="";u=u.trim();try{h=u?new URL(u).hostname.toLowerCase():""}catch{h=""}return{base:u.replace(/\\/+$/,""),host:h}})();';

// The guard's private-address test: the proxy's own host is allowed, and a Ladder URL is unwrapped (a page could
// otherwise ask the proxy for http://127.0.0.1:3000/api/config, which answers with the provider API keys).
const PRIV_FROM = ',"localhost"===h||h.endsWith(".localhost"))return!0;';
const PRIV_TO = `${PRIV_FROM}/*fane:priv-ladder*/if(FANE_LADDER&&FANE_LADDER.host&&h===FANE_LADDER.host)return!1;`;
const BAD_FROM = 'bad=async u=>{let p;try{p=new URL(u)}catch{return!0}return!/^https?:$/.test(p.protocol)||await priv(p.hostname)}';
const BAD_TO =
  'bad=async u=>{try{let t=String(u),p,n=0;for(;;){if(p=new URL(t),n++>3||!FANE_LADDER||!FANE_LADDER.host||p.hostname.toLowerCase()!==FANE_LADDER.host)break;t=decodeURIComponent(p.pathname+p.search).replace(/^\\//,"").replace(/^(api|raw)\\//,"")}return!/^https?:$/.test(p.protocol)||await priv(p.hostname)}catch{return!0}}';

const TARGETS = [
  {
    name: 'the scraper reads the page it is asked for',
    file: FILES.research,
    from: 'static async scrape(a){',
    to: 'static async fanePage(a){',
  },
  {
    name: 'a scrape falls back to Ladder',
    file: FILES.research,
    from: 'this.scheduleIdleKill()}}}let h=g}};',
    to: `this.scheduleIdleKill()}}static async scrape(a){return await (${LADDER_FALLBACK})(a,u=>this.fanePage(u),FANE_LADDER)}}${CONFIG}let h=g}};`,
  },
  { name: 'the proxy host is allowed through the scraper guard', file: FILES.research, from: PRIV_FROM, to: PRIV_TO, marker: '/*fane:priv-ladder*/' },
  { name: "a Ladder URL's own target is checked", file: FILES.research, from: BAD_FROM, to: BAD_TO },
];

module.exports = { TARGETS, LADDER_FALLBACK };
if (require.main === module) run('patch-scrape-ladder', TARGETS);

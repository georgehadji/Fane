// Vane: keep the page scraper away from private addresses. Targets are in chunks/641.js (module 96227).
// Upstream behaviour being fixed: the scraper is headless Chromium that follows redirects and runs page scripts,
// and nothing filters private addresses. A page found by a search could therefore make the container call Vane
// itself (127.0.0.1:3000): GET /api/config answers with the provider API keys and POST /api/config takes new
// settings with no login. Quality reads pages (upstream), Balanced reads them (patch-web-search) and the
// scrape_url tool reads them, all through this one method, so it is guarded here once:
//  1. every request the page makes goes through a route handler that aborts anything but GET and anything whose
//     host is private (names are resolved, the answer cached for the scrape);
//  2. service workers are blocked, so a page cannot fetch around the handler;
//  3. after the page loaded, the address asked for and every redirect hop must be public http(s); otherwise the
//     scrape fails like any other (Vane's "Failed to scrape" result).
// The private-address rule is PRIVATE_ADDRESS in lib/vane.js (a test keeps it equal to cli/image/download.mjs).
// Residual risk: Playwright does not call the route handler for redirect hops (checked in the container), so the GET
// to a private host at the end of a redirect happens once; its body is discarded and the scrape fails. WebSockets
// are not routed by Playwright.
// DNS is resolved here and again by Chromium, so rebinding between the two is not prevented.
const { run } = require('./lib/apply-targets');
const { FILES, PRIVATE_ADDRESS } = require('./lib/vane');

const UA = 'userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"';
const GOTO = 'await c.goto(a,{waitUntil:"domcontentloaded",timeout:this.NAVIGATION_TIMEOUT}),';

// Module-level helpers. FANE_GUARD() makes one guard per scrape: .route for the context, .check for the loaded page.
// No backticks or ${ } allowed here.
const GUARD = String.raw`var FANE_PRIV=${PRIVATE_ADDRESS},FANE_NET=require("node:net"),FANE_DNS=require("node:dns").promises,FANE_GUARD=()=>{let seen=new Map,priv=async h=>{if(h=String(h).toLowerCase().replace(/^\[|\]$/g,""),"localhost"===h||h.endsWith(".localhost"))return!0;if(FANE_NET.isIP(h))return FANE_PRIV(h,FANE_NET.isIP);return seen.has(h)||seen.set(h,FANE_DNS.lookup(h,{all:!0}).then(r=>!r.length||r.some(x=>FANE_PRIV(x.address,FANE_NET.isIP)),()=>!0)),seen.get(h)},bad=async u=>{let p;try{p=new URL(u)}catch{return!0}return!/^https?:$/.test(p.protocol)||await priv(p.hostname)};return{route:async r=>{let q=r.request(),u=q.url(),ok=!1;try{ok=/^(data|blob):/.test(u)||"GET"===q.method()&&!await bad(u)}catch{}ok?await r.continue().catch(()=>0):await r.abort("blockedbyclient").catch(()=>0)},check:async(a,r)=>{if(await bad(a))throw Error("refusing a private address");for(let q=r&&r.request();q;q=q.redirectedFrom())if(await bad(q.url()))throw Error("refusing a redirect to a private address")}}};`;

const TARGETS = [
  {
    name: 'scraper guard helpers',
    from: 'var d=c(32325),e=c(40131),f=c(24425);class g{',
    to: `var d=c(32325),e=c(40131),f=c(24425);/*fane:scrape-guard*/${GUARD}class g{`,
  },
  {
    name: 'every request of a scraped page is checked',
    from: `${UA}});await b.addInitScript(`,
    to: `${UA},serviceWorkers:"block"}),FANE_G=FANE_GUARD();await b.route("**/*",FANE_G.route);await b.addInitScript(`,
  },
  {
    name: 'the address and its redirects are checked',
    from: GOTO,
    to: 'await FANE_G.check(a,await c.goto(a,{waitUntil:"domcontentloaded",timeout:this.NAVIGATION_TIMEOUT})),',
  },
].map(t => ({ file: FILES.research, ...t }));

module.exports = { TARGETS, GUARD };
if (require.main === module) run('patch-scrape-guard', TARGETS);

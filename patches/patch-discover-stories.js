// Vane: the Discover route keeps its stories, drops repeats and finds pictures.
// One Discover page load ran about thirty SearXNG searches (English sites x queries, Greek sites x 2, two magazines) plus
// three feeds, so switching topics waited for all of them and the burst got engines suspended; the page drops every story
// without a thumbnail (two thirds of the magazines' and many Greek ones), and Greek sites often carry the same agency
// story. The "normal" branch of the route (the Discover page; the home widget's "preview" stays as it is) now builds its
// list inside STORIES_CACHE, once per topic, and the per-request shuffle stays outside, so the page still varies.
//  - STORIES_CACHE: one entry per key on `globalThis.faneStories`, stale-while-revalidate with a single flight. Fresh
//    under 10 minutes: served. Stale up to 60 minutes: served, and one refresh starts in the background. Older or empty:
//    the request waits for one refresh. A refresh that throws or finds nothing is never stored (a SearXNG hiccup is not
//    served for ten minutes), and concurrent requests share one producer run.
//  - DEDUPE_STORIES: two stories are the same when the words of their titles (lowercase, accents and final sigma folded,
//    punctuation and words under 3 letters dropped) overlap by 0.6 (Jaccard); the first with a thumbnail wins.
//  - FILL_THUMBNAILS: for stories with no thumbnail whose page is on one of the route's own sites, reads the first 64 KB of
//    the page and takes og:image, then twitter:image (https only). At most 12 pages, 4 at a time, 4 seconds for the stage;
//    `redirect: "manual"`, so a redirect to another host is never followed. The trust boundary is the host list (the
//    topic's English sites plus the Greek table), not DNS: a story whose host is not a listed name or a subdomain of one is
//    never fetched, and an IP address cannot match a name. The page then shows the image as origin + pathname + "?id=null",
//    which a CDN that needs other query parameters would refuse (checked live per site, see CLAUDE.md).
// All three run in the cached producer, so the cost is paid once per topic per refresh, mostly in the background.
// A server route: Vane must be restarted. Runs after the other Discover route patches (file order): their text sits between
// the two insertion points, so they still count as applied; if GREEK changes, the host list written here changes too (a
// test compares them), and the target needs an upgrade `alts` entry.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');
const { GREEK } = require('./patch-discover-greek');

// Injected as source text: no imports, no closure, ASCII, no backticks. `produce` returns the topic's stories.
async function STORIES_CACHE(root, key, produce, opts) {
  var o = opts || {};
  var now = o.now || Date.now;
  var fresh = o.freshMs || 600000;
  var stale = o.staleMs || 3600000;
  var store = root.faneStories || (root.faneStories = {});
  var start = function () {
    var cur = store[key] || (store[key] = { items: null, at: 0, run: null });
    if (!cur.run) {
      cur.run = Promise.resolve()
        .then(produce)
        .then(
          function (items) {
            if (Array.isArray(items) && items.length) { cur.items = items; cur.at = now(); }
            else console.log('fane: discover ' + key + ': refresh found nothing, not stored');
          },
          function (err) { console.log('fane: discover ' + key + ': refresh failed (' + String((err && err.message) || err) + ')'); }
        )
        .then(function () { cur.run = null; });
    }
    return cur.run;
  };
  var cur = store[key];
  var age = cur && cur.items ? now() - cur.at : Infinity;
  if (age < fresh) return cur.items;
  if (age < stale) { start(); return cur.items; }
  await start();
  cur = store[key];
  return cur && cur.items && now() - cur.at < stale ? cur.items : [];
}

// Injected as source text: the stories with repeats removed, in the order given.
function DEDUPE_STORIES(items) {
  var words = function (title) {
    var seen = {};
    String(title || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\u03c2/g, '\u03c3')
      .split(/[^\p{L}\p{N}]+/u)
      .forEach(function (w) { if (w.length >= 3) seen[w] = 1; });
    return Object.keys(seen);
  };
  var same = function (a, b) {
    if (!a.length || !b.length) return false;
    var inter = 0;
    a.forEach(function (w) { if (b.indexOf(w) >= 0) inter++; });
    return inter / (a.length + b.length - inter) >= 0.6;
  };
  var kept = [];
  var keptWords = [];
  (items || []).forEach(function (item) {
    var w = words(item && item.title);
    for (var i = 0; i < kept.length; i++) {
      if (same(w, keptWords[i])) {
        if (!kept[i].thumbnail && item.thumbnail) { kept[i] = item; keptWords[i] = w; }
        return;
      }
    }
    kept.push(item);
    keptWords.push(w);
  });
  return kept;
}

// Injected as source text: the same stories, with a thumbnail added where the story's own page names one.
// o = { hosts, fetchImpl, limit, concurrency, budgetMs, maxBytes }.
async function FILL_THUMBNAILS(items, o) {
  var hosts = o.hosts || [];
  var limit = o.limit || 12;
  var width = o.concurrency || 4;
  var budget = o.budgetMs || 4000;
  var cap = o.maxBytes || 65536;
  var doFetch = o.fetchImpl || fetch;
  var allowed = function (u) {
    try {
      var x = new URL(u);
      return (x.protocol === 'https:' || x.protocol === 'http:') && hosts.some(function (h) { return x.hostname === h || x.hostname.endsWith('.' + h); });
    } catch (e) { return false; }
  };
  var todo = [];
  items.forEach(function (it, i) { if (it && !it.thumbnail && todo.length < limit && allowed(it.url)) todo.push(i); });
  if (!todo.length) return items;
  var attr = function (tag, name) {
    var m = new RegExp('[\\s"\']' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
  };
  var ctl = new AbortController();
  var image = async function (url) {
    var res = await doFetch(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' }, signal: ctl.signal });
    if (!res || !res.ok) return '';
    var type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
    if (type && !/html/i.test(type)) return '';
    var html = '';
    if (res.body && res.body.getReader) {
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var size = 0;
      while (size < cap) {
        var part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        html += dec.decode(part.value, { stream: true });
      }
      try { await reader.cancel(); } catch (e) {}
    } else html = String(await res.text());
    html = html.slice(0, cap);
    var metas = html.match(/<meta\b[^>]*>/gi) || [];
    var names = ['og:image', 'twitter:image'];
    for (var n = 0; n < names.length; n++) {
      for (var m = 0; m < metas.length; m++) {
        var tag = attr(metas[m], 'property') || attr(metas[m], 'name');
        var content = attr(metas[m], 'content').replace(/&amp;/g, '&').trim();
        if (tag.toLowerCase() !== names[n] || !content || content.length > 2000) continue;
        try {
          var abs = new URL(content, url);
          // the page keeps only origin + pathname, so a picture named in the query (espncdn's combiner/i?img=...) is lost
          if (abs.protocol === 'https:' && !/[?&][^=&]*=(%2f|\/|https?(:|%3a))/i.test(abs.search)) return abs.href;
        } catch (e) {}
      }
    }
    return '';
  };
  var out = items.slice();
  var next = 0;
  var worker = async function () {
    while (next < todo.length && !ctl.signal.aborted) {
      var i = todo[next++];
      try {
        var img = await image(items[i].url);
        if (img && !ctl.signal.aborted) out[i] = Object.assign({}, items[i], { thumbnail: img });
      } catch (e) {}
    }
  };
  var timer;
  var deadline = new Promise(function (resolve) { timer = setTimeout(function () { ctl.abort(); resolve(); }, budget); });
  await Promise.race([Promise.all(Array.from({ length: Math.min(width, todo.length) }, worker)), deadline]);
  clearTimeout(timer);
  return out.slice();
}

// The Greek sites of each topic (the route's own list; a test keeps this equal to patch-discover-greek's table).
const GREEK_HOSTS = Object.fromEntries(Object.entries(GREEK).map(([topic, v]) => [topic, v.links]));

const TOPIC = 'b.get("topic")||"tech"';
const OPEN_FROM = 'if("normal"===c){let a=new Set;e=(await Promise.all(';
const OPEN_TO = `if("normal"===c){e=(await (${STORIES_CACHE})(globalThis,"discover:"+(${TOPIC}),async()=>{let a=new Set,e;e=(await Promise.all(`;
const CLOSE_FROM = '.sort(()=>Math.random()-.5)}else e=(await (0,v.n)(';
const CLOSE_TO = `.sort(()=>Math.random()-.5);e=await (${FILL_THUMBNAILS})((${DEDUPE_STORIES})(e),{hosts:d.links.concat(${JSON.stringify(GREEK_HOSTS)}[${TOPIC}]||[])});return e})).slice().sort(()=>Math.random()-.5)}else e=(await (0,v.n)(`;

const TARGETS = [
  { name: 'Discover builds its stories once per topic (cache)', file: FILES.discoverRoute, from: OPEN_FROM, to: OPEN_TO },
  { name: 'Discover drops repeats and fills pictures', file: FILES.discoverRoute, from: CLOSE_FROM, to: CLOSE_TO, marker: 'return e})).slice().sort(()=>Math.random()-.5)' },
];

module.exports = { TARGETS, STORIES_CACHE, DEDUPE_STORIES, FILL_THUMBNAILS, GREEK_HOSTS };
if (require.main === module) run('patch-discover-stories', TARGETS);

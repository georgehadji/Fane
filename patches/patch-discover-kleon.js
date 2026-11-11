// Vane: Austin Kleon's blog in Discover.
// Austin Kleon's blog (austinkleon.com) is not in Bing's news index (0 results per site:<query>, checked in the
// container), so the route reads its RSS feed (https://austinkleon.com/feed/) instead, like MEDIUM does. Five
// stories with an image are mixed in with the rest and the feed is cached for ten minutes (a failure for one
// minute). The new element is added inside the Promise.all array, so this patch is independent of
// patch-discover-greek / patch-discover-medium / patch-discover-ellipsis (they never touch this fragment). Only the
// Discover page (mode "normal"); the home widget (mode "preview") stays as it is. A server route, so it needs Vane
// restarted.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// Injected as-is into the route (no imports, no closure, ASCII only): Austin Kleon's RSS feed, shaped like the
// search results the page already renders ({title, url, content, thumbnail}).
async function KLEON(fetchImpl) {
  const store = globalThis.faneKleon || (globalThis.faneKleon = {});
  if (store.items && Date.now() - store.at < 600000) return store.items;
  const text = (s) =>
    String(s || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  const first = (source, re) => {
    const m = re.exec(source);
    return m ? m[1] : '';
  };
  try {
    const res = await (fetchImpl || fetch)('https://austinkleon.com/feed/', {
      headers: { 'user-agent': 'Mozilla/5.0' },
      signal: typeof AbortSignal === 'object' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    if (!res || !res.ok) throw new Error('Kleon feed ' + (res ? res.status : 'unavailable'));
    const items = [];
    for (const chunk of String(await res.text()).split('<item>').slice(1)) {
      const body = chunk.split('</item>')[0];
      const url = text(first(body, /<link>([\s\S]*?)<\/link>/)).split('?')[0];
      const description = first(body, /<description>([\s\S]*?)<\/description>/);
      const contentEncoded = first(body, /<content:encoded>([\s\S]*?)<\/content:encoded>/);
      const imgSrc = first(description + contentEncoded, /<img[^>]+src="([^"]+)"/);
      const title = text(first(body, /<title>([\s\S]*?)<\/title>/));
      const snippet = text(description.replace(/<[^>]*>/g, ' '));
      const thumbnail = imgSrc && /^https?:\/\//.test(imgSrc) ? imgSrc.replace(/^http:\/\//, 'https://') : '';
      if (!title || !/^https?:\/\/([a-z0-9-]+\.)*austinkleon\.com\//.test(url) || !thumbnail) continue;
      items.push({ title, url, content: snippet, thumbnail });
      if (items.length >= 5) break;
    }
    store.items = items;
    store.at = Date.now();
    return items;
  } catch (err) {
    store.items = [];
    store.at = Date.now();
    return [];
  }
}

// The Greek SearXNG options object closes (`"el"}`), then the GREEK_SEARCHES call and the outer array's `]` follow.
// An extra array element (the Kleon feed promise) is appended before the `]`, so the story list afterwards is
// deduplicated, shuffled and trimmed exactly like the rest.
const FROM = '"el"}))])).flat()';
const TO = `"el"}))` + `,(async()=>await (${KLEON})())()` + `]))` + `.flat()`;

module.exports = { TARGETS: [{ name: 'Austin Kleon in Discover', file: FILES.discoverRoute, from: FROM, to: TO }], KLEON };
if (require.main === module) run('patch-discover-kleon', module.exports.TARGETS);
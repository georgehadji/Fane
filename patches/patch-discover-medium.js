// Vane: Medium stories in Discover.
// Discover searches three news sites per topic through SearXNG's Bing News engine. Medium is not in Bing's news
// index: `site:medium.com <topic>` makes that engine fail with "parsing error" from the container (checked
// 2026-11-02, while `site:techcrunch.com` answers 9 results), so the route reads Medium's own tag feeds instead.
// https://medium.com/feed/tag/<tag> answers in about a quarter of a second with ten stories, seven to ten of them
// carrying a feed image, which is what the page needs: it drops every story without a thumbnail and rebuilds the
// image URL as origin + pathname + "?id=", which Medium's CDN answers with the same image (checked). Five stories per
// topic are mixed in before the route's shuffle, and the feed is cached for ten minutes (a failure for one minute),
// because it is one request per topic. Only the Discover page (mode "normal"); the home widget (mode "preview") stays
// as it is. A server route: the change needs Vane restarted.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// Injected as-is into the route (no imports, no closure, ASCII only): one Medium tag feed per topic, shaped like the
// search results the page already renders ({title, url, content, thumbnail}). The cache sits on globalThis because a
// module-level binding would need a second target.
async function MEDIUM(topic, fetchImpl) {
  const tag = { tech: 'technology', finance: 'finance', art: 'art', sports: 'sports', entertainment: 'entertainment' }[topic];
  if (!tag) return [];
  const store = globalThis.faneMedium || (globalThis.faneMedium = {});
  const hit = store[topic];
  if (hit && Date.now() - hit.at < hit.ttl) return hit.items;
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
    const res = await (fetchImpl || fetch)('https://medium.com/feed/tag/' + tag, {
      headers: { 'user-agent': 'Mozilla/5.0' },
      signal: typeof AbortSignal === 'object' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    if (!res || !res.ok) throw new Error('Medium feed ' + (res ? res.status : 'unavailable'));
    const items = [];
    for (const chunk of String(await res.text()).split('<item>').slice(1)) {
      const body = chunk.split('</item>')[0];
      const description = first(body, /<description>([\s\S]*?)<\/description>/);
      const url = text(first(body, /<link>([\s\S]*?)<\/link>/)).split('?')[0];
      const title = text(first(body, /<title>([\s\S]*?)<\/title>/));
      const image = first(description, /<img[^>]+src="([^"]+)"/);
      if (!title || !/^https?:\/\/([a-z0-9-]+\.)*medium\.com\//.test(url) || !/^https?:\/\//.test(image)) continue;
      items.push({ title, url, content: text(first(description, /medium-feed-snippet">([\s\S]*?)<\/p>/)), thumbnail: image });
      if (items.length >= 5) break;
    }
    store[topic] = { at: Date.now(), ttl: 10 * 60 * 1000, items };
    return items;
  } catch (err) {
    store[topic] = { at: Date.now(), ttl: 60 * 1000, items: [] };
    return [];
  }
}

// The Discover page's results, deduplicated and shuffled. `b` is the request's searchParams here (it is shadowed
// only inside the filter callback), `a` the Set the route deduplicates with.
const FROM = ').flat().filter(b=>{let c=b.url?.toLowerCase().trim();return!a.has(c)&&(a.add(c),!0)}).sort(()=>Math.random()-.5)';
const TO = `).flat().concat(await (${MEDIUM})(b.get("topic")||"tech")).filter(b=>{let c=b.url?.toLowerCase().trim();return!a.has(c)&&(a.add(c),!0)}).sort(()=>Math.random()-.5)`;

const TARGETS = [{ name: 'Medium stories in Discover', file: FILES.discoverRoute, from: FROM, to: TO }];

module.exports = { TARGETS, MEDIUM };
if (require.main === module) run('patch-discover-medium', TARGETS);

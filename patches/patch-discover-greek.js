// Vane: Greek news sites next to the English ones in Discover.
// Vane's Discover page searches three English sites per topic (site:techcrunch.com technology news, ...) through
// SearXNG's Bing News engine in English only. This patch adds Greek sites per topic, searched in Greek with
// language "el", and the page shuffles them in with the rest. Sites picked by querying Bing News from the container:
// each returned 5 or more stories with a thumbnail for these queries (the page drops a story without one); four
// more sites were added in 2026-11-02 (skai.gr to tech, tanea.gr to art, tovima.gr and iefimerida.gr to
// entertainment), each 8-9 results from Bing News, iefimerida with about half carrying a thumbnail.
// A Greek search that fails gives no stories instead of failing the page. Only the Discover page (mode "normal");
// the home widget (mode "preview") stays as it is. A server route: the change needs Vane restarted.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// The table since the patch shipped: a container patched with it has its JSON in the route, so the target's second
// alternative upgrades that text in place instead of failing (found 0) or inserting a second Greek block.
const GREEK_V1 = {
  tech: { links: ['news247.gr', 'unboxholics.com', 'in.gr'], query: ['τεχνολογία', 'τεχνητή νοημοσύνη'] },
  finance: { links: ['capital.gr', 'euro2day.gr', 'naftemporiki.gr'], query: ['οικονομία', 'χρηματιστήριο'] },
  art: { links: ['efsyn.gr', 'lifo.gr', 'kathimerini.gr'], query: ['πολιτισμός', 'τέχνη'] },
  sports: { links: ['sport24.gr', 'gazzetta.gr', 'sdna.gr'], query: ['αθλητικά', 'ποδόσφαιρο'] },
  entertainment: { links: ['flix.gr', 'protothema.gr', 'athinorama.gr'], query: ['σινεμά', 'τηλεόραση'] },
};

const GREEK = {
  tech: { links: ['news247.gr', 'unboxholics.com', 'in.gr', 'skai.gr'], query: ['τεχνολογία', 'τεχνητή νοημοσύνη'] },
  finance: { links: ['capital.gr', 'euro2day.gr', 'naftemporiki.gr'], query: ['οικονομία', 'χρηματιστήριο'] },
  art: { links: ['efsyn.gr', 'lifo.gr', 'kathimerini.gr', 'tanea.gr'], query: ['πολιτισμός', 'τέχνη'] },
  sports: { links: ['sport24.gr', 'gazzetta.gr', 'sdna.gr'], query: ['αθλητικά', 'ποδόσφαιρο'] },
  entertainment: { links: ['flix.gr', 'protothema.gr', 'athinorama.gr', 'tovima.gr', 'iefimerida.gr'], query: ['σινεμά', 'τηλεόραση'] },
};

// Injected as-is into the route (no imports, no closure): one search per site and query, each a list of stories.
function GREEK_SEARCHES(table, topic, search) {
  const t = table[topic];
  return t ? t.links.flatMap((site) => t.query.map((q) => search(`site:${site} ${q}`).then((r) => r.results || [], () => []))) : [];
}

// The Discover page's search: every English site with every query. `b` is the request's searchParams here (it is
// shadowed only inside the map callback), `d` the topic's English sites and queries, `v.n` Vane's SearXNG client.
const SEARCH = 'd.links.flatMap(a=>d.query.map(async b=>(await (0,v.n)(`site:${a} ${b}`,{engines:["bing news"],pageno:1,language:"en"})).results))';
const FROM = `e=(await Promise.all(${SEARCH})).flat()`;
const TO = `e=(await Promise.all([...${SEARCH},...(${GREEK_SEARCHES})(${JSON.stringify(GREEK)},b.get("topic")||"tech",q=>(0,v.n)(q,{engines:["bing news"],pageno:1,language:"el"}))])).flat()`;
const TO_V1 = `e=(await Promise.all([...${SEARCH},...(${GREEK_SEARCHES})(${JSON.stringify(GREEK_V1)},b.get("topic")||"tech",q=>(0,v.n)(q,{engines:["bing news"],pageno:1,language:"el"}))])).flat()`;

const TARGETS = [
  {
    name: 'Greek sites in Discover',
    file: FILES.discoverRoute,
    // The first alternative is a fresh Vane; the second upgrades a container patched with the first site table.
    alts: [{ from: FROM, to: TO }, { from: TO_V1, to: TO }],
    // patch-discover-kleon (and -medium) edit the end of `to`; the new table's first-added site stays as it is.
    marker: '"skai.gr"',
  },
];

module.exports = { TARGETS, GREEK, GREEK_V1, GREEK_SEARCHES };
if (require.main === module) run('patch-discover-greek', TARGETS);
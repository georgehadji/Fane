// Vane: the Atlantic articles in Discover.
// The Discover page's topic object `d` is copied per request with "theatlantic.com" appended to its links, so every
// topic searches it in English alongside the three news sites, and the home widget (mode "preview") can pick it too.
// patch-discover-newyorker.js runs after this one (file order), so the target has two alternatives: Vane's original
// topic lookup, or the lookup after newyorker.com was added — whichever the route holds is the anchor, so the two
// patches can run in either order, both sites end up listed, and re-running is a no-op (marker).
// Bing News returns 6-10 stories per site:<query> for site:theatlantic.com, most with a thumbnail for the tech,
// finance and culture queries, fewer for sports and entertainment (the page drops a story without one).
// A server route, so it needs Vane restarted.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

const ORIGINAL = 'd=w[b.get("topic")||"tech"],e=[];';
const ATLANTIC_ONLY = 'd={...w[b.get("topic")||"tech"],links:[...w[b.get("topic")||"tech"].links,"theatlantic.com"]},e=[];';
const WITH_NEWYORKER = 'd={...w[b.get("topic")||"tech"],links:[...w[b.get("topic")||"tech"].links,"newyorker.com"]},e=[];';
const BOTH = 'd={...w[b.get("topic")||"tech"],links:[...w[b.get("topic")||"tech"].links,"theatlantic.com","newyorker.com"]},e=[];';

module.exports = {
  TARGETS: [
    {
      name: 'theatlantic.com in Discover',
      file: FILES.discoverRoute,
      marker: '"theatlantic.com"',
      alts: [
        { from: ORIGINAL, to: ATLANTIC_ONLY },
        { from: WITH_NEWYORKER, to: BOTH },
      ],
    },
  ],
};
if (require.main === module) run('patch-discover-atlantic', module.exports.TARGETS);
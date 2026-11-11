// Vane: New Yorker articles in Discover.
// The Discover page's topic object `d` is copied per request with "newyorker.com" appended to its links, so every
// topic searches it in English alongside the three news sites, and the home widget (mode "preview") can pick it too.
// patch-discover-atlantic.js runs before this one (file order), so the target has two alternatives: Vane's original
// topic lookup, or the lookup after theatlantic.com was added — whichever the route holds is the anchor, so the two
// patches can run in either order, both sites end up listed, and re-running is a no-op (marker).
// Bing News returns 5-10 stories per site:<query> for site:newyorker.com, about a third with a thumbnail
// (the page drops a story without one). A server route, so it needs Vane restarted.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

const ORIGINAL = 'd=w[b.get("topic")||"tech"],e=[];';
const NEWYORKER_ONLY = 'd={...w[b.get("topic")||"tech"],links:[...w[b.get("topic")||"tech"].links,"newyorker.com"]},e=[];';
const WITH_ATLANTIC = 'd={...w[b.get("topic")||"tech"],links:[...w[b.get("topic")||"tech"].links,"theatlantic.com"]},e=[];';
const BOTH = 'd={...w[b.get("topic")||"tech"],links:[...w[b.get("topic")||"tech"].links,"theatlantic.com","newyorker.com"]},e=[];';

module.exports = {
  TARGETS: [
    {
      name: 'newyorker.com in Discover',
      file: FILES.discoverRoute,
      marker: '"newyorker.com"',
      alts: [
        { from: ORIGINAL, to: NEWYORKER_ONLY },
        { from: WITH_ATLANTIC, to: BOTH },
      ],
    },
  ],
};
if (require.main === module) run('patch-discover-newyorker', module.exports.TARGETS);
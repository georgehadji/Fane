// Vane: a real ellipsis at the end of a cut Discover summary.
// The news feeds behind Discover cut their summaries with three periods ("but that..."); on the pinned build 60 of the
// 78 summaries on the page ended that way. The route that returns them now ends each one with a no-break space and
// "…" instead, so the browser shows "but that …". The text is fixed once, where it leaves the server, because the
// Discover page writes it in three places. A server route: the change needs Vane restarted.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// Injected as-is into the route (no imports, no closure).
function ELLIPSIS(items) {
  return Array.isArray(items)
    ? items.map((b) => (b && typeof b.content === 'string' ? { ...b, content: b.content.replace(/\s*(?:\.{3}|…)$/, ' …') } : b))
    : items;
}

const FROM = 'Response.json({blogs:e},{status:200})';

const TARGETS = [
  {
    name: 'real ellipsis in Discover summaries',
    file: FILES.discoverRoute,
    from: FROM,
    to: `Response.json({blogs:(${ELLIPSIS})(e)},{status:200})`,
  },
];

module.exports = { TARGETS, ELLIPSIS };
if (require.main === module) run('patch-discover-ellipsis', TARGETS);

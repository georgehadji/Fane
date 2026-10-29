// Vane: Discover summaries in Greek.
// The Discover page shows English stories (and, since patch-discover-greek, Greek ones) with their summaries as the news
// feeds wrote them. Before the route answers, the summaries that are not Greek go through cli/image/translate.mjs
// (mounted at FANE_IMAGE_DIR), which translates them with the chat model of Vane's own providers and keeps each result
// in memory, so only the first load of a page waits. Titles stay as they are. Only the Discover page (mode "normal").
// If the module is missing, there is no provider or the model is late, the route answers with the English text as before.
// Runs before patch-discover-ellipsis's function (it wraps the same value), which is why that patch carries a marker.
// A server route: the change needs Vane restarted.
const { run } = require('./lib/apply-targets');
const { FILES, CONFIG_JSON, FANE_IMAGE_DIR } = require('./lib/vane');

// the end of ELLIPSIS's call: `e` is the stories, `c` the request's mode
const FROM = '})(e)},{status:200})';
const TO = `})("normal"===c?await(async()=>{try{return await(await import(${JSON.stringify(`file://${FANE_IMAGE_DIR}/translate.mjs`)})).greekSummaries(e,{configPath:${JSON.stringify(CONFIG_JSON)}})}catch(E){console.log("fane: Discover translation unavailable:",E&&E.message);return e}})():e)},{status:200})/*fane:discover-translate*/`;

const TARGETS = [{ name: 'Discover summaries translated to Greek', file: FILES.discoverRoute, from: FROM, to: TO, marker: '/*fane:discover-translate*/' }];

module.exports = { TARGETS };
if (require.main === module) run('patch-discover-translate', TARGETS);

// Vane: no sources, no answer from memory.
// When the research found nothing (no search result and no widget), Vane's writer still answered, from the model's
// memory, with no citations: "latest news in Greece" came back with a government that left office years ago. Its prompt
// says to reply "could not find any relevant information", and models ignore that. Now the first question of a chat
// gets a fixed "nothing was found" answer without calling the writer; a follow-up still reaches the writer, with a rule
// to answer only from the conversation above, since "translate that" needs no search. Research always runs in Fane
// (patch-always-search), so an empty result means the search found nothing.
// Wraps the writer call that patch-quality-check already wrapped, so it runs after it (file order) and that patch
// carries a marker. In Quality the fixed answer has no citations, so the check leaves it alone.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

const NOTHING = {
  en: 'Nothing was found for this question, so there is no answer from sources. Try other words, or ask again: the search engines sometimes miss on the first try.',
  el: 'Δεν βρέθηκε τίποτα για αυτή την ερώτηση, οπότε δεν υπάρχει απάντηση από πηγές. Δοκιμάστε με άλλες λέξεις ή ρωτήστε ξανά: οι μηχανές αναζήτησης μερικές φορές αστοχούν την πρώτη φορά.',
};
const FOLLOW_UP_RULE = '\n\n### No sources\nThe search found nothing for this message. Answer only from the conversation above. If the conversation does not hold the answer, say that nothing was found. Never answer from your own memory.';

// Non-ASCII as \u escapes, so the bundles stay ASCII.
const js = (s) => JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
// Greek when Greek letters outnumber Latin ones in the question (as patch-greek-lang decides).
const NOTHING_FOR_QUESTION = `((b.followUp.match(/[\\u0370-\\u03ff\\u1f00-\\u1fff]/g)||[]).length>(b.followUp.match(/[a-z]/gi)||[]).length?${js(NOTHING.el)}:${js(NOTHING.en)})`;

const writer = (system) => `b.config.llm.streamText({messages:[{role:"system",content:${system}},...b.chatHistory,{role:"user",content:b.followUp}]})`;
// findings: the research's search results; widgets: the widget results; system: the writer prompt.
const guarded = (findings, widgets, system) =>
  `(${findings}?.length||${widgets}.length?${writer(system)}:b.chatHistory.length?${writer(`${system}+${js(FOLLOW_UP_RULE)}`)}:(async function*(){/*fane:sources-required*/yield{contentChunk:${NOTHING_FOR_QUESTION}}})())`;

const TARGETS = [
  {
    // chat route: o = the research result, n = the widget results, s = the writer prompt
    name: 'no answer from memory (/api/chat)',
    file: FILES.chatRoute,
    from: `(${writer('s')}),u="";`,
    to: `(${guarded('o?.searchFindings', 'n', 's')}),u="";`,
  },
  {
    // search route (the CLI): l = the research result, k = the widget results, p = the writer prompt
    name: 'no answer from memory (/api/search)',
    file: FILES.searchRoute,
    from: `(${writer('p')}))a.emit(`,
    to: `(${guarded('l?.searchFindings', 'k', 'p')}))a.emit(`,
  },
];

module.exports = { TARGETS, NOTHING, FOLLOW_UP_RULE };
if (require.main === module) run('patch-sources-required', TARGETS);

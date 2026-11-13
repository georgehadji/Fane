// Is this prompt a request for a researched report, and about what? Greek and English.
// A report is not an article: the question is split into sub-questions, each researched on its own, and the answer has
// fixed sections and a table of figures (write/pipeline.mjs, format 'report'). Like the article detector it needs a request
// verb at the start ("write a report on ...", «γράψε μια έκθεση για ...»), or the words "deep research" / «βαθιά έρευνα»
// followed by what it is about ("deep research on ...", «βαθιά έρευνα για ...»): "report" or "deep research" on their own are
// search questions and stay ones. A code or brainstorm request is never a report ("write a report generator in Python").
import { isBrainstormRequest } from './intent-brainstorm.mjs';
import { isCodeRequest } from './intent-code.mjs';
import { fold } from './language.mjs';
import { EL_VERB, EN_VERB, LINK, POLITE } from './polite.mjs';

const EN_ADJ = String.raw`(?:(?:new|short|long|detailed|well[- ]researched|researched|in-depth|brief|full|complete|thorough|comprehensive|deep|research|analytical|market|industry|sourced|cited),?\s+){0,3}`;
const EN_REPORT = new RegExp(String.raw`^\s*${POLITE}${EN_VERB}\s+(?:me\s+|us\s+)?(?:(?:an?|the|one)\s+)?(?:\d{3,4}[- ]words?\s+)?${EN_ADJ}reports?(?![\p{L}])`, 'iu');
// "deep research on solar power", "do an in-depth research into ...", "give me a deep dive on ..."
const EN_DEEP = new RegExp(String.raw`^\s*${POLITE}(?:(?:${EN_VERB}|do|run|conduct|perform|start|give)\s+(?:me\s+|us\s+)?(?:an?\s+)?)?(?:deep|in-depth|thorough|comprehensive)\s+(?:research|dive)\s+(?:on|about|into|of|for)(?![\p{L}])`, 'iu');

// Over folded text: no accents, final sigma written as sigma.
const EL_REPORT = new RegExp(String.raw`^\s*${POLITE}${EL_VERB}\s+(?:μου\s+|μασ\s+)?(?:(?:ενα|μια|μιασ|το|τον|την|εναν)\s+)?(?:\p{L}+\s+){0,2}?(?:εκθεσ\p{L}*|αναφορ\p{L}*)(?![\p{L}])`, 'iu');
const EL_DEEP = new RegExp(String.raw`^\s*${POLITE}(?:(?:κανε|κανετε|διεξαγε|πραγματοποιησε)\s+(?:μου\s+|μασ\s+)?(?:μια\s+)?)?(?:βαθια ερευνα|ερευνα σε βαθοσ)\s*(?:για|σχετικα με|πανω σε|περι|:)(?![\p{L}])`, 'iu');

const matchOf = (text) => {
  const t = String(text || '');
  const folded = fold(t);
  return EN_REPORT.exec(t) || EN_DEEP.exec(t) || EL_REPORT.exec(folded) || EL_DEEP.exec(folded);
};

export const isReportRequest = (text) => Boolean(matchOf(text)) && !isCodeRequest(text) && !isBrainstormRequest(text);

// The subject without the request words: "write a report on tidal power" -> "tidal power".
export function reportTopic(text) {
  const t = String(text || '').trim();
  const folded = fold(t);
  const m = matchOf(t);
  if (!m) return t;
  // fold() keeps the length of precomposed text, so a match end in one is an index into the other
  const source = folded.length === t.length ? t : folded;
  const rest = source.slice(m[0].length);
  const link = LINK.exec(folded.slice(m[0].length))?.[0].length || 0;
  return rest.slice(link).trim() || t;
}

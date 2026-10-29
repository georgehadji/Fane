// The polite openings the request detectors (intent-article, intent-code, intent-brainstorm) skip before the request
// word: "please write …", "could you brainstorm …", «παρακαλω γραψε …». One list, so a phrasing that routes to one
// feature does not fall through to a search in the next (cli/test/intent-routing.test.mjs runs a table through all
// three). English as written; Greek over folded text (no accents, final sigma as sigma), as the detectors see it.
// Pure; imports nothing.
const EN = ['please', 'can you', 'could you', "i(?:'|’)d like you to", 'i want you to', 'i need you to', 'help me', "let(?:'|’)?s"];
const EL = ['παρακαλω', 'μπορεισ να', 'θα ηθελα να', 'θελω να'];

// Regex source for "any number of these openings, each followed by spaces". `extra`: regex sources a detector adds
// (the brainstorm detector also accepts «θελω» alone and "i need 10 names").
export const politeWith = (extra = []) => String.raw`(?:${[...EN, ...EL, ...extra].map(p => `${p}\\s+`).join('|')})*`;

export const POLITE = politeWith();

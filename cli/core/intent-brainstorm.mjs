// Is this prompt a request for ideas? Greek and English. A request word at the start, as for articles and code:
//  - "brainstorm ..." / «καταιγισμός ιδεών για ...»;
//  - an asking verb, then ideas, ways, names, titles ... and what they are for: "give me 10 ideas for a café",
//    "suggest names for my bakery", «δώσε μου ιδέες για ...», «πρότεινε τρόπους να ...»;
//  - "suggest ways <someone> can <do something>".
// Questions ("what are good ideas for ...?") and bare topics ("ideas for dinner") stay searches. "Alternatives"
// and "options" are left out: "suggest alternatives to Photoshop" asks for products that exist, which is a search.
import { fold } from './language.mjs';
import { politeWith } from './polite.mjs';

const POLITE = politeWith(['i need', 'i want']); // "i need 10 names", "i want some ideas"
const ASK = String.raw`(?:give me|give us|suggest|propose|come up with|think (?:of|up)|generate|list|pitch)`;
const HOW_MANY = String.raw`(?:(?:some|a few|several|a couple of|a list of|a bunch of|more|\d+|three|five|ten|twenty)\s+)?`;
const KIND = String.raw`(?:(?:new|fresh|creative|original|innovative|unusual|unconventional|good|great|bold|wild|clever|fun|practical|cheap)\s+)*`;
const THINGS = String.raw`(?:ideas?|ways|names|concepts|angles|approaches|themes|titles|slogans|taglines|hooks|strategies|uses)`;
const FOR = String.raw`\s+(?:for|to|on|about|how|that|in)\b`;

const EN_BRAINSTORM = new RegExp(String.raw`^\s*${POLITE}brainstorm(?:\s|$|[,:])`, 'iu');
const EN_ASK = new RegExp(String.raw`^\s*${POLITE}${ASK}\s+${HOW_MANY}${KIND}${THINGS}${FOR}`, 'iu');
// "suggest ways a small publisher can win authors": who does it, then a modal. Not after "list" or "generate":
// "list ways the virus can spread" asks for facts.
const EN_WAYS = new RegExp(String.raw`^\s*${POLITE}(?:give me|give us|suggest|propose|come up with|think (?:of|up)|pitch)\s+${HOW_MANY}${KIND}ways\s+(?:[\p{L}\d'’-]+\s+){1,6}?(?:can|could|might|should|would|will|may)\s+\p{L}`, 'iu');

// Greek, over folded text (no accents, final sigma as sigma). \b is ASCII-only, so a lookahead ends the words.
const EL_BRAINSTORM = /^\s*(?:brainstorm|καταιγισμοσ ιδεων|καταιγισμο ιδεων)(?![\p{L}])/iu;
const EL_ASK = new RegExp(String.raw`^\s*${politeWith(['θελω'])}(?:δωσε|δωστε|προτεινε|προτειντε|σκεψου|σκεφτειτε|βρες|βρειτε|φερε|γραψε|γραψτε|φτιαξε)\s+(?:μου\s+|μασ\s+)?(?:(?:\d+|μερικεσ|μερικουσ|μερικα|καποιεσ|καποιουσ|καποια|λιγεσ|λιγουσ|τρεισ|τρια|πεντε|δεκα|εικοσι)\s+)?(?:(?:νεεσ|νεουσ|νεα|πρωτοτυπεσ|πρωτοτυπουσ|πρωτοτυπα|δημιουργικεσ|δημιουργικουσ|καινοτομεσ|καινοτομουσ|καλεσ|καλουσ|καλα|εξυπνεσ|εξυπνουσ|εξυπνα)\s+)*(?:ιδεεσ|ιδεα|τροπουσ|ονοματα|τιτλουσ|συνθηματα|στρατηγικεσ)\s+(?:για|να|ωστε|πωσ|σχετικα|που|σε)(?![\p{L}])`, 'iu');

export function isBrainstormRequest(text) {
  const t = String(text || '');
  if (EN_BRAINSTORM.test(t) || EN_ASK.test(t) || EN_WAYS.test(t)) return true;
  const folded = fold(t);
  return EL_BRAINSTORM.test(folded) || EL_ASK.test(folded);
}

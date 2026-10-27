// Is this prompt a request to write an article, and about what? Greek and English.
// Like the image intent, it needs a writing verb at the start ("write an article about ...",
// "γράψε ένα άρθρο για ..."): "article about X" on its own is a search question and stays one.
// A bare "κείμενο" (text) is not enough either: it would catch ordinary questions.
import { detectLanguage, fold } from './language.mjs';

const POLITE = String.raw`(?:please\s+|can you\s+|could you\s+|i(?:'|’)d like you to\s+|i want you to\s+|παρακαλω\s+|μπορεισ να\s+|θα ηθελα να\s+|θελω να\s+)*`;
const EN_VERB = String.raw`(?:write|draft|compose|create|prepare|produce|generate)`;
const EN_NOUN = String.raw`(?:article|blog ?post|blog|essay|op-?ed|long-?form piece|report|white ?paper)`;
const EN_ADJ = String.raw`(?:(?:new|short|long|detailed|well[- ]researched|researched|in-depth|short|brief|full|complete|good|balanced|thoughtful|engaging|fact[- ]based|sourced),?\s+){0,3}`;
const EN = new RegExp(String.raw`^\s*${POLITE}${EN_VERB}\s+(?:me\s+|us\s+)?(?:(?:an?|the|one)\s+)?(?:\d{3,4}[- ]words?\s+)?${EN_ADJ}${EN_NOUN}s?(?![\p{L}])`, 'iu');

// Over folded text: no accents, final sigma written as sigma.
const EL_VERB = String.raw`(?:γραψε|γραψτε|γραψου|συνταξε|συνταξτε|δημιουργησε|δημιουργηστε|ετοιμασε|ετοιμαστε|φτιαξε|φτιαξτε|παραγαγε|γραψεισ|γραψετε)`;
const EL_NOUN = String.raw`(?:αρθρο\p{L}*|δοκιμι\p{L}*|εκθεσ\p{L}*|αναρτησ\p{L}*|ποστ|blogpost|blog post|blog)`;
const EL = new RegExp(String.raw`^\s*${POLITE}${EL_VERB}\s+(?:μου\s+|μασ\s+)?(?:(?:ενα|μια|μιασ|το|τον|την|εναν)\s+)?(?:\p{L}+\s+){0,2}?${EL_NOUN}(?![\p{L}])`, 'iu');

export const isArticleRequest = (text) => {
  const t = String(text || '');
  return EN.test(t) || EL.test(fold(t));
};

// Over folded text, after the request words: "about", "για", "σχετικά με" ...
const LINK = /^\s*(?:about|on|regarding|concerning|covering|exploring|that (?:explains|covers|looks at|argues)|of|for|για|σχετικα με|με θεμα|περι|πανω σε|οσον αφορα|που εξηγει|[:\-–])\s*/iu;

// The subject without the request words: "write an article about tidal power" -> "tidal power".
export function articleTopic(text) {
  const t = String(text || '').trim();
  const folded = fold(t);
  const m = EN.exec(t) || EL.exec(folded);
  if (!m) return t;
  // fold() keeps the length of precomposed text, so a match end in one is an index into the other
  const source = folded.length === t.length ? t : folded;
  const rest = source.slice(m[0].length);
  const link = LINK.exec(folded.slice(m[0].length))?.[0].length || 0;
  return rest.slice(link).trim() || t;
}

// Length asked for in the prompt: "an article of 800 words", "άρθρο 1200 λέξεων". Flags win over these words.
export function parseArticleOptions(text) {
  const folded = fold(text);
  const m = /(?<!\p{N})(\d{3,4})\s*[- ]?(?:words?|λεξεισ|λεξεων|λεξη)(?![\p{L}])/iu.exec(folded);
  const out = {};
  if (m) out.words = Number(m[1]);
  return out;
}

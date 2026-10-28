// Is this prompt a request to write an article, and about what? Greek and English.
// Like the image intent, it needs a writing verb at the start ("write an article about ...",
// "γράψε ένα άρθρο για ..."): "article about X" on its own is a search question and stays one.
// A bare "κείμενο" (text) is not enough either: it would catch ordinary questions.
import { isBrainstormRequest } from '../brainstorm/intent.mjs';
import { isCodeRequest } from '../code/intent.mjs';
import { DEFAULT_PLATFORM } from './formats.mjs';
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

// A code request is never an article: "write a report generator in Python" has "report" after the verb.
export const isArticleRequest = (text) => {
  const t = String(text || '');
  return (EN.test(t) || EL.test(fold(t))) && !isCodeRequest(t) && !isBrainstormRequest(t); // «γράψε 5 τίτλους για ...»
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
// Posts are shorter, so two-digit counts ("a 90-word post") are read for them.
export function parseArticleOptions(text, { post = false } = {}) {
  const folded = fold(text);
  const m = new RegExp(String.raw`(?<!\p{N})(\d{${post ? 2 : 3},4})\s*[- ]?(?:words?|λεξεισ|λεξεων|λεξη)(?![\p{L}])`, 'iu').exec(folded);
  const out = {};
  if (m) out.words = Number(m[1]);
  return out;
}

// Posts: "write a LinkedIn post about X", "draft a post for Facebook on X", «γράψε μια ανάρτηση για το LinkedIn
// για ...». Checked before isArticleRequest, which also matches «ανάρτηση» (a blog post, «ανάρτηση για το blog μου»,
// stays an article). A post request that names no platform gets DEFAULT_PLATFORM.
const PLATFORM = String.raw`(?:linkedin|λινκ(?:ε)?ντ(?:ι|ε)ν|facebook|φει?σ ?μπουκ|fb)`;
const EN_POST = new RegExp(String.raw`^\s*${POLITE}${EN_VERB}\s+(?:me\s+|us\s+)?(?:(?:an?|the|one)\s+)?(?:\d{2,4}[- ]words?\s+)?${EN_ADJ}(?:${PLATFORM}\s+)?(?:post|update)s?(?![\p{L}])`, 'iu');
const EL_POST = new RegExp(String.raw`^\s*${POLITE}${EL_VERB}\s+(?:μου\s+|μασ\s+)?(?:(?:ενα|μια|μιασ|το|την|εναν)\s+)?(?:\p{L}+\s+){0,2}?(?:αναρτησ\p{L}*|ποστ|post)(?![\p{L}])`, 'iu');
const platformIn = (folded) => {
  const m = new RegExp(String.raw`(?<![\p{L}])${PLATFORM}(?![\p{L}])`, 'iu').exec(folded);
  if (!m) return null;
  return /^(?:facebook|φει?σ ?μπουκ|fb)$/iu.test(m[0]) ? 'facebook' : 'linkedin';
};

export function postPlatform(text) {
  const folded = fold(text);
  if (!EN_POST.test(folded) && !EL_POST.test(folded)) return null;
  if (isCodeRequest(text) || isBrainstormRequest(text)) return null; // "write a LinkedIn post scheduler in Python", "give me ideas for LinkedIn posts"
  const platform = platformIn(folded);
  if (!platform && /(?<![\p{L}])blog/iu.test(folded)) return null;
  return platform || DEFAULT_PLATFORM;
}

// "for LinkedIn", «για το LinkedIn», «στο Facebook»: request words, not the subject.
const PLATFORM_PHRASE = new RegExp(String.raw`(?:^|\s+)(?:(?:for|on|in)\s+|(?:για|στο|σε)\s+(?:το\s+)?)?${PLATFORM}(?![\p{L}])`, 'iu');

// The subject of a post request: "write a LinkedIn post about tidal power" -> "tidal power".
export function postTopic(text) {
  const t = String(text || '').trim();
  const folded = fold(t);
  const m = EN_POST.exec(folded) || EL_POST.exec(folded);
  if (!m) return t;
  const source = folded.length === t.length ? t : folded;
  let rest = source.slice(m[0].length), restFolded = folded.slice(m[0].length);
  for (let i = 0; i < 3; i++) { // "for LinkedIn about", «για το LinkedIn σχετικά με»: platform and link words in any order
    const cut = (PLATFORM_PHRASE.exec(restFolded)?.index === 0 && PLATFORM_PHRASE.exec(restFolded)[0].length) || LINK.exec(restFolded)?.[0].length || 0;
    if (!cut) break;
    rest = rest.slice(cut);
    restFolded = restFolded.slice(cut);
  }
  // a platform named at the end: "... about tidal power, for LinkedIn"
  const tail = new RegExp(String.raw`[\s,]+(?:(?:for|on)\s+|(?:για|στο)\s+(?:το\s+)?)${PLATFORM}\s*[.!]?\s*$`, 'iu').exec(fold(rest));
  if (tail) rest = rest.slice(0, tail.index);
  return rest.trim() || t;
}

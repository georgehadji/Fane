// Is this prompt a request to write code? Greek and English. Like the article intent it needs a request verb at
// the start ("write a script that ...", «γράψε ένα πρόγραμμα που ...»): "python script for renaming files" on its
// own is a search question and stays one. Two ways in:
//  - a code noun after the verb (script, function, CLI, API, regex ...), followed by the end or a linking word, so
//    "build a tool shed" and "write an application letter" are not requests;
//  - any object written "in/using <language>" ("implement quicksort in Rust").
// Words that are also ordinary English (class, application, test, query, game, server) count only next to a
// language ("a Python class"). A text noun right after the verb (article, post, essay, poem ...) is never code:
// "write an article on machine learning in Python" stays an article. write/intent.mjs asks this module first.
import { fold } from '../write/language.mjs';

const POLITE = String.raw`(?:please\s+|can you\s+|could you\s+|i(?:'|’)d like you to\s+|i want you to\s+|i need you to\s+|παρακαλω\s+|μπορεισ να\s+|θα ηθελα να\s+|θελω να\s+)*`;
const EN_VERB = String.raw`(?:write|create|build|make|generate|implement|code|develop|program|scaffold|give me|show me)`;
// a language or stack word; "go", "c" and "r" only count after in/using/with (see IN_LANG)
const LANG = String.raw`(?:python|javascript|typescript|node(?:\.?js)?|deno|bun|golang|rust|java|kotlin|swift|c\+\+|cpp|c#|csharp|ruby|php|perl|bash|shell|powershell|sql|scala|haskell|elixir|dart|flutter|lua|julia|react|vue|svelte|angular|next\.?js|django|flask|fastapi|express|rails|laravel|spring|html|css|js|ts)`;
const STRONG = String.raw`(?:script|function|program|programme|module|library|package|cli|command[- ]line (?:tool|app|program|utility)|tool|utility|app|api|endpoint|bot|code|snippet|regex|regular expression|sql query|parser|scraper|crawler|algorithm|unit tests?|test suite|dockerfile|makefile|web ?app|webapp|microservice|component|plugin|extension|website|web ?page|landing page|(?:web|mobile|desktop|android|ios|console) application)`;
const WEAK = String.raw`(?:class|application|hook|tests?|query|game|service|server|backend|frontend)`;
const TEXT = String.raw`(?:article|blog ?post|blog|post|essay|op-?ed|report|white ?paper|poem|story|letter|email|e-mail|summary|speech|review|update)`;
// after the noun: the end, punctuation, or a word that goes on to say what it does
const NEXT = String.raw`(?=\s*$|\s*[.,:;!?(]|\s+(?:that|which|to|for|in|using|with|called|named|on|from|so|and|where|who|of)\b)`;
// a text noun used as a modifier ("a report generator") does not count
const TEXT_NEXT = String.raw`(?=\s*$|\s*[.,:;!?(]|\s+(?:that|which|to|for|in|on|of|about|regarding|explaining|covering|describing|summari[sz]ing|from|with|and)\b)`;
const ART = String.raw`(?:(?:an?|the|one|some|me|us)\s+)*`;
const WORDS = String.raw`(?:[\w.+#-]+\s+){0,3}?`;

const EN_START = new RegExp(String.raw`^\s*${POLITE}${EN_VERB}\s+`, 'iu');
const EN_TEXT = new RegExp(String.raw`^${ART}(?:[\w-]+\s+){0,3}?${TEXT}s?${TEXT_NEXT}`, 'iu');
const EN_STRONG = new RegExp(String.raw`^${ART}${WORDS}${STRONG}s?${NEXT}`, 'iu');
const EN_WEAK = new RegExp(String.raw`^${ART}(?:[\w.+#-]+\s+){0,2}?${LANG}\s+${WEAK}e?s?${NEXT}`, 'iu');
const IN_LANG = new RegExp(String.raw`\b(?:in|using|with)\s+(?:${LANG}|go|c|r)(?![\w+#])`, 'iu');

// Greek, over folded text (no accents, final sigma as sigma).
const EL_VERB = String.raw`(?:γραψε|γραψτε|φτιαξε|φτιαξτε|δημιουργησε|δημιουργηστε|υλοποιησε|υλοποιηστε|αναπτυξε|αναπτυξτε|προγραμματισε|προγραμματιστε|κωδικοποιησε)`;
const EL_START = new RegExp(String.raw`^\s*${POLITE}${EL_VERB}\s+`, 'iu');
const EL_ART = String.raw`(?:(?:μου|μασ|ενα|μια|μιασ|το|τον|την|εναν|λιγο|καποιο|καποια)\s+)*`;
const EL_TEXT = new RegExp(String.raw`^${EL_ART}(?:\p{L}+\s+){0,2}?(?:αρθρο|δοκιμι|εκθεσ|αναρτησ|ποστ|ποιημα|ιστορι|επιστολ|γραμμα|email|περιληψ|ομιλι|κειμεν)\p{L}*`, 'iu');
const EL_STRONG = new RegExp(String.raw`^${EL_ART}(?:[\p{L}\w.+#-]+\s+){0,3}?(?:κωδικα|κωδικο|προγραμμα\p{L}*|συναρτησ\p{L}*|script|σκριπτ\p{L}*|βιβλιοθηκ\p{L}*|εφαρμογ\p{L}*|api|bot|μποτ|αλγοριθμ\p{L}*|εργαλει\p{L}*|ιστοσελιδ\p{L}*|website|regex|cli)(?![\p{L}])`, 'iu');
const EL_IN_LANG = new RegExp(String.raw`(?:σε|με)\s+(?:την\s+|το\s+|τη\s+)?(?:${LANG}|go|c)(?![\w+#])`, 'iu');

export function isCodeRequest(text) {
  const t = String(text || '');
  const en = EN_START.exec(t);
  if (en) {
    const rest = t.slice(en[0].length);
    if (EN_TEXT.test(rest)) return false;
    return EN_STRONG.test(rest) || EN_WEAK.test(rest) || IN_LANG.test(rest);
  }
  const folded = fold(t);
  const el = EL_START.exec(folded);
  if (!el) return false;
  const rest = folded.slice(el[0].length);
  if (EL_TEXT.test(rest)) return false;
  return EL_STRONG.test(rest) || EL_IN_LANG.test(rest);
}

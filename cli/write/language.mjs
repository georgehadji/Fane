// Language handling for articles: which language a request is in, and the language-specific
// "sounds machine-written" patterns (tells) and typography faults a deterministic check can count.
// Pure functions, no I/O. English tells are condensed from the Humanizer rules
// (HUMANIZER.md in github.com/georgehadji/reasoner, MIT; after Wikipedia's "Signs of AI writing").
// The Greek list is written natively, not translated: Greek has its own tells (participle tails
// such as "αναδεικνύοντας", "καθοριστικό ρόλο", "Αξίζει να σημειωθεί").

export const LANGUAGES = ['en', 'el'];
export const LANGUAGE_NAMES = { en: 'English', el: 'Greek' };

// Lowercase, without accents, final sigma as sigma: "Αναδεικνύοντας" and "αναδεικνυοντασ" compare equal.
export const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ');

const GREEK_LETTER = /[Ͱ-Ͽἀ-῿]/gu;
const LETTER = /\p{L}/gu;

// 'el' when a third or more of the letters are Greek; 'en' otherwise. A mostly-Latin prompt that
// quotes a Greek word stays English; "Γράψε ένα άρθρο για AI" is Greek.
export function greekShare(text) {
  const letters = String(text || '').match(LETTER)?.length || 0;
  return letters ? (String(text).match(GREEK_LETTER)?.length || 0) / letters : 0;
}
export const detectLanguage = (text) => (greekShare(text) >= 0.33 ? 'el' : 'en');

// A phrase or stem not glued to other letters (JS \b only knows ASCII letters).
const stem = (s) => new RegExp(`(?<!\\p{L})${s}`, 'gu');
const word = (s) => new RegExp(`(?<!\\p{L})${s}(?!\\p{L})`, 'gu');

// [label, regex] over text that has been through fold().
const TELLS = {
  en: [
    ['significance', word('(?:stands as|serves as|is a testament|a testament to|pivotal|plays an? (?:vital|crucial|key|pivotal|significant) role|underscor\\w*|indelible|enduring legacy|evolving landscape|broader trends?)')],
    ['promotional', word('(?:vibrant|breathtaking|stunning|nestled|rich (?:cultural )?(?:heritage|tapestry)|tapestry|groundbreaking|renowned|boasts?)')],
    ['ai-vocabulary', word('(?:delve\\w*|intricate|interplay|foster\\w*|garner\\w*|showcas\\w*|seamless\\w*|robust|leverag\\w*|navigat\\w+ the|realm of|unlock\\w*)')],
    ['filler', word('(?:it is important to note|it(?:\'|’)s worth noting|it is worth noting|in today(?:\'|’)s (?:world|age|landscape)|in conclusion|in summary|at the end of the day|when it comes to)')],
    ['vague-attribution', word('(?:experts (?:say|argue|believe)|some critics argue|industry reports|observers have cited|studies show)')],
    ['negative-parallelism', word('(?:not just|not only|it(?:\'|’)s not (?:just|merely|simply)|is not (?:just|merely|simply))')],
    ['generic-conclusion', word('(?:the future (?:looks|is) bright|paves the way|exciting times? (?:lie|are) ahead|journey of discovery|only time will tell)')],
    ['chatbot', word('(?:i hope this helps|let me know if|certainly!|great question|as an ai)')],
    // the article talks about its evidence instead of its subject (a Quality run: "None of these sources show ...")
    ['source-talk', word('(?:the (?:cited )?sources? (?:does not|doesn(?:\'|’)t|do not|don(?:\'|’)t|did not|says? nothing|gives? no|offers? no|provides? no)|none of (?:these|the|its|their) sources|no source (?:says|states|shows|gives)|according to the (?:available|cited) (?:data|sources|information|evidence))')],
  ],
  el: [
    ['participle-tail', new RegExp('[,;·]\\s+(?<!\\p{L})\\p{L}{4,}(?:οντασ|ωντασ)(?!\\p{L})', 'gu')],
    ['significance', stem('(?:καθοριστικ\\p{L}* ρολο|κομβικ\\p{L}* ρολο|διαδραματιζ\\p{L}* (?:\\p{L}+ )?ρολο|ζωτικησ σημασιασ|κομβικησ σημασιασ|υψιστησ σημασιασ|αποτελει (?:μαρτυρια|φαρο|απολυτη αποδειξη)|σημαντικο οροσημο|σημειο καμπησ|διαχρονικη αξια|στο επικεντρο|υπογραμμιζει τη σημασια|αναδεικνυει τη σημασια|αδιαμφισβητητ\\p{L}*)')],
    ['promotional', stem('(?:μοναδικ(?:οσ|η|ο|ων)(?!\\p{L})|εντυπωσιακ\\p{L}*|συναρπαστικ\\p{L}*|ανεπαναληπτ\\p{L}*|πρωτοποριακ\\p{L}*|κορυφαι\\p{L}*|μαγευτικ\\p{L}*|ειδυλλιακ\\p{L}*|πλουσια πολιτιστικη κληρονομια)')],
    ['ai-vocabulary', stem('(?:πολυδιαστατ\\p{L}*|πολυεπιπεδ\\p{L}*|ολιστικ\\p{L}*|δυναμικο τοπιο|εξελισσομενο τοπιο|ευρυ φασμα|διαφορεσ πτυχεσ|ολεσ τισ πτυχεσ|συμβολιζει|αντανακλα(?:ται)?(?!\\p{L})|σημειωθηκε (?:αυξηση|μειωση)|πραγματοποιηθηκε|προβαιν\\p{L}* σε)')],
    ['filler', stem('(?:ειναι σημαντικο να (?:σημειωθει|τονιστει)|αξιζει να σημειωθει|αξιζει να αναφερθει|θα πρεπει να επισημανθει|ειναι γεγονοσ οτι|δεν θα ηταν υπερβολη|σε τελικη αναλυση|εν κατακλειδι|συνοψιζοντασ|σε ενα κοσμο που|σε εναν κοσμο που|στη σημερινη εποχη|στην εποχη μασ|στον σημερινο κοσμο|σε αυτο το αρθρο θα|ασ δουμε|ασ εξερευνησουμε)')],
    ['vague-attribution', stem('(?:οι ειδικοι υποστηριζουν|πολλοι ειδικοι|συμφωνα με ειδικουσ|συμφωνα με μελετεσ|ερευνεσ δειχνουν|οπωσ ειναι γνωστο|ειναι γνωστο οτι)')],
    ['negative-parallelism', stem('(?:δεν ειναι απλωσ|δεν ειναι απλα|δεν αποτελει απλωσ|δεν αφορα μονο|οχι απλωσ)')],
    ['generic-conclusion', stem('(?:το μελλον (?:ειναι ευοιωνο|προμηνυεται)|ανοιγει νεουσ (?:οριζοντεσ|δρομουσ)|ανοιγουν νεουσ (?:οριζοντεσ|δρομουσ)|ταξιδι ανακαλυψησ|(?:παρα)?μενει να δουμε|μονο ο χρονοσ θα δειξει)')],
    ['chatbot', stem('(?:ελπιζω αυτο να βοηθα|φυσικα!|ασφαλωσ!|ωσ μοντελο|ωσ τεχνητη νοημοσυνη|θα ηθελεσ να)')],
    // «Η πηγή δεν δίνει σαφές έτος», «Ούτε προκύπτει από τις πηγές» (a Quality run)
    ['source-talk', stem('(?:(?:η|οι) πηγ(?:η|εσ) (?:\\p{L}+ )?δεν|καμια (?:απο τισ )?πηγ\\p{L}* δεν|προκυπτει απο τισ πηγεσ|απο τισ πηγεσ (?:δεν )?προκυπτει|επικαλειται η πηγη|συμφωνα με τα διαθεσιμα στοιχεια)')],
  ],
};

export const wordCount = (text) => (String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

// -> { total, perThousand, hits: [{ label, count }] }, most frequent first. Counts, never fixes:
// the pipeline reports it and the editing passes are told which kinds to remove.
export function countTells(text, lang) {
  const folded = fold(text);
  const hits = (TELLS[lang] || []).map(([label, re]) => ({ label, count: folded.match(re)?.length || 0 })).filter(h => h.count);
  hits.sort((a, b) => b.count - a.count);
  const total = hits.reduce((n, h) => n + h.count, 0);
  const words = wordCount(text);
  return { total, perThousand: words ? Math.round((total / words) * 10000) / 10 : 0, hits };
}

// Models sometimes put a Latin look-alike (o, a, e, p, x, v ...) inside a Greek word; the word then
// searches, sorts and copies wrongly although it reads fine. -> the offending words.
const MIXED_OK = /^[μΩ]\p{Script=Latin}{1,2}$/u; // units: μm, μg, Ωm
export function findHomoglyphs(text) {
  const out = [];
  for (const w of String(text || '').match(/[\p{L}\p{M}]+/gu) || []) {
    if (/\p{Script=Greek}/u.test(w) && /\p{Script=Latin}/u.test(w) && !MIXED_OK.test(w)) out.push(w);
  }
  return [...new Set(out)];
}

// Greek typography faults: straight quotes where « » belong, "?" where Greek uses ";", polytonic
// accents in modern text. -> [{ name, count }] (only non-zero).
export function greekTypography(text) {
  const t = String(text || '');
  const found = [
    ['straight quotes (use « »)', (t.match(/"[^"\n]{2,}"/g) || []).length],
    ['"?" as question mark (Greek uses ";")', (t.match(/\p{Script=Greek}[»”’)\]]*\?/gu) || []).length],
    ['polytonic accents', (t.match(/[ἀ-῿]/g) || []).length],
  ];
  return found.filter(([, count]) => count).map(([name, count]) => ({ name, count }));
}

// Latin letters that look like Greek ones, for repairing a Greek word that contains them.
const LATIN_TO_GREEK = { A: 'Α', B: 'Β', E: 'Ε', Z: 'Ζ', H: 'Η', I: 'Ι', K: 'Κ', M: 'Μ', N: 'Ν', O: 'Ο', P: 'Ρ', T: 'Τ', Y: 'Υ', X: 'Χ', a: 'α', o: 'ο', e: 'ε', i: 'ι', k: 'κ', p: 'ρ', v: 'ν', u: 'υ', x: 'χ', n: 'η', y: 'γ' };

// Replace the look-alikes inside mixed words; a word with a Latin letter that has no look-alike
// (a brand such as "iPhone" glued to a Greek ending) is left alone and still reported by findHomoglyphs.
export function repairHomoglyphs(text) {
  const fixed = [];
  const out = String(text || '').replace(/[\p{L}\p{M}]+/gu, (w) => {
    if (!/\p{Script=Greek}/u.test(w) || !/\p{Script=Latin}/u.test(w) || MIXED_OK.test(w)) return w;
    const latin = w.match(/\p{Script=Latin}/gu);
    if (!latin.every(ch => LATIN_TO_GREEK[ch])) return w;
    fixed.push(w);
    return w.replace(/\p{Script=Latin}/gu, ch => LATIN_TO_GREEK[ch]);
  });
  return { text: out, fixed: [...new Set(fixed)] };
}

// The final ν that models drop: «την», «στην», «μην» keep it before a vowel and before κ, π, τ, ξ, ψ, γκ, μπ,
// ντ, τσ, τζ (a live Greek article had «στη ξηρά»). Safe in code because «τη», «στη» and «μη» are never
// neuter; «το(ν)» is left alone, since the neuter «το» never takes it.
const NU_BEFORE = /(?<!\p{L})(στη|τη|μη)(\s+)(?=[αεηιουωάέήίόύώϊϋΐΰκπτξψ]|γκ|μπ|ντ|τσ|τζ)/giu;
export function repairFinalNu(text) {
  const fixed = [];
  const out = String(text || '').replace(NU_BEFORE, (m, w, space, at, all) => {
    fixed.push(`${w}${space}${all.slice(at + m.length).match(/^\p{L}+/u)?.[0] || ''}`);
    return `${w}${w.at(-1) === w.at(-1).toUpperCase() ? 'Ν' : 'ν'}${space}`;
  });
  return { text: out, fixed };
}

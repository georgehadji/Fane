// Code and prose in Markdown text. Cleanup that rewrites model text (whitespace, HTML tags) must leave code alone:
// `Promise<string>` is not a tag, and the indentation of a Python block is not a double space.
// Pure; imports nothing. Fenced blocks (``` or ~~~, closed by a fence of the same character and at least the same
// length, or by the end of the text) and inline code spans (a backtick run closed by a run of the same length) are code.
// shortcut: indented code blocks (4 spaces) are not recognised; no model output here uses them.

const SPAN = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

// text -> [{ code, fenced, text }] in order; joining the texts gives the input back. `fenced` is set for fenced blocks only.
export function segments(text) {
  const out = [];
  const push = (code, fenced, t) => {
    if (!t) return;
    const last = out.at(-1);
    if (last && last.code === code && last.fenced === fenced) last.text += t; else out.push({ code, fenced, text: t });
  };
  let prose = '', fence = null;
  const flush = () => {
    let i = 0;
    for (const m of prose.matchAll(SPAN)) { push(false, false, prose.slice(i, m.index)); push(true, false, m[0]); i = m.index + m[0].length; }
    push(false, false, prose.slice(i));
    prose = '';
  };
  for (const line of String(text).split(/(?<=\n)/)) {
    if (fence) {
      push(true, true, line);
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    // a backtick fence's info string has no backtick: "```x```" is an inline span, not a fence
    if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) { flush(); fence = open[1]; push(true, true, line); continue; }
    prose += line;
  }
  flush();
  return out;
}

// `fn` applied to prose only (no fenced block, no inline span).
export const mapProse = (text, fn) => segments(text).map(s => (s.code ? s.text : fn(s.text))).join('');

// `fn` applied to everything between fenced blocks, inline spans included; for line-level cleanup.
export function mapOutsideFences(text, fn) {
  let out = '', run = '';
  for (const s of segments(text)) {
    if (s.fenced) { out += fn(run) + s.text; run = ''; } else run += s.text;
  }
  return out + fn(run);
}

const urlKey = (u) => String(u).trim().replace(/[.,;:!?]+$/, '').replace(/\/+$/, '').toLowerCase();

// Prose may link only to `allowed` URLs (what the run retrieved). A Markdown link to any other address keeps its text
// and loses the link; a bare URL is dropped. Code is left alone: a URL there is an example, not a citation.
// -> { text, removed: [url...] } in order of first appearance.
export function enforceCitations(text, allowed) {
  const ok = new Set([...allowed].map(urlKey));
  const removed = [];
  const out = mapProse(text, (prose) => prose
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi, (m, label, url) => {
      if (ok.has(urlKey(url))) return m;
      removed.push(url);
      return label;
    })
    .replace(/https?:\/\/[^\s)\]<>]+/gi, (url) => {
      if (ok.has(urlKey(url))) return url;
      removed.push(url);
      return '';
    }));
  return { text: out, removed: [...new Set(removed)] };
}

// The text with its fenced blocks removed.
export const withoutFences = (text) => segments(text).filter(s => !s.fenced).map(s => s.text).join('');

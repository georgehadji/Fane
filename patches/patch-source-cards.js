// Vane: citation chips that name their site and show the source on hover, as Perplexity does.
// Vane drew each [n] as a grey chip with the number only; seeing what a sentence rests on meant opening the link.
//  1. The chat code (FILES.chatClient) turns "[1, 4]" into one chip instead of two, and adjacent chips ("[1][4]",
//     "[1] [4]") into one as well: the chip's text is the list of numbers, its href the first source's address.
//  2. The message code (FILES.messageClient) passes the answer's sources (`p`, the same flat list the chat code
//     numbers) to the chip through markdown-to-jsx's override props, as Vane already does for <think>.
//  3. The chip (CHIP) shows the first source's site ("reddit", "wikipedia") and "+1" for each further one. Hovering
//     (150 ms) or focusing it opens a card: favicon and host, title (the link), about 220 characters of the source's
//     text, the platform label of patch-social-sources, and a 1/2 pager when the chip holds several sources. Leaving
//     closes it after 120 ms, so the pointer can move into the card; Esc, scrolling and a tap elsewhere close it too.
//     On touch the first tap opens the card and the title opens the source. The card is position:fixed, placed from
//     the chip's box, kept 16px from the screen's sides and flipped above the chip near the bottom.
//  4. One CSS block at the end of FILES.appCss in patch-colors' palette.
// Favicons come from Google's favicon service (Vane's source cards already use it) and are asked for by host only.
// Browser files only (max-age=0): a normal reload picks the change up, no restart.
const { run } = require('./lib/apply-targets');
const { APP_CSS_END: END, FILES } = require('./lib/vane');

// (sources, children, href) -> one entry per cited source, in the order of the chip's numbers. Injected as-is into
// the bundle (no imports, no closure, ASCII only), and exported for its test.
function CITE_ITEMS(sources, children, href) {
  var S = Array.isArray(sources) ? sources : [];
  var text = [].concat(children == null ? [] : children).join('');
  var seen = {}, out = [];
  function one(s) {
    var m = (s && s.metadata) || {}, url = String(m.url || ''), file = url.indexOf('file_id://') === 0, host = '';
    try { host = file ? '' : new URL(url).hostname.replace(/^www\d*\./, ''); } catch (e) { host = ''; }
    var parts = host.split('.'), k = parts.length - 2;
    if (k > 0 && parts[k + 1].length === 2 && /^(co|com|gov|ac|org|net|edu|or|ne|go)$/.test(parts[k])) k--;
    var site = file ? String(m.fileName || 'file') : parts[Math.max(k, 0)] || url;
    var body = String((s && s.content) || ''), label = '';
    var lm = /^\[((?:Reddit|Hacker News|Lemmy(?: comment)?|Stack Overflow|Super User|Ask Ubuntu)(?: \| [^\]\n]*)?)\]\s*/.exec(body);
    if (lm) { label = lm[1]; body = body.slice(lm[0].length); }
    var t = body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, '').replace(/\*\*|__|`|\|/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length > 220) {
      var cut = t.slice(0, 220), sp = cut.lastIndexOf(' ');
      t = (sp > 120 ? cut.slice(0, sp) : cut).replace(/[\s,.;:\u2013\u2014-]+$/, '') + '\u2026';
    }
    return {
      url: url, site: site, host: file ? 'Uploaded file' : host, title: String(m.title || host || url), text: t, label: label,
      icon: host ? 'https://s2.googleusercontent.com/s2/favicons?sz=32&domain=' + encodeURIComponent(host) : '',
    };
  }
  text.split(',').forEach(function (x) {
    var n = parseInt(x, 10);
    if (!(n > 0) || seen[n] || !S[n - 1]) return;
    seen[n] = 1;
    out.push(one(S[n - 1]));
  });
  if (!out.length && href) {
    var hit = S.filter(function (s) { return s && s.metadata && s.metadata.url === href; })[0];
    out.push(one(hit || { metadata: { url: href } }));
  }
  return out;
}

// The chip component: (props, react/jsx-runtime, React, CITE_ITEMS). Injected as-is like CITE_ITEMS.
function CHIP(P, R, C, ITEMS) {
  var h = R.jsx, hs = R.jsxs;
  var items = ITEMS(P.sources, P.children, P.href);
  var o = C.useState(false), open = o[0], setOpen = o[1];
  var g = C.useState(0), page = g[0], setPage = g[1];
  var q = C.useState(null), pos = q[0], setPos = q[1];
  var wrap = C.useRef(null), chip = C.useRef(null), card = C.useRef(null);
  var timer = C.useRef(0), hover = C.useRef(false), mute = C.useRef(false), wasOpen = C.useRef(false), touch = C.useRef(false);
  var id = 'fane-cite-' + String(C.useId ? C.useId() : '').replace(/[^\w-]/g, '');
  function set(v, ms) {
    clearTimeout(timer.current);
    if (ms) timer.current = setTimeout(function () { setOpen(v); }, ms); else setOpen(v);
  }
  C.useEffect(function () { return function () { clearTimeout(timer.current); }; }, []);
  C.useEffect(function () { if (!open) { setPos(null); setPage(0); } }, [open]);
  C.useLayoutEffect(function () {
    if (!open || !chip.current || !card.current) return;
    var a = chip.current.getBoundingClientRect(), b = card.current.getBoundingClientRect();
    var vw = document.documentElement.clientWidth, vh = window.innerHeight, m = 16;
    var top = a.bottom + 6;
    if (top + b.height > vh - m && a.top - 6 - b.height >= m) top = a.top - 6 - b.height;
    setPos({ left: Math.max(m, Math.min(a.left, vw - m - b.width)), top: top });
  }, [open, page]);
  C.useEffect(function () {
    if (!open) return;
    function key(e) {
      if (e.key !== 'Escape') return;
      if (wrap.current && wrap.current.contains(document.activeElement) && chip.current) { mute.current = true; chip.current.focus(); }
      set(false);
    }
    function away(e) { if (wrap.current && !wrap.current.contains(e.target)) set(false); }
    function scroll(e) { if (!(card.current && card.current.contains(e.target))) set(false); }
    function resize() { set(false); }
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', away);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return function () {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  if (!items.length) return h('a', { href: P.href, target: '_blank', rel: 'noopener', className: 'fane-cite-chip', children: P.children });
  var it = items[Math.min(page, items.length - 1)], n = items.length;
  var more = n > 1 ? ' +' + (n - 1) : '';
  function turn(d) { return function (e) { e.preventDefault(); setPage(function (p) { return (p + d + n) % n; }); }; }
  var head = [
    it.icon ? h('img', { src: it.icon, alt: '', width: 16, height: 16, loading: 'lazy', referrerPolicy: 'no-referrer' }, 'i') : null,
    h('span', { className: 'fane-cite-host', children: it.host || it.site }, 'h'),
    it.label ? h('span', { className: 'fane-cite-label', children: it.label }, 'l') : null,
    n > 1 ? hs('span', { className: 'fane-cite-pager', children: [
      h('button', { type: 'button', onClick: turn(-1), 'aria-label': 'Previous source', children: '\u2039' }, 'p'),
      h('span', { 'aria-live': 'polite', children: (page + 1) + '/' + n }, 'c'),
      h('button', { type: 'button', onClick: turn(1), 'aria-label': 'Next source', children: '\u203a' }, 'n'),
    ] }, 'g') : null,
  ];
  return hs('span', {
    ref: wrap,
    className: 'fane-cite' + (open ? ' fane-cite-open' : ''),
    onPointerEnter: function (e) { if (e.pointerType === 'mouse') { hover.current = true; set(true, 150); } },
    onPointerLeave: function (e) { if (e.pointerType === 'mouse') { hover.current = false; set(false, 120); } },
    onFocus: function () { if (mute.current) mute.current = false; else set(true); },
    onBlur: function (e) { if (!hover.current && !(wrap.current && wrap.current.contains(e.relatedTarget))) set(false); },
    children: [
      h('a', {
        ref: chip,
        href: it.url || P.href,
        target: '_blank',
        rel: 'noopener',
        className: 'fane-cite-chip',
        'aria-describedby': open ? id : undefined,
        onPointerDown: function (e) { touch.current = e.pointerType !== 'mouse'; wasOpen.current = open; },
        onClick: function (e) { if (touch.current && !wasOpen.current) { e.preventDefault(); set(true); } },
        children: items[0].site + more,
      }, 'a'),
      open ? hs('span', {
        ref: card,
        id: id,
        className: 'fane-cite-card',
        style: pos ? { left: pos.left + 'px', top: pos.top + 'px' } : { left: '0px', top: '0px', visibility: 'hidden' },
        children: [
          hs('span', { className: 'fane-cite-head', children: head }, 'hd'),
          h('a', { href: it.url, target: '_blank', rel: 'noopener', className: 'fane-cite-title', children: it.title }, 't'),
          it.text ? h('span', { className: 'fane-cite-text', children: it.text }, 'x') : null,
        ],
      }, 'c') : null,
    ],
  });
}

// ChatProvider, inside the "[x]" rewrite: `l` is the answer's sources, `a` the cited source's address.
const CHIP_HTML = 'return a?`<citation href="${a}">${e}</citation>`:""}).join(""))';
// The pieces of one bracket are joined with no space, so this makes them one chip, and also chips that only spaces
// part ("[1] [4]"); a line break is left alone, so a paragraph's last chip never joins the next one's first.
const MERGE = String.raw`.replace(/<\/citation>[ \t]*<citation href="[^"]*">/g,",")`;
// The message component: `ee` is Vane's chip, `r` react/jsx-runtime and `c` React in this chunk.
const VANE_CHIP = 'ee=({href:e,children:t})=>(0,r.jsx)("a",{href:e,target:"_blank",className:"bg-light-secondary dark:bg-dark-secondary px-1 rounded ml-1 no-underline text-xs text-black/70 dark:text-white/70 relative",children:t})';

// Light: chip on patch-colors' card tone, card on a lifted paper; dark: the lifted charcoal. Accent #9e4420 / #e0805a.
// The card sits inside .prose, so it resets the prose font (Literata), image margins and link underline.
const STYLE = String.raw`/*fane:source-cards*/
.fane-cite{white-space:nowrap}
.prose a.fane-cite-chip,a.fane-cite-chip{display:inline-block;max-width:12em;overflow:hidden;text-overflow:ellipsis;vertical-align:1px;margin-left:4px;padding:0 7px;border-radius:999px;background:#efe8dc;color:#5c5246;font:500 12px/18px Commissioner,Montserrat,Arial,sans-serif;text-decoration:none;transition:background-color .12s,color .12s}
.dark .prose a.fane-cite-chip,.dark a.fane-cite-chip{background:#2a251c;color:#a39a8c}
.prose a.fane-cite-chip:hover,.fane-cite-open>a.fane-cite-chip{background:#e2d8c7;color:#9e4420}
.dark .prose a.fane-cite-chip:hover,.dark .fane-cite-open>a.fane-cite-chip{background:#322c22;color:#e0805a}
.fane-cite-card{position:fixed;z-index:60;display:block;box-sizing:border-box;width:min(320px,calc(100vw - 32px));padding:12px 14px;border:1px solid #e2d8c7;border-radius:12px;background:#fffdf9;color:#3d362e;box-shadow:0 10px 30px rgb(61 54 46/.16);white-space:normal;text-align:left;font:400 13px/1.45 Commissioner,Montserrat,Arial,sans-serif;animation:fane-cite-in .12s ease-out}
.dark .fane-cite-card{border-color:#322c22;background:#1f1b14;color:#ede6da;box-shadow:0 10px 30px rgb(0 0 0/.5)}
.fane-cite-head{display:flex;align-items:center;gap:6px;min-height:20px;color:#5c5246;font-size:12px}
.dark .fane-cite-head{color:#a39a8c}
.prose .fane-cite-head img{display:block;width:16px;height:16px;margin:0;border-radius:4px}
.fane-cite-host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fane-cite-label{flex:none;padding:0 6px;border-radius:999px;background:#efe8dc;font-size:11px;line-height:18px}
.dark .fane-cite-label{background:#2a251c}
.fane-cite-pager{display:flex;align-items:center;gap:2px;margin-left:auto;flex:none;font-variant-numeric:tabular-nums}
.fane-cite-pager button{width:24px;height:24px;border-radius:6px;color:inherit;font-size:16px;line-height:1}
.fane-cite-pager button:hover{background:#efe8dc;color:#9e4420}
.dark .fane-cite-pager button:hover{background:#2a251c;color:#e0805a}
.prose a.fane-cite-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin:6px 0 4px;color:inherit;font-size:14px;font-weight:600;line-height:1.35;text-decoration:none}
.prose a.fane-cite-title:hover{color:#9e4420;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:.18em}
.dark .prose a.fane-cite-title:hover{color:#e0805a}
.fane-cite-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;color:#5c5246}
.dark .fane-cite-text{color:#a39a8c}
@media (pointer:coarse){.fane-cite-pager button{width:44px;height:44px}}
@keyframes fane-cite-in{from{opacity:0;transform:translateY(-2px)}}
@media (prefers-reduced-motion:reduce){.fane-cite-card{animation:none}.prose a.fane-cite-chip,a.fane-cite-chip{transition:none}}`;

const TARGETS = [
  { name: 'one chip per citation group', file: FILES.chatClient, from: CHIP_HTML, to: CHIP_HTML + MERGE, marker: MERGE.slice(0, MERGE.indexOf('href')) },
  {
    name: 'chips get the answer\'s sources',
    file: FILES.messageClient,
    from: 'citation:{component:ee}',
    to: 'citation:{component:ee,props:{sources:p}}',
  },
  { name: 'chip with site name and source card', file: FILES.messageClient, from: VANE_CHIP, to: `ee=((F,I)=>P=>F(P,r,c,I))(${CHIP},${CITE_ITEMS})` },
  { name: 'source card styles', file: FILES.appCss, from: END, to: `${END}\n${STYLE}\n`, marker: '/*fane:source-cards*/' },
];

module.exports = { TARGETS, CHIP, CITE_ITEMS, MERGE };
if (require.main === module) run('patch-source-cards', TARGETS);

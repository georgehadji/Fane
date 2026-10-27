// Fane page: the live receipt, the switches, copy buttons, entrances and the scroll-linked wordmark.
// Nothing here is needed to read the page: without script every picture, receipt and answer is already in the HTML.
(() => {
  'use strict';
  const NB = ' ';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Real runs: the same prompt through each of Fane's three tiers, four pictures each. Model names and
  // prices are OpenRouter's for those runs (October 2026). In the Quality run the fourth model
  // (Riverflow V2.5 Pro) timed out, so its fallback drew that picture.
  const PROMPT_ALT = 'a copper weathervane rooster on a stone barn roof under a stormy sky';
  const TIERS = {
    speed: {
      label: 'Speed',
      note: 'Speed draws from the cheapest third of the image models. Four images cost 1.8 cents.',
      pics: [['Seedream 5.0 Pro', 0.003], ['Qwen Image 3 Pro', 0.003], ['Muse Image', 0.00309], ['Krea 2 Medium', 0.00927]],
      file: 'budget',
    },
    balanced: {
      label: 'Balanced',
      note: 'Balanced draws from the middle third. Four images cost 6.5 cents.',
      pics: [['FLUX.2 Max', 0.02205], ['Qwen Image 2.1 Pro', 0.01421], ['Grok Imagine Image Quality', 0.01], ['Krea 2 Large', 0.01854]],
      file: 'value',
    },
    quality: {
      label: 'Quality',
      note: 'Quality draws from the dearest third. Four images cost 38 cents. Here the fourth model timed out, so its fallback drew that picture.',
      pics: [['Nano Banana Pro (Gemini 3 Pro Image)', 0.1548], ['MAI-Image-2.5 Pro', 0.13932], ['Recraft V4.1 Pro', 0.06489], ['MAI-Image-2.6 Flash', 0.02451]],
      file: 'premium',
    },
  };
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  // The same reading Fane's chat hook does: a count in the request ("2 images", "three pictures").
  const COUNT = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight)\s+(?:[a-z-]+\s+){0,2}(?:images?|pictures?|photos?)\b/i;
  const money = (n) => `$${n.toFixed(3)}`;

  const q = document.getElementById('q');
  const pics = document.getElementById('pics');
  const receipt = document.getElementById('receipt');
  const note = document.getElementById('mode-note');
  const answer = document.getElementById('answer');
  const modes = [...document.querySelectorAll('input[name="mode"]')];

  const asked = () => {
    const m = COUNT.exec(q.value);
    const n = m ? Number(m[1]) || WORDS[m[1].toLowerCase()] : 4;
    return Math.min(Math.max(n || 4, 1), 4);
  };

  function render(reprint) {
    const tier = TIERS[modes.find((r) => r.checked).value];
    const n = asked();
    const shown = tier.pics.slice(0, n);
    const total = shown.reduce((s, p) => s + p[1], 0);
    pics.innerHTML = shown.map(([name, price], i) =>
      `<figure><img src="img/${tier.file}-${i + 1}.jpg" width="1200" height="1200" alt="Image ${i + 1} of ${n}: ${PROMPT_ALT}" loading="lazy"><figcaption><b>${name}</b><span>· ≈${NB}${money(price)}</span></figcaption></figure>`).join('');
    receipt.textContent = `${n}${NB}image${n > 1 ? 's' : ''} · ≈${NB}${money(total)} · ${tier.label}`;
    note.textContent = tier.note;
    if (reprint && !reduce) {
      answer.classList.remove('reprint');
      void answer.offsetWidth; // restart the animation
      answer.classList.add('reprint');
    }
  }

  if (q) {
    q.addEventListener('input', () => render(true));
    modes.forEach((r) => r.addEventListener('change', () => render(true)));
    document.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => {
      q.value = b.dataset.example; render(true); q.focus();
    }));
    render(false);
  }

  // Sentences with switches: click, Space and Enter (native button), and the consequence line follows.
  document.querySelectorAll('.band').forEach((band) => {
    const sw = band.querySelector('.switch');
    sw.addEventListener('click', () => {
      const on = band.classList.toggle('on');
      sw.setAttribute('aria-checked', String(on));
    });
  });

  // Copy buttons.
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select it'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1600);
  }));

  // Entrances: heading, then text, then picture, staggered, once, as each part comes into view.
  const rise = [...document.querySelectorAll('[data-rise]')];
  rise.forEach((el, i) => { el.style.setProperty('--i', String(i % 3)); });
  if ('IntersectionObserver' in window && !reduce) {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { rootMargin: '0px 0px 60% 0px', threshold: 0 });
    rise.forEach((el) => io.observe(el));
  } else {
    rise.forEach((el) => el.classList.add('in'));
  }

  // Signature move: the wordmark is heavy. As the first screen leaves it settles back a few percent.
  const mark = document.getElementById('wordmark');
  if (mark && !reduce) {
    let ticking = false;
    const update = () => {
      ticking = false;
      const p = Math.min(Math.max(scrollY / Math.max(innerHeight, 1), 0), 1);
      mark.style.transform = `scale(${(1 - 0.06 * p).toFixed(4)})`;
    };
    addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }
})();

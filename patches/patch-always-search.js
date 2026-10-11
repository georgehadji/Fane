// Vane: always run web research, in both the agent API (/api/search, used by
// the `vane` CLI) and the web UI (/api/chat).
// Upstream, a classifier may set skipSearch=true for "general knowledge"
// questions, but the writer only answers from search results, so the reply
// becomes "could not find any relevant information".
const fs = require('fs');

const TARGETS = [
  {
    file: '/home/vane/.next/server/app/api/search/route.js',
    from: 'c.classification.skipSearch||(j=new g.A().research(',
    to: '(c.classification.skipSearch=!1)||(j=new g.A().research(',
  },
  {
    file: '/home/vane/.next/server/app/api/chat/route.js',
    from: 'd.classification.skipSearch||(m=new f.A().research(',
    to: '(d.classification.skipSearch=!1)||(m=new f.A().research(',
  },
];

// Check every target first so a mismatch leaves all files untouched.
const plan = TARGETS.map(t => {
  const s = fs.readFileSync(t.file, 'utf8');
  if (s.includes(t.to)) return { ...t, s, done: true };
  const count = s.split(t.from).length - 1;
  if (count !== 1) {
    console.error(`${t.file}: expected 1 match, found ${count}; not patching anything`);
    process.exit(1);
  }
  return { ...t, s, done: false };
});

for (const t of plan) {
  if (t.done) {
    console.log(`${t.file}: already patched`);
    continue;
  }
  if (!fs.existsSync(`${t.file}.bak`)) fs.copyFileSync(t.file, `${t.file}.bak`);
  fs.writeFileSync(t.file, t.s.replace(t.from, t.to));
  console.log(`${t.file}: patched (backup: ${t.file}.bak)`);
}

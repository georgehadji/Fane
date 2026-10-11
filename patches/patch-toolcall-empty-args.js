// Fix Vane bug: streamed tool-call continuation chunks with empty arguments
// crash with "Error:  is empty" (first chunk already falls back to "{}").
const fs = require('fs');
const f = '/home/vane/.next/server/chunks/136.js';
const s = fs.readFileSync(f, 'utf8');
const from = 'return b.arguments+=a.function?.arguments||"",{...b,arguments:(0,n.parse)(b.arguments)}';
const to = 'return b.arguments+=a.function?.arguments||"",{...b,arguments:(0,n.parse)(b.arguments.trim()||"{}")}';
if (s.includes(to)) {
  console.log('already patched');
  process.exit(0);
}
const count = s.split(from).length - 1;
if (count !== 1) {
  console.error(`expected 1 match, found ${count}; not patching`);
  process.exit(1);
}
fs.writeFileSync(f, s.replace(from, to));
console.log('patched 1 occurrence');

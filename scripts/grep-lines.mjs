// Prints matching lines with numbers, like grep -n, for the given files.
// Usage: node scripts/grep-lines.mjs PATTERN FILE... [--max 80]
// PATTERN is a JavaScript regular expression. Long lines are cut at 200 chars.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const maxAt = args.indexOf('--max');
const max = maxAt >= 0 ? Number(args.splice(maxAt, 2)[1]) || 80 : 80;
const [pattern, ...files] = args;
if (!pattern || !files.length) {
  console.error('usage: node scripts/grep-lines.mjs PATTERN FILE... [--max N]');
  process.exit(2);
}
const re = new RegExp(pattern);
let shown = 0;
for (const file of files) {
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }
  lines.forEach((line, i) => {
    if (shown >= max || !re.test(line)) return;
    console.log(`${file}:${i + 1}: ${line.slice(0, 200)}`);
    shown++;
  });
}
console.error(`${shown} line(s)`);

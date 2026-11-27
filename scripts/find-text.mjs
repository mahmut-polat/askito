// Lists files under a folder whose name or content contains a text.
// Usage: node scripts/find-text.mjs DIR TEXT [--max-mb 5] [--names]
// Prints paths only, never file contents. Skips files larger than --max-mb.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, text, ...rest] = process.argv.slice(2);
if (!dir || !text) {
  console.error('usage: node scripts/find-text.mjs DIR TEXT [--max-mb N] [--names]');
  process.exit(2);
}
const maxMb = Number(rest[rest.indexOf('--max-mb') + 1]) || 5;
const namesOnly = rest.includes('--names');
let hits = 0;

function walk(path, depth) {
  if (depth > 8 || hits > 200) return;
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name.includes(text)) { console.log(`${full}/`); hits++; }
      if (/^(node_modules|Cache|Code Cache|GPUCache|blob_storage|IndexedDB)$/.test(entry.name)) continue;
      walk(full, depth + 1);
      continue;
    }
    if (entry.name.includes(text)) { console.log(full); hits++; continue; }
    if (namesOnly) continue;
    try {
      if (statSync(full).size > maxMb * 1024 * 1024) continue;
      if (readFileSync(full).includes(text)) { console.log(full); hits++; }
    } catch { /* unreadable */ }
  }
}
walk(dir, 0);
console.error(`${hits} match(es)`);

#!/usr/bin/env node
// Replaces one visible brand name with another in the given files.
// Usage: node scripts/rename-brand.mjs FROM TO FILE...
import { readFileSync, writeFileSync } from 'node:fs';

const [from, to, ...files] = process.argv.slice(2);
if (!from || to === undefined || !files.length) {
  console.error('usage: node scripts/rename-brand.mjs FROM TO FILE...');
  process.exit(2);
}
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const count = text.split(from).length - 1;
  if (count) writeFileSync(file, text.split(from).join(to));
  console.log(`${file}: ${count}`);
}

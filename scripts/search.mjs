#!/usr/bin/env node
// Prints the lines of the given files that match a pattern, with line numbers.
// A plain helper for working in this repository without shell pipelines.
//
// Usage: node scripts/search.mjs PATTERN FILE [FILE...]   (PATTERN is a case-insensitive regex)
import fs from 'node:fs';

const [pattern, ...files] = process.argv.slice(2);
if (!pattern || !files.length) {
  console.error('usage: node scripts/search.mjs PATTERN FILE [FILE...]');
  process.exit(2);
}
const re = new RegExp(pattern, 'i');
let found = 0;
for (const file of files) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (!re.test(line)) return;
    found += 1;
    console.log(`${file}:${index + 1}: ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
  });
}
process.exitCode = found ? 0 : 1;

// Prints the top-level keys of a JSON file with short previews of the values.
// Usage: node scripts/json-keys.mjs FILE
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const secret = /token|key|secret|password|cookie|auth/i;
for (const [key, value] of Object.entries(data)) {
  let preview;
  if (secret.test(key)) preview = '<hidden>';
  else if (Array.isArray(value)) preview = `[array of ${value.length}]`;
  else if (value && typeof value === 'object') preview = `{${Object.keys(value).slice(0, 8).join(', ')}}`;
  else preview = JSON.stringify(value)?.slice(0, 100);
  console.log(`${key}: ${preview}`);
}

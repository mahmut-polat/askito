#!/usr/bin/env node
// Prints what the user wrote on inbox items (answers, comments, replies), newest first.
// Usage: node scripts/user-comments.mjs [--project NAME] [--since HOURS] [--status open|answered|done|dismissed]
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const project = flag('--project', null);
const sinceHours = Number(flag('--since', '48'));
const statuses = flag('--status', null) ? [flag('--status')] : ['open', 'answered', 'done', 'dismissed'];
const bin = path.join(os.homedir(), '.askito', 'bin', 'askito');
const cutoff = Date.now() - sinceHours * 3600 * 1000;

const rows = [];
for (const status of statuses) {
  const list = ['list', '--status', status, '--json'];
  if (project) list.push('--project', project);
  const parsed = JSON.parse(execFileSync(bin, list, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const items = Array.isArray(parsed) ? parsed : parsed.items ?? [];
  for (const item of items) {
    if (flag('--dump', null) && String(item.number) === flag('--dump')) {
      console.log(JSON.stringify({ ...item, body: undefined }, null, 1).slice(0, 6000));
    }
    for (const message of item.messages ?? []) {
      if (message.from !== 'human' && message.from !== 'user') continue;
      if (Date.parse(message.at) < cutoff) continue;
      rows.push({ at: message.at, item, message });
    }
  }
}
rows.sort((a, b) => b.at.localeCompare(a.at));
for (const { at, item, message } of rows) {
  const parts = [message.decision, message.choices?.join(','), message.text, message.comment].filter(Boolean);
  console.log(`#${item.number ?? item.id} [${item.status}] ${item.title}\n  ${at}: ${parts.join(' | ')}`);
}
if (!rows.length) console.log('No messages from the user in that window.');

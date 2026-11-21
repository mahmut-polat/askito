import fs from 'node:fs';
import path from 'node:path';

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;
const ANY_URL = /https?:\/\/[^\s|)>\]]+/;

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function dateOf(value) {
  const match = /(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(value ?? '');
  if (!match) return undefined;
  const parsed = new Date(`${match[1]}T${match[2] ?? '12:00'}:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

// Reads every Markdown table row that holds an address, such as an artifact
// register kept by hand. The header names the account and date columns.
export function parseLinkTable(markdown) {
  const links = [];
  let header = null;
  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('|')) {
      header = null;
      continue;
    }
    const row = cells(line);
    if (row.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const urlIndex = row.findIndex((cell) => ANY_URL.test(cell));
    if (urlIndex === -1) {
      header = row.map((cell) => cell.toLocaleLowerCase('tr'));
      continue;
    }
    const column = (pattern) => (header ? header.findIndex((name) => pattern.test(name)) : -1);
    const titleIndex = row.findIndex((cell, index) => index !== urlIndex && cell);
    // Rows added under a note lose their header; then the cell after the
    // address is the account when it is one word or an email address.
    const accountIndex = header ? column(/hesap|account/) : /^[\w.+-]+(@[\w.-]+)?$/.test(row[urlIndex + 1] ?? '') ? urlIndex + 1 : -1;
    const updated = column(/güncelleme|updated|tarih|date/);
    links.push({
      url: ANY_URL.exec(row[urlIndex])[0],
      title: row[titleIndex] ?? ANY_URL.exec(row[urlIndex])[0],
      account: accountIndex >= 0 ? row[accountIndex]?.split('@')[0] || undefined : undefined,
      updatedAt: updated >= 0 ? dateOf(row[updated]) : dateOf(row.find((cell) => dateOf(cell))),
    });
  }
  return links;
}

function htmlTitle(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 20000);
    const match = /<title[^>]*>([^<]+)<\/title>/i.exec(head);
    return match?.[1].replace(/\s+/g, ' ').trim() || null;
  } catch {
    return null;
  }
}

// Turns a finished Artifact publish into a link, or null when the call was
// something else (a read, a list, an asset upload, a failure).
export function artifactFromHook(input) {
  if (input?.tool_name !== 'Artifact') return null;
  const tool = input.tool_input ?? {};
  if (tool.action && tool.action !== 'publish') return null;
  if (tool.asset) return null;
  // Claude Code hands over { url, title, ... }; other shapes fall back to text.
  const result = input.tool_response && typeof input.tool_response === 'object' && !Array.isArray(input.tool_response) ? input.tool_response : {};
  const response = typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response ?? '');
  const url = result.url?.match(ARTIFACT_URL)?.[0] ?? tool.url?.match(ARTIFACT_URL)?.[0] ?? response.match(ARTIFACT_URL)?.[0];
  if (!url) return null;
  const file = tool.file_path ? path.resolve(input.cwd ?? process.cwd(), tool.file_path) : null;
  const title =
    (typeof result.title === 'string' && result.title.trim()) || (file && htmlTitle(file)) || tool.title || (file ? path.basename(file).replace(/\.[^.]+$/, '') : null) || 'Artifact';
  return { url, title: title.slice(0, 300), body: tool.description?.slice(0, 500) };
}

export function accountName(env = process.env) {
  const email = env.CLAUDE_CODE_USER_EMAIL ?? '';
  return email.includes('@') ? email.split('@')[0] : undefined;
}

// Opening one of these would run it, so the inbox only shows them in their folder.
const RUNNABLE = /\.(app|command|tool|terminal|sh|bash|zsh|fish|csh|scpt|scptd|applescript|workflow|action|pkg|mpkg|dmg|jar|exe|msi|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|scr|cpl|reg|desktop|run|bin|appimage|py|rb|pl)$/i;

export function isRunnable(file) {
  return RUNNABLE.test(file);
}

// The command that opens a file, or shows it in its folder, with no shell.
export function openCommand(platform, file, reveal) {
  if (platform === 'darwin') return ['open', reveal ? ['-R', file] : [file]];
  if (platform === 'win32') return ['explorer.exe', [reveal ? `/select,${file}` : file]];
  return ['xdg-open', [reveal ? path.dirname(file) : file]];
}

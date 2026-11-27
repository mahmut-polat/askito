import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from './paths.js';

function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function detectAgent(env) {
  if (env.ASKITO_AGENT) return env.ASKITO_AGENT;
  if (env.CLAUDECODE) return 'claude-code';
  if (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_THREAD_ID) return 'codex';
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return 'cursor';
  if (env.GEMINI_CLI) return 'gemini';
  if (env.OPENCODE) return 'opencode';
  return null;
}

// Worktrees of one repository share a common git dir, so every parallel chat in
// that repository lands under the same project.
function repoRoot(cwd) {
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!common) return null;
  return path.basename(common) === '.git' ? path.dirname(common) : common;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DESKTOP_SESSION = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The Claude desktop app names each chat in its sidebar and keeps that name in
// a small file per chat. Reading it lets the inbox show the chat's real name
// and a link that opens it, so the user finds it again after switching
// accounts. `home` is only for tests.
export function desktopChat(env = process.env, home = os.homedir()) {
  const id = env.CLAUDE_CODE_HOST_SESSION_ID;
  if (!id || !DESKTOP_SESSION.test(id)) return {};
  const chat = { chatLink: `claude://claude.ai/epitaxy/${id}`, account: env.CLAUDE_CODE_USER_EMAIL || null };
  const accountId = env.CLAUDE_CODE_ACCOUNT_UUID;
  const orgId = env.CLAUDE_CODE_ORGANIZATION_UUID;
  if (UUID.test(accountId ?? '') && UUID.test(orgId ?? '')) {
    const file = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', accountId, orgId, `${id}.json`);
    try {
      const title = JSON.parse(readFileSync(file, 'utf8')).title;
      if (typeof title === 'string' && title.trim()) chat.chatTitle = title.trim().slice(0, 200);
    } catch {
      // No file yet, or another layout: the link alone still finds the chat.
    }
  }
  return chat;
}

export function detectContext(cwd = process.cwd(), env = process.env) {
  const root = repoRoot(cwd);
  const aliases = readConfig().aliases ?? {};
  const branch = root ? git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') : null;
  const desktop = desktopChat(env);
  return {
    project: env.ASKITO_PROJECT || aliases[root ?? cwd] || path.basename(root ?? cwd),
    chat: env.ASKITO_CHAT || desktop.chatTitle || (branch && !['main', 'master', 'HEAD'].includes(branch) ? branch : null),
    chatTitle: desktop.chatTitle ?? null,
    chatLink: desktop.chatLink ?? null,
    account: desktop.account ?? null,
    agent: detectAgent(env),
    session: env.ASKITO_SESSION || env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID || null,
    cwd,
    root: root ?? cwd,
  };
}

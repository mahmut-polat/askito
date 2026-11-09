import { execFileSync } from 'node:child_process';
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

export function detectContext(cwd = process.cwd(), env = process.env) {
  const root = repoRoot(cwd);
  const aliases = readConfig().aliases ?? {};
  const branch = root ? git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') : null;
  return {
    project: env.ASKITO_PROJECT || aliases[root ?? cwd] || path.basename(root ?? cwd),
    chat: env.ASKITO_CHAT || (branch && !['main', 'master', 'HEAD'].includes(branch) ? branch : null),
    agent: detectAgent(env),
    session: env.ASKITO_SESSION || env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID || null,
    cwd,
    root: root ?? cwd,
  };
}

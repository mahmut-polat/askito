// Waking a chat when the person answers. A chat that is open in the Claude
// desktop app is woken by the askito panel inside it, which sends the answer
// in as a prompt. When nothing from that chat has been seen for a while (the
// chat was closed, or it has no panel), askito continues the chat itself with
// the Claude CLI: `claude --resume <session> -p <prompt>` in the chat's
// folder. With no session to resume it starts a new one there.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// How long after an answer a chat has to collect it, or show it is open,
// before askito continues it.
export const WAKE_GRACE_MS = 20_000;
// A panel polls every few seconds; a chat whose panel went quiet for this
// long is treated as closed.
export const BEAT_FRESH_MS = 15_000;

export function answerLine(item) {
  const answer = item.answer ?? {};
  const parts = [answer.decision];
  if (answer.choices?.length) parts.push(answer.choices.join(', '));
  if (answer.comment) parts.push(`"${answer.comment}"`);
  if (answer.exitCode != null) parts.push(`exit code ${answer.exitCode}`);
  return parts.filter(Boolean).join(': ');
}

// What the chat reads as the person's next message.
export function wakePrompt(item, { resumed = true } = {}) {
  const ref = item.number ? `#${item.number}` : item.id;
  const lines = [
    `askito ${ref} "${item.title}" was answered: ${answerLine(item)}.`,
  ];
  if (resumed) {
    lines.push(`Collect it with \`~/.askito/bin/askito wait ${item.number ?? item.id}\`, then carry on with the work it was for.`);
  } else {
    lines.push(
      `The chat that asked is closed, so this is a new chat in project "${item.project}". First claim it with \`~/.askito/bin/askito claim ${item.number ?? item.id}\`. \`~/.askito/bin/askito wait ${item.number ?? item.id} --json\` shows the question, its context and the answer. Finish the work it was for.`,
    );
  }
  return lines.join('\n');
}

// The transcript of a Claude Code session, if this computer has one.
export function findTranscript(sessionId, home = os.homedir()) {
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return null;
  const root = path.join(home, '.claude', 'projects');
  let folders = [];
  try {
    folders = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const file = path.join(root, folder, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function findClaude(env = process.env, home = os.homedir()) {
  const candidates = [
    env.ASKITO_CLAUDE,
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'claude')),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  return candidates.find((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? null;
}

// The command that continues the chat, or starts a new one when the old one is gone.
export function wakeCommand(item, { transcript, claude, home = os.homedir() }) {
  const cwd = item.cwd && fs.existsSync(item.cwd) ? item.cwd : transcript ? home : null;
  if (!claude || !cwd) return null;
  const resumed = Boolean(transcript);
  const args = resumed ? ['--resume', item.sessionId, '-p', wakePrompt(item)] : ['-p', wakePrompt(item, { resumed: false })];
  return { command: claude, args, cwd, resumed };
}

// Starts the chat in the background. Its output goes to a log in askito's home.
export function startChat(item, { logDir, env = process.env } = {}) {
  const plan = wakeCommand(item, { transcript: findTranscript(item.sessionId), claude: findClaude(env) });
  if (!plan) return null;
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `wake-${item.number ?? item.id}-${Date.now()}.log`);
  const out = fs.openSync(log, 'a');
  // The new chat must not think it is still inside the chat that ran the server.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('CLAUDE_CODE_') && key !== 'ASKITO_SESSION'));
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: childEnv, detached: true, stdio: ['ignore', out, out] });
  child.on('error', () => {});
  child.unref();
  fs.closeSync(out);
  return { ...plan, log };
}

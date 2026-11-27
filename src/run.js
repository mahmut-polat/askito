import { spawn } from 'node:child_process';
import fs from 'node:fs';

// A script may run this long before askito stops it.
export const RUN_LIMIT_MS = 60 * 60 * 1000;

// Runs a script item's command with no shell, so nothing in it is expanded or
// chained, and reports its output and how it ended. On Windows the program must
// be one that starts directly, such as node, python or powershell.
export function startScript({ command, cwd }, { onOutput, onExit, limitMs = RUN_LIMIT_MS }) {
  let ended = false;
  let timer = null;
  const end = (result) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    onExit(result);
  };

  if (!fs.existsSync(cwd)) {
    queueMicrotask(() => end({ error: `the folder ${cwd} does not exist` }));
    return { stop() {} };
  }

  const child = spawn(command[0], command.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.on('error', (err) => end({ error: err.code === 'ENOENT' ? `${command[0]} was not found` : err.message }));
  child.on('close', (exitCode, signal) => end({ exitCode, signal }));

  timer = setTimeout(() => {
    onOutput(`\naskito stopped the script after ${Math.round(limitMs / 60000)} minutes.\n`);
    child.kill();
  }, limitMs);
  timer.unref?.();

  return {
    stop() {
      if (!ended) child.kill();
    },
  };
}

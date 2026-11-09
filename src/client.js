import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentToken, filePath, getPort, PACKAGE_ROOT, uiToken, VERSION } from './paths.js';

const LONG_POLL_SECONDS = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = () => `http://127.0.0.1:${getPort()}`;

async function health() {
  try {
    const res = await fetch(`${base()}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json().catch(() => null);
    return body?.name === 'askito' ? body : { foreign: true };
  } catch {
    return null;
  }
}

function isOlder(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i];
  }
  return false;
}

async function untilDown() {
  for (let i = 0; i < 30; i += 1) {
    if (!(await health())) return;
    await sleep(100);
  }
}

export async function stopServer() {
  if (!(await health())) return false;
  await fetch(`${base()}/api/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentToken()}`, 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => {});
  await untilDown();
  return true;
}

export async function ensureServer() {
  let current = await health();
  if (current?.foreign) throw new Error(`port ${getPort()} is used by another program. Set a different one: ASKITO_PORT=<port>`);
  if (current && isOlder(current.version, VERSION)) {
    await stopServer();
    current = null;
  }
  if (current) return;

  fs.mkdirSync(path.dirname(filePath('server.log')), { recursive: true, mode: 0o700 });
  const log = fs.openSync(filePath('server.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'askito.js'), 'serve'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);

  for (let i = 0; i < 50; i += 1) {
    if (await health()) return;
    await sleep(100);
  }
  throw new Error(`the server did not start. See ${filePath('server.log')}`);
}

export async function status() {
  return health();
}

export async function api(method, route, body) {
  await ensureServer();
  const res = await fetch(`${base()}${route}`, {
    method,
    headers: { Authorization: `Bearer ${agentToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.message ?? `request failed with status ${res.status}`);
  return payload;
}

// Polls in short rounds so it survives tool timeouts and server restarts.
// timeoutSeconds of 0 means wait forever.
export async function waitForItems(ids, { timeoutSeconds = 0, all = false } = {}) {
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : Infinity;
  const query = (seconds) => `/api/wait?ids=${ids.map(encodeURIComponent).join(',')}&timeout=${seconds}&mode=${all ? 'all' : 'any'}`;
  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const round = Math.max(0, Math.min(LONG_POLL_SECONDS, remaining));
    let result = null;
    try {
      result = await api('GET', query(round));
    } catch (err) {
      if (err.cause?.code !== 'ECONNREFUSED' && err.name !== 'TimeoutError' && !/fetch failed/.test(err.message)) throw err;
      await sleep(1000);
    }
    if (result) {
      const finished = all ? result.pending.length === 0 : result.ready.length > 0;
      if (finished) {
        await Promise.all(result.ready.map((item) => api('POST', `/api/items/${item.id}/ack`, {})));
        return result;
      }
      if (Date.now() >= deadline) return result;
    } else if (Date.now() >= deadline) {
      return { ready: [], pending: ids };
    }
  }
}

export function inboxUrl() {
  // Names under .localhost reach this machine with no DNS change or admin rights.
  return `http://askito.localhost:${getPort()}/login?t=${uiToken()}`;
}

export function formatItem(item) {
  const lines = [`id: ${item.id}`, `title: ${item.title}`, `status: ${item.status}`];
  if (item.key) lines.push(`key: ${item.key}`);
  if (item.answer) {
    lines.push(`decision: ${item.answer.decision}`);
    if (item.answer.choices.length) lines.push(`choices: ${item.answer.choices.join(' | ')}`);
    if (item.answer.comment) lines.push(`comment: ${item.answer.comment}`);
  }
  return lines.join('\n');
}

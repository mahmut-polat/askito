// Optional sync with askito.net. Nothing here runs, and no request leaves the
// machine, until `askito login` has stored a device token in cloud.json.
// The contract is docs/SYNC.md in the askito-cloud repository.
import fs from 'node:fs';
import os from 'node:os';
import { ensureHome, filePath } from './paths.js';
import { HttpError } from './store.js';

export const DEFAULT_SERVER = 'https://askito.net';
const CLOUD_FILE = 'cloud.json';
const STATE_FILE = 'sync-state.json';
const INTERVAL_MS = 15_000;
const KICK_MS = 1_000;
const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
const RATE_LIMIT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PUSH_BATCH = 50;
const PUSH_BYTES = 3_500_000;
const PULL_LIMIT = 100;
const MAX_MESSAGES = 500;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export class CloudError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function readFile(name) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch {
    return null;
  }
}

function writePrivate(name, value) {
  ensureHome();
  const file = filePath(name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function remove(name) {
  try {
    fs.unlinkSync(filePath(name));
  } catch {
    // Already gone.
  }
}

export function readCloud() {
  const cloud = readFile(CLOUD_FILE);
  return cloud && typeof cloud.token === 'string' && typeof cloud.server === 'string' ? cloud : null;
}

export function readSyncState() {
  return readFile(STATE_FILE) ?? {};
}

export function forgetCloud() {
  remove(CLOUD_FILE);
  remove(STATE_FILE);
}

// The token travels in a header, so plain http is only allowed to this machine.
export function serverOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a valid server address: ${raw}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('the server address must start with https://');
  }
  return url.origin;
}

// No Origin header: the server refuses requests that carry a foreign one.
export async function cloudRequest(server, method, route, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${server}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new CloudError(res.status, payload.error ?? 'http_error', payload.message ?? `request failed with status ${res.status}`);
  return { status: res.status, body: payload };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function login({ server = DEFAULT_SERVER, name = os.hostname(), print, openBrowser, wait = sleep }) {
  const origin = serverOrigin(server);
  const deviceName = (name || 'computer').slice(0, 100);
  const { body: start } = await cloudRequest(origin, 'POST', '/api/pair/start', { body: { name: deviceName } }).catch((err) => {
    if (err.status === 429) throw new Error('too many attempts. Wait a few minutes and run askito login again');
    throw err;
  });
  print(`Code: ${start.userCode}`);
  print(`Open ${start.verifyUrl} and check that it shows the same code, then click Allow.`);
  openBrowser(start.verifyUrl);
  print('Waiting for approval...');

  const every = (Number(start.interval) > 0 ? Number(start.interval) : 5) * 1000;
  const deadline = Date.now() + (Number(start.expiresIn) > 0 ? Number(start.expiresIn) : 600) * 1000;
  while (Date.now() < deadline) {
    await wait(every);
    let result;
    try {
      result = await cloudRequest(origin, 'POST', '/api/pair/poll', { body: { deviceCode: start.deviceCode } });
    } catch (err) {
      if (err.status === 403) throw new Error('the request was denied on the website');
      if (err.status === 404) throw new Error('the code expired. Run askito login again');
      if (err.status === 429) await wait(RATE_LIMIT_MS);
      continue;
    }
    if (result.status === 200 && typeof result.body.token === 'string') {
      forgetCloud();
      writePrivate(CLOUD_FILE, { server: origin, token: result.body.token, deviceId: result.body.deviceId ?? null, name: deviceName, pairedAt: new Date().toISOString() });
      const me = await cloudRequest(origin, 'GET', '/api/sync/me', { token: result.body.token }).catch(() => null);
      return { server: origin, email: me?.body.email ?? null };
    }
  }
  throw new Error('the code expired. Run askito login again');
}

// The local token is deleted even when the server cannot be reached.
export async function logout() {
  const cloud = readCloud();
  if (!cloud) return { signedIn: false };
  try {
    await cloudRequest(cloud.server, 'DELETE', '/api/sync/me', { token: cloud.token });
    return { signedIn: true, revoked: true };
  } catch (err) {
    return { signedIn: true, revoked: err.status === 401, error: err.message };
  } finally {
    forgetCloud();
  }
}

export function cloudStatus() {
  const cloud = readCloud();
  const state = readSyncState();
  return { on: Boolean(cloud), server: cloud?.server ?? null, lastSyncAt: state.lastSyncAt ?? null, lastError: state.lastError ?? null };
}

// Only the fields in the contract. cwd, sessionId and key stay on this machine.
export function toCloudItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body ?? null,
    options: (item.options ?? []).map((o) => ({ id: o.id, label: o.label, description: o.description ?? null, recommended: o.recommended === true })),
    multi: item.multi === true,
    urgent: item.urgent === true,
    project: item.project ?? null,
    chat: item.chat ?? null,
    agent: item.agent ?? null,
    status: item.status,
    answer: item.answer ?? null,
    laterAt: item.laterAt ?? null,
    deliveredAt: item.deliveredAt ?? null,
    messages: (item.messages ?? []).slice(-MAX_MESSAGES).map((m) => ({
      from: m.from,
      kind: m.kind ?? null,
      decision: m.decision ?? null,
      choices: m.choices ?? [],
      text: m.text ?? null,
      at: m.at,
    })),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export class Sync {
  constructor({ store, intervalMs = INTERVAL_MS, log = (line) => process.stderr.write(`askito sync: ${line}\n`) }) {
    this.store = store;
    this.intervalMs = intervalMs;
    this.log = log;
    this.cloud = null;
    this.state = {};
    this.sent = new Map();
    this.pushAll = false;
    this.failures = 0;
    this.running = false;
    this.timer = null;
    this.dueAt = 0;
    this.onChange = ({ type }) => {
      // Merging projects edits items without touching updatedAt.
      if (type === 'merge') this.pushAll = true;
      if (this.failures === 0) this.schedule(KICK_MS);
    };
  }

  load() {
    this.cloud = readCloud();
    this.state = this.cloud ? readSyncState() : {};
    return Boolean(this.cloud);
  }

  start() {
    if (!this.load()) return false;
    this.store.on('change', this.onChange);
    this.schedule(0);
    return true;
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.store.off('change', this.onChange);
    this.cloud = null;
  }

  schedule(ms) {
    if (!this.cloud) return;
    const due = Date.now() + ms;
    if (this.timer && this.dueAt <= due) return;
    clearTimeout(this.timer);
    this.dueAt = due;
    this.timer = setTimeout(() => this.tick(), ms);
    this.timer.unref?.();
  }

  async tick() {
    this.timer = null;
    if (this.running || !this.cloud) return;
    this.running = true;
    let next = this.intervalMs;
    try {
      await this.syncOnce();
      this.failures = 0;
    } catch (err) {
      next = this.failed(err);
    } finally {
      this.running = false;
    }
    if (next !== null) this.schedule(next);
  }

  failed(err) {
    if (!this.cloud) return null;
    if (err.status === 401) {
      this.log('the server no longer accepts this computer. Sync is off until askito login');
      forgetCloud();
      writePrivate(STATE_FILE, { lastError: 'signed out by the server', lastErrorAt: new Date().toISOString() });
      this.stop();
      return null;
    }
    const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures += 1;
    this.log(`${err.message}. Retrying in ${Math.round(wait / 1000)} s`);
    this.saveState({ lastError: err.message, lastErrorAt: new Date().toISOString() });
    return err.status === 429 ? Math.max(wait, RATE_LIMIT_MS) : wait;
  }

  saveState(patch) {
    if (!this.cloud) return;
    this.state = { ...this.state, ...patch };
    writePrivate(STATE_FILE, this.state);
  }

  // Logging out from the terminal deletes cloud.json; the loop stops at its next run.
  stillSignedIn() {
    const current = readCloud();
    if (current?.token === this.cloud?.token) return true;
    this.stop();
    return false;
  }

  call(method, route, body) {
    return cloudRequest(this.cloud.server, method, route, { token: this.cloud.token, body });
  }

  async syncOnce() {
    if (!this.cloud || !this.stillSignedIn()) return;
    await this.pushChanged();
    for (;;) {
      const cursor = Number.isInteger(this.state.cursor) ? this.state.cursor : 0;
      const { body } = await this.call('GET', `/api/sync/changes?cursor=${cursor}&limit=${PULL_LIMIT}`);
      const changes = (Array.isArray(body.changes) ? body.changes : []).sort((a, b) => a.seq - b.seq);
      if (changes.length) {
        const acks = [];
        const touched = new Map();
        for (const change of changes) {
          acks.push({ seq: change.seq, applied: this.apply(change) });
          const item = this.store.items.get(change.itemId);
          if (item) touched.set(item.id, item);
        }
        // Push first, so the server sees a local answer before it hears applied: false.
        await this.push([...touched.values()]);
        await this.call('POST', '/api/sync/ack', { acks });
      }
      this.saveState({ cursor: Number.isInteger(body.cursor) ? body.cursor : cursor });
      if (!body.more || !changes.length) break;
    }
    this.saveState({ lastSyncAt: new Date().toISOString(), lastError: null, lastErrorAt: null });
  }

  // An answer given here first wins: only an item that is still open takes the online change.
  apply(change) {
    const item = this.store.items.get(change.itemId);
    if (!item || item.status !== 'open') return false;
    try {
      if (change.action === 'answer') {
        this.store.answer(item.id, { decision: change.answer?.decision, choices: change.answer?.choices, comment: change.answer?.comment });
      } else if (change.action === 'dismiss') {
        this.store.dismiss(item.id, change.answer?.comment);
      } else if (change.action === 'later') {
        this.store.later(item.id, change.later === true);
      } else {
        return false;
      }
      return true;
    } catch (err) {
      if (err instanceof HttpError) return false;
      throw err;
    }
  }

  async pushChanged() {
    const mark = new Date().toISOString();
    const all = this.pushAll;
    const since = all ? null : this.state.pushedUntil;
    this.pushAll = false;
    const items = [...this.store.items.values()].filter((i) => (!since || i.updatedAt >= since) && this.sent.get(i.id) !== i.updatedAt);
    try {
      await this.push(items);
    } catch (err) {
      this.pushAll ||= all;
      throw err;
    }
    this.saveState({ pushedUntil: mark });
  }

  async push(items) {
    let batch = [];
    let bytes = 0;
    const send = async () => {
      if (!batch.length) return;
      try {
        await this.call('POST', '/api/sync/items', { items: batch.map((b) => b.data) });
      } catch (err) {
        // One item too large for the server must not hold back the rest.
        if (!(err.status === 413 && batch.length === 1)) throw err;
        this.log(`item ${batch[0].data.id} is too large to send`);
      }
      for (const b of batch) this.sent.set(b.data.id, b.updatedAt);
      batch = [];
      bytes = 0;
    };
    for (const item of items) {
      const data = toCloudItem(item);
      const size = JSON.stringify(data).length;
      if (batch.length === PUSH_BATCH || (batch.length && bytes + size > PUSH_BYTES)) await send();
      batch.push({ data, updatedAt: item.updatedAt });
      bytes += size;
    }
    await send();
  }
}

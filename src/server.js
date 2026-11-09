import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { notify } from './notify.js';
import { agentToken, ensureHome, filePath, getPort, PACKAGE_ROOT, readConfig, uiToken, VERSION } from './paths.js';
import { HttpError, isResolved, Store } from './store.js';

const MAX_BODY = 256 * 1024;
const MAX_WAIT_SECONDS = 120;
const WAITER_GRACE_MS = 90_000;
const COOKIE = 'askito_ui';

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/i18n/en.json': ['i18n/en.json', 'application/json; charset=utf-8'],
  '/i18n/tr.json': ['i18n/tr.json', 'application/json; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors chrome-extension:",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function sameSecret(a, b) {
  const left = Buffer.from(a ?? '');
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      reject(new HttpError(415, 'unsupported_media_type', 'send application/json'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too_large', 'request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'invalid_json', 'body is not a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function createApp({ store, port, tokens, onShutdown, sendNotification = notify }) {
  const allowedHosts = new Set([`askito.localhost:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const streams = new Set();
  const waiters = new Map();

  const waiting = (id) => {
    const entry = waiters.get(id);
    return Boolean(entry && (entry.active > 0 || Date.now() - entry.last < WAITER_GRACE_MS));
  };
  const view = (item) => ({ ...item, agentWaiting: item.status === 'open' && waiting(item.id) });
  const broadcast = () => {
    for (const stream of streams) stream.write('event: change\ndata: {}\n\n');
  };

  store.on('change', ({ type, item }) => {
    broadcast();
    if (type === 'created' || type === 'reply') sendNotification(`askito: ${item.project}`, item.title);
  });

  function caller(req) {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer ') && sameSecret(header.slice(7), tokens.agent)) return 'agent';
    const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
    if (cookie && sameSecret(cookie.slice(COOKIE.length + 1), tokens.ui)) return 'human';
    return null;
  }

  function require_(who, ...allowed) {
    if (!who) throw new HttpError(401, 'unauthorized', 'missing or wrong credentials');
    if (!allowed.includes(who)) throw new HttpError(403, 'forbidden', `only the ${allowed.join(' or ')} can do this`);
  }

  function waitFor(res, ids, seconds, all) {
    const items = () => ids.map((id) => store.get(id));
    const result = () => {
      const current = items();
      const ready = current.filter(isResolved);
      return { ready: ready.map(view), pending: current.filter((i) => !isResolved(i)).map((i) => i.id) };
    };
    const done = (r) => (all ? r.pending.length === 0 : r.ready.length > 0);

    const first = result();
    if (done(first) || seconds === 0) return Promise.resolve(first);

    let fresh = false;
    for (const id of ids) {
      const entry = waiters.get(id) ?? { active: 0, last: 0 };
      if (entry.active === 0 && Date.now() - entry.last >= WAITER_GRACE_MS) fresh = true;
      entry.active += 1;
      waiters.set(id, entry);
    }
    if (fresh) broadcast();

    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        store.off('change', onChange);
        res.off('close', finish);
        for (const id of ids) {
          const entry = waiters.get(id);
          entry.active -= 1;
          entry.last = Date.now();
        }
        resolve(result());
      };
      const onChange = () => {
        if (done(result())) finish();
      };
      timer = setTimeout(finish, seconds * 1000);
      store.on('change', onChange);
      // A closed connection also ends the wait, so a killed agent is not held open.
      res.on('close', finish);
    });
  }

  async function api(req, res, url) {
    const who = caller(req);
    const { pathname, searchParams } = url;
    const route = `${req.method} ${pathname}`;

    if (req.method === 'POST' && who === 'human' && !allowedOrigins.has(req.headers.origin)) {
      throw new HttpError(403, 'bad_origin', 'browser requests must come from the inbox page');
    }

    if (route === 'GET /api/health') return sendJson(res, 200, { name: 'askito', version: VERSION, pid: process.pid });

    if (route === 'GET /api/events') {
      require_(who, 'human');
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      streams.add(res);
      const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
      res.on('close', () => {
        clearInterval(beat);
        streams.delete(res);
      });
      return undefined;
    }

    if (route === 'GET /api/items') {
      require_(who, 'agent', 'human');
      const filter = { status: searchParams.get('status') ?? undefined, project: searchParams.get('project') ?? undefined, chat: searchParams.get('chat') ?? undefined };
      return sendJson(res, 200, { items: store.list(filter).map(view) });
    }

    if (route === 'POST /api/items') {
      require_(who, 'agent');
      const item = store.create(await readJson(req));
      return sendJson(res, item.deduped ? 200 : 201, { item: view(item) });
    }

    if (route === 'GET /api/pickup') {
      require_(who, 'agent');
      const filter = { project: searchParams.get('project') ?? undefined, chat: searchParams.get('chat') ?? undefined };
      return sendJson(res, 200, { items: store.pickup(filter).map(view) });
    }

    if (route === 'GET /api/wait') {
      require_(who, 'agent');
      const ids = (searchParams.get('ids') ?? '').split(',').filter(Boolean);
      if (!ids.length) throw new HttpError(400, 'invalid_request', 'ids is required');
      const requested = Number(searchParams.get('timeout') ?? 50);
      const seconds = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), MAX_WAIT_SECONDS) : 50;
      return sendJson(res, 200, await waitFor(res, ids, seconds, searchParams.get('mode') === 'all'));
    }

    if (route === 'POST /api/shutdown') {
      require_(who, 'agent');
      sendJson(res, 200, { ok: true });
      return onShutdown();
    }

    const match = pathname.match(/^\/api\/items\/([a-z0-9]+)(?:\/([a-z]+))?$/);
    if (!match) throw new HttpError(404, 'not_found', 'unknown route');
    const [, id, action] = match;

    if (req.method === 'GET' && !action) {
      require_(who, 'agent', 'human');
      return sendJson(res, 200, { item: view(store.get(id)) });
    }
    if (req.method !== 'POST' || !action) throw new HttpError(404, 'not_found', 'unknown route');

    const body = await readJson(req);
    const handlers = {
      answer: ['human', () => store.answer(id, body)],
      dismiss: ['human', () => store.dismiss(id, body.note)],
      reopen: ['human', () => store.reopen(id)],
      close: ['human', () => store.close(id, 'human', body.note)],
      ack: ['agent', () => store.ack(id)],
      reply: ['agent', () => store.reply(id, body)],
      done: ['agent', () => store.close(id, 'agent', body.note)],
    };
    const handler = handlers[action];
    if (!handler) throw new HttpError(404, 'not_found', 'unknown route');
    require_(who, handler[0]);
    return sendJson(res, 200, { item: view(handler[1]()) });
  }

  function page(req, res, url) {
    if (url.pathname === '/login') {
      if (!sameSecret(url.searchParams.get('t'), tokens.ui)) {
        res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('This link is out of date. Run: askito open\n');
        return;
      }
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        Location: '/',
        'Set-Cookie': `${COOKIE}=${tokens.ui}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      });
      res.end();
      return;
    }
    const entry = STATIC_FILES[url.pathname];
    if (!entry || req.method !== 'GET') {
      res.writeHead(404, SECURITY_HEADERS);
      res.end();
      return;
    }
    if (url.pathname === '/' && caller(req) !== 'human') {
      res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Open the inbox from a terminal: askito open\n');
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': entry[1] });
    res.end(fs.readFileSync(path.join(PACKAGE_ROOT, 'web', entry[0])));
  }

  const server = http.createServer((req, res) => {
    // Rejecting unknown Host headers blocks DNS rebinding from a website.
    if (!allowedHosts.has(req.headers.host)) {
      sendJson(res, 403, { error: 'bad_host', message: 'unknown host' });
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith('/api/')) {
      page(req, res, url);
      return;
    }
    api(req, res, url).catch((err) => {
      if (res.headersSent) {
        res.end();
      } else if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
      } else {
        sendJson(res, 500, { error: 'internal', message: err.message });
      }
    });
  });

  return { server, closeStreams: () => streams.forEach((s) => s.end()) };
}

export function serve() {
  ensureHome();
  const port = getPort();
  const store = new Store(filePath('items.json'));
  const config = readConfig();
  const quiet = config.notifications === false || process.env.ASKITO_NO_NOTIFY === '1';

  const stop = () => {
    store.flush();
    try {
      fs.unlinkSync(filePath('server.pid'));
    } catch {
      // Already gone.
    }
    process.exit(0);
  };

  const { server } = createApp({
    store,
    port,
    tokens: { agent: agentToken(), ui: uiToken() },
    onShutdown: stop,
    sendNotification: quiet ? () => {} : notify,
  });

  server.on('error', (err) => {
    // Two chats can start the server at once; the loser exits quietly.
    process.stderr.write(`askito: ${err.message}\n`);
    process.exit(err.code === 'EADDRINUSE' ? 3 : 1);
  });
  server.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(filePath('server.pid'), String(process.pid), { mode: 0o600 });
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

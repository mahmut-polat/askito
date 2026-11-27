import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cloudLink, Sync } from './cloud.js';
import { isRunnable, openCommand } from './links.js';
import { notify } from './notify.js';
import { setWritingLanguage, WRITING_LANGUAGES, writingLanguage } from './setup.js';
import { agentToken, ensureHome, filePath, getPort, PACKAGE_ROOT, readConfig, uiToken, VERSION } from './paths.js';
import { startScript } from './run.js';
import { HttpError, isResolved, Store } from './store.js';
import { BEAT_FRESH_MS, startChat, WAKE_GRACE_MS } from './wake.js';

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

// Paths under the home folder read better as ~/...
function shortPath(file) {
  const home = os.homedir();
  return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

function launchFile(file, reveal) {
  const [command, args] = openCommand(process.platform, file, reveal);
  execFile(command, args, () => {});
}

function continueChat(item) {
  if (process.env.ASKITO_WAKE === 'off') return null;
  return startChat(item, { logDir: filePath('logs') });
}

export function createApp({
  store,
  port,
  tokens,
  onShutdown,
  sendNotification = notify,
  openFile = launchFile,
  runScript = startScript,
  wakeChat = continueChat,
  wakeGraceMs = WAKE_GRACE_MS,
  cloud = null,
}) {
  const allowedHosts = new Set([`askito.localhost:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const streams = new Set();
  const waiters = new Map();
  const running = new Map();
  // When the askito panel inside each open chat last checked in, by session id.
  const beats = new Map();
  const wakeTimers = new Set();
  // One continuation per answer, even if the answer event repeats.
  const woken = new Set();

  // Only the person at the inbox starts a script; a chat can post one but never run it.
  function run(id) {
    const item = store.startRun(id);
    let pending = '';
    let timer = null;
    // Output is saved a few times a second, not on every line the script prints.
    const save = () => {
      timer = null;
      if (pending) store.appendRun(id, pending);
      pending = '';
    };
    const handle = runScript(item.script, {
      onOutput: (chunk) => {
        pending += chunk;
        timer ??= setTimeout(save, 300);
      },
      onExit: (result) => {
        clearTimeout(timer);
        save();
        running.delete(id);
        store.finishRun(id, result);
      },
    });
    if (store.get(id).run?.state === 'running') running.set(id, handle);
    return store.get(id);
  }

  function stop(id) {
    const item = store.get(id);
    if (item.run?.state !== 'running') throw new HttpError(409, 'not_running', 'this script is not running');
    running.get(id)?.stop();
    return item;
  }

  const waiting = (id) => {
    const entry = waiters.get(id);
    return Boolean(entry && (entry.active > 0 || Date.now() - entry.last < WAITER_GRACE_MS));
  };
  const view = (item) => ({ ...item, agentWaiting: item.status === 'open' && waiting(item.id), orphaned: store.isOrphan(item, { isWaited: waiting }) });
  const broadcast = () => {
    for (const stream of streams) stream.write('event: change\ndata: {}\n\n');
  };

  const chatIsOpen = (sessionId) => Boolean(sessionId) && Date.now() - (beats.get(sessionId) ?? 0) < BEAT_FRESH_MS;

  // A chat that is waiting, or open with the panel in it, gets the answer by
  // itself. Any other chat is continued, or a new one is started, so the work
  // goes on as soon as the person answers.
  function wakeLater(id, answeredAt) {
    const timer = setTimeout(() => {
      wakeTimers.delete(timer);
      let item;
      try {
        item = store.get(id);
      } catch {
        return;
      }
      const key = `${id}@${answeredAt}`;
      if (woken.has(key) || item.status !== 'answered' || item.answer?.at !== answeredAt || item.deliveredAt) return;
      if (waiting(id) || chatIsOpen(item.sessionId)) return;
      woken.add(key);
      try {
        const started = wakeChat(item);
        if (started) store.handover(id, started.resumed ? 'askito continued the chat with the answer.' : 'The chat was closed; askito started a new chat with the answer.');
      } catch {
        // A chat that cannot be started leaves the item as it was; the next chat in the project picks it up.
      }
    }, wakeGraceMs);
    timer.unref?.();
    wakeTimers.add(timer);
  }

  store.on('change', ({ type, item }) => {
    broadcast();
    if (type === 'created' || type === 'reply') sendNotification(`Ask·ito: ${item.project}`, item.title);
    if (type === 'answered') wakeLater(item.id, item.answer.at);
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

    if (route === 'GET /api/followups') {
      require_(who, 'agent');
      const session = searchParams.get('session') ?? '';
      const project = searchParams.get('project') ?? undefined;
      store.touchSession({ id: session, project, chat: searchParams.get('chat') ?? undefined, agent: searchParams.get('agent') ?? undefined, chatTitle: searchParams.get('chatTitle') ?? undefined, chatLink: searchParams.get('chatLink') ?? undefined });
      const orphans = project ? store.orphans({ project, session, isWaited: waiting }).map(view) : [];
      return sendJson(res, 200, { ...store.followups(session), orphans });
    }

    // The askito panel inside an open chat says so every few seconds. That
    // chat is woken by its panel, so askito does not start another one.
    if (route === 'POST /api/sessions/beat') {
      require_(who, 'human');
      const body = await readJson(req);
      if (typeof body.sessionId !== 'string' || !/^[\w-]{1,200}$/.test(body.sessionId)) throw new HttpError(400, 'invalid_request', 'sessionId is required');
      beats.set(body.sessionId, Date.now());
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'GET /api/directory') {
      require_(who, 'human');
      return sendJson(res, 200, store.directory());
    }

    if (route === 'POST /api/projects/merge') {
      require_(who, 'human');
      const body = await readJson(req);
      store.mergeProject(body.from, body.to);
      return sendJson(res, 200, store.directory());
    }

    if (route === 'GET /api/settings') {
      require_(who, 'human');
      return sendJson(res, 200, { writingLanguage: writingLanguage(), writingLanguages: Object.keys(WRITING_LANGUAGES) });
    }

    if (route === 'POST /api/settings') {
      require_(who, 'human');
      const body = await readJson(req);
      if (!WRITING_LANGUAGES[body.writingLanguage]) throw new HttpError(400, 'invalid_request', 'unknown language');
      setWritingLanguage(body.writingLanguage);
      return sendJson(res, 200, { writingLanguage: writingLanguage() });
    }

    // Connecting this computer to an askito.net account. Only the browser may.
    if (route === 'GET /api/cloud' || route === 'POST /api/cloud/connect' || route === 'POST /api/cloud/cancel' || route === 'POST /api/cloud/disconnect') {
      require_(who, 'human');
      if (!cloud) throw new HttpError(404, 'not_found', 'online sync is not available here');
      if (req.method === 'POST') await readJson(req);
      if (route === 'GET /api/cloud') return sendJson(res, 200, cloud.view());
      if (route === 'POST /api/cloud/connect') return sendJson(res, 200, await cloud.connect());
      if (route === 'POST /api/cloud/cancel') return sendJson(res, 200, cloud.cancel());
      return sendJson(res, 200, await cloud.disconnect());
    }

    if (route === 'GET /api/links') {
      require_(who, 'agent', 'human');
      const filter = { project: searchParams.get('project') ?? undefined, removed: searchParams.get('removed') === '1' };
      // Files can move or be deleted after they were added, so say which are still there.
      const links = store.listLinks(filter).map((link) => (link.path ? { ...link, exists: fs.existsSync(link.path), shortPath: shortPath(link.path) } : { kind: 'web', ...link }));
      return sendJson(res, 200, { links });
    }

    if (route === 'POST /api/links') {
      require_(who, 'agent');
      const link = store.addLink(await readJson(req));
      return sendJson(res, link.updated ? 200 : 201, { link });
    }

    const linkMatch = pathname.match(/^\/api\/links\/([a-z0-9]+)\/(remove|restore|open|reveal)$/);
    if (req.method === 'POST' && linkMatch) {
      const [, linkId, linkAction] = linkMatch;
      if (linkAction === 'open' || linkAction === 'reveal') {
        // Only the person at the inbox opens files, and only files on the list.
        require_(who, 'human');
        const link = store.getLink(linkId);
        if (!link.path) throw new HttpError(400, 'not_a_file', 'only file entries open on this computer');
        if (!fs.existsSync(link.path)) throw new HttpError(404, 'file_missing', 'the file is no longer there');
        const reveal = linkAction === 'reveal' || isRunnable(link.path);
        openFile(link.path, reveal);
        return sendJson(res, 200, { ok: true, revealed: reveal });
      }
      require_(who, 'agent', 'human');
      return sendJson(res, 200, { link: store.removeLink(linkId, linkAction === 'remove') });
    }

    if (route === 'GET /api/wait') {
      require_(who, 'agent');
      const ids = (searchParams.get('ids') ?? '').split(',').filter(Boolean).map((ref) => store.resolveId(ref));
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

    // An item is named by its id or its number, written 42 or #42.
    const match = pathname.match(/^\/api\/items\/(?:%23|#)?([a-z0-9]+)(?:\/([a-z]+))?$/);
    if (!match) throw new HttpError(404, 'not_found', 'unknown route');
    const [, ref, action] = match;
    const id = store.resolveId(ref);

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
      later: ['human', () => store.later(id, body.later !== false)],
      assign: ['human', () => store.assign(id, body)],
      claim: [
        'agent',
        () => {
          store.touchSession({ id: body.sessionId, chat: body.chat, agent: body.agent });
          return store.claim(id, body.sessionId);
        },
      ],
      close: ['human', () => store.close(id, 'human', body.note)],
      run: ['human', () => run(id)],
      stop: ['human', () => stop(id)],
      ack: ['agent', () => store.ack(id)],
      reply: ['agent', () => store.reply(id, body)],
      progress: ['agent', () => store.progress(id, body)],
      done: ['agent', () => store.close(id, 'agent', body.note)],
      // The Claude panel cannot follow a claude:// link, so askito opens the
      // chat for it. The store only keeps links of the app's own form.
      chat: [
        'human',
        () => {
          const item = store.get(id);
          if (!item.chatLink) throw new HttpError(400, 'no_chat_link', 'this item has no chat link');
          openFile(item.chatLink, false);
          return item;
        },
      ],
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

  return {
    server,
    closeStreams: () => streams.forEach((s) => s.end()),
    stopScripts: () => running.forEach((handle) => handle.stop()),
    stopWakes: () => wakeTimers.forEach((timer) => clearTimeout(timer)),
  };
}

export function serve() {
  ensureHome();
  const port = getPort();
  const store = new Store(filePath('items.json'));
  const config = readConfig();
  const quiet = config.notifications === false || process.env.ASKITO_NO_NOTIFY === '1';

  // Sync runs only after askito login. Without cloud.json nothing leaves the machine.
  const sync = new Sync({ store });

  const stop = () => {
    stopScripts();
    sync.stop();
    store.flush();
    try {
      fs.unlinkSync(filePath('server.pid'));
    } catch {
      // Already gone.
    }
    process.exit(0);
  };

  const { server, stopScripts } = createApp({
    store,
    port,
    tokens: { agent: agentToken(), ui: uiToken() },
    onShutdown: stop,
    sendNotification: quiet ? () => {} : notify,
    cloud: cloudLink({ sync }),
  });

  server.on('error', (err) => {
    // Two chats can start the server at once; the loser exits quietly.
    process.stderr.write(`askito: ${err.message}\n`);
    process.exit(err.code === 'EADDRINUSE' ? 3 : 1);
  });
  server.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(filePath('server.pid'), String(process.pid), { mode: 0o600 });
    sync.start();
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

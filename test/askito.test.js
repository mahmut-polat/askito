import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { formatItem } from '../src/client.js';
import { Sync } from '../src/cloud.js';
import { notifyCommand } from '../src/notify.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'askito.js');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'askito-test-'));

function newStore() {
  return new Store(path.join(tempDir(), 'items.json'));
}

describe('store', () => {
  test('a question moves from open to answered and records the labels', () => {
    const store = newStore();
    const item = store.create({ title: 'Which?', options: ['A', 'B'] });
    assert.equal(item.status, 'open');
    const answered = store.answer(item.id, { decision: 'option', choices: ['2'], comment: 'because' });
    assert.equal(answered.status, 'answered');
    assert.deepEqual(answered.answer.choices, ['B']);
    assert.equal(answered.answer.comment, 'because');
  });

  test('a single-choice question refuses two choices', () => {
    const store = newStore();
    const item = store.create({ title: 'Which?', options: ['A', 'B'] });
    assert.throws(() => store.answer(item.id, { decision: 'option', choices: ['1', '2'] }), /one choice/);
  });

  test('an unknown option id is refused', () => {
    const store = newStore();
    const item = store.create({ title: 'Which?', options: ['A'], multi: true });
    assert.throws(() => store.answer(item.id, { decision: 'option', choices: ['1', '9'] }), /valid option/);
  });

  test('a decision from another kind is refused', () => {
    const store = newStore();
    const item = store.create({ kind: 'task', title: 'Sign' });
    assert.throws(() => store.answer(item.id, { decision: 'approved' }), /decision must be/);
  });

  test('an empty comment is not an answer', () => {
    const store = newStore();
    const item = store.create({ title: 'Why?' });
    assert.throws(() => store.answer(item.id, { decision: 'comment', comment: '   ' }), /comment is required/);
  });

  test('answering twice is a conflict', () => {
    const store = newStore();
    const item = store.create({ kind: 'approval', title: 'Go?' });
    store.answer(item.id, { decision: 'approved' });
    assert.throws(() => store.answer(item.id, { decision: 'rejected' }), /already been answered/);
  });

  test('a repeated key returns the same item', () => {
    const store = newStore();
    const first = store.create({ title: 'Go?', project: 'p', key: 'k' });
    const second = store.create({ title: 'Go?', project: 'p', key: 'k' });
    assert.equal(second.id, first.id);
    assert.equal(second.deduped, true);
    assert.equal(store.list().length, 1);
  });

  test('a reply reopens the item and keeps the earlier answer in the thread', () => {
    const store = newStore();
    const item = store.create({ title: 'Why?' });
    store.answer(item.id, { decision: 'comment', comment: 'first' });
    const replied = store.reply(item.id, { text: 'more detail please' });
    assert.equal(replied.status, 'open');
    assert.equal(replied.answer, null);
    assert.deepEqual(replied.messages.map((m) => m.from), ['human', 'agent']);
  });

  test('removal counts as resolved so a blocked chat is released', () => {
    const store = newStore();
    const item = store.create({ title: 'Go?' });
    const dismissed = store.dismiss(item.id);
    assert.equal(dismissed.status, 'dismissed');
    assert.equal(dismissed.answer.decision, 'dismissed');
  });

  test('pickup returns only answers nobody collected', () => {
    const store = newStore();
    const a = store.create({ title: 'A', project: 'p' });
    const b = store.create({ title: 'B', project: 'p' });
    store.create({ title: 'C', project: 'p' });
    const other = store.create({ title: 'D', project: 'q' });
    store.answer(a.id, { decision: 'comment', comment: 'x' });
    store.answer(b.id, { decision: 'comment', comment: 'y' });
    store.answer(other.id, { decision: 'comment', comment: 'z' });
    store.ack(b.id);
    assert.deepEqual(store.pickup({ project: 'p' }).map((i) => i.id), [a.id]);
  });

  test('the first-run question reaches pickup in every project and shows its key', () => {
    const store = newStore();
    const item = store.create({ kind: 'approval', title: 'Tell chats?', project: 'askito', key: 'first-run-broadcast' });
    store.answer(item.id, { decision: 'approved' });
    const picked = store.pickup({ project: 'somewhere-else' });
    assert.deepEqual(picked.map((i) => i.id), [item.id]);
    assert.match(formatItem(picked[0]), /key: first-run-broadcast/);
  });

  test('later sets an open item aside without closing it, and a follow-up brings it back', () => {
    const store = newStore();
    const item = store.create({ title: 'Not today' });
    const aside = store.later(item.id, true);
    assert.equal(aside.status, 'open');
    assert.ok(aside.laterAt);
    assert.equal(store.later(item.id, false).laterAt, null);
    store.later(item.id, true);
    assert.equal(store.reply(item.id, { text: 'Something changed' }).laterAt, null);
  });

  test('a closed item cannot be set aside', () => {
    const store = newStore();
    const item = store.create({ kind: 'approval', title: 'Go?' });
    store.answer(item.id, { decision: 'approved' });
    assert.throws(() => store.later(item.id, true), /only waiting items/);
  });

  test('progress records what the chat is doing and counts as receiving the answer', () => {
    const store = newStore();
    const item = store.create({ title: 'Why?' });
    store.answer(item.id, { decision: 'comment', comment: 'because' });
    const after = store.progress(item.id, { text: 'Applying it now' });
    assert.ok(after.deliveredAt);
    assert.equal(after.status, 'answered');
    const last = after.messages.at(-1);
    assert.equal(last.kind, 'progress');
    assert.equal(last.text, 'Applying it now');
  });

  test('a chat cannot close an item without saying what happened', () => {
    const store = newStore();
    const item = store.create({ title: 'Why?' });
    assert.throws(() => store.close(item.id, 'agent', '  '), /note is required/);
    const done = store.close(item.id, 'agent', 'Fixed the bug');
    assert.equal(done.messages.at(-1).kind, 'result');
    const other = store.create({ title: 'Mine' });
    assert.equal(store.close(other.id, 'human').status, 'done');
  });

  test('follow-ups list what a session has not collected or not reported on', () => {
    const store = newStore();
    const waiting = store.create({ title: 'A', sessionId: 's1' });
    const received = store.create({ title: 'B', sessionId: 's1' });
    const reported = store.create({ title: 'C', sessionId: 's1' });
    const foreign = store.create({ title: 'D', sessionId: 's2' });
    for (const item of [waiting, received, reported, foreign]) store.answer(item.id, { decision: 'comment', comment: 'x' });
    store.ack(received.id);
    store.progress(reported.id, { text: 'On it' });
    const result = store.followups('s1');
    assert.deepEqual(result.uncollected.map((i) => i.id), [waiting.id]);
    assert.deepEqual(result.unreported.map((i) => i.id), [received.id]);
  });

  describe('handing work between chats', () => {
    const OLD = Date.now() + 11 * 60 * 1000;

    function answered(store, input) {
      const item = store.create({ title: 'Work', project: 'p', ...input });
      store.answer(item.id, { decision: 'comment', comment: 'go' });
      return item;
    }

    test('an answer nobody collects becomes an orphan for other chats in the project', () => {
      const store = newStore();
      const item = answered(store, { sessionId: 'gone' });
      answered(store, { project: 'q', sessionId: 'gone' });
      assert.deepEqual(store.orphans({ project: 'p', session: 'live' }), []);
      assert.deepEqual(store.orphans({ project: 'p', session: 'live', now: OLD }).map((i) => i.id), [item.id]);
      assert.deepEqual(store.orphans({ project: 'p', session: 'gone', now: OLD }), []);
    });

    test('a chat that was seen recently keeps its work', () => {
      const store = newStore();
      answered(store, { sessionId: 'busy' });
      store.touchSession({ id: 'busy', project: 'p', now: OLD - 1000 });
      assert.deepEqual(store.orphans({ project: 'p', session: 'live', now: OLD }), []);
    });

    test('claiming moves the work to the new chat and records it, and only one chat wins', () => {
      const store = newStore();
      const item = answered(store, { sessionId: 'gone' });
      store.touchSession({ id: 'new', project: 'p', chat: 'helper' });
      const claimed = store.claim(item.id, 'new', { now: OLD });
      assert.equal(claimed.sessionId, 'new');
      assert.equal(claimed.chat, 'helper');
      assert.ok(claimed.deliveredAt);
      assert.equal(claimed.messages.at(-1).kind, 'handover');
      assert.throws(() => store.claim(item.id, 'other', { now: OLD + 1 }), /already/);
    });

    test('the user can assign a chat, or leave it to any chat in the project', () => {
      const store = newStore();
      const item = answered(store, { sessionId: 'gone' });
      store.touchSession({ id: 'new', project: 'p', chat: 'helper' });
      const assigned = store.assign(item.id, { sessionId: 'new' });
      assert.equal(assigned.chat, 'helper');
      assert.equal(assigned.deliveredAt, null);
      const open = store.assign(item.id, { anyChat: true });
      assert.equal(open.sessionId, null);
      assert.deepEqual(store.orphans({ project: 'p', session: 'x' }).map((i) => i.id), [item.id]);
    });

    test('an item can move to another project', () => {
      const store = newStore();
      const item = store.create({ title: 'Work', project: 'p' });
      assert.equal(store.assign(item.id, { project: 'q' }).project, 'q');
    });

    test('merging projects moves the items and remembers the mapping for new ones', () => {
      const store = newStore();
      const old = store.create({ title: 'A', project: 'Portal' });
      store.touchSession({ id: 's', project: 'Portal' });
      store.mergeProject('Portal', 'Licensing Portal');
      assert.equal(store.get(old.id).project, 'Licensing Portal');
      assert.equal(store.create({ title: 'B', project: 'Portal' }).project, 'Licensing Portal');
      assert.equal(store.directory().sessions[0].project, 'Licensing Portal');
      assert.deepEqual(store.directory().projects, ['Licensing Portal']);
      assert.throws(() => store.mergeProject('X', 'X'), /different/);
    });

    test('sessions and mappings survive a restart', () => {
      const file = path.join(tempDir(), 'items.json');
      const first = new Store(file);
      first.touchSession({ id: 's', project: 'p', chat: 'c' });
      first.mergeProject('a', 'b');
      first.flush();
      const second = new Store(file);
      assert.equal(second.directory().sessions[0].chat, 'c');
      assert.equal(second.create({ title: 'T', project: 'a' }).project, 'b');
    });
  });

  test('items survive a restart', () => {
    const file = path.join(tempDir(), 'items.json');
    const first = new Store(file);
    const item = first.create({ title: 'Keep me' });
    first.flush();
    assert.equal(new Store(file).get(item.id).title, 'Keep me');
  });

  test('a corrupt file is set aside and not overwritten', () => {
    const dir = tempDir();
    const file = path.join(dir, 'items.json');
    fs.writeFileSync(file, '{not json');
    const store = new Store(file);
    assert.equal(store.list().length, 0);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('items.json.corrupt-')));
  });
});

describe('notifications', () => {
  test('macOS gets no desktop notifier, because osascript opens Script Editor', () => {
    assert.equal(notifyCommand('darwin', 'T', 'B'), null);
  });

  test('Linux and Windows pass agent text as arguments or environment, never as script', () => {
    assert.deepEqual(notifyCommand('linux', 'T', 'B').slice(0, 2), ['notify-send', ['--', 'T', 'B']]);
    const [command, args, options] = notifyCommand('win32', '$(evil)', 'B');
    assert.equal(command, 'powershell');
    assert.doesNotMatch(args.join(' '), /evil/);
    assert.equal(options.env.ASKITO_N_TITLE, '$(evil)');
  });
});

describe('server', () => {
  const tokens = { agent: 'agent-secret', ui: 'ui-secret' };
  const notifications = [];
  let server;
  let port;
  let store;

  before(async () => {
    store = newStore();
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    port = probe.address().port;
    await new Promise((r) => probe.close(r));
    ({ server } = createApp({ store, port, tokens, onShutdown: () => {}, sendNotification: (...args) => notifications.push(args) }));
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    clearTimeout(store.timer);
  });

  // fetch forbids setting Host, so these requests use http directly.
  function call(method, route, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, method, path: route, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers } },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: () => JSON.parse(data) }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  const agent = { Authorization: `Bearer ${tokens.agent}` };
  const human = () => ({ Cookie: `askito_ui=${tokens.ui}`, Origin: `http://127.0.0.1:${port}` });
  const create = async (body) => (await call('POST', '/api/items', { headers: agent, body })).json().item;

  test('an unknown Host header is refused, which blocks DNS rebinding', async () => {
    const res = await call('GET', '/api/health', { headers: { Host: 'evil.example' } });
    assert.equal(res.status, 403);
  });

  test('the friendly askito.localhost address is accepted, for reads and browser posts', async () => {
    const friendly = `askito.localhost:${port}`;
    assert.equal((await call('GET', '/api/health', { headers: { Host: friendly } })).status, 200);
    const item = await create({ kind: 'approval', title: 'From the friendly host' });
    const res = await call('POST', `/api/items/${item.id}/answer`, {
      headers: { Host: friendly, Cookie: human().Cookie, Origin: `http://${friendly}` },
      body: { decision: 'approved' },
    });
    assert.equal(res.status, 200);
  });

  test('reading items needs credentials', async () => {
    assert.equal((await call('GET', '/api/items')).status, 401);
  });

  test('a wrong agent token is refused', async () => {
    assert.equal((await call('GET', '/api/items', { headers: { Authorization: 'Bearer nope-nope-nope' } })).status, 401);
  });

  test('an agent cannot answer its own request', async () => {
    const item = await create({ kind: 'approval', title: 'Self approve?' });
    const res = await call('POST', `/api/items/${item.id}/answer`, { headers: agent, body: { decision: 'approved' } });
    assert.equal(res.status, 403);
    assert.equal(store.get(item.id).status, 'open');
  });

  test('only the browser can set an item aside, and a waiting chat stays waiting', async () => {
    const item = await create({ title: 'Set me aside' });
    assert.equal((await call('POST', `/api/items/${item.id}/later`, { headers: agent, body: { later: true } })).status, 403);
    const res = await call('POST', `/api/items/${item.id}/later`, { headers: human(), body: { later: true } });
    assert.equal(res.status, 200);
    assert.ok(res.json().item.laterAt);
    const waited = (await call('GET', `/api/wait?ids=${item.id}&timeout=0`, { headers: agent })).json();
    assert.deepEqual(waited.pending, [item.id]);
  });

  test('only a chat can report progress', async () => {
    const item = await create({ title: 'Report me' });
    await call('POST', `/api/items/${item.id}/answer`, { headers: human(), body: { decision: 'comment', comment: 'ok' } });
    assert.equal((await call('POST', `/api/items/${item.id}/progress`, { headers: human(), body: { text: 'x' } })).status, 403);
    assert.equal((await call('POST', `/api/items/${item.id}/progress`, { headers: agent, body: { text: 'Working' } })).status, 200);
  });

  test('assigning and merging are the browser\'s, claiming is the chat\'s', async () => {
    const item = await create({ title: 'Move me', project: 'alpha' });
    assert.equal((await call('POST', `/api/items/${item.id}/assign`, { headers: agent, body: { project: 'beta' } })).status, 403);
    assert.equal((await call('POST', `/api/items/${item.id}/assign`, { headers: human(), body: { project: 'beta' } })).json().item.project, 'beta');
    assert.equal((await call('POST', '/api/projects/merge', { headers: agent, body: { from: 'beta', to: 'gamma' } })).status, 403);
    assert.equal((await call('POST', '/api/projects/merge', { headers: human(), body: { from: 'beta', to: 'gamma' } })).status, 200);
    assert.equal((await call('GET', '/api/directory', { headers: agent })).status, 403);
    assert.ok((await call('GET', '/api/directory', { headers: { Cookie: human().Cookie } })).json().projects.includes('gamma'));
    assert.equal((await call('POST', `/api/items/${item.id}/claim`, { headers: human(), body: { sessionId: 's' } })).status, 403);
  });

  test('a cross-site browser post is refused even with the cookie', async () => {
    const item = await create({ kind: 'approval', title: 'CSRF?' });
    const res = await call('POST', `/api/items/${item.id}/answer`, {
      headers: { Cookie: human().Cookie, Origin: 'https://evil.example' },
      body: { decision: 'approved' },
    });
    assert.equal(res.status, 403);
    assert.equal(store.get(item.id).status, 'open');
  });

  test('a post without JSON content type is refused', async () => {
    const res = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/items', headers: { ...agent, 'Content-Type': 'text/plain' } }, resolve);
      req.end('{"title":"x"}');
    });
    res.resume();
    assert.equal(res.statusCode, 415);
  });

  test('the browser can answer and the agent can read it', async () => {
    const item = await create({ kind: 'approval', title: 'Ship?' });
    const res = await call('POST', `/api/items/${item.id}/answer`, { headers: human(), body: { decision: 'approved', comment: 'yes' } });
    assert.equal(res.status, 200);
    const read = (await call('GET', `/api/items/${item.id}`, { headers: agent })).json().item;
    assert.equal(read.answer.decision, 'approved');
    assert.equal(read.answer.comment, 'yes');
  });

  test('a waiting agent gets the answer as soon as it is given', async () => {
    const item = await create({ title: 'Wait for me' });
    const started = Date.now();
    const pending = call('GET', `/api/wait?ids=${item.id}&timeout=20`, { headers: agent });
    await new Promise((r) => setTimeout(r, 100));
    const seen = (await call('GET', `/api/items/${item.id}`, { headers: agent })).json().item;
    assert.equal(seen.agentWaiting, true);
    await call('POST', `/api/items/${item.id}/answer`, { headers: human(), body: { decision: 'comment', comment: 'done waiting' } });
    const result = (await pending).json();
    assert.equal(result.ready[0].answer.comment, 'done waiting');
    assert.ok(Date.now() - started < 5000);
  });

  test('a wait with nothing to report returns pending when it times out', async () => {
    const item = await create({ title: 'Silence' });
    const result = (await call('GET', `/api/wait?ids=${item.id}&timeout=1`, { headers: agent })).json();
    assert.deepEqual(result.ready, []);
    assert.deepEqual(result.pending, [item.id]);
  });

  test('new items raise one desktop notification', async () => {
    const before_ = notifications.length;
    await create({ title: 'Ping', project: 'demo' });
    assert.equal(notifications.length, before_ + 1);
    assert.deepEqual(notifications.at(-1), ['Ask·ito: demo', 'Ping']);
  });

  test('the login link sets an HttpOnly strict cookie and a wrong link does not', async () => {
    const good = await call('GET', `/login?t=${tokens.ui}`);
    assert.equal(good.status, 302);
    assert.match(good.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    const bad = await call('GET', '/login?t=wrong');
    assert.equal(bad.status, 401);
    assert.equal(bad.headers['set-cookie'], undefined);
  });

  test('the page has a strict content security policy', async () => {
    const res = await call('GET', '/', { headers: { Cookie: human().Cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.doesNotMatch(res.headers['content-security-policy'], /unsafe/);
    assert.match(res.headers['content-security-policy'], /frame-ancestors chrome-extension:;?$|frame-ancestors chrome-extension:\s*(;|$)/);
  });

  test('the page does not load without the browser cookie', async () => {
    assert.equal((await call('GET', '/')).status, 401);
  });

  test('files outside the allow list are not served', async () => {
    assert.equal((await call('GET', '/../package.json')).status, 404);
    assert.equal((await call('GET', '/items.json')).status, 404);
  });
});

describe('end to end', () => {
  const home = tempDir();
  const fakeHome = tempDir();
  const env = { ...process.env, HOME: fakeHome, ASKITO_HOME: home, ASKITO_PORT: '45991', ASKITO_NO_NOTIFY: '1', PATH: path.dirname(process.execPath) };
  const cli = (...args) => run(process.execPath, [BIN, ...args], { env, cwd: fakeHome });

  after(async () => {
    await cli('stop').catch(() => {});
  });

  function mcpSession() {
    let buffer = '';
    const waiting = new Map();
    const child = execFile(process.execPath, [BIN, 'mcp'], { env, cwd: fakeHome });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        waiting.get(message.id)?.(message);
      }
    });
    let nextId = 1;
    return {
      child,
      call(method, params) {
        const id = nextId;
        nextId += 1;
        return new Promise((resolve) => {
          waiting.set(id, resolve);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
      },
    };
  }

  async function answerAsHuman(id, body) {
    const ui = fs.readFileSync(path.join(home, 'ui.token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:45991/api/items/${id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `askito_ui=${ui}`, Origin: 'http://127.0.0.1:45991' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
  }

  test('the command line starts the server, waits and prints the answer', async () => {
    const posted = await cli('ask', 'Pick one', '--option', 'Red', '--option', 'Blue::the calm one', '--recommend', '2', '--project', 'demo', '--json');
    const item = JSON.parse(posted.stdout);
    assert.equal(item.options[1].recommended, true);
    assert.equal(item.options[1].description, 'the calm one');
    const waiting = cli('wait', item.id, '--timeout', '20');
    await new Promise((r) => setTimeout(r, 300));
    await answerAsHuman(item.id, { decision: 'option', choices: ['2'], comment: 'go' });
    const { stdout } = await waiting;
    assert.match(stdout, /decision: option/);
    assert.match(stdout, /choices: Blue/);
    assert.match(stdout, /comment: go/);
  });

  test('wait exits with 4 when nothing arrives', async () => {
    const { stdout } = await cli('ask', 'Quiet one', '--project', 'demo');
    await assert.rejects(cli('wait', stdout.trim(), '--timeout', '1'), (err) => err.code === 4);
  });

  test('open keeps the browser secret out of its output unless --url is given', async () => {
    const opened = await cli('open');
    const secret = fs.readFileSync(path.join(home, 'ui.token'), 'utf8').trim();
    assert.ok(!opened.stdout.includes(secret));
    assert.match(opened.stdout, /opened/);
    assert.ok((await cli('open', '--url')).stdout.includes(secret));
  });

  test('the skill tells the agent to open the inbox for /askito', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'skill', 'SKILL.md'), 'utf8');
    assert.match(skill, /types `\/askito`/);
    assert.match(skill, /askito open/);
  });

  describe('enforcement hooks', () => {
    const hook = (name, input) => spawnSync(process.execPath, [BIN, 'hook', name], { input: JSON.stringify(input), env, cwd: fakeHome, encoding: 'utf8' });

    test('the chat question tool is blocked and points at askito', () => {
      const res = hook('block-question', { tool_name: 'AskUserQuestion', tool_input: {} });
      assert.equal(res.status, 2);
      assert.match(res.stderr, /askito(\.cmd)? ask/);
    });

    test('end-of-turn buttons are blocked only when they carry a question', () => {
      assert.equal(hook('block-question', { tool_name: 'mcp__ccd_turn__wrap_up', tool_input: { ask: 'Ship it?' } }).status, 2);
      assert.equal(hook('block-question', { tool_name: 'mcp__ccd_turn__wrap_up', tool_input: { recap: 'Done.' } }).status, 0);
    });

    test('other tools pass', () => {
      assert.equal(hook('block-question', { tool_name: 'Bash', tool_input: {} }).status, 0);
    });

    test('a turn that ends on a question is sent back once', () => {
      assert.equal(hook('stop', { last_assistant_message: 'Tests pass.\n\nHangisini seçeyim?' }).status, 2);
      assert.equal(hook('stop', { last_assistant_message: 'Hangisini seçeyim?', stop_hook_active: true }).status, 0);
      assert.equal(hook('stop', { last_assistant_message: 'Tests pass.' }).status, 0);
    });

    test('the rule is put back into context at session start and on each prompt', () => {
      for (const name of ['session', 'reminder']) {
        const res = hook(name, { cwd: fakeHome });
        assert.equal(res.status, 0);
        assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /askito/);
      }
    });

    test('a chat cannot stop while it owes a report on an answer', async () => {
      const session = { env: { ...env, ASKITO_SESSION: 'follow-1' }, cwd: fakeHome };
      const posted = await run(process.execPath, [BIN, 'ask', 'Report back', '--project', 'demo'], session);
      const id = posted.stdout.trim();
      await answerAsHuman(id, { decision: 'comment', comment: 'use the blue one' });
      const stopped = hook('stop', { session_id: 'follow-1', last_assistant_message: 'All done.' });
      assert.equal(stopped.status, 2);
      assert.match(stopped.stderr, /use the blue one/);
      const reminder = JSON.parse(hook('reminder', { session_id: 'follow-1' }).stdout).hookSpecificOutput.additionalContext;
      assert.match(reminder, /use the blue one/);
      await cli('ack', id);
      const owed = hook('stop', { session_id: 'follow-1', last_assistant_message: 'All done.' });
      assert.equal(owed.status, 2);
      assert.match(owed.stderr, /progress|done/);
      await cli('progress', id, 'Changed the colour');
      assert.equal(hook('stop', { session_id: 'follow-1', last_assistant_message: 'All done.' }).status, 0);
      await assert.rejects(cli('done', id), /what happened/);
      await cli('done', id, 'Colour changed and deployed');
    });

    test('a chat in the project is told about work another chat dropped', async () => {
      const posted = await run(process.execPath, [BIN, 'ask', 'Dropped work', '--project', 'handover'], { env: { ...env, ASKITO_SESSION: 'dead-chat' }, cwd: fakeHome });
      const id = posted.stdout.trim();
      await answerAsHuman(id, { decision: 'comment', comment: 'carry on' });
      const assignAny = await fetch(`http://127.0.0.1:45991/api/items/${id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `askito_ui=${fs.readFileSync(path.join(home, 'ui.token'), 'utf8').trim()}`, Origin: 'http://127.0.0.1:45991' },
        body: JSON.stringify({ anyChat: true }),
      });
      assert.equal(assignAny.status, 200);
      const live = { ...env, ASKITO_PROJECT: 'handover' };
      const res = spawnSync(process.execPath, [BIN, 'hook', 'stop'], { input: JSON.stringify({ session_id: 'live-chat', last_assistant_message: 'Done.' }), env: live, cwd: fakeHome, encoding: 'utf8' });
      assert.equal(res.status, 2);
      assert.match(res.stderr, /claim/);
      assert.match(res.stderr, /carry on/);
      await run(process.execPath, [BIN, 'claim', id], { env: { ...env, ASKITO_SESSION: 'live-chat' }, cwd: fakeHome });
      await run(process.execPath, [BIN, 'done', id, 'Finished it'], { env: { ...env, ASKITO_SESSION: 'live-chat' }, cwd: fakeHome });
    });

    test('broken input never blocks a tool', () => {
      const res = spawnSync(process.execPath, [BIN, 'hook', 'block-question'], { input: 'not json', env, cwd: fakeHome, encoding: 'utf8' });
      assert.equal(res.status, 0);
    });

    test('when askito cannot run, chats may ask normally', async () => {
      const other = http.createServer((_, res) => res.end('something else'));
      await new Promise((r) => other.listen(45993, '127.0.0.1', r));
      const running = run(process.execPath, [BIN, 'hook', 'block-question'], { env: { ...env, ASKITO_PORT: '45993' }, cwd: fakeHome });
      running.child.stdin.end(JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: {} }));
      await running;
      other.close();
    });
  });

  test('an agent cannot use the command line to approve', async () => {
    const help = await cli('--help');
    assert.doesNotMatch(help.stdout, /askito answer/);
    await assert.rejects(cli('answer', 'abc'), /unknown command/);
  });

  test('MCP lists its tools and completes a question', async () => {
    const session = mcpSession();
    const init = await session.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'askito');
    assert.equal(init.result.protocolVersion, '2025-06-18');

    const list = await session.call('tools/list', {});
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['askito_ask', 'askito_wait', 'askito_pickup', 'askito_ack', 'askito_reply', 'askito_claim', 'askito_progress', 'askito_done']);

    const asked = await session.call('tools/call', { name: 'askito_ask', arguments: { title: 'From MCP', project: 'demo', kind: 'approval' } });
    const id = asked.result.content[0].text.match(/id: (\w+)/)[1];

    const pending = await session.call('tools/call', { name: 'askito_wait', arguments: { ids: [id], timeout_seconds: 1 } });
    assert.match(pending.result.content[0].text, /^PENDING/);

    const waiting = session.call('tools/call', { name: 'askito_wait', arguments: { ids: [id], timeout_seconds: 20 } });
    await new Promise((r) => setTimeout(r, 200));
    await answerAsHuman(id, { decision: 'rejected', comment: 'not today' });
    const answered = await waiting;
    assert.match(answered.result.content[0].text, /decision: rejected/);
    assert.match(answered.result.content[0].text, /comment: not today/);
    session.child.stdin.end();
  });

  test('MCP reports an unknown method as a JSON-RPC error', async () => {
    const session = mcpSession();
    const reply = await session.call('nope/nothing', {});
    assert.equal(reply.error.code, -32601);
    session.child.stdin.end();
  });
});

describe('setup', () => {
  function sandbox() {
    const fakeHome = tempDir();
    const home = path.join(fakeHome, '.askito');
    // PATH holds only node, so no real AI tool on this machine can be touched.
    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, APPDATA: path.join(fakeHome, 'AppData'), ASKITO_HOME: home, ASKITO_PORT: '45992', ASKITO_NO_NOTIFY: '1', PATH: path.dirname(process.execPath) };
    const cli = (...args) => run(process.execPath, [BIN, ...args], { env, cwd: fakeHome });
    return { fakeHome, home, cli };
  }

  test('setup writes each tool, keeps other settings, and running twice changes nothing', async () => {
    const { fakeHome, home, cli } = sandbox();
    fs.mkdirSync(path.join(fakeHome, '.cursor'));
    fs.writeFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));
    fs.mkdirSync(path.join(fakeHome, '.codex'));
    fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'model = "x"\n');
    fs.mkdirSync(path.join(fakeHome, '.claude'));
    fs.writeFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), '# My rules\n\nKeep this.\n');

    await cli('setup');

    const cursor = JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(cursor.mcpServers.mine.command, 'x');
    assert.equal(cursor.mcpServers.askito.args.at(-1), 'mcp');
    assert.equal(cursor.mcpServers.askito.type, 'stdio');
    const toml = fs.readFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'utf8');
    assert.match(toml, /model = "x"/);
    assert.match(toml, /\[mcp_servers\.askito\]/);
    const rules = fs.readFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), 'utf8');
    assert.match(rules, /Keep this\./);
    assert.match(rules, /askito inbox/);
    assert.match(rules, /mandatory/i);
    assert.match(rules, /AskUserQuestion/);
    assert.ok(fs.existsSync(path.join(fakeHome, '.claude', 'skills', 'askito', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, 'backups')));

    await cli('setup');
    const again = fs.readFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), 'utf8');
    assert.equal(again, rules);
    assert.equal(fs.readFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'utf8'), toml);

    const statusEnv = { env: { ...process.env, HOME: fakeHome, ASKITO_HOME: home, ASKITO_PORT: '45992' } };
    const { stdout } =
      process.platform === 'win32'
        ? await run('cmd.exe', ['/d', '/c', path.join(home, 'bin', 'askito.cmd'), 'status'], statusEnv)
        : await run(path.join(home, 'bin', 'askito'), ['status'], statusEnv);
    assert.match(stdout, /running/);

    await cli('uninstall');
    assert.equal(fs.readFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), 'utf8'), '# My rules\n\nKeep this.\n');
    assert.equal(fs.readFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'utf8'), 'model = "x"\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8')).mcpServers.askito, undefined);
    assert.ok(!fs.existsSync(path.join(fakeHome, '.claude', 'skills', 'askito')));
  });

  test('a config file with comments is left untouched', async () => {
    const { fakeHome, cli } = sandbox();
    fs.mkdirSync(path.join(fakeHome, '.config', 'zed'), { recursive: true });
    const original = '// my settings\n{ "theme": "One Dark" }\n';
    fs.writeFileSync(path.join(fakeHome, '.config', 'zed', 'settings.json'), original);
    const { stdout } = await cli('setup', '--tools', 'zed');
    assert.equal(fs.readFileSync(path.join(fakeHome, '.config', 'zed', 'settings.json'), 'utf8'), original);
    assert.match(stdout, /SKIPPED/);
    await cli('uninstall', '--purge');
  });

  test('setup adds the Claude Code hooks, keeps the user\'s own, and uninstall restores the file', async () => {
    const { fakeHome, cli } = sandbox();
    fs.mkdirSync(path.join(fakeHome, '.claude'));
    const file = path.join(fakeHome, '.claude', 'settings.json');
    const original = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } };
    fs.writeFileSync(file, JSON.stringify(original));

    await cli('setup');
    const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(installed.model, 'x');
    assert.ok(installed.hooks.Stop.some((entry) => entry.hooks[0].command === 'mine'));
    assert.match(JSON.stringify(installed.hooks.PreToolUse), /AskUserQuestion/);
    assert.match(JSON.stringify(installed.hooks.SessionStart), /compact/);
    assert.match(JSON.stringify(installed.hooks.UserPromptSubmit), /hook reminder/);

    await cli('setup');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), installed);

    await cli('uninstall', '--purge');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  });

  test('a new install posts one first question and a reinstall does not', async () => {
    const { fakeHome, cli } = sandbox();
    fs.mkdirSync(path.join(fakeHome, '.claude'));
    const first = await cli('setup');
    assert.match(first.stdout, /First question/);
    assert.match(fs.readFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), 'utf8'), /first-run-broadcast/);
    await cli('setup');
    const items = JSON.parse((await cli('list', '--json')).stdout);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'approval');
    assert.equal(items[0].key, 'first-run-broadcast');
    await cli('uninstall', '--purge');
  });

  test('a dry run writes nothing', async () => {
    const { fakeHome, home, cli } = sandbox();
    fs.mkdirSync(path.join(fakeHome, '.cursor'));
    const { stdout } = await cli('setup', '--dry-run');
    assert.match(stdout, /Dry run/);
    assert.ok(!fs.existsSync(path.join(home, 'app')));
    assert.ok(!fs.existsSync(path.join(fakeHome, '.cursor', 'mcp.json')));
  });

  test('an unknown tool name is an error', async () => {
    const { cli } = sandbox();
    await assert.rejects(cli('setup', '--tools', 'nothing'), /unknown tool/);
  });
});

// A stand-in for askito.net that follows docs/SYNC.md in the askito-cloud repository.
function fakeCloud() {
  const state = { requests: [], items: new Map(), changes: [], tokens: new Set(), polls: 0 };
  let base = '';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      const body = raw ? JSON.parse(raw) : undefined;
      state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.origin) return send(403, { error: 'bad_origin', message: 'unexpected Origin header' });
      const route = `${req.method} ${url.pathname}`;
      if (route === 'POST /api/pair/start') {
        return send(201, { deviceCode: 'device-code-secret', userCode: 'CSDE-UQSH', verifyUrl: `${base}/pair?code=CSDE-UQSH`, expiresIn: 30, interval: 0.05 });
      }
      if (route === 'POST /api/pair/poll') {
        state.polls += 1;
        if (body.deviceCode !== 'device-code-secret' || state.polls > 2) return send(404, { error: 'expired', message: 'expired' });
        if (state.polls === 1) return send(202, { status: 'pending' });
        state.tokens.add('askd_login_token');
        return send(200, { status: 'approved', token: 'askd_login_token', deviceId: 'dev1' });
      }
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!state.tokens.has(token)) return send(401, { error: 'unauthorized', message: 'missing or revoked device token' });
      if (route === 'GET /api/sync/me') return send(200, { deviceId: 'dev1', name: 'test', email: 'person@example.com' });
      if (route === 'DELETE /api/sync/me') {
        state.tokens.delete(token);
        return send(200, { ok: true });
      }
      if (route === 'POST /api/sync/items') {
        if (body.items.length > 50) return send(400, { error: 'invalid_request', message: 'at most 50 items per request' });
        for (const item of body.items) state.items.set(item.id, item);
        return send(200, { stored: body.items.length });
      }
      if (route === 'GET /api/sync/changes') {
        const cursor = Number(url.searchParams.get('cursor'));
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const waiting = state.changes.filter((c) => c.seq > cursor && c.applied === undefined);
        const page = waiting.slice(0, limit).map(({ applied, ...change }) => change);
        return send(200, { changes: page, cursor: page.at(-1)?.seq ?? cursor, more: waiting.length > limit });
      }
      if (route === 'POST /api/sync/ack') {
        let acked = 0;
        for (const ack of body.acks) {
          const change = state.changes.find((c) => c.seq === ack.seq && c.applied === undefined);
          if (!change) continue;
          change.applied = ack.applied;
          acked += 1;
        }
        return send(200, { acked });
      }
      return send(404, { error: 'not_found', message: 'unknown route' });
    });
  });
  return {
    state,
    server,
    get base() {
      return base;
    },
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
    },
    queue(change) {
      const seq = state.changes.length + 1;
      state.changes.push({ seq, at: new Date().toISOString(), ...change });
      return seq;
    },
    calls: (method, route) => state.requests.filter((r) => r.method === method && r.path === route),
  };
}

describe('online sync', () => {
  const cloud = fakeCloud();
  const home = tempDir();
  const previousHome = process.env.ASKITO_HOME;
  const stores = [];

  before(async () => {
    await cloud.start();
    process.env.ASKITO_HOME = home;
  });

  after(() => {
    if (previousHome === undefined) delete process.env.ASKITO_HOME;
    else process.env.ASKITO_HOME = previousHome;
    for (const s of stores) clearTimeout(s.timer);
    cloud.server.closeAllConnections();
    cloud.server.close();
  });

  function paired(token) {
    cloud.state.tokens.add(token);
    fs.rmSync(path.join(home, 'sync-state.json'), { force: true });
    fs.writeFileSync(path.join(home, 'cloud.json'), JSON.stringify({ server: cloud.base, token }), { mode: 0o600 });
    const store = newStore();
    stores.push(store);
    const sync = new Sync({ store, log: () => {} });
    assert.equal(sync.load(), true);
    return { store, sync };
  }

  describe('login and logout from the command line', () => {
    const loginHome = tempDir();
    const fakeHome = tempDir();
    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, ASKITO_HOME: loginHome, ASKITO_PORT: '45996', ASKITO_NO_NOTIFY: '1', PATH: path.dirname(process.execPath) };
    const cli = (...args) => run(process.execPath, [BIN, ...args], { env, cwd: fakeHome });
    const statusText = () => cli('status').then((r) => r.stdout, (err) => err.stdout);

    test('login prints the code and link, stores the token with mode 0600 and never prints it', async () => {
      const { stdout } = await cli('login', '--server', cloud.base);
      assert.match(stdout, /Code: CSDE-UQSH/);
      assert.ok(stdout.includes(`${cloud.base}/pair?code=CSDE-UQSH`));
      assert.match(stdout, /online sync is on for person@example.com/);
      assert.ok(!stdout.includes('askd_login_token'));
      assert.ok(!stdout.includes('device-code-secret'));
      const file = path.join(loginHome, 'cloud.json');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'askd_login_token');
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(cloud.calls('POST', '/api/pair/start')[0].body.name.length > 0, true);
      assert.ok(cloud.state.requests.every((r) => r.headers.origin === undefined));
      assert.match(await statusText(), /online sync: on with http:\/\/127\.0\.0\.1/);
    });

    test('logout revokes the token on the server and deletes it here', async () => {
      const { stdout } = await cli('logout');
      assert.match(stdout, /signed out/);
      const revoke = cloud.calls('DELETE', '/api/sync/me').at(-1);
      assert.equal(revoke.headers.authorization, 'Bearer askd_login_token');
      assert.ok(!cloud.state.tokens.has('askd_login_token'));
      assert.ok(!fs.existsSync(path.join(loginHome, 'cloud.json')));
      assert.match(await statusText(), /online sync: off/);
    });

    test('a plain http server other than this machine is refused', async () => {
      await assert.rejects(cli('login', '--server', 'http://askito.example'), /must start with https/);
    });
  });

  test('push sends the contract fields of items that changed, and nothing else', async () => {
    const { store, sync } = paired('askd_push');
    const item = store.create({ title: 'Which cache?', options: ['Redis', 'SQLite'], project: 'p', cwd: '/secret/path', sessionId: 's1', key: 'k1' });
    const before_ = cloud.calls('POST', '/api/sync/items').length;
    await sync.syncOnce();
    const pushed = cloud.state.items.get(item.id);
    assert.equal(pushed.title, 'Which cache?');
    assert.equal(pushed.status, 'open');
    assert.deepEqual(pushed.options.map((o) => o.label), ['Redis', 'SQLite']);
    for (const field of ['cwd', 'sessionId', 'key']) assert.equal(field in pushed, false);
    assert.equal(cloud.calls('POST', '/api/sync/items').length, before_ + 1);

    await sync.syncOnce();
    assert.equal(cloud.calls('POST', '/api/sync/items').length, before_ + 1, 'nothing changed, nothing sent');

    store.later(item.id, true);
    await sync.syncOnce();
    assert.equal(cloud.calls('POST', '/api/sync/items').length, before_ + 2);
    assert.ok(cloud.state.items.get(item.id).laterAt);
  });

  test('an online answer goes through the store and releases a waiting chat', async () => {
    const { store, sync } = paired('askd_pull');
    const tokens = { agent: 'agent-secret', ui: 'ui-secret' };
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address();
    await new Promise((r) => probe.close(r));
    const { server } = createApp({ store, port, tokens, onShutdown: () => {}, sendNotification: () => {} });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    try {
      const item = store.create({ title: 'Pick a colour', options: ['Red', 'Blue'] });
      await sync.syncOnce();
      const waiting = fetch(`http://127.0.0.1:${port}/api/wait?ids=${item.id}&timeout=20`, { headers: { Authorization: `Bearer ${tokens.agent}` } }).then((r) => r.json());
      await new Promise((r) => setTimeout(r, 200));
      const seq = cloud.queue({ itemId: item.id, action: 'answer', answer: { decision: 'option', choices: ['2'], comment: 'from my phone', at: new Date().toISOString() } });
      await sync.syncOnce();
      const result = await waiting;
      assert.equal(result.ready[0].status, 'answered');
      assert.deepEqual(result.ready[0].answer.choices, ['Blue']);
      assert.equal(result.ready[0].answer.comment, 'from my phone');
      assert.equal(cloud.state.changes.find((c) => c.seq === seq).applied, true);
      assert.equal(cloud.state.items.get(item.id).status, 'answered');
      const order = cloud.state.requests.map((r) => `${r.method} ${r.path}`);
      assert.ok(order.lastIndexOf('POST /api/sync/items') < order.lastIndexOf('POST /api/sync/ack'), 'the answered item is pushed before the ack');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test('dismiss and later from online use the store too', async () => {
    const { store, sync } = paired('askd_actions');
    const a = store.create({ title: 'Drop this' });
    const b = store.create({ title: 'Not today' });
    cloud.queue({ itemId: a.id, action: 'dismiss', answer: { decision: 'dismissed', choices: [], comment: 'not needed', at: new Date().toISOString() } });
    cloud.queue({ itemId: b.id, action: 'later', later: true });
    await sync.syncOnce();
    assert.equal(store.get(a.id).status, 'dismissed');
    assert.equal(store.get(a.id).answer.comment, 'not needed');
    assert.equal(store.get(b.id).status, 'open');
    assert.ok(store.get(b.id).laterAt);
  });

  test('an answer given locally first wins, and the local item is pushed before the ack', async () => {
    const { store, sync } = paired('askd_conflict');
    const item = store.create({ kind: 'approval', title: 'Deploy?' });
    await sync.syncOnce();
    store.answer(item.id, { decision: 'rejected', comment: 'said no in the terminal' });
    const seq = cloud.queue({ itemId: item.id, action: 'answer', answer: { decision: 'approved', choices: [], comment: null, at: new Date().toISOString() } });
    const missing = cloud.queue({ itemId: 'gone123', action: 'answer', answer: { decision: 'approved', choices: [], comment: null, at: new Date().toISOString() } });
    await sync.syncOnce();
    assert.equal(store.get(item.id).answer.decision, 'rejected');
    assert.equal(cloud.state.changes.find((c) => c.seq === seq).applied, false);
    assert.equal(cloud.state.changes.find((c) => c.seq === missing).applied, false);
    assert.equal(cloud.state.items.get(item.id).status, 'answered');
    const order = cloud.state.requests.map((r) => `${r.method} ${r.path}`);
    assert.ok(order.lastIndexOf('POST /api/sync/items') < order.lastIndexOf('POST /api/sync/ack'));
  });

  test('a revoked token is forgotten and sync stops', async () => {
    const { store, sync } = paired('askd_revoked');
    cloud.state.tokens.delete('askd_revoked');
    store.create({ title: 'Anyone there?' });
    await sync.tick();
    assert.equal(sync.cloud, null);
    assert.equal(sync.timer, null);
    assert.ok(!fs.existsSync(path.join(home, 'cloud.json')));
  });

  test('without login the server sends no network request, and with it the loop runs', async () => {
    const dir = tempDir();
    const spy = path.join(dir, 'spy.mjs');
    fs.writeFileSync(
      spy,
      [
        "import fs from 'node:fs';",
        "import net from 'node:net';",
        'const record = (line) => fs.appendFileSync(process.env.SPY_LOG, `${line}\\n`);',
        'const connect = net.Socket.prototype.connect;',
        'net.Socket.prototype.connect = function (...args) {',
        "  record(`connect ${JSON.stringify(args[0]?.port ?? args[0])}`);",
        '  return connect.apply(this, args);',
        '};',
        'const realFetch = globalThis.fetch;',
        'globalThis.fetch = (...args) => {',
        '  record(`fetch ${args[0]}`);',
        '  return realFetch(...args);',
        '};',
      ].join('\n'),
    );

    async function serveWithSpy(serveHome, port) {
      const log = path.join(dir, `net-${port}.log`);
      const child = spawn(process.execPath, ['--import', pathToFileURL(spy).href, BIN, 'serve'], {
        env: { ...process.env, ASKITO_HOME: serveHome, ASKITO_PORT: String(port), ASKITO_NO_NOTIFY: '1', SPY_LOG: log },
        stdio: 'ignore',
      });
      for (let i = 0; i < 50; i += 1) {
        if (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const agent = fs.readFileSync(path.join(serveHome, 'agent.token'), 'utf8').trim();
      const res = await fetch(`http://127.0.0.1:${port}/api/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Is anything sent?' }),
      });
      assert.equal(res.status, 201);
      return {
        log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
        stop: () => new Promise((r) => {
          child.on('exit', r);
          child.kill();
        }),
      };
    }

    const offline = await serveWithSpy(tempDir(), 45994);
    await new Promise((r) => setTimeout(r, 2000));
    const offlineLog = offline.log();
    await offline.stop();
    assert.equal(offlineLog, '', 'no outgoing connection without login');

    const onlineHome = tempDir();
    cloud.state.tokens.add('askd_spy');
    fs.writeFileSync(path.join(onlineHome, 'cloud.json'), JSON.stringify({ server: cloud.base, token: 'askd_spy' }), { mode: 0o600 });
    const pushesBefore = cloud.calls('POST', '/api/sync/items').length;
    const online = await serveWithSpy(onlineHome, 45995);
    for (let i = 0; i < 50 && cloud.calls('POST', '/api/sync/items').length === pushesBefore; i += 1) await new Promise((r) => setTimeout(r, 100));
    const onlineLog = online.log();
    await online.stop();
    assert.ok(cloud.calls('POST', '/api/sync/items').length > pushesBefore, 'the loop pushed the new item');
    assert.match(onlineLog, /fetch http:\/\/127\.0\.0\.1/, 'the spy sees requests when they happen');
  });
});

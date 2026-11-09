import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { formatItem } from '../src/client.js';
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
    assert.deepEqual(notifications.at(-1), ['askito: demo', 'Ping']);
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
      assert.match(res.stderr, /askito ask/);
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
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['askito_ask', 'askito_wait', 'askito_pickup', 'askito_ack', 'askito_reply', 'askito_done']);

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

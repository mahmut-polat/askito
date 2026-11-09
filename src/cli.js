import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { api, ensureServer, formatItem, inboxUrl, status, stopServer, waitForItems } from './client.js';
import { detectContext } from './context.js';
import { runMcp } from './mcp.js';
import { filePath, readConfig, VERSION, writeConfig } from './paths.js';
import { serve } from './server.js';
import { rulesBlock, runSetup, runUninstall } from './setup.js';

const EXIT_DISMISSED = 3;
const EXIT_TIMEOUT = 4;

const HELP = `askito ${VERSION}: one local inbox for every question your AI chats need to ask you.

Set up
  askito setup [--tools claude,codex,...] [--dry-run]
  askito uninstall [--purge]
  askito instructions             Print the rules to paste into any other AI tool
  askito open [--url]             Open the inbox in your browser, or print its link
  askito status | start | stop
  askito alias "Name" [path]      Show a repository under a friendlier project name

For agents
  askito ask "Title" [options]    Post a question
  askito approve "Title" [...]    Post an approve-or-reject request
  askito task "Title" [...]       Post something only the human can do
    --body TEXT  --body-file FILE (- reads stdin)
    --option "Label" or "Label::Description" (repeat)
    --recommend N  --multi  --urgent
    --project NAME  --chat NAME  --key STABLE_ID
    --wait  --timeout SECONDS  --json
  askito wait ID... [--all] [--timeout SECONDS] [--json]
  askito pickup [--project NAME] [--chat NAME] [--json]
  askito ack ID
  askito reply ID "Follow-up text"
  askito done ID ["What happened"]
  askito list [--status open|answered|done|dismissed] [--project NAME] [--json]

Exit codes for --wait and wait: 0 answered, 3 removed by the human, 4 timed out.
`;

const OPTIONS = {
  body: { type: 'string' },
  'body-file': { type: 'string' },
  option: { type: 'string', multiple: true },
  recommend: { type: 'string' },
  multi: { type: 'boolean' },
  urgent: { type: 'boolean' },
  project: { type: 'string' },
  chat: { type: 'string' },
  key: { type: 'string' },
  wait: { type: 'boolean' },
  timeout: { type: 'string' },
  json: { type: 'boolean' },
  all: { type: 'boolean' },
  status: { type: 'string' },
  tools: { type: 'string' },
  'dry-run': { type: 'boolean' },
  url: { type: 'boolean' },
  purge: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const print = (text) => process.stdout.write(`${text}\n`);

function readBody(values) {
  if (values['body-file']) return fs.readFileSync(values['body-file'] === '-' ? 0 : values['body-file'], 'utf8');
  return values.body;
}

function parseOptions(values) {
  const recommended = values.recommend ? Number(values.recommend) : 0;
  return (values.option ?? []).map((raw, index) => {
    const [label, ...rest] = raw.split('::');
    return { label, description: rest.join('::') || undefined, recommended: index + 1 === recommended };
  });
}

function outputResult(result, values) {
  print(values.json ? JSON.stringify(result, null, 2) : result.ready.map(formatItem).join('\n\n') || `pending: ${result.pending.join(', ')}`);
  if (!result.ready.length) return EXIT_TIMEOUT;
  return result.ready.some((item) => item.status === 'dismissed') ? EXIT_DISMISSED : 0;
}

async function post(kind, title, values) {
  if (!title) throw new Error(`a title is required. Example: askito ${kind === 'question' ? 'ask' : kind === 'approval' ? 'approve' : 'task'} "What should happen?"`);
  const context = detectContext();
  const { item } = await api('POST', '/api/items', {
    kind,
    title,
    body: readBody(values),
    options: parseOptions(values),
    multi: values.multi,
    urgent: values.urgent,
    key: values.key,
    project: values.project ?? context.project,
    chat: values.chat ?? context.chat,
    agent: context.agent,
    cwd: context.cwd,
  });
  if (!values.wait) {
    print(values.json ? JSON.stringify(item, null, 2) : item.id);
    return 0;
  }
  return outputResult(await waitForItems([item.id], { timeoutSeconds: Number(values.timeout ?? 0) }), values);
}

function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replaceAll('&', '^&')]] : ['xdg-open', [url]];
  execFile(command, args, () => {});
}

export async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command, ...rest] = positionals;

  if (values.version) {
    print(VERSION);
    return 0;
  }
  if (values.help || !command) {
    print(HELP);
    return 0;
  }

  switch (command) {
    case 'serve':
      serve();
      return new Promise(() => {});
    case 'mcp':
      await runMcp();
      return 0;
    case 'setup':
      return runSetup(values);
    case 'uninstall':
      return runUninstall(values);
    case 'instructions':
      print(rulesBlock());
      return 0;
    case 'start':
      await ensureServer();
      print(`running at http://127.0.0.1 (data in ${filePath('')})`);
      return 0;
    case 'stop':
      print((await stopServer()) ? 'stopped' : 'not running');
      return 0;
    case 'status': {
      const current = await status();
      print(current?.name ? `running, version ${current.version}, pid ${current.pid}` : 'not running');
      return current?.name ? 0 : 1;
    }
    case 'open': {
      await ensureServer();
      const url = inboxUrl();
      // The link holds the browser secret, so it stays out of agent transcripts by default.
      if (values.url) {
        print(url);
      } else {
        openBrowser(url);
        print('inbox opened in your browser');
      }
      return 0;
    }
    case 'alias': {
      const [name, target] = rest;
      if (!name) throw new Error('usage: askito alias "Project name" [path]');
      const root = detectContext(target ?? process.cwd()).root;
      const config = readConfig();
      writeConfig({ ...config, aliases: { ...config.aliases, [root]: name } });
      print(`${root} now shows as "${name}"`);
      return 0;
    }
    case 'ask':
      return post('question', rest[0], values);
    case 'approve':
      return post('approval', rest[0], values);
    case 'task':
      return post('task', rest[0], values);
    case 'wait':
      if (!rest.length) throw new Error('usage: askito wait ID...');
      return outputResult(await waitForItems(rest, { timeoutSeconds: Number(values.timeout ?? 0), all: values.all }), values);
    case 'pickup': {
      const query = new URLSearchParams({ project: values.project ?? detectContext().project });
      if (values.chat) query.set('chat', values.chat);
      const { items } = await api('GET', `/api/pickup?${query}`);
      print(values.json ? JSON.stringify(items, null, 2) : items.map(formatItem).join('\n\n') || 'no uncollected answers');
      return 0;
    }
    case 'list': {
      const query = new URLSearchParams();
      if (values.status) query.set('status', values.status);
      if (values.project) query.set('project', values.project);
      const { items } = await api('GET', `/api/items?${query}`);
      print(values.json ? JSON.stringify(items, null, 2) : items.map((i) => `${i.id}  ${i.status.padEnd(9)}  ${i.project}  ${i.title}`).join('\n') || 'empty');
      return 0;
    }
    case 'ack':
      await api('POST', `/api/items/${encodeURIComponent(rest[0])}/ack`, {});
      return 0;
    case 'reply':
      if (!rest[1]) throw new Error('usage: askito reply ID "Follow-up text"');
      await api('POST', `/api/items/${encodeURIComponent(rest[0])}/reply`, { text: rest[1] });
      return 0;
    case 'done':
      await api('POST', `/api/items/${encodeURIComponent(rest[0])}/done`, { note: rest[1] });
      return 0;
    default:
      throw new Error(`unknown command "${command}". Run: askito --help`);
  }
}

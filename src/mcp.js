import readline from 'node:readline';
import { api, formatItem, itemLink, itemRef, waitForItems } from './client.js';
import { detectContext } from './context.js';
import { VERSION } from './paths.js';

const MAX_WAIT = 110;

const cwdField = { type: 'string', description: 'Absolute path of your working directory. It decides the project this lands under.' };

const TOOLS = [
  {
    name: 'askito_ask',
    description:
      'Put a question, an approval request or a task for the human into their inbox instead of asking in chat. Write title and body so they make sense with no chat history. Returns the number of the item (its id) and a link; tell the user about it as askito #42 "Title" with that link. Then call askito_wait, or carry on with other work and call askito_pickup later.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'The question or action, in one line.' },
        body: { type: 'string', description: 'Context the human needs: what you found, what each choice means, your recommendation. Markdown.' },
        kind: { type: 'string', enum: ['question', 'approval', 'task'], description: 'question: pick or type an answer. approval: approve or reject. task: something only the human can do.' },
        options: {
          type: 'array',
          description: 'Choices for a question. The human can always type their own answer too.',
          items: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, description: { type: 'string' }, recommended: { type: 'boolean' } } },
        },
        multi: { type: 'boolean', description: 'Allow more than one option.' },
        yes: { type: 'string', description: 'For an approval: the approve button, in words that answer the title, such as "Yes, delete the 40 lines". Up to 60 characters, in the language you write the title in.' },
        no: { type: 'string', description: 'For an approval: the reject button, such as "No, leave them". Up to 60 characters.' },
        urgent: { type: 'boolean', description: 'Sort to the top. Use only when work is fully blocked.' },
        chat: { type: 'string', description: 'Short name of this chat or work stream.' },
        project: { type: 'string', description: 'Project name. Leave empty to detect it from cwd.' },
        key: { type: 'string', description: 'Stable id for this request, so a retry does not create a duplicate.' },
        cwd: cwdField,
      },
    },
  },
  {
    name: 'askito_script',
    description:
      'Put a script the human has to run into their inbox, where one click runs it and shows its output. Always write the same command in your chat as well, in a bash code block. In the chat, say only that the script is waiting, with the askito #N line; never copy the command into a task. The command runs with no shell, so no pipes, && or redirects: name a script file instead. askito_wait returns the output and exit code once it has run.',
    inputSchema: {
      type: 'object',
      required: ['title', 'command', 'cwd'],
      properties: {
        title: { type: 'string', description: 'What the script does, in one line.' },
        command: { type: 'array', items: { type: 'string' }, description: 'The program and its arguments, one per entry, such as ["python3", "scripts/owner/price.py", "--apply"].' },
        cwd: { type: 'string', description: 'Absolute path of the folder the script runs in.' },
        body: { type: 'string', description: 'What it changes and why the human runs it. Markdown.' },
        chat: { type: 'string', description: 'Short name of this chat or work stream.' },
        project: { type: 'string', description: 'Project name. Leave empty to detect it from cwd.' },
        key: { type: 'string', description: 'Stable id for this request, so a retry does not create a duplicate.' },
      },
    },
  },
  {
    name: 'askito_wait',
    description: 'Wait for answers to inbox items. Returns PENDING if nothing arrived in timeout_seconds. On PENDING, call it again.',
    inputSchema: {
      type: 'object',
      required: ['ids'],
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        timeout_seconds: { type: 'number', description: `How long to hold this call. Default 50, maximum ${MAX_WAIT}. Keep it below your client's tool timeout.` },
      },
    },
  },
  {
    name: 'askito_pickup',
    description: 'List answers from the human that no chat has collected yet in this project. Call at the start of a session. Then call askito_ack on the ones that belong to your work.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, chat: { type: 'string' }, cwd: cwdField } },
  },
  {
    name: 'askito_ack',
    description: 'Mark an answered item as received by you, so other chats do not pick it up.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'askito_reply',
    description: 'Send a follow-up on an item. It goes back to waiting for the human.',
    inputSchema: {
      type: 'object',
      required: ['id', 'text'],
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        options: { type: 'array', items: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, description: { type: 'string' }, recommended: { type: 'boolean' } } } },
        multi: { type: 'boolean' },
      },
    },
  },
  {
    name: 'askito_claim',
    description: 'Take over an answer no chat is following in this project, so the work does not get stuck. Then report with askito_progress and askito_done.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, cwd: cwdField } },
  },
  {
    name: 'askito_progress',
    description: 'Tell the human what you are doing about their answer. Call it as soon as you start acting on an answer, and again on long work.',
    inputSchema: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string', description: 'One line on what you are doing.' } } },
  },
  {
    name: 'askito_done',
    description: 'Close an item after you have acted on the answer, or withdraw it if it is no longer needed.',
    inputSchema: { type: 'object', required: ['id', 'note'], properties: { id: { type: 'string' }, note: { type: 'string', description: 'One line on what you did. The human reads this as the result.' } } },
  },
  {
    name: 'askito_link',
    description:
      'Add something the human will want to open again to their inbox: a web page (published artifact, report, preview, shared document) goes to the Links tab, a file on this computer (video, PDF, Markdown report, image) goes to the Files tab, where a click opens it or its folder. Call it every time you publish, update or produce one. The same address or path again updates its entry.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'What it is, in a few words.' },
        url: { type: 'string', description: 'The full web address. Give this or path.' },
        path: { type: 'string', description: 'The absolute path of a file on this computer. Give this or url.' },
        body: { type: 'string', description: 'Optional one line on what is in it.' },
        project: { type: 'string' },
        cwd: cwdField,
      },
    },
  },
];

const handlers = {
  async askito_ask(args) {
    const context = detectContext(args.cwd || process.cwd());
    const { item } = await api('POST', '/api/items', {
      ...args,
      project: args.project || context.project,
      chat: args.chat || context.chat,
      chatTitle: context.chatTitle,
      chatLink: context.chatLink,
      account: context.account,
      agent: context.agent,
      cwd: context.cwd,
      sessionId: context.session,
    });
    const id = item.number ?? item.id;
    return `Posted to the inbox. id: ${id}\nTell the user in chat: ${itemRef(item)} ${itemLink(item)}\nCall askito_wait with this id to get the answer.`;
  },
  async askito_script(args) {
    const context = detectContext(args.cwd || process.cwd());
    const { item } = await api('POST', '/api/items', {
      kind: 'script',
      title: args.title,
      body: args.body,
      command: args.command,
      cwd: args.cwd,
      key: args.key,
      project: args.project || context.project,
      chat: args.chat || context.chat,
      chatTitle: context.chatTitle,
      chatLink: context.chatLink,
      account: context.account,
      agent: context.agent,
      sessionId: context.session,
    });
    const id = item.number ?? item.id;
    return `Posted to the inbox. id: ${id}\nTell the user in chat: the script is waiting, ${itemRef(item)} ${itemLink(item)}\nShow the same command in your chat as a bash code block too. Call askito_wait with this id to get the output and exit code.`;
  },
  async askito_wait({ ids, timeout_seconds: seconds = 50 }) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('ids is required');
    const timeoutSeconds = Math.max(1, Math.min(Number(seconds) || 50, MAX_WAIT));
    const result = await waitForItems(ids, { timeoutSeconds });
    if (!result.ready.length) return `PENDING: the human has not answered ${ids.join(', ')}. Call askito_wait again.`;
    return result.ready.map(formatItem).join('\n\n');
  },
  async askito_pickup(args) {
    const context = detectContext(args.cwd || process.cwd());
    const query = new URLSearchParams({ project: args.project || context.project });
    if (args.chat) query.set('chat', args.chat);
    const { items } = await api('GET', `/api/pickup?${query}`);
    return items.length ? items.map(formatItem).join('\n\n') : 'No uncollected answers.';
  },
  async askito_ack({ id }) {
    await api('POST', `/api/items/${encodeURIComponent(id)}/ack`, {});
    return `Received ${id}.`;
  },
  async askito_reply({ id, ...body }) {
    await api('POST', `/api/items/${encodeURIComponent(id)}/reply`, body);
    return `Sent. ${id} is waiting for the human again. Call askito_wait.`;
  },
  async askito_claim({ id, cwd }) {
    const here = detectContext(cwd || process.cwd());
    const { item } = await api('POST', `/api/items/${encodeURIComponent(id)}/claim`, { sessionId: here.session ?? `mcp-${process.pid}`, chat: here.chat, agent: here.agent });
    return formatItem(item);
  },
  async askito_progress({ id, text }) {
    await api('POST', `/api/items/${encodeURIComponent(id)}/progress`, { text });
    return `Reported on ${id}.`;
  },
  async askito_link({ cwd, ...args }) {
    const here = detectContext(cwd || process.cwd());
    const { link } = await api('POST', '/api/links', { ...args, project: args.project || here.project, chat: here.chat, sessionId: here.session });
    return `${link.updated ? 'Updated' : 'Added'} in the ${link.path ? 'Files' : 'Links'} tab: ${link.title}`;
  },
  async askito_done({ id, note }) {
    await api('POST', `/api/items/${encodeURIComponent(id)}/done`, { note });
    return `Closed ${id}.`;
  },
};

async function handle(message) {
  const { method, params } = message;
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'askito', version: VERSION },
      instructions: 'Use askito_ask for any question, approval or task for the human, instead of asking in chat. Then askito_wait for the answer. For a script the human must run, show the command in chat and post it with askito_script, which gives them a Run button.',
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const handler = handlers[params?.name];
    if (!handler) return { content: [{ type: 'text', text: `Unknown tool ${params?.name}` }], isError: true };
    try {
      return { content: [{ type: 'text', text: await handler(params.arguments ?? {}) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `askito error: ${err.message}` }], isError: true };
    }
  }
  throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
}

export function runMcp(input = process.stdin, output = process.stdout) {
  const send = (payload) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
  const lines = readline.createInterface({ input });
  const pending = new Set();

  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // Requests run concurrently, so a long wait does not block a ping.
    if (message.id === undefined) return;
    const task = handle(message)
      .then((result) => send({ id: message.id, result }))
      .catch((err) => send({ id: message.id, error: { code: err.rpcCode ?? -32603, message: err.message } }))
      .finally(() => pending.delete(task));
    pending.add(task);
  });

  return new Promise((resolve) => {
    lines.on('close', () => Promise.allSettled(pending).then(resolve));
  });
}

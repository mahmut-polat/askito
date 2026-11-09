import readline from 'node:readline';
import { api, formatItem, waitForItems } from './client.js';
import { detectContext } from './context.js';
import { VERSION } from './paths.js';

const MAX_WAIT = 110;

const cwdField = { type: 'string', description: 'Absolute path of your working directory. It decides the project this lands under.' };

const TOOLS = [
  {
    name: 'askbell_ask',
    description:
      'Put a question, an approval request or a task for the human into their inbox instead of asking in chat. Write title and body so they make sense with no chat history. Returns an id. Then call askbell_wait, or carry on with other work and call askbell_pickup later.',
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
        urgent: { type: 'boolean', description: 'Sort to the top. Use only when work is fully blocked.' },
        chat: { type: 'string', description: 'Short name of this chat or work stream.' },
        project: { type: 'string', description: 'Project name. Leave empty to detect it from cwd.' },
        key: { type: 'string', description: 'Stable id for this request, so a retry does not create a duplicate.' },
        cwd: cwdField,
      },
    },
  },
  {
    name: 'askbell_wait',
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
    name: 'askbell_pickup',
    description: 'List answers from the human that no chat has collected yet in this project. Call at the start of a session. Then call askbell_ack on the ones that belong to your work.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, chat: { type: 'string' }, cwd: cwdField } },
  },
  {
    name: 'askbell_ack',
    description: 'Mark an answered item as received by you, so other chats do not pick it up.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'askbell_reply',
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
    name: 'askbell_done',
    description: 'Close an item after you have acted on the answer, or withdraw it if it is no longer needed.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, note: { type: 'string', description: 'One line on what happened.' } } },
  },
];

const handlers = {
  async askbell_ask(args) {
    const context = detectContext(args.cwd || process.cwd());
    const { item } = await api('POST', '/api/items', {
      ...args,
      project: args.project || context.project,
      chat: args.chat || context.chat,
      agent: context.agent,
      cwd: context.cwd,
    });
    return `Posted to the inbox. id: ${item.id}\nCall askbell_wait with this id to get the answer.`;
  },
  async askbell_wait({ ids, timeout_seconds: seconds = 50 }) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('ids is required');
    const timeoutSeconds = Math.max(1, Math.min(Number(seconds) || 50, MAX_WAIT));
    const result = await waitForItems(ids, { timeoutSeconds });
    if (!result.ready.length) return `PENDING: the human has not answered ${ids.join(', ')}. Call askbell_wait again.`;
    return result.ready.map(formatItem).join('\n\n');
  },
  async askbell_pickup(args) {
    const context = detectContext(args.cwd || process.cwd());
    const query = new URLSearchParams({ project: args.project || context.project });
    if (args.chat) query.set('chat', args.chat);
    const { items } = await api('GET', `/api/pickup?${query}`);
    return items.length ? items.map(formatItem).join('\n\n') : 'No uncollected answers.';
  },
  async askbell_ack({ id }) {
    await api('POST', `/api/items/${encodeURIComponent(id)}/ack`, {});
    return `Received ${id}.`;
  },
  async askbell_reply({ id, ...body }) {
    await api('POST', `/api/items/${encodeURIComponent(id)}/reply`, body);
    return `Sent. ${id} is waiting for the human again. Call askbell_wait.`;
  },
  async askbell_done({ id, note }) {
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
      serverInfo: { name: 'askbell', version: VERSION },
      instructions: 'Use askbell_ask for any question, approval or task for the human, instead of asking in chat. Then askbell_wait for the answer.',
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
      return { content: [{ type: 'text', text: `askbell error: ${err.message}` }], isError: true };
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

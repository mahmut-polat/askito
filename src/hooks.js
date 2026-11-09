import fs from 'node:fs';
import { api, ensureServer, formatItem } from './client.js';
import { detectContext } from './context.js';
import { localize } from './setup.js';

const BLOCK = 2;
const RULE = localize(
  'askito is running. Every question, decision, approval or job for the user goes to the inbox with `~/.askito/bin/askito ask|approve|task "Title" --body "Context" --wait` or the askito_* MCP tools. Do not ask in the chat.',
);

function readInput() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('error', () => resolve(null));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

function lastAssistantText(input) {
  if (typeof input.last_assistant_message === 'string') return input.last_assistant_message;
  try {
    const lines = fs.readFileSync(input.transcript_path, 'utf8').trim().split('\n').slice(-50).reverse();
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;
      const text = entry.message?.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      if (text) return text;
    }
  } catch {
    // An unreadable transcript is no reason to hold up the chat.
  }
  return '';
}

function endsOnQuestion(text) {
  const last = text.trim().split('\n').at(-1) ?? '';
  return /[?؟]$/.test(last.replace(/[\s*_`"')]+$/, ''));
}

function refuse(message) {
  process.stderr.write(`${message}\n`);
  return BLOCK;
}

function context(text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: text.event, additionalContext: text.body } });
}

async function sessionContext(input) {
  const project = detectContext(input.cwd || process.cwd()).project;
  const { items } = await api('GET', `/api/pickup?project=${encodeURIComponent(project)}`);
  if (!items.length) return RULE;
  return `${RULE}\n\nAnswers no chat has collected yet. Act on the ones that are yours and ack them:\n\n${items.map(formatItem).join('\n\n')}`;
}

async function followUps(input) {
  if (!input.session_id) return '';
  const { uncollected, unreported } = await api('GET', `/api/followups?session=${encodeURIComponent(input.session_id)}`);
  const parts = [];
  if (uncollected.length) parts.push(`The user answered. Act on these and ack them:\n\n${uncollected.map(formatItem).join('\n\n')}`);
  if (unreported.length) {
    parts.push(
      localize(`You received these answers and the user cannot see what you did about them. Run \`~/.askito/bin/askito progress ID "what you are doing"\` now and \`~/.askito/bin/askito done ID "what you did"\` when finished:\n\n${unreported.map(formatItem).join('\n\n')}`),
    );
  }
  return parts.join('\n\n');
}

export async function runHook(name) {
  const input = await readInput();
  if (!input) return 0;
  try {
    await ensureServer();
  } catch {
    // Enforcement only applies while askito can actually take the question.
    return 0;
  }

  switch (name) {
    case 'block-question': {
      const asksUser = input.tool_name === 'AskUserQuestion' || (input.tool_name === 'mcp__ccd_turn__wrap_up' && input.tool_input?.ask);
      return asksUser ? refuse(RULE) : 0;
    }
    case 'stop':
    {
      if (input.stop_hook_active) return 0;
      if (endsOnQuestion(lastAssistantText(input))) return refuse(`Your reply ends on a question. ${RULE} Post it there now and end your turn without asking it.`);
      const owed = await followUps(input);
      return owed ? refuse(owed) : 0;
    }
    case 'session':
      process.stdout.write(context({ event: 'SessionStart', body: [await sessionContext(input), await followUps(input)].filter(Boolean).join('\n\n') }));
      return 0;
    case 'reminder':
      process.stdout.write(context({ event: 'UserPromptSubmit', body: [RULE, await followUps(input)].filter(Boolean).join('\n\n') }));
      return 0;
    default:
      return 0;
  }
}

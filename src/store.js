import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

export const KINDS = ['question', 'approval', 'task'];
export const FIRST_RUN_KEY = 'first-run-broadcast';

const DECISIONS = {
  question: ['option', 'comment'],
  approval: ['approved', 'rejected', 'comment'],
  task: ['done', 'blocked', 'comment'],
};

const LIMITS = { title: 300, body: 20000, comment: 20000, options: 12, label: 200, description: 500, meta: 200 };
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (message) => new HttpError(400, 'invalid_request', message);

function text(value, name, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw invalid(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw invalid(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw invalid(`${name} is required`);
    return null;
  }
  if (trimmed.length > max) throw invalid(`${name} is longer than ${max} characters`);
  return trimmed;
}

function normalizeOptions(raw, kind) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('options must be a list');
  if (raw.length && kind !== 'question') throw invalid('options only apply to kind "question"');
  if (raw.length > LIMITS.options) throw invalid(`at most ${LIMITS.options} options`);
  const seen = new Set();
  return raw.map((entry, index) => {
    const source = typeof entry === 'string' ? { label: entry } : entry;
    if (!source || typeof source !== 'object') throw invalid('each option needs a label');
    const label = text(source.label, 'option label', LIMITS.label, { required: true });
    if (seen.has(label)) throw invalid(`duplicate option "${label}"`);
    seen.add(label);
    return {
      id: String(index + 1),
      label,
      description: text(source.description, 'option description', LIMITS.description),
      recommended: source.recommended === true,
    };
  });
}

function newId() {
  const bytes = randomBytes(6);
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

export function isResolved(item) {
  return item.status !== 'open';
}

export class Store extends EventEmitter {
  constructor(file) {
    super();
    this.setMaxListeners(0);
    this.file = file;
    this.items = new Map();
    this.timer = null;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    try {
      for (const item of JSON.parse(raw).items) this.items.set(item.id, item);
    } catch {
      // Keep the unreadable file for recovery instead of overwriting it.
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      this.items.clear();
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: [...this.items.values()] }), { mode: 0o600 });
    // On Windows, antivirus and indexers can hold the target open for a moment.
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (err) {
        if (attempt === 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }

  changed(type, item) {
    item.updatedAt = new Date().toISOString();
    this.timer ??= setTimeout(() => this.flush(), 30);
    this.emit('change', { type, item });
  }

  get(id) {
    const item = this.items.get(id);
    if (!item) throw new HttpError(404, 'not_found', `no item with id ${id}`);
    return item;
  }

  list({ status, project, chat } = {}) {
    return [...this.items.values()]
      .filter((i) => (!status || i.status === status) && (!project || i.project === project) && (!chat || i.chat === chat))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  create(input) {
    const kind = input.kind ?? 'question';
    if (!KINDS.includes(kind)) throw invalid(`kind must be one of ${KINDS.join(', ')}`);
    const options = normalizeOptions(input.options, kind);
    const fields = {
      kind,
      title: text(input.title, 'title', LIMITS.title, { required: true }),
      body: text(input.body, 'body', LIMITS.body),
      options,
      multi: input.multi === true && options.length > 0,
      urgent: input.urgent === true,
      project: text(input.project, 'project', LIMITS.meta) ?? 'unsorted',
      chat: text(input.chat, 'chat', LIMITS.meta),
      agent: text(input.agent, 'agent', LIMITS.meta),
      cwd: text(input.cwd, 'cwd', 1000),
      key: text(input.key, 'key', LIMITS.meta),
    };

    // A retrying agent must not create a second copy of the same request.
    if (fields.key) {
      const existing = this.list({ project: fields.project }).find((i) => i.key === fields.key && (i.status === 'open' || i.status === 'answered'));
      if (existing) return { ...existing, deduped: true };
    }

    const now = new Date().toISOString();
    const item = { id: newId(), ...fields, status: 'open', answer: null, deliveredAt: null, messages: [], createdAt: now, updatedAt: now };
    this.items.set(item.id, item);
    this.changed('created', item);
    return item;
  }

  answer(id, input) {
    const item = this.get(id);
    if (item.status !== 'open') throw new HttpError(409, 'not_open', 'this item has already been answered');
    const decision = input.decision;
    if (!DECISIONS[item.kind].includes(decision)) throw invalid(`decision must be one of ${DECISIONS[item.kind].join(', ')}`);
    const comment = text(input.comment, 'comment', LIMITS.comment);
    if (decision === 'comment' && !comment) throw invalid('comment is required');

    let choices = [];
    if (decision === 'option') {
      const picked = Array.isArray(input.choices) ? input.choices : [];
      const chosen = item.options.filter((o) => picked.includes(o.id));
      if (!chosen.length || chosen.length !== picked.length) throw invalid('choices must be valid option ids');
      if (!item.multi && chosen.length > 1) throw invalid('this question takes one choice');
      choices = chosen.map((o) => o.label);
    }

    const at = new Date().toISOString();
    item.answer = { decision, choices, comment, at };
    item.status = 'answered';
    item.deliveredAt = null;
    item.messages.push({ from: 'human', decision, choices, text: comment, at });
    this.changed('answered', item);
    return item;
  }

  reply(id, input) {
    const item = this.get(id);
    if (item.status === 'done' || item.status === 'dismissed') throw new HttpError(409, 'closed', 'this item is closed');
    const body = text(input.text, 'text', LIMITS.comment, { required: true });
    if (input.options !== undefined) {
      item.options = normalizeOptions(input.options, item.kind);
      item.multi = input.multi === true && item.options.length > 0;
    }
    item.status = 'open';
    item.answer = null;
    item.deliveredAt = null;
    item.messages.push({ from: 'agent', text: body, at: new Date().toISOString() });
    this.changed('reply', item);
    return item;
  }

  ack(id) {
    const item = this.get(id);
    if (item.status === 'open') throw new HttpError(409, 'not_answered', 'this item has no answer yet');
    item.deliveredAt ??= new Date().toISOString();
    this.changed('ack', item);
    return item;
  }

  close(id, from, note) {
    const item = this.get(id);
    if (item.status === 'dismissed') throw new HttpError(409, 'closed', 'this item was removed');
    if (item.status === 'done') return item;
    const body = text(note, 'note', LIMITS.comment);
    item.status = 'done';
    if (body) item.messages.push({ from, text: body, at: new Date().toISOString() });
    this.changed('done', item);
    return item;
  }

  dismiss(id, note) {
    const item = this.get(id);
    if (item.status === 'dismissed') return item;
    const comment = text(note, 'note', LIMITS.comment);
    const at = new Date().toISOString();
    // A chat blocked on this item must be released, so removal counts as an answer.
    item.status = 'dismissed';
    item.answer = { decision: 'dismissed', choices: [], comment, at };
    item.deliveredAt = null;
    this.changed('dismissed', item);
    return item;
  }

  reopen(id) {
    const item = this.get(id);
    if (item.status === 'open') return item;
    item.status = 'open';
    item.answer = null;
    item.deliveredAt = null;
    this.changed('reopened', item);
    return item;
  }

  pickup({ project, chat } = {}) {
    // The first-run answer is for whichever chat comes along next, in any project.
    return this.list()
      .filter((i) => i.key === FIRST_RUN_KEY || ((!project || i.project === project) && (!chat || i.chat === chat)))
      .filter((i) => (i.status === 'answered' || i.status === 'dismissed') && !i.deliveredAt)
      .reverse();
  }
}

// Everything agents write is untrusted, so this file builds the DOM with
// textContent only and never assigns innerHTML.

const LANGUAGES = { en: 'English', tr: 'Türkçe' };
const LANGUAGE_KEY = 'askito.ui-language';
const TABS = [
  { id: 'waiting', status: 'open', label: 'tabWaiting', head: 'headWaiting', empty: 'emptyWaiting' },
  { id: 'later', status: 'open', later: true, label: 'tabLater', head: 'headLater', empty: 'emptyLater' },
  // Answered is done for the user: the chat's progress shows on the row.
  { id: 'done', status: ['answered', 'done'], label: 'tabDone', head: 'headDone', empty: 'emptyDone' },
  { id: 'removed', status: 'dismissed', label: 'tabRemoved', head: 'headRemoved', empty: 'emptyRemoved' },
  { id: 'links', links: 'web', label: 'tabLinks', head: 'headLinks', empty: 'emptyLinks' },
  { id: 'files', links: 'file', label: 'tabFiles', head: 'headFiles', empty: 'emptyFiles' },
];
const STALL_MINUTES = 30;
const KIND_LABEL = { question: 'kindQuestion', approval: 'kindApproval', task: 'kindTask', script: 'kindScript' };
// Lucide icons, one distinct silhouette per kind.
const KIND_ICON = {
  question: [
    ['circle', { cx: 12, cy: 12, r: 10 }],
    ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }],
    ['path', { d: 'M12 17h.01' }],
  ],
  approval: [
    ['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }],
    ['path', { d: 'm9 12 2 2 4-4' }],
  ],
  task: [
    ['circle', { cx: 12, cy: 8, r: 5 }],
    ['path', { d: 'M20 21a8 8 0 0 0-16 0' }],
  ],
  script: [
    ['path', { d: 'M12 19h8' }],
    ['path', { d: 'm4 17 6-6-6-6' }],
  ],
  file: [
    ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
    ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
  ],
  link: [
    ['path', { d: 'M15 3h6v6' }],
    ['path', { d: 'M10 14 21 3' }],
    ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
  ],
};

const app = document.getElementById('app');
const live = document.getElementById('live');
const state = { sort: 'newest', directory: { projects: [], sessions: [] }, mergeOpen: false, mergeFrom: '', mergeTo: '', items: [], links: [], project: null, tab: 'waiting', selected: null, query: '', busy: null, error: null, sessionLost: false };
const drafts = new Map();
let catalog = {};
let language = 'en';
let snapshot = '';

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private windows can refuse storage; preferences just reset.
    }
  },
};

function t(key, vars = {}) {
  return (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value' || key === 'checked' || key === 'disabled') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

async function loadLanguage(code) {
  language = LANGUAGES[code] ? code : 'en';
  const res = await fetch(`/i18n/${language}.json`);
  catalog = await res.json();
  document.documentElement.lang = language;
}

function applyTheme(choice) {
  const dark = choice === 'dark' || (choice !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function inlineNodes(text) {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)]+)/g;
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1]) nodes.push(h('code', {}, match[1].slice(1, -1)));
    else if (match[2]) nodes.push(h('strong', {}, match[2].slice(2, -2)));
    else {
      const href = match[4] ?? match[5];
      nodes.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, match[3] ?? href));
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/;

function tableCells(line) {
  return line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
}

// A GitHub-style pipe table: header row, a |---| rule, then body rows.
// Narrow containers stack each row into a block with the column name beside each value.
function table(header, rows) {
  return h(
    'div',
    { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': header.join(', ') },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, header.map((cell) => h('th', { scope: 'col' }, inlineNodes(cell))))),
      h(
        'tbody',
        {},
        rows.map((row) =>
          h(
            'tr',
            {},
            header.map((label, index) =>
              index === 0
                ? h('th', { scope: 'row' }, inlineNodes(row[index] ?? ''))
                : h('td', { 'data-label': label }, inlineNodes(row[index] ?? '')),
            ),
          ),
        ),
      ),
    ),
  );
}

function markdown(source) {
  const root = h('div', { class: 'body' });
  const lines = source.split('\n');
  let list = null;
  let paragraph = [];
  // Line breaks the writer typed stay line breaks: reports and logs are written line by line.
  const flush = () => {
    if (paragraph.length) {
      root.append(h('p', {}, paragraph.flatMap((text, index) => (index ? [h('br'), ...inlineNodes(text)] : inlineNodes(text)))));
    }
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      flush();
      list = null;
      const header = tableCells(line);
      const rows = [];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i += 1) rows.push(tableCells(lines[i]));
      i -= 1;
      root.append(table(header, rows));
      continue;
    }
    if (line.startsWith('```')) {
      flush();
      list = null;
      const code = [];
      for (i += 1; i < lines.length && !lines[i].startsWith('```'); i += 1) code.push(lines[i]);
      root.append(h('pre', {}, h('code', {}, code.join('\n'))));
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)/);
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (heading) {
      flush();
      list = null;
      root.append(h('h3', {}, inlineNodes(heading[1])));
    } else if (bullet || numbered) {
      flush();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = h(tag);
        root.append(list);
      }
      list.append(h('li', {}, inlineNodes((bullet ?? numbered)[1])));
    } else if (!line.trim()) {
      flush();
      list = null;
    } else {
      list = null;
      paragraph.push(line.trim());
    }
  }
  flush();
  return root;
}

function stamp(iso) {
  const date = new Date(iso);
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', year, hour: '2-digit', minute: '2-digit' }).format(date);
}

function relative(iso) {
  const seconds = Math.round((new Date(iso) - Date.now()) / 1000);
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
  }
  return format.format(0, 'minute');
}

const draftFor = (id) => {
  if (!drafts.has(id)) drafts.set(id, { choices: new Set(), comment: '' });
  return drafts.get(id);
};

function projectHue(name) {
  return Array.from(name).reduce((total, char) => total + char.codePointAt(0), 0) % 6;
}

const projectLabel = (name) => (name === 'unsorted' ? t('unsorted') : name);

function inTab(item, tab) {
  const statuses = [tab.status].flat();
  return statuses.includes(item.status) && (item.status !== 'open' || Boolean(item.laterAt) === Boolean(tab.later));
}

function dayKey(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayLabel(key) {
  const [year, month, day] = key.split('-').map(Number);
  const then = new Date(year, month - 1, day);
  const now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - then) / 86400000);
  if (days <= 1) {
    const word = new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(-days, 'day');
    return word.charAt(0).toLocaleUpperCase(language) + word.slice(1);
  }
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'long', year: year === now.getFullYear() ? undefined : 'numeric' }).format(then);
}

// Items arrive sorted, so groups and days keep the order of their first item.
function groupItems(items) {
  const projects = new Map();
  for (const item of items) {
    const days = projects.get(item.project) ?? new Map();
    const key = dayKey(item.createdAt);
    days.set(key, [...(days.get(key) ?? []), item]);
    projects.set(item.project, days);
  }
  return [...projects.entries()]
    .map(([project, days]) => ({
      project,
      count: [...days.values()].flat().length,
      days: [...days.entries()].map(([key, list]) => ({ key, label: dayLabel(key), items: list })),
    }));
}

function currentTab() {
  return TABS.find((tab) => tab.id === state.tab);
}

function visibleItems() {
  const tab = currentTab();
  const query = state.query.trim().toLocaleLowerCase(language);
  const items = state.items.filter((item) => {
    if (!inTab(item, tab)) return false;
    if (state.project && item.project !== state.project) return false;
    if (!query) return true;
    if (String(item.number) === query.replace(/^#/, '')) return true;
    return [item.title, item.body, item.chat, item.chatTitle, item.project].some((field) => field?.toLocaleLowerCase(language).includes(query));
  });
  const newest = (a, b) => b.createdAt.localeCompare(a.createdAt);
  const compare = {
    newest,
    oldest: (a, b) => newest(b, a),
    urgent: (a, b) => Number(b.urgent) - Number(a.urgent) || newest(a, b),
    project: (a, b) => a.project.localeCompare(b.project, language) || newest(a, b),
  };
  return items.sort(compare[state.sort] ?? newest);
}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    state.sessionLost = true;
    throw new Error('session');
  }
  if (!res.ok) throw Object.assign(new Error('request'), { status: res.status });
  return res.json();
}

// Browser notifications replace the macOS ones, which opened Script Editor.
const seenOpen = new Set();
let firstLoad = true;

function notifyNew(items) {
  const fresh = items.filter((item) => item.status === 'open' && !item.laterAt && !seenOpen.has(item.id));
  for (const item of fresh) seenOpen.add(item.id);
  if (firstLoad || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  for (const item of fresh.slice(0, 3)) {
    const note = new Notification(`ask++: ${projectLabel(item.project)}`, { body: item.title, tag: item.id });
    note.onclick = () => {
      window.focus();
      state.selected = item.id;
      render();
    };
  }
}

function notificationButton() {
  if (!('Notification' in window) || Notification.permission !== 'default') return null;
  return h(
    'button',
    {
      type: 'button',
      class: 'btn notify-on',
      onclick: async () => {
        await Notification.requestPermission();
        render();
      },
    },
    t('notificationsOn'),
  );
}

async function refresh() {
  try {
    const [{ items }, directory, { links }] = await Promise.all([request('GET', '/api/items'), request('GET', '/api/directory'), request('GET', '/api/links')]);
    const next = JSON.stringify([items, directory, links]);
    if (next === snapshot && !state.sessionLost) return;
    snapshot = next;
    notifyNew(items);
    announceRunEnds(items);
    firstLoad = false;
    state.items = items;
    state.links = links;
    state.directory = directory;
    keepSelection();
    liveRender();
  } catch {
    liveRender();
  }
}

function keepSelection() {
  const items = visibleItems();
  // Nothing opens by itself: answering one item must not unfold the next.
  if (!items.some((item) => item.id === state.selected)) state.selected = null;
}

async function act(id, action, body = {}) {
  if (state.busy) return;
  state.busy = `${id}:${action}:${body.decision ?? ''}`;
  state.error = null;
  render();
  try {
    await request('POST', `/api/items/${id}/${action}`, body);
    drafts.delete(id);
    live.textContent = t('announceSent');
  } catch (err) {
    // A 409 means another tab answered first; the refresh below shows that.
    if (err.status !== 409) state.error = { id, message: state.sessionLost ? t('errorSession') : t('errorGeneric') };
  }
  state.busy = null;
  await refresh();
  render();
}

function button(item, { label, mark, kind, action, body, disabled, needsComment }) {
  const busy = state.busy === `${item.id}:${action}:${body?.decision ?? ''}`;
  return h(
    'button',
    {
      type: 'button',
      class: `btn ${kind ?? ''}`,
      disabled: disabled ?? false,
      'aria-busy': busy ? 'true' : null,
      'data-needs-comment': needsComment ? '1' : null,
      onclick: () => {
        const payload = typeof body === 'function' ? body() : body;
        act(item.id, action, payload);
      },
    },
    busy ? t('sending') : [mark ? h('span', { class: 'btn-mark', 'aria-hidden': 'true' }, mark) : null, label],
  );
}

function submitQuestion(item) {
  const draft = draftFor(item.id);
  const comment = draft.comment.trim();
  if (draft.choices.size) return { decision: 'option', choices: [...draft.choices], comment };
  return { decision: 'comment', comment };
}

function syncSendState(row, item) {
  const draft = draftFor(item.id);
  const hasComment = draft.comment.trim().length > 0;
  row.querySelectorAll('[data-needs-comment]').forEach((el) => {
    el.disabled = !hasComment;
  });
  const send = row.querySelector('[data-send]');
  if (send) send.disabled = !hasComment && draft.choices.size === 0;
}

function optionPicker(item, row) {
  const draft = draftFor(item.id);
  const type = item.multi ? 'checkbox' : 'radio';
  return h(
    'fieldset',
    { class: 'choices' },
    h('legend', { class: 'sr-only' }, item.title),
    item.options.map((option) =>
      h(
        'label',
        { class: 'choice' },
        h('input', {
          type,
          name: `choice-${item.id}`,
          value: option.id,
          checked: draft.choices.has(option.id),
          'data-option': option.id,
          onchange: (event) => {
            if (!item.multi) draft.choices.clear();
            if (event.target.checked) draft.choices.add(option.id);
            else draft.choices.delete(option.id);
            syncSendState(row(), item);
          },
        }),
        h(
          'span',
          {},
          h('span', { class: 'choice-label' }, option.label),
          option.recommended ? h('span', { class: 'reco' }, h('span', { 'aria-hidden': 'true' }, '★ '), t('recommended')) : null,
          option.description ? h('span', { class: 'choice-note' }, option.description) : null,
        ),
      ),
    ),
  );
}

function commentBox(item, row) {
  const draft = draftFor(item.id);
  const id = `comment-${item.id}`;
  return h(
    'div',
    {},
    h('label', { for: id, class: 'note' }, t(item.kind === 'question' ? 'commentLabel' : 'noteLabel')),
    h('textarea', {
      id,
      'data-fk': id,
      placeholder: t(item.kind === 'question' ? 'commentPlaceholder' : 'notePlaceholder'),
      value: draft.comment,
      oninput: (event) => {
        draft.comment = event.target.value;
        syncSendState(row(), item);
      },
      onkeydown: (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          row().querySelector('.btn.primary:not(:disabled)')?.click();
        }
      },
    }),
  );
}

// How a script ended, in one line.
function runSummary(run) {
  if (run.state === 'running') return t('running');
  if (run.error) return t('runFailed', { error: run.error });
  if (run.signal) return t('runStopped', { signal: run.signal });
  return t('runExit', { code: run.exitCode });
}

// Tells screen readers through the page's one live region when a run ends.
function announceRunEnds(items) {
  for (const item of items) {
    const before = state.items.find((old) => old.id === item.id);
    if (before?.run?.state === 'running' && item.run?.state === 'finished') live.textContent = `${item.title}: ${runSummary(item.run)}`;
  }
}

// Shows a word that holds spaces or shell signs in quotes, so the line reads as typed.
function shellWord(word) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

function scriptView(item) {
  const { command, cwd } = item.script;
  const run = item.run;
  const failed = run?.state === 'finished' && (run.error || run.signal || run.exitCode !== 0);
  return h(
    'div',
    { class: 'script' },
    h('p', { class: 'note' }, t('scriptIntro')),
    h('pre', { class: 'script-command' }, h('code', {}, command.map(shellWord).join(' '))),
    h('p', { class: 'note' }, t('scriptFolder'), ' ', h('code', {}, cwd)),
    run
      ? h(
          'div',
          { class: 'run' },
          h(
            'p',
            { class: `run-state${failed ? ' bad' : run.state === 'finished' ? ' good' : ''}` },
            run.state === 'running' ? h('progress', { 'aria-label': t('running') }) : null,
            runSummary(run),
          ),
          h('pre', { class: 'run-output', tabindex: '0', 'data-out': item.id, 'aria-label': t('runOutput') }, run.output || t('noOutput')),
        )
      : null,
  );
}

function scriptActions(item) {
  const remove = button(item, { label: t('remove'), kind: 'quiet', action: 'dismiss', body: {} });
  if (item.run?.state === 'running') return h('div', { class: 'actions' }, button(item, { label: t('stop'), kind: 'danger', action: 'stop', body: {} }));
  if (item.status === 'answered') {
    return h(
      'div',
      { class: 'actions' },
      button(item, { label: t('complete'), kind: 'primary', action: 'close', body: {} }),
      button(item, { label: t('runAgain'), action: 'run', body: {} }),
      remove,
    );
  }
  const setAside = item.laterAt
    ? button(item, { label: t('backToWaiting'), action: 'later', body: { later: false } })
    : button(item, { label: t('later'), action: 'later', body: { later: true } });
  return h('div', { class: 'actions' }, button(item, { label: t('run'), kind: 'primary', action: 'run', body: {} }), setAside, remove);
}

function openControls(item, row) {
  if (item.kind === 'script') return [scriptActions(item)];
  const draft = draftFor(item.id);
  const hasComment = draft.comment.trim().length > 0;
  const comment = () => draftFor(item.id).comment.trim();
  const setAside = item.laterAt
    ? button(item, { label: t('backToWaiting'), action: 'later', body: { later: false } })
    : button(item, { label: t('later'), action: 'later', body: { later: true } });
  const removeButton = [setAside, button(item, { label: t('remove'), kind: 'quiet', action: 'dismiss', body: {} })];
  const commentButton = button(item, { label: t('commentOnly'), action: 'answer', body: () => ({ decision: 'comment', comment: comment() }), disabled: !hasComment, needsComment: true });

  if (item.kind === 'approval') {
    return [
      commentBox(item, row),
      h(
        'div',
        { class: 'actions' },
        button(item, { label: item.yes || t('approve'), mark: '✓', kind: 'ok', action: 'answer', body: () => ({ decision: 'approved', comment: comment() }) }),
        button(item, { label: item.no || t('reject'), mark: '✕', kind: 'danger', action: 'answer', body: () => ({ decision: 'rejected', comment: comment() }) }),
        commentButton,
        removeButton,
      ),
    ];
  }
  if (item.kind === 'task') {
    return [
      commentBox(item, row),
      h(
        'div',
        { class: 'actions' },
        button(item, { label: t('markDone'), mark: '✓', kind: 'ok', action: 'answer', body: () => ({ decision: 'done', comment: comment() }) }),
        button(item, { label: t('cantDo'), mark: '✕', action: 'answer', body: () => ({ decision: 'blocked', comment: comment() }) }),
        commentButton,
        removeButton,
      ),
    ];
  }

  const send = button(item, { label: t('send'), kind: 'primary', action: 'answer', body: () => submitQuestion(item), disabled: !hasComment && draft.choices.size === 0 });
  send.dataset.send = '1';
  return [item.options.length ? optionPicker(item, row) : null, commentBox(item, row), h('div', { class: 'actions' }, send, removeButton)];
}

function answerLine(item) {
  if (!item.answer) return null;
  const custom = { approved: item.yes, rejected: item.no }[item.answer.decision];
  const parts = [h('strong', {}, custom || t(`decision_${item.answer.decision}`))];
  if (item.answer.choices.length) parts.push(`: ${item.answer.choices.join(', ')}`);
  return h('div', { class: 'answer-line' }, parts, item.answer.comment ? h('div', {}, item.answer.comment) : null);
}

function chatState(item) {
  if (item.status !== 'answered' || !item.answer) return null;
  if (item.orphaned) return { label: t('stateOrphaned'), tone: 'warn' };
  if (!item.deliveredAt) return { label: t('stateNotReceived'), tone: 'warn' };
  const last = item.messages.filter((m) => m.from === 'agent' && m.kind !== 'handover' && m.at >= item.answer.at).at(-1);
  const minutes = Math.floor((Date.now() - Date.parse(last?.at ?? item.deliveredAt)) / 60000);
  if (minutes >= STALL_MINUTES) return { label: t('stateStalled', { mins: minutes }), tone: 'warn', note: last?.text };
  if (last) return { label: t('stateWorking'), tone: 'ok', note: last.text };
  return { label: t('stateReceived'), tone: 'info' };
}

function resultOf(item) {
  if (item.status !== 'done') return null;
  return item.messages.filter((m) => m.kind === 'result' || m.from === 'agent').at(-1)?.text ?? null;
}

// The text the reader selected inside one item's body, kept here because pressing
// the copy button can collapse the live selection before its click runs.
let picked = { item: null, text: '' };
const copyTimers = new WeakMap();

function selectionInApp() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return app.contains(range.commonAncestorContainer) ? selection : null;
}

function trackSelection() {
  const selection = selectionInApp();
  const body = selection?.anchorNode?.parentElement?.closest('[data-copy-item] .body');
  const owner = body?.closest('[data-copy-item]')?.dataset.copyItem ?? null;
  picked = owner && body.contains(selection.focusNode) ? { item: owner, text: selection.toString().trim() } : { item: null, text: '' };
  for (const button of app.querySelectorAll('.btn.copy')) {
    if (button.dataset.copied === undefined) button.textContent = button.dataset.copyFor === picked.item && picked.text ? t('copySelection') : t('copy');
  }
}

document.addEventListener('selectionchange', () => {
  trackSelection();
  if (pendingRender && !selectionInApp()) render();
});

function copyButton(item) {
  const tip = h('span', { class: 'copy-tip', role: 'status' });
  const button = h(
    'button',
    {
      type: 'button',
      class: 'btn copy',
      'data-copy-for': item.id,
      // Keep the reader's selection alive while the button is pressed.
      onpointerdown: (event) => event.preventDefault(),
      onclick: async (event) => {
        const control = event.currentTarget;
        const text = picked.item === item.id && picked.text ? picked.text : [item.title, item.body].filter(Boolean).join('\n\n');
        let ok = true;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          ok = false;
        }
        clearTimeout(copyTimers.get(control));
        control.dataset.copied = '';
        control.textContent = ok ? t('copied') : t('copyFailed');
        tip.textContent = control.textContent;
        copyTimers.set(
          control,
          setTimeout(() => {
            delete control.dataset.copied;
            tip.textContent = '';
            trackSelection();
          }, 1500),
        );
      },
    },
    picked.item === item.id && picked.text ? t('copySelection') : t('copy'),
  );
  return h('span', { class: 'copy-wrap' }, button, tip);
}

function assignControls(item) {
  const { projects, sessions } = state.directory;
  const others = sessions.filter((session) => session.id !== item.sessionId);
  const ordered = [...others.filter((session) => session.project === item.project), ...others.filter((session) => session.project !== item.project)];
  const chatName = (session) => `${session.project ? `${projectLabel(session.project)}: ` : ''}${session.chat || session.id.slice(0, 8)} (${relative(session.lastSeen)})`;
  return h(
    'div',
    { class: 'assign' },
    h(
      'label',
      {},
      t('assignProject'),
      h('select', { onchange: (event) => act(item.id, 'assign', { project: event.target.value }) }, projects.map((name) => h('option', { value: name, selected: name === item.project }, projectLabel(name)))),
    ),
    h(
      'label',
      {},
      t('assignChat'),
      h(
        'select',
        {
          onchange: (event) => {
            const { value } = event.target;
            if (value) act(item.id, 'assign', value === 'any' ? { anyChat: true } : { sessionId: value });
          },
        },
        h('option', { value: '', selected: true }, item.chat || t('chatUnknown')),
        h('option', { value: 'any' }, t('assignAnyChat')),
        ordered.map((session) => h('option', { value: session.id }, chatName(session))),
      ),
    ),
  );
}

function mergeControls() {
  const { projects } = state.directory;
  if (projects.length < 2) return null;
  const from = projects.includes(state.mergeFrom) ? state.mergeFrom : projects[0];
  const to = projects.includes(state.mergeTo) && state.mergeTo !== from ? state.mergeTo : projects.find((name) => name !== from);
  const select = (value, field) =>
    h(
      'select',
      {
        onchange: (event) => {
          state[field] = event.target.value;
          render();
        },
      },
      projects.map((name) => h('option', { value: name, selected: name === value }, projectLabel(name))),
    );
  return h(
    'details',
    { class: 'merge', open: state.mergeOpen, ontoggle: (event) => (state.mergeOpen = event.target.open) },
    h('summary', {}, t('mergeTitle')),
    h('label', {}, t('mergeFrom'), select(from, 'mergeFrom')),
    h('label', {}, t('mergeTo'), select(to, 'mergeTo')),
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        onclick: async () => {
          if (!window.confirm(t('mergeConfirm', { from, to }))) return;
          await request('POST', '/api/projects/merge', { from, to });
          state.project = null;
          await refresh();
        },
      },
      t('mergeAction'),
    ),
  );
}

function resolvedControls(item) {
  if (item.kind === 'script' && item.status === 'answered') return [scriptActions(item)];
  if (item.status === 'answered') {
    return [
      h(
        'div',
        { class: 'actions' },
        button(item, { label: t('complete'), kind: 'primary', action: 'close', body: {} }),
        button(item, { label: t('changeAnswer'), action: 'reopen', body: {} }),
        button(item, { label: t('remove'), kind: 'quiet', action: 'dismiss', body: {} }),
      ),
    ];
  }
  if (item.status === 'done') {
    return [h('div', { class: 'actions' }, button(item, { label: t('reopen'), action: 'reopen', body: {} }), button(item, { label: t('remove'), kind: 'quiet', action: 'dismiss', body: {} }))];
  }
  return [answerLine(item), h('div', { class: 'actions' }, button(item, { label: t('restore'), action: 'reopen', body: {} }))];
}

const AGENT_EVENT = { handover: 'eventHandover', progress: 'eventProgress', result: 'eventResult', question: 'eventQuestion' };

function timeline(item) {
  const events = [{ at: item.createdAt, label: t('eventAsked') }];
  for (const message of item.messages) {
    if (message.from === 'human') {
      if (message.kind === 'assigned') {
        events.push({ at: message.at, label: t('eventAssigned'), text: message.text });
        continue;
      }
      const decided = message.decision ? `: ${t(`decision_${message.decision}`)}` : '';
      const picked = message.choices?.length ? ` (${message.choices.join(', ')})` : '';
      events.push({ at: message.at, label: `${t('youLabel')}${decided}${picked}`, text: message.text });
    } else {
      const fallback = item.status === 'done' ? 'result' : 'question';
      events.push({ at: message.at, label: t(AGENT_EVENT[message.kind ?? fallback]), text: message.text });
    }
  }
  if (item.deliveredAt) events.push({ at: item.deliveredAt, label: t('eventReceived') });
  if (events.length === 1) return null;
  events.sort((a, b) => a.at.localeCompare(b.at));
  return h(
    'ol',
    { class: 'thread' },
    events.map((event) => h('li', {}, h('div', { class: 'thread-who' }, `${stamp(event.at)}, ${event.label}`), event.text ? markdown(event.text) : null)),
  );
}

function kindIcon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const attrs = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  Object.entries(attrs).forEach(([name, value]) => svg.setAttribute(name, value));
  for (const [tag, shape] of KIND_ICON[kind]) {
    const part = document.createElementNS(ns, tag);
    Object.entries(shape).forEach(([name, value]) => part.setAttribute(name, value));
    svg.append(part);
  }
  return h('span', { class: 'kind-icon' }, svg);
}

// The two orange crosses of the ask++ wordmark, drawn inline because the
// page's CSP (img-src 'self') refuses data: images.
function brandPlus() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [name, value] of Object.entries({ class: 'brand-plus', viewBox: '0 0 54 22', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
  for (const [x, y, width, height] of [[7.5, 0, 7, 22], [0, 7.5, 22, 7], [39.5, 0, 7, 22], [32, 7.5, 22, 7]]) {
    const bar = document.createElementNS(ns, 'rect');
    for (const [name, value] of Object.entries({ x, y, width, height, rx: 2 })) bar.setAttribute(name, value);
    svg.append(bar);
  }
  return svg;
}

// The chat that asked, by the name in the Claude sidebar, with a link that opens it.
// It sits in the open row, because the row head is itself a button.
function chatPlace(item) {
  if (!item.chatLink) return null;
  const title = item.chatTitle || item.chat || t('openChatUntitled');
  return h(
    'p',
    { class: 'chat-place' },
    h('a', { href: item.chatLink }, t('openChat', { title })),
    item.account ? h('span', { class: 'chat-account' }, t('chatAccount', { account: item.account })) : null,
  );
}

function renderRow(item, index) {
  const isOpen = state.selected === item.id;
  const row = () => document.querySelector(`[data-item="${item.id}"]`);
  const progress = chatState(item);
  const result = resultOf(item);
  const note = progress?.note ?? (result ? `${t('eventResult')}: ${result}` : null);
  const meta = h(
    'span',
    { class: 'meta' },
    h('span', { class: `badge badge-${projectHue(item.project)}` }, projectLabel(item.project)),
    h('span', { class: 'tag' }, t(KIND_LABEL[item.kind])),
    item.urgent ? h('span', { class: 'tag urgent' }, t('urgent')) : null,
    item.chatTitle || item.chat ? h('span', { class: 'chat-name' }, `${t('chatLabel')}: `, h('strong', {}, item.chatTitle || item.chat)) : null,
    item.agent ? h('span', {}, item.agent) : null,
    h('time', { datetime: item.createdAt }, `${stamp(item.createdAt)} (${relative(item.createdAt)})`),
    progress ? h('span', { class: `state state-${progress.tone}` }, progress.label) : null,
  );
  const toggle = () => {
    state.selected = isOpen ? null : item.id;
    render();
  };
  // A div, because the text inside a button cannot be selected and copied.
  const header = h(
    'div',
    {
      class: 'row-head',
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(isOpen),
      onclick: () => {
        if (!window.getSelection()?.toString()) toggle();
      },
      onkeydown: (event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          toggle();
        }
      },
    },
    h('span', { class: 'row-num' }, item.number ? `#${item.number}` : String(index + 1)),
    kindIcon(item.kind),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, item.title), meta, note ? h('span', { class: 'row-note' }, note) : null),
  );
  const error = state.error?.id === item.id ? h('p', { class: 'error', role: 'alert' }, state.error.message) : null;
  const detail = isOpen
    ? h(
        'div',
        { class: 'detail', 'data-copy-item': item.id },
        item.body ? markdown(item.body) : null,
        item.script ? scriptView(item) : null,
        chatPlace(item),
        copyButton(item),
        timeline(item),
        item.status === 'open' ? h('p', { class: `note${item.agentWaiting ? ' live' : ''}` }, t(item.agentWaiting ? 'chatWaiting' : 'chatAway', { chat: item.chatTitle || item.chat || t('openChatUntitled') })) : null,
        item.status === 'open' ? openControls(item, row) : resolvedControls(item),
        item.status === 'open' || item.status === 'answered' ? assignControls(item) : null,
        error,
      )
    : null;
  return h('li', { class: `row kind-${item.kind}${isOpen ? ' is-open' : ''}`, 'data-item': item.id }, header, detail);
}

const linkKind = (link) => (link.path ? 'file' : 'web');

function visibleLinks(kind) {
  const query = state.query.trim().toLocaleLowerCase(language);
  const links = state.links.filter((link) => {
    if (linkKind(link) !== kind) return false;
    if (state.project && link.project !== state.project) return false;
    if (!query) return true;
    return [link.title, link.body, link.url, link.path, link.chat, link.project, link.account].some((field) => field?.toLocaleLowerCase(language).includes(query));
  });
  const newest = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
  const compare = { newest, urgent: newest, oldest: (a, b) => newest(b, a), project: (a, b) => a.project.localeCompare(b.project, language) || newest(a, b) };
  return links.sort(compare[state.sort] ?? newest).map((link) => ({ ...link, createdAt: link.updatedAt }));
}

async function openLink(link, action) {
  state.error = null;
  try {
    await request('POST', `/api/links/${link.id}/${action}`, {});
    live.textContent = t(action === 'reveal' ? 'announceRevealed' : 'announceOpened');
  } catch (err) {
    state.error = { id: link.id, message: state.sessionLost ? t('errorSession') : err.status === 404 ? t('fileMissing') : t('errorGeneric') };
  }
  await refresh();
  render();
}

async function removeLink(link) {
  try {
    await request('POST', `/api/links/${link.id}/remove`, {});
    live.textContent = t('linkRemoved');
  } catch {
    state.error = { id: link.id, message: state.sessionLost ? t('errorSession') : t('errorGeneric') };
  }
  await refresh();
}

function copyText(value, label) {
  return h(
    'button',
    {
      type: 'button',
      class: 'btn copy',
      onclick: async (event) => {
        const control = event.currentTarget;
        await navigator.clipboard.writeText(value);
        control.textContent = t('copied');
        setTimeout(() => {
          control.textContent = label;
        }, 1500);
      },
    },
    label,
  );
}

function renderFileRow(link) {
  const shown = link.shortPath ?? link.path;
  const name = shown.split(/[\\/]/).pop();
  const folder = shown.slice(0, shown.length - name.length);
  const missing = link.exists === false;
  return h(
    'li',
    { class: 'row kind-file', 'data-link': link.id },
    h(
      'div',
      { class: 'row-head link-head file-head' },
      kindIcon('file'),
      h(
        'span',
        { class: 'row-text' },
        h('button', { type: 'button', class: 'row-title link-title file-title', disabled: missing, onclick: () => openLink(link, 'open') }, link.title),
        h(
          'span',
          { class: 'meta' },
          h('span', { class: `badge badge-${projectHue(link.project)}` }, projectLabel(link.project)),
          missing ? h('span', { class: 'tag urgent' }, t('fileMissing')) : null,
          link.chat ? h('span', {}, link.chat) : null,
          h('time', { datetime: link.updatedAt }, `${stamp(link.updatedAt)} (${relative(link.updatedAt)})`),
        ),
        h('span', { class: 'file-path', title: link.path }, h('span', { class: 'file-folder' }, folder), h('strong', {}, name)),
        link.body ? h('span', { class: 'row-note' }, link.body) : null,
      ),
      h(
        'span',
        { class: 'link-actions' },
        h('button', { type: 'button', class: 'btn primary', disabled: missing, onclick: () => openLink(link, 'open') }, t('openFile')),
        h('button', { type: 'button', class: 'btn', disabled: missing, onclick: () => openLink(link, 'reveal') }, t('revealFile')),
        copyText(link.path, t('copyPath')),
        h('button', { type: 'button', class: 'btn', onclick: () => removeLink(link) }, t('removeLink')),
      ),
    ),
    state.error?.id === link.id ? h('p', { class: 'error', role: 'alert' }, state.error.message) : null,
  );
}

function renderLinkRow(link) {
  if (link.path) return renderFileRow(link);
  let host = '';
  try {
    host = new URL(link.url).host;
  } catch {
    // The server only keeps full addresses, so this stays empty at worst.
  }
  const copy = h(
    'button',
    {
      type: 'button',
      class: 'btn copy',
      onclick: async (event) => {
        const control = event.currentTarget;
        await navigator.clipboard.writeText(link.url);
        control.textContent = t('copied');
        setTimeout(() => {
          control.textContent = t('copyLink');
        }, 1500);
      },
    },
    t('copyLink'),
  );
  return h(
    'li',
    { class: 'row kind-link', 'data-link': link.id },
    h(
      'div',
      { class: 'row-head link-head' },
      kindIcon('link'),
      h(
        'span',
        { class: 'row-text' },
        h('a', { class: 'row-title link-title', href: link.url, target: '_blank', rel: 'noopener noreferrer' }, link.title, h('span', { class: 'sr-only' }, ` (${t('opensNewTab')})`)),
        h(
          'span',
          { class: 'meta' },
          h('span', { class: `badge badge-${projectHue(link.project)}` }, projectLabel(link.project)),
          link.account ? h('span', { class: 'tag' }, t('linkAccount', { name: link.account })) : null,
          link.chat ? h('span', {}, link.chat) : null,
          h('span', {}, host),
          h('time', { datetime: link.updatedAt }, `${stamp(link.updatedAt)} (${relative(link.updatedAt)})`),
        ),
        link.body ? h('span', { class: 'row-note' }, link.body) : null,
      ),
      h('span', { class: 'link-actions' }, copy, h('button', { type: 'button', class: 'btn', onclick: () => removeLink(link) }, t('removeLink'))),
    ),
    state.error?.id === link.id ? h('p', { class: 'error', role: 'alert' }, state.error.message) : null,
  );
}

// The language agents write questions in, saved on this computer for every
// chat. It is separate from the language of the page itself.
function writingLanguageControl() {
  if (!state.settings) return null;
  const names = new Intl.DisplayNames([language], { type: 'language' });
  const failed = state.error?.id === 'settings' ? h('p', { class: 'error', role: 'alert' }, state.error.message) : null;
  return [failed, h(
    'label',
    {},
    t('writingLanguage'),
    h(
      'select',
      {
        onchange: async (event) => {
          try {
            state.error = null;
            state.settings = { ...state.settings, ...(await request('POST', '/api/settings', { writingLanguage: event.target.value })) };
            live.textContent = t('writingLanguageSaved');
          } catch {
            state.error = { id: 'settings', message: t('errorGeneric') };
          }
          render();
        },
      },
      state.settings.writingLanguages.map((code) => h('option', { value: code, selected: code === state.settings.writingLanguage }, names.of(code))),
    ),
  )];
}

// Connecting this computer to an askito.net account. The server does the
// pairing; the page shows the code, a link to the website and then asks again
// until the website says Allow.
let cloudTimer = null;

async function cloudAction(route) {
  try {
    state.error = null;
    const before = state.cloud;
    state.cloud = await request(route === 'view' ? 'GET' : 'POST', route === 'view' ? '/api/cloud' : `/api/cloud/${route}`, route === 'view' ? undefined : {});
    if (before?.on === false && state.cloud.on) live.textContent = t('cloudConnected');
    if (before?.on && !state.cloud.on) live.textContent = t('cloudDisconnected');
  } catch {
    if (route !== 'view') state.error = { id: 'cloud', message: t('errorGeneric') };
  }
  clearTimeout(cloudTimer);
  if (state.cloud?.pairing?.state === 'pending') cloudTimer = setTimeout(() => cloudAction('view'), 3000);
  render();
}

function cloudControl() {
  const cloud = state.cloud;
  if (!cloud) return null;
  const failed = state.error?.id === 'cloud' ? h('p', { class: 'error', role: 'alert' }, state.error.message) : null;
  const pairing = cloud.pairing ?? { state: 'idle' };
  let body;
  if (cloud.on) {
    body = [
      h('p', {}, cloud.email ? t('cloudOnAs', { email: cloud.email }) : t('cloudOn')),
      cloud.lastError ? h('p', {}, t('cloudLastError', { error: cloud.lastError })) : null,
      h('button', { type: 'button', class: 'btn quiet', onclick: () => cloudAction('disconnect') }, t('cloudDisconnect')),
    ];
  } else if (pairing.state === 'pending') {
    body = [
      h('p', {}, t('cloudCodeIntro')),
      h('p', { class: 'cloud-code' }, pairing.userCode),
      pairing.verifyUrl ? h('a', { href: pairing.verifyUrl, target: '_blank', rel: 'noopener noreferrer', class: 'btn primary' }, t('cloudOpenSite')) : null,
      h('p', {}, t('cloudWaiting')),
      h('button', { type: 'button', class: 'btn quiet', onclick: () => cloudAction('cancel') }, t('cloudCancel')),
    ];
  } else {
    body = [
      h('p', {}, t('cloudOffHint')),
      pairing.state === 'failed' ? h('p', { class: 'error', role: 'alert' }, t('cloudFailed', { error: pairing.error })) : null,
      h('button', { type: 'button', class: 'btn', disabled: pairing.state === 'starting', onclick: () => cloudAction('connect') }, t('cloudConnect')),
    ];
  }
  return h('section', { class: 'cloud', 'aria-labelledby': 'cloud-title' }, h('h2', { id: 'cloud-title' }, t('cloudTitle')), failed, body);
}

function renderSide() {
  const counts = new Map();
  for (const item of state.items) {
    if (!counts.has(item.project)) counts.set(item.project, 0);
    if (item.status === 'open' && !item.laterAt) counts.set(item.project, counts.get(item.project) + 1);
  }
  // A project with only links still needs a place in the list to filter by.
  for (const link of state.links) if (!counts.has(link.project)) counts.set(link.project, 0);
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  document.title = total ? `(${total}) ask++` : 'ask++';
  const entry = (name, label, count) =>
    h(
      'li',
      {},
      h(
        'button',
        {
          type: 'button',
          class: 'project',
          'aria-current': state.project === name ? 'true' : null,
          onclick: () => {
            state.project = name;
            state.selected = null;
            keepSelection();
            render();
          },
        },
        h('span', {}, label),
        count ? h('span', { class: 'count' }, String(count)) : null,
      ),
    );
  const names = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b, language));
  const theme = storage.get('askito.theme') ?? 'auto';
  return h(
    'aside',
    { class: 'side' },
    h('div', { class: 'brand', role: 'img', 'aria-label': 'ask++' }, h('span', { class: 'brand-ask', 'aria-hidden': 'true' }, 'ask'), brandPlus()),
    h('nav', { 'aria-label': t('projects') }, h('h2', {}, t('projects')), h('ul', { class: 'projects' }, entry(null, t('allProjects'), total), names.map((name) => entry(name, projectLabel(name), counts.get(name))))),
    h(
      'div',
      { class: 'side-foot' },
      mergeControls(),
      cloudControl(),
      notificationButton(),
      h('div', { class: 'shortcuts' }, shortcutHint()),
      h(
        'label',
        {},
        t('language'),
        h(
          'select',
          {
            onchange: async (event) => {
              storage.set(LANGUAGE_KEY, event.target.value);
              await loadLanguage(event.target.value);
              render();
            },
          },
          Object.entries(LANGUAGES).map(([code, name]) => h('option', { value: code, selected: code === language }, name)),
        ),
      ),
      writingLanguageControl(),
      h(
        'label',
        {},
        t('theme'),
        h(
          'select',
          {
            onchange: (event) => {
              storage.set('askito.theme', event.target.value);
              applyTheme(event.target.value);
            },
          },
          [
            ['auto', 'themeAuto'],
            ['light', 'themeLight'],
            ['dark', 'themeDark'],
          ].map(([value, key]) => h('option', { value, selected: value === theme }, t(key))),
        ),
      ),
    ),
  );
}

function shortcutHint() {
  const keys = { j: h('kbd', {}, 'J'), k: h('kbd', {}, 'K'), n: h('kbd', {}, '1-9'), send: h('kbd', {}, 'Ctrl Enter') };
  return (catalog.shortcuts ?? '')
    .split(/(\{\w+\})/)
    .map((part) => {
      const name = part.match(/^\{(\w+)\}$/)?.[1];
      return name ? keys[name] : part;
    });
}

function renderMain() {
  const tab = currentTab();
  const inProject = state.items.filter((item) => !state.project || item.project === state.project);
  const items = tab.links ? visibleLinks(tab.links) : visibleItems();
  const count = tab.links
    ? state.links.filter((link) => linkKind(link) === tab.links && (!state.project || link.project === state.project)).length
    : inProject.filter((item) => inTab(item, tab)).length;
  let content;
  if (items.length && tab.links) {
    const groups = groupItems(items);
    content = groups.map((group) =>
      h(
        'section',
        { class: 'group' },
        !state.project && groups.length > 1 ? h('h2', { class: 'group-head' }, projectLabel(group.project), h('span', { class: 'group-count' }, String(group.count))) : null,
        group.days.flatMap((day) => [h('h3', { class: 'day-head' }, day.label), h('ol', { class: 'list' }, day.items.map((link) => renderLinkRow(link)))]),
      ),
    );
  } else if (items.length) {
    let number = -1;
    const groups = groupItems(items);
    content = [
      ...groups.map((group) =>
        h(
          'section',
          { class: 'group' },
          !state.project && groups.length > 1 ? h('h2', { class: 'group-head' }, projectLabel(group.project), h('span', { class: 'group-count' }, String(group.count))) : null,
          group.days.flatMap((day) => [h('h3', { class: 'day-head' }, day.label), h('ol', { class: 'list' }, day.items.map((item) => renderRow(item, (number += 1))))]),
        ),
      ),
      h('p', { class: 'list-end' }, t('listEnd')),
    ];
  } else if (state.query.trim()) {
    content = h('div', { class: 'empty' }, h('strong', {}, t('noMatch')));
  } else {
    content = h('div', { class: 'empty' }, h('strong', {}, t(`${tab.empty}Title`)), h('span', {}, t(`${tab.empty}Body`)));
  }
  return h(
    'main',
    { class: 'main' },
    state.sessionLost ? h('p', { class: 'error', role: 'alert' }, t('errorSession')) : null,
    h('h1', { class: 'head' }, h('span', { class: 'number' }, String(count)), h('span', { class: 'label' }, t(tab.head))),
    h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        TABS.map((entry) =>
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              class: 'tab',
              'aria-selected': String(entry.id === state.tab),
              onclick: () => {
                state.tab = entry.id;
                state.selected = null;
                keepSelection();
                render();
              },
            },
            t(entry.label),
          ),
        ),
      ),
      h(
        'select',
        {
          class: 'sort',
          'aria-label': t('sortLabel'),
          onchange: (event) => {
            state.sort = event.target.value;
            storage.set('askito.sort', state.sort);
            render();
          },
        },
        ['newest', 'oldest', 'urgent', 'project'].map((value) => h('option', { value, selected: value === state.sort }, t(`sort_${value}`))),
      ),
      h('input', {
        class: 'search',
        type: 'search',
        'data-fk': 'search',
        'aria-label': t('searchLabel'),
        placeholder: t('searchPlaceholder'),
        value: state.query,
        oninput: (event) => {
          state.query = event.target.value;
          keepSelection();
          render();
        },
        // Enter on a number such as 42 or #42 opens that item, whichever tab it is in.
        onkeydown: (event) => {
          if (event.key === 'Enter' && openItem(event.target.value)) event.preventDefault();
        },
      }),
    ),
    content,
  );
}

// A live update waits while the reader has text selected, or the redraw would wipe the selection.
let pendingRender = false;

function liveRender() {
  if (selectionInApp()) {
    pendingRender = true;
    return;
  }
  render();
}

function render() {
  pendingRender = false;
  // A live update must not steal the cursor from whoever is typing.
  const active = document.activeElement;
  const focusKey = active?.dataset?.fk;
  const range = focusKey ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = window.scrollY;
  // Script output stays pinned to its end while it grows, unless the reader scrolled up.
  const outputs = new Map([...app.querySelectorAll('[data-out]')].map((el) => [el.dataset.out, el.scrollHeight - el.scrollTop - el.clientHeight < 8 ? null : el.scrollTop]));
  app.replaceChildren(h('div', { class: 'shell' }, renderSide(), renderMain()));
  for (const el of app.querySelectorAll('[data-out]')) el.scrollTop = outputs.get(el.dataset.out) ?? el.scrollHeight;
  if (focusKey) {
    const target = document.querySelector(`[data-fk="${focusKey}"]`);
    if (target) {
      target.focus({ preventScroll: true });
      target.setSelectionRange(...range);
    }
  }
  window.scrollTo(0, scroll);
}

// Opens one item by its number (42 or #42) or id: switches to its tab, clears
// the filters that would hide it, unfolds it and moves the keyboard to it.
function openItem(ref) {
  const wanted = String(ref ?? '').trim().replace(/^#/, '');
  if (!wanted) return false;
  const item = state.items.find((entry) => String(entry.number) === wanted || entry.id === wanted);
  if (!item) return false;
  state.tab = TABS.find((tab) => !tab.links && inTab(item, tab))?.id ?? state.tab;
  state.project = null;
  state.query = '';
  state.selected = item.id;
  render();
  const head = document.querySelector(`[data-item="${item.id}"] .row-head`);
  head?.scrollIntoView({ block: 'center' });
  head?.focus({ preventScroll: true });
  return true;
}

// http://askito.localhost:4517/#42 opens item #42.
function openFromAddress() {
  const ref = decodeURIComponent(location.hash.slice(1));
  if (ref && openItem(ref)) history.replaceState(null, '', location.pathname + location.search);
}

function moveSelection(step) {
  const items = groupItems(visibleItems()).flatMap((group) => group.days.flatMap((day) => day.items));
  if (!items.length) return;
  const index = items.findIndex((item) => item.id === state.selected);
  const next = items[Math.min(items.length - 1, Math.max(0, index === -1 ? 0 : index + step))];
  state.selected = next.id;
  render();
  document.querySelector(`[data-item="${next.id}"] .row-head`)?.focus();
}

document.addEventListener('keydown', (event) => {
  if (event.target.matches('textarea, input[type="search"], select') || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'j') moveSelection(1);
  else if (event.key === 'k') moveSelection(-1);
  else if (/^[1-9]$/.test(event.key)) {
    document.querySelector(`[data-item="${state.selected}"] [data-option="${event.key}"]`)?.click();
  }
});

async function start() {
  applyTheme(storage.get('askito.theme') ?? 'auto');
  state.sort = storage.get('askito.sort') ?? 'newest';
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(storage.get('askito.theme') ?? 'auto'));
  // English unless the person picks another language here. The browser's own
  // language is not a choice; the key is new so an older pick does not stick.
  await loadLanguage(storage.get(LANGUAGE_KEY) ?? 'en');
  state.settings = await request('GET', '/api/settings').catch(() => null);
  state.cloud = await request('GET', '/api/cloud').catch(() => null);
  if (state.cloud?.pairing?.state === 'pending') cloudTimer = setTimeout(() => cloudAction('view'), 3000);
  await refresh();
  render();
  openFromAddress();
  addEventListener('hashchange', openFromAddress);
  new EventSource('/api/events').addEventListener('change', refresh);
  // Waiting-chat indicators expire on the server without an event.
  setInterval(() => {
    // Forces a redraw so times and the quiet-chat warning stay current.
    snapshot = '';
    refresh();
  }, 30_000);
}

start();

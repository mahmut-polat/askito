// Everything agents write is untrusted, so this file builds the DOM with
// textContent only and never assigns innerHTML.

const LANGUAGES = { en: 'English', tr: 'Türkçe' };
const TABS = [
  { id: 'waiting', status: 'open', label: 'tabWaiting', head: 'headWaiting', empty: 'emptyWaiting' },
  { id: 'agents', status: 'answered', label: 'tabAgents', head: 'headAgents', empty: 'emptyAgents' },
  { id: 'done', status: 'done', label: 'tabDone', head: 'headDone', empty: 'emptyDone' },
  { id: 'removed', status: 'dismissed', label: 'tabRemoved', head: 'headRemoved', empty: 'emptyRemoved' },
];
const KIND_LABEL = { question: 'kindQuestion', approval: 'kindApproval', task: 'kindTask' };
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
};

const app = document.getElementById('app');
const live = document.getElementById('live');
const state = { items: [], project: null, tab: 'waiting', selected: null, query: '', busy: null, error: null, sessionLost: false };
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

function markdown(source) {
  const root = h('div', { class: 'body' });
  const lines = source.split('\n');
  let list = null;
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) root.append(h('p', {}, inlineNodes(paragraph.join(' '))));
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
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

const projectLabel = (name) => (name === 'unsorted' ? t('unsorted') : name);

function currentTab() {
  return TABS.find((tab) => tab.id === state.tab);
}

function visibleItems() {
  const status = currentTab().status;
  const query = state.query.trim().toLocaleLowerCase(language);
  const items = state.items.filter((item) => {
    if (item.status !== status) return false;
    if (state.project && item.project !== state.project) return false;
    if (!query) return true;
    return [item.title, item.body, item.chat, item.project].some((field) => field?.toLocaleLowerCase(language).includes(query));
  });
  if (status === 'open') {
    // Urgent first, then oldest first, so nothing sinks to the bottom.
    return items.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.createdAt.localeCompare(b.createdAt));
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

async function refresh() {
  try {
    const { items } = await request('GET', '/api/items');
    const next = JSON.stringify(items);
    if (next === snapshot && !state.sessionLost) return;
    snapshot = next;
    state.items = items;
    keepSelection();
    render();
  } catch {
    render();
  }
}

function keepSelection() {
  const items = visibleItems();
  if (!items.some((item) => item.id === state.selected)) state.selected = state.tab === 'waiting' ? (items[0]?.id ?? null) : null;
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

function button(item, { label, kind, action, body, disabled, needsComment }) {
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
    busy ? t('sending') : label,
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
          option.recommended ? h('span', { class: 'reco' }, t('recommended')) : null,
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
    h('label', { for: id, class: 'note' }, t('commentLabel')),
    h('textarea', {
      id,
      'data-fk': id,
      placeholder: t('commentPlaceholder'),
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

function openControls(item, row) {
  const draft = draftFor(item.id);
  const hasComment = draft.comment.trim().length > 0;
  const comment = () => draftFor(item.id).comment.trim();
  const removeButton = button(item, { label: t('remove'), kind: 'quiet', action: 'dismiss', body: {} });
  const commentButton = button(item, { label: t('commentOnly'), action: 'answer', body: () => ({ decision: 'comment', comment: comment() }), disabled: !hasComment, needsComment: true });

  if (item.kind === 'approval') {
    return [
      commentBox(item, row),
      h(
        'div',
        { class: 'actions' },
        button(item, { label: t('approve'), kind: 'primary', action: 'answer', body: () => ({ decision: 'approved', comment: comment() }) }),
        button(item, { label: t('reject'), kind: 'danger', action: 'answer', body: () => ({ decision: 'rejected', comment: comment() }) }),
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
        button(item, { label: t('markDone'), kind: 'primary', action: 'answer', body: () => ({ decision: 'done', comment: comment() }) }),
        button(item, { label: t('cantDo'), action: 'answer', body: () => ({ decision: 'blocked', comment: comment() }) }),
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
  const parts = [h('strong', {}, t(`decision_${item.answer.decision}`))];
  if (item.answer.choices.length) parts.push(`: ${item.answer.choices.join(', ')}`);
  return h('div', { class: 'answer-line' }, parts, item.answer.comment ? h('div', {}, item.answer.comment) : null);
}

function resolvedControls(item) {
  if (item.status === 'answered') {
    return [
      answerLine(item),
      h('p', { class: 'note' }, item.deliveredAt ? t('received') : t('notCollected')),
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
    return [
      answerLine(item),
      h('div', { class: 'actions' }, button(item, { label: t('reopen'), action: 'reopen', body: {} }), button(item, { label: t('remove'), kind: 'quiet', action: 'dismiss', body: {} })),
    ];
  }
  return [answerLine(item), h('div', { class: 'actions' }, button(item, { label: t('restore'), action: 'reopen', body: {} }))];
}

function thread(item) {
  // The closing answer is already shown by answerLine.
  const messages = item.messages.filter((m) => !(item.answer && m.at === item.answer.at));
  if (!messages.length) return null;
  return h(
    'ol',
    { class: 'thread' },
    messages.map((message) =>
      h(
        'li',
        {},
        h('div', { class: 'thread-who' }, `${message.from === 'agent' ? t('agentLabel') : t('youLabel')}, ${relative(message.at)}`),
        message.choices?.length ? h('div', {}, message.choices.join(', ')) : null,
        message.text ? markdown(message.text) : null,
      ),
    ),
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

function renderRow(item, index) {
  const isOpen = state.selected === item.id;
  const row = () => document.querySelector(`[data-item="${item.id}"]`);
  const meta = h(
    'span',
    { class: 'meta' },
    h('span', { class: 'tag' }, t(KIND_LABEL[item.kind])),
    item.urgent ? h('span', { class: 'tag urgent' }, t('urgent')) : null,
    !state.project ? h('span', {}, projectLabel(item.project)) : null,
    item.chat ? h('span', {}, item.chat) : null,
    item.agent ? h('span', {}, item.agent) : null,
    h('span', {}, relative(item.createdAt)),
  );
  const header = h(
    'button',
    {
      type: 'button',
      class: 'row-head',
      'aria-expanded': String(isOpen),
      onclick: () => {
        state.selected = isOpen ? null : item.id;
        render();
      },
    },
    h('span', { class: 'row-num' }, String(index + 1)),
    kindIcon(item.kind),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, item.title), meta),
  );
  const error = state.error?.id === item.id ? h('p', { class: 'error', role: 'alert' }, state.error.message) : null;
  const detail = isOpen
    ? h(
        'div',
        { class: 'detail' },
        item.body ? markdown(item.body) : null,
        thread(item),
        item.status === 'open' ? h('p', { class: `note${item.agentWaiting ? ' live' : ''}` }, item.agentWaiting ? t('chatWaiting') : t('chatAway')) : null,
        item.status === 'open' ? openControls(item, row) : resolvedControls(item),
        error,
      )
    : null;
  return h('li', { class: `row kind-${item.kind}${isOpen ? ' is-open' : ''}`, 'data-item': item.id }, header, detail);
}

function renderSide() {
  const counts = new Map();
  for (const item of state.items) {
    if (!counts.has(item.project)) counts.set(item.project, 0);
    if (item.status === 'open') counts.set(item.project, counts.get(item.project) + 1);
  }
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  document.title = total ? `(${total}) askito` : 'askito';
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
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), 'askito'),
    h('nav', { 'aria-label': t('projects') }, h('h2', {}, t('projects')), h('ul', { class: 'projects' }, entry(null, t('allProjects'), total), names.map((name) => entry(name, projectLabel(name), counts.get(name))))),
    h(
      'div',
      { class: 'side-foot' },
      h('div', { class: 'shortcuts' }, shortcutHint()),
      h(
        'label',
        {},
        t('language'),
        h(
          'select',
          {
            onchange: async (event) => {
              storage.set('askito.lang', event.target.value);
              await loadLanguage(event.target.value);
              render();
            },
          },
          Object.entries(LANGUAGES).map(([code, name]) => h('option', { value: code, selected: code === language }, name)),
        ),
      ),
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
  const items = visibleItems();
  const count = inProject.filter((item) => item.status === tab.status).length;
  let content;
  if (items.length) {
    content = [h('ol', { class: 'list' }, items.map(renderRow)), h('p', { class: 'list-end' }, t('listEnd'))];
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
      }),
    ),
    content,
  );
}

function render() {
  // A live update must not steal the cursor from whoever is typing.
  const active = document.activeElement;
  const focusKey = active?.dataset?.fk;
  const range = focusKey ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = window.scrollY;
  app.replaceChildren(h('div', { class: 'shell' }, renderSide(), renderMain()));
  if (focusKey) {
    const target = document.querySelector(`[data-fk="${focusKey}"]`);
    if (target) {
      target.focus({ preventScroll: true });
      target.setSelectionRange(...range);
    }
  }
  window.scrollTo(0, scroll);
}

function moveSelection(step) {
  const items = visibleItems();
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
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(storage.get('askito.theme') ?? 'auto'));
  const saved = storage.get('askito.lang');
  await loadLanguage(saved ?? (navigator.language ?? 'en').slice(0, 2).toLowerCase());
  await refresh();
  render();
  new EventSource('/api/events').addEventListener('change', refresh);
  // Waiting-chat indicators expire on the server without an event.
  setInterval(refresh, 30_000);
}

start();

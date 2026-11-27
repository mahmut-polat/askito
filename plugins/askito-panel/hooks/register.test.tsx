import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'askito-panel',
  component: 'Pane',
  requestId: 'askito-inbox',
  surface: 'desktop',
  props: {
    title: 'askito',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const WORDS = {
  kindApproval: 'Approval',
  headWaiting: 'waiting for you',
  approve: 'Approve',
  panelOffline: 'askito is not running.',
  chatLabel: 'Chat',
}
// Asked two hours ago, so the date line is today's.
const ASKED = new Date(Date.now() - 2 * 3600_000)
const DAY = 86400_000
const ITEM = {
  id: 'abc123',
  kind: 'approval',
  title: 'Run the migration?',
  body: 'Adds one column.',
  options: [],
  multi: false,
  urgent: false,
  project: 'billing',
  chat: 'invoices',
  agentWaiting: true,
  createdAt: ASKED.toISOString(),
}

const catalogs: string[] = []

type Fetch = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }

const beats: string[] = []
const prompts: string[] = []

async function start($: any, on: any, options: { installed?: boolean; items?: object[]; agents?: object[]; links?: object[]; config?: string } = {}) {
  const sent: Fetch[] = []
  let open: object[] = options.items ?? [ITEM]
  on('session.id', () => ({ value: 'this-chat' }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('command.register', () => ({ value: { command: 'askito-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // Never resolves, so the poll does not spin during the test.
  on('clock.every', () => new Promise(() => {}))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (options.installed === false) throw new Error('missing')
    return { value: e.path.endsWith('ui.token') ? 'secret\n' : (options.config ?? '{"language":"en"}') }
  })
  on('http.fetch', (_: unknown, e: Fetch) => {
    if (e.url.endsWith('/api/sessions/beat')) {
      beats.push(JSON.parse(e.init?.body ?? '{}').sessionId)
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    if (e.init?.method === 'POST') {
      sent.push(e)
      open = []
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    const list = e.url.includes('status=answered') ? (options.agents ?? []) : open
    if (e.url.includes('/i18n/')) catalogs.push(e.url)
    const text = e.url.includes('/i18n/')
      ? JSON.stringify(WORDS)
      : e.url.includes('/api/links')
        ? JSON.stringify({ links: options.links ?? [] })
        : JSON.stringify({ items: list })
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return sent
}

test('the pane numbers an open item and names its kind', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Run the migration/ }))?.text).toBe('Run the migration?')
  expect((await ui.find({ type: 'Text', text: '1' }))?.text).toBe('1')
  expect((await ui.find({ type: 'Text', text: /^Approval$/ }))?.text).toBe('Approval')
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.unmount()
})

test('an answer for this chat wakes it once; other chats and collected answers are left alone', async ($, on) => {
  const answeredAt = new Date(Date.now() - 10_000).toISOString()
  const answer = { decision: 'option', choices: ['Ship'], comment: 'today', at: answeredAt }
  const mine = { ...ITEM, id: 'mine1', number: 7, title: 'Ship it?', sessionId: 'this-chat', answer, deliveredAt: null }
  const fresh = { ...ITEM, id: 'fresh1', number: 8, sessionId: 'this-chat', answer: { ...answer, at: new Date().toISOString() }, deliveredAt: null }
  const other = { ...ITEM, id: 'other1', number: 9, sessionId: 'another-chat', answer, deliveredAt: null }
  const collected = { ...ITEM, id: 'got1', number: 10, sessionId: 'this-chat', answer, deliveredAt: answeredAt }
  prompts.length = 0
  beats.length = 0
  await start($, on, { agents: [mine, fresh, other, collected] })
  expect(beats).toEqual(['this-chat'])
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('askito #7 "Ship it?" was answered: option: Ship: "today".')
  expect(prompts[0]).toContain('askito wait 7')
  // The next poll finds the same answer still uncollected and does not send it again.
  await $.command.run({ command: 'askito-panel', args: '' })
  expect(prompts).toHaveLength(1)
})

test('approving posts the answer as the browser would', async ($, on) => {
  const sent = await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'toggle-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  await ui.press({ key: 'yes-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(sent).toHaveLength(1)
  expect(sent[0].url).toBe('http://127.0.0.1:4517/api/items/abc123/answer')
  expect(sent[0].init?.headers?.Cookie).toBe('askito_ui=secret')
  expect(sent[0].init?.headers?.Origin).toBe('http://127.0.0.1:4517')
  expect(JSON.parse(sent[0].init?.body ?? '{}').decision).toBe('approved')
  await ui.unmount()
})

test('an approval shows its own button words, green for yes and red for no', async ($, on) => {
  await start($, on, { items: [{ ...ITEM, yes: 'Yes, run it', no: 'No, wait' }] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'toggle-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  const yes = await ui.find({ type: 'Text', text: '✓ Yes, run it' })
  const no = await ui.find({ type: 'Text', text: '✕ No, wait' })
  expect(yes?.props.color).toBe('success')
  expect(no?.props.color).toBe('error')
  await ui.unmount()
})

test('an approval without its own words falls back to Approve', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'toggle-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect((await ui.find({ type: 'Text', text: '✓ Approve' }))?.props.color).toBe('success')
  await ui.unmount()
})

test('Later sets the item aside', async ($, on) => {
  const sent = await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'toggle-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  await ui.press({ key: 'later-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(sent[0].url).toBe('http://127.0.0.1:4517/api/items/abc123/later')
  expect(JSON.parse(sent[0].init?.body ?? '{}').later).toBe(true)
  await ui.unmount()
})

test('items set aside stay out of the panel', async ($, on) => {
  await start($, on, { items: [{ ...ITEM, laterAt: '2026-11-09T11:00:00.000Z' }] })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Run the migration/ })).toBeUndefined()
  await ui.unmount()
})

const OTHER = { ...ITEM, id: 'def456', title: 'Pick a colour', project: 'storefront', createdAt: new Date(ASKED.getTime() + 3600_000).toISOString() }

test('every row shows its project as a badge', async ($, on) => {
  await start($, on, { items: [ITEM, OTHER] })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /billing/ }))?.text?.trim()).toBe('billing')
  expect((await ui.find({ type: 'Text', text: /storefront/ }))?.text?.trim()).toBe('storefront')
  await ui.unmount()
})

test('a project filter narrows the list', async ($, on) => {
  await start($, on, { items: [ITEM, OTHER] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'project-storefront' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(await ui.find({ type: 'Text', text: /Run the migration/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Pick a colour/ }))?.text).toBe('Pick a colour')
  await ui.press({ key: 'project-all' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect((await ui.find({ type: 'Text', text: /Run the migration/ }))?.text).toBe('Run the migration?')
  await ui.unmount()
})

test('With chats shows whether the answer arrived and what the chat did', async ($, on) => {
  const answered = {
    ...ITEM,
    status: 'answered',
    answer: { decision: 'approved', choices: [], comment: null, at: '2026-11-09T10:01:00.000Z' },
    deliveredAt: '2026-11-09T10:02:00.000Z',
    messages: [{ from: 'agent', kind: 'progress', text: 'Running it', at: new Date().toISOString() }],
  }
  await start($, on, { items: [ITEM], agents: [answered] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'view-agents' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect((await ui.find({ type: 'Text', text: /Running it/ }))?.text).toContain('Running it')
  await ui.unmount()
})

test('every row shows the date and time it was asked', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount(PANE)
  const day = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(ASKED)
  expect((await ui.find({ type: 'Text', text: /\d{1,2}:\d{2}/ }))?.text).toContain(day)
  await ui.unmount()
})

test('no item opens by itself, and only the pressed one opens', async ($, on) => {
  await start($, on, { items: [ITEM, { ...OTHER }] })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'yes-abc123' })).toBeUndefined()
  await ui.press({ key: 'toggle-def456' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(await ui.find({ key: 'yes-abc123' })).toBeUndefined()
  expect(await ui.find({ key: 'comment-def456' })).toBeDefined()
  await ui.unmount()
})

test('questions, approvals and tasks share one list, grouped by project and newest first inside it', async ($, on) => {
  const question = { ...ITEM, id: 'q1', kind: 'question', title: 'Which colour?', createdAt: new Date(ASKED.getTime() + 60_000).toISOString() }
  const task = { ...OTHER, id: 't1', kind: 'task', title: 'Sign in to the store' }
  await start($, on, { items: [ITEM, question, task] })
  const ui = await $.ui.mount(PANE)
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text?.trim())
  const at = (text: string) => texts.indexOf(text)
  // storefront holds the newest item, so its group comes first.
  expect(at('storefront')).toBeLessThan(at('Sign in to the store'))
  expect(at('Sign in to the store')).toBeLessThan(at('billing'))
  expect(at('billing')).toBeLessThan(at('Which colour?'))
  expect(at('Which colour?')).toBeLessThan(at('Run the migration?'))
  expect(at('Approvals')).toBe(-1)
  await ui.unmount()
})

test('old items stay in the list, under their own day', async ($, on) => {
  const old = { ...ITEM, id: 'old1', title: 'Old question', createdAt: new Date(Date.now() - 8 * DAY).toISOString() }
  await start($, on, { items: [ITEM, old] })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: 'Old question' }))?.text).toBe('Old question')
  expect((await ui.find({ type: 'Text', text: 'Run the migration?' }))?.text).toBe('Run the migration?')
  await ui.unmount()
})

test('every row names the chat that asked, by its full sidebar name', async ($, on) => {
  await start($, on, { items: [{ ...ITEM, chatTitle: 'Fix the invoice totals in billing' }] })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: 'Fix the invoice totals in billing' }))?.text).toBe('Fix the invoice totals in billing')
  await ui.unmount()
})

test('the newest item is on top, and the sort can be changed', async ($, on) => {
  await start($, on, { items: [ITEM, OTHER] })
  const ui = await $.ui.mount(PANE)
  const position = async (title: string) => (await ui.findAll({ type: 'Text' })).findIndex(found => found.text === title)
  expect(await position('Pick a colour')).toBeLessThan(await position('Run the migration?'))
  await ui.select({ key: 'sort', value: 'oldest' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(await position('Run the migration?')).toBeLessThan(await position('Pick a colour'))
  await ui.unmount()
})

test('copy puts the question on the clipboard', async ($, on) => {
  const copied: string[] = []
  on('ui.copy', (_: unknown, e: { text: string }) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'toggle-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  await ui.press({ key: 'copy-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(copied).toEqual(['Run the migration?\n\nAdds one column.'])
  await ui.unmount()
})

test('select text shows the item in a field, where part of it can be selected', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'toggle-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(await ui.find({ key: 'plain-text-abc123' })).toBeUndefined()
  await ui.press({ key: 'plain-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  const field = await ui.find({ key: 'plain-text-abc123' })
  expect(field?.props?.value).toBe('Run the migration?\n\nAdds one column.')
  await ui.press({ key: 'plain-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(await ui.find({ key: 'plain-text-abc123' })).toBeUndefined()
  await ui.unmount()
})

test('the title itself opens the row, with no separate open button', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'toggle-abc123' }))?.text).toBe('Run the migration?')
  await ui.unmount()
})

test('an open item names its chat as the sidebar does, with a link that opens it', async ($, on) => {
  const chatLink = 'claude://claude.ai/epitaxy/local_0325ae8d-01dd-48a2-a61d-6ab717343e71'
  const sent = await start($, on, { items: [{ ...ITEM, chat: 'made-up name', chatTitle: 'Multi-chat app', chatLink }] })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Multi-chat app/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /made-up name/ })).toBeUndefined()
  await ui.press({ key: 'toggle-abc123' })
  expect((await ui.find({ key: 'chat-abc123' }))?.props?.label).toContain('Multi-chat app')
  await ui.press({ key: 'chat-abc123' })
  expect(sent.at(-1)?.url).toContain('/api/items/abc123/chat')
  await ui.unmount()
})

test('with one project there is no filter row', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'project-all' })).toBeUndefined()
  await ui.unmount()
})

test('without askito the pane says so', async ($, on) => {
  await start($, on, { installed: false })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text' })).toBeDefined()
  await ui.unmount()
})

test('Links lists published pages, and each title opens its address', async ($, on) => {
  const link = { id: 'lnk1', title: 'Leaflet 2 (A4)', url: 'https://claude.ai/artifact/abc', body: null, project: 'billing', chat: null, account: 'admin', createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-21T09:00:00.000Z' }
  await start($, on, { items: [ITEM], links: [link] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'view-links' })
  const shown = (await ui.findAll({ type: 'Link' })).find((found: any) => found.props?.href === 'https://claude.ai/artifact/abc')
  expect(shown?.props?.label).toBe('Leaflet 2 (A4)')
  expect(await ui.find({ type: 'Text', text: /Run the migration/ })).toBeUndefined()
  await ui.unmount()
})

test('Files lists files on this computer, and Open asks askito to open one', async ($, on) => {
  const file = { id: 'fil1', title: 'Promo cut 3', url: null, path: '/Users/me/promo/cut3.mp4', exists: true, body: null, project: 'billing', chat: null, account: null, createdAt: '2026-11-21T10:00:00.000Z', updatedAt: '2026-11-21T10:00:00.000Z' }
  const sent = await start($, on, { items: [ITEM], links: [file] })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'view-files' })
  expect((await ui.find({ type: 'Text', text: 'Promo cut 3' }))?.text).toBe('Promo cut 3')
  await ui.press({ key: 'reveal-fil1' })
  expect(sent.at(-1)?.url).toContain('/api/links/fil1/reveal')
  await ui.unmount()
})

test('the panel is in English even when agents are told to write in Turkish', async ($, on) => {
  catalogs.length = 0
  await start($, on, { config: '{"language":"tr"}' })
  expect(catalogs.at(-1)).toContain('/i18n/en.json')
})

test('the panel follows uiLanguage when the config names one', async ($, on) => {
  catalogs.length = 0
  await start($, on, { config: '{"language":"tr","uiLanguage":"tr"}' })
  expect(catalogs.at(-1)).toContain('/i18n/tr.json')
})

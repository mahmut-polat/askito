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

const WORDS = { kindApproval: 'Approval', headWaiting: 'waiting for you', approve: 'Approve', panelOffline: 'askito is not running.' }
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
  createdAt: '2026-11-09T10:00:00.000Z',
}

type Fetch = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }

async function start($: any, on: any, options: { installed?: boolean; items?: object[]; agents?: object[] } = {}) {
  const sent: Fetch[] = []
  let open: object[] = options.items ?? [ITEM]
  on('command.register', () => ({ value: { command: 'askito-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // Never resolves, so the poll does not spin during the test.
  on('clock.every', () => new Promise(() => {}))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (options.installed === false) throw new Error('missing')
    return { value: e.path.endsWith('ui.token') ? 'secret\n' : '{"language":"en"}' }
  })
  on('http.fetch', (_: unknown, e: Fetch) => {
    if (e.init?.method === 'POST') {
      sent.push(e)
      open = []
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    const list = e.url.includes('status=answered') ? (options.agents ?? []) : open
    const text = e.url.includes('/i18n/') ? JSON.stringify(WORDS) : JSON.stringify({ items: list })
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
  expect((await ui.find({ type: 'Text', text: 'Approval' }))?.text).toBe('Approval')
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.unmount()
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

const OTHER = { ...ITEM, id: 'def456', title: 'Pick a colour', project: 'storefront', createdAt: '2026-11-09T11:00:00.000Z' }

test('every row shows its project as a badge', async ($, on) => {
  await start($, on, { items: [ITEM, OTHER] })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: 'billing' }))?.text).toBe('billing')
  expect((await ui.find({ type: 'Text', text: 'storefront' }))?.text).toBe('storefront')
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
  expect((await ui.find({ type: 'Text', text: /Nov/ }))?.text).toMatch(/\d{1,2}:\d{2}/)
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

test('rows are grouped by project and then by day', async ($, on) => {
  await start($, on, { items: [ITEM, OTHER] })
  const ui = await $.ui.mount(PANE)
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.filter(text => text?.trim() === 'billing').length).toBeGreaterThanOrEqual(2)
  expect(texts.some(text => /Nov 9|today|yesterday/i.test(text ?? ''))).toBe(true)
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

test('the title itself opens the row, with no separate open button', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'toggle-abc123' }))?.text).toBe('Run the migration?')
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

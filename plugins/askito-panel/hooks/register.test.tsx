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

async function start($: any, on: any, options: { installed?: boolean } = {}) {
  const sent: Fetch[] = []
  let open = [ITEM]
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
    const text = e.url.includes('/i18n/') ? JSON.stringify(WORDS) : JSON.stringify({ items: open })
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return sent
}

test('the pane numbers an open item and names its kind', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', text: /Run the migration/ }))?.text).toBe('1. Approval: Run the migration?')
  await ui.unmount()
})

test('approving posts the answer as the browser would', async ($, on) => {
  const sent = await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'yes-abc123' })
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(sent).toHaveLength(1)
  expect(sent[0].url).toBe('http://127.0.0.1:4517/api/items/abc123/answer')
  expect(sent[0].init?.headers?.Cookie).toBe('askito_ui=secret')
  expect(sent[0].init?.headers?.Origin).toBe('http://127.0.0.1:4517')
  expect(JSON.parse(sent[0].init?.body ?? '{}').decision).toBe('approved')
  await ui.unmount()
})

test('without askito the pane says so', async ($, on) => {
  await start($, on, { installed: false })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text' })).toBeDefined()
  await ui.unmount()
})

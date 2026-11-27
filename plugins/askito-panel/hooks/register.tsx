import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Catalog, InboxItem, LinkEntry } from '../types'

const PANE = 'askito-inbox'
const POLL_MS = 4000
const KIND_LABEL = { question: 'kindQuestion', approval: 'kindApproval', task: 'kindTask', script: 'kindScript' } as const
// The panel shows the end of a script's output; the inbox page shows all of it.
const PANEL_OUTPUT = 4000

// Lucide shapes, one silhouette and color per kind, matching the inbox page.
// These tones stay legible on both the light and the dark theme.
const KIND_ICON = {
  question: {
    color: '#4f8fe8',
    shapes: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  },
  approval: {
    color: '#c9922e',
    shapes:
      '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  },
  task: {
    color: '#a678e2',
    shapes: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  },
  script: {
    color: '#2aa5b8',
    shapes: '<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>',
  },
  file: {
    color: '#c9922e',
    shapes: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  },
  link: {
    color: '#2fa38a',
    shapes: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  },
} as const

// Translucent, so one project keeps its color on the light and the dark theme.
const BADGE_COLORS = ['#4f8fe838', '#2fa36b38', '#c9922e38', '#a678e238', '#e0607038', '#2aa5b838']

function badgeColor(project: string) {
  const sum = Array.from(project).reduce((total, char) => total + (char.codePointAt(0) ?? 0), 0)
  return BADGE_COLORS[sum % BADGE_COLORS.length]
}

function kindSvg(kind: InboxItem['kind'] | 'link' | 'file') {
  const { color, shapes } = KIND_ICON[kind]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${color}" fill-opacity="0.18"/><g transform="translate(6 6) scale(0.8333)" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</g></svg>`
}

const items = atom({ plugin: 'askito-panel', key: 'items' } as const, [], { shape: 'items-1' })
const selected = atom({ plugin: 'askito-panel', key: 'selected' } as const, null, { shape: 'selected-1' })
// The item whose text is shown in a field, where it can be selected and copied in part.
const plainText = atom({ plugin: 'askito-panel', key: 'plainText' } as const, null, { shape: 'plainText-1' })
const filter = atom({ plugin: 'askito-panel', key: 'filter' } as const, null, { shape: 'filter-1' })
// What the search field holds: a number such as 42 or #42, or words from a title.
const query = atom({ plugin: 'askito-panel', key: 'query' } as const, '', { shape: 'query-1' })
const agents = atom({ plugin: 'askito-panel', key: 'agents' } as const, [], { shape: 'agents-1' })
const view = atom({ plugin: 'askito-panel', key: 'view' } as const, 'waiting', { shape: 'view-1' })
const sortMode = atom({ plugin: 'askito-panel', key: 'sort' } as const, 'newest', { shape: 'sort-1' })
const catalog = atom({ plugin: 'askito-panel', key: 'catalog' } as const, {}, { shape: 'catalog-1' })
const status = atom({ plugin: 'askito-panel', key: 'status' } as const, 'loading', { shape: 'status-1' })
const error = atom({ plugin: 'askito-panel', key: 'error' } as const, false, { shape: 'error-1' })
const links = atom({ plugin: 'askito-panel', key: 'links' } as const, [], { shape: 'links-1' })
const woken = atom({ plugin: 'askito-panel', key: 'woken' } as const, [], { shape: 'woken-1' })
const olderOpen = atom({ plugin: 'askito-panel', key: 'olderOpen' } as const, false, { shape: 'olderOpen-1' })

// A chat waiting with `askito wait` collects an answer within a second or two.
// One that is not waiting is woken by its own panel after this long.
const WAKE_AFTER_MS = 3000
let sessionId: string | null | undefined

const STALL_MINUTES = 30
const TONE = { warn: '#e06070', ok: '#2fa36b', info: undefined } as const

let locale: string | undefined

function stamp(iso: string) {
  const date = new Date(iso)
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year, hour: '2-digit', minute: '2-digit' }).format(date)
}

function dayKey(iso: string) {
  const date = new Date(iso)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dayLabel(key: string) {
  const [year, month, day] = key.split('-').map(Number)
  const then = new Date(year, month - 1, day)
  const now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - then.getTime()) / 86400000)
  if (days <= 1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day')
    return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1)
  }
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: year === now.getFullYear() ? undefined : 'numeric' }).format(then)
}

// Items arrive sorted, so groups and days keep the order of their first item.
function groupItems<T extends { project: string; createdAt: string }>(items: T[]) {
  const projects = new Map<string, Map<string, T[]>>()
  for (const item of items) {
    const days = projects.get(item.project) ?? new Map<string, T[]>()
    const key = dayKey(item.createdAt)
    days.set(key, [...(days.get(key) ?? []), item])
    projects.set(item.project, days)
  }
  return [...projects.entries()]
    .map(([project, days]) => ({
      project,
      days: [...days.entries()].map(([key, list]) => ({ key, label: dayLabel(key), items: list })),
    }))
}

const KIND_ORDER = ['question', 'approval', 'task', 'script'] as const
const SECTION_LABEL = { question: 'sectionQuestion', approval: 'sectionApproval', task: 'sectionTask', script: 'sectionScript' } as const
const OLDER_AFTER_MS = 7 * 86400000

// Waiting items in one section per kind; anything older than a week goes to a folded section.
function sectionItems<T extends { kind: InboxItem['kind']; createdAt: string }>(items: T[], now = Date.now()) {
  const older = items.filter(item => now - new Date(item.createdAt).getTime() > OLDER_AFTER_MS)
  const recent = items.filter(item => !older.includes(item))
  const sections = KIND_ORDER.map(kind => ({ kind, label: SECTION_LABEL[kind], items: recent.filter(item => item.kind === kind) })).filter(
    section => section.items.length,
  )
  return { sections, older }
}

function chatState(item: InboxItem, t: (key: string) => string) {
  if (!item.answer) return null
  if (item.orphaned) return { label: t('stateOrphaned'), tone: 'warn' as const }
  if (!item.deliveredAt) return { label: t('stateNotReceived'), tone: 'warn' as const }
  const answeredAt = item.answer.at
  const last = (item.messages ?? []).filter(m => m.from === 'agent' && m.kind !== 'handover' && m.at >= answeredAt).at(-1)
  const minutes = Math.floor((Date.now() - Date.parse(last?.at ?? item.deliveredAt)) / 60000)
  if (minutes >= STALL_MINUTES) return { label: t('stateStalled').replace('{mins}', String(minutes)), tone: 'warn' as const, note: last?.text ?? undefined }
  if (last) return { label: t('stateWorking'), tone: 'ok' as const, note: last.text ?? undefined }
  return { label: t('stateReceived'), tone: 'info' as const }
}

function eventLines(item: InboxItem, t: (key: string) => string) {
  const events: { at: string; line: string }[] = (item.messages ?? []).map(message => {
    const label =
      message.kind === 'assigned'
        ? t('eventAssigned')
        : message.from === 'human'
        ? [t('youLabel'), message.decision ? t(`decision_${message.decision}`) : '', message.choices?.join(', ')].filter(Boolean).join(': ')
        : t(message.kind === 'handover' ? 'eventHandover' : message.kind === 'progress' ? 'eventProgress' : message.kind === 'question' ? 'eventQuestion' : 'eventResult')
    return { at: message.at, line: message.text ? `${stamp(message.at)}  ${label}: ${message.text}` : `${stamp(message.at)}  ${label}` }
  })
  if (item.deliveredAt) events.push({ at: item.deliveredAt, line: `${stamp(item.deliveredAt)}  ${t('eventReceived')}` })
  return events.sort((a, b) => a.at.localeCompare(b.at)).map(event => event.line)
}

// A draft is typed by one person in one pane, and redrawing must not touch it.
const drafts: Record<string, string> = {}
let inboxHref = 'http://localhost:4517'

type Connection = { port: number; token: string; language?: string }

async function connect($: EngineInterface): Promise<Connection | null> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  const root = (await $.env.get('ASKITO_HOME')) || `${home}/.askito`
  // `language` is what agents write in; `uiLanguage` is the panel's own wording.
  let config: { port?: number; uiLanguage?: string } = {}
  try {
    config = JSON.parse(await $.fs.read(`${root}/config.json`))
  } catch {
    // No config file yet: the defaults below apply.
  }
  try {
    const token = (await $.fs.read(`${root}/ui.token`)).trim()
    const port = Number(await $.env.get('ASKITO_PORT')) || config.port || 4517
    // The desktop app only makes a link of https: or http://localhost.
    inboxHref = `http://localhost:${port}/login?t=${token}`
    // English unless the config names another language for the interface.
    const language = config.uiLanguage ?? 'en'
    locale = language
    return { port, token, language }
  } catch {
    return null
  }
}

function request($: EngineInterface, link: Connection, path: string, body?: object) {
  const origin = `http://127.0.0.1:${link.port}`
  return $.http.fetch(`${origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Cookie: `askito_ui=${link.token}`,
      Origin: origin,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

function sortItems(list: InboxItem[], mode: string) {
  const newest = (a: InboxItem, b: InboxItem) => b.createdAt.localeCompare(a.createdAt)
  const compare =
    mode === 'oldest'
      ? (a: InboxItem, b: InboxItem) => newest(b, a)
      : mode === 'urgent'
        ? (a: InboxItem, b: InboxItem) => Number(b.urgent) - Number(a.urgent) || newest(a, b)
        : mode === 'project'
          ? (a: InboxItem, b: InboxItem) => a.project.localeCompare(b.project) || newest(a, b)
          : newest
  return [...list].sort(compare)
}

function sortLinks<T extends { project: string; createdAt: string }>(list: T[], mode: string) {
  const newest = (a: T, b: T) => b.createdAt.localeCompare(a.createdAt)
  const compare = mode === 'oldest' ? (a: T, b: T) => newest(b, a) : mode === 'project' ? (a: T, b: T) => a.project.localeCompare(b.project) || newest(a, b) : newest
  return [...list].sort(compare)
}

async function loadCatalog($: EngineInterface, link: Connection) {
  const language = ['en', 'tr'].includes(link.language ?? '') ? link.language : 'en'
  const res = await request($, link, `/i18n/${language}.json`)
  if (!res.ok) return
  // Read every time: a stored copy from an older version shows new wording as raw keys.
  const next = JSON.parse(res.text) as Catalog
  if (JSON.stringify(await read($, catalog)) !== JSON.stringify(next)) await update($, catalog, () => next)
}

function wakeText(item: InboxItem) {
  const answer = item.answer
  const parts = [answer?.decision, answer?.choices?.length ? answer.choices.join(', ') : '', answer?.comment ? `"${answer.comment}"` : ''].filter(Boolean)
  const ref = item.number ?? item.id
  return [
    `askito #${ref} "${item.title}" was answered: ${parts.join(': ')}.`,
    `Collect it with \`~/.askito/bin/askito wait ${ref}\`, then carry on with the work it was for.`,
  ].join('\n')
}

// Tells askito this chat is open, and sends this chat's new answers in as its
// next prompt, so the work goes on as soon as the person answers.
async function wake($: EngineInterface, link: Connection, answered: InboxItem[]) {
  if (sessionId === undefined) sessionId = await $.session.id().catch(() => null)
  if (!sessionId) return
  await request($, link, '/api/sessions/beat', { sessionId }).catch(() => null)
  const sent = await read($, woken)
  const now = Date.now()
  const due = answered.filter(
    item =>
      item.sessionId === sessionId &&
      item.answer &&
      !item.deliveredAt &&
      now - Date.parse(item.answer.at) >= WAKE_AFTER_MS &&
      !sent.includes(`${item.id}@${item.answer.at}`),
  )
  if (!due.length) return
  await update($, woken, list => [...list, ...due.map(item => `${item.id}@${item.answer?.at}`)].slice(-200))
  for (const item of due) void $.prompt.submit({ text: wakeText(item) })
}

async function refresh($: EngineInterface) {
  try {
    const link = await connect($)
    if (!link) throw new Error('not installed')
    await loadCatalog($, link)
    const res = await request($, link, '/api/items?status=open')
    if (!res.ok) throw new Error(String(res.status))
    const next = (JSON.parse(res.text) as { items: InboxItem[] }).items.filter(item => !item.laterAt)
    const current = await read($, items)
    if (JSON.stringify(current) !== JSON.stringify(next)) await update($, items, () => next)
    const answered = await request($, link, '/api/items?status=answered')
    const nextAgents = answered.ok
      ? (JSON.parse(answered.text) as { items: InboxItem[] }).items
      : await read($, agents)
    if (JSON.stringify(await read($, agents)) !== JSON.stringify(nextAgents)) await update($, agents, () => nextAgents)
    if (answered.ok) await wake($, link, nextAgents)
    const linked = await request($, link, '/api/links')
    const nextLinks = linked.ok ? ((JSON.parse(linked.text) as { links?: LinkEntry[] }).links ?? []) : await read($, links)
    if (JSON.stringify(await read($, links)) !== JSON.stringify(nextLinks)) await update($, links, () => nextLinks)
    if ((await read($, status)) !== 'ready') await update($, status, () => 'ready')
  } catch {
    if ((await read($, status)) !== 'offline') await update($, status, () => 'offline')
  }
}

async function openFile($: EngineInterface, id: string, action: 'open' | 'reveal') {
  const link = await connect($)
  const res = link ? await request($, link, `/api/links/${id}/${action}`, {}).catch(() => null) : null
  await update($, error, () => !res || !res.ok)
  await refresh($)
}

// A Markdown code block that holds any text, even text with backtick runs in it.
function codeBlock(text: string, language = '') {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${language}\n${text}\n${fence}`
}

function shellWord(word: string) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
}

function runSummary(run: NonNullable<InboxItem['run']>, t: (key: string) => string) {
  if (run.state === 'running') return t('running')
  if (run.error) return t('runFailed').replace('{error}', run.error)
  if (run.signal) return t('runStopped').replace('{signal}', run.signal)
  return t('runExit').replace('{code}', String(run.exitCode))
}

async function act($: EngineInterface, id: string, action: 'answer' | 'dismiss' | 'later' | 'close' | 'reopen' | 'run' | 'stop' | 'chat', body: object) {
  const link = await connect($)
  const res = link ? await request($, link, `/api/items/${id}/${action}`, body).catch(() => null) : null
  // A 409 means the page answered first; the refresh below shows that.
  const failed = !res || (!res.ok && res.status !== 409)
  await update($, error, () => failed)
  if (!failed) delete drafts[id]
  await refresh($)
}

function itemNumber(item: InboxItem) {
  return item.number ? `#${item.number}` : ''
}

function matches(item: InboxItem, text: string) {
  const wanted = text.trim().replace(/^#/, '').toLocaleLowerCase()
  if (!wanted) return true
  if (/^\d+$/.test(wanted)) return String(item.number) === wanted
  return [item.title, item.body, item.project, item.chat, item.chatTitle].some(field => field?.toLocaleLowerCase().includes(wanted))
}

// Opens one item by its number (42 or #42) in whichever list holds it.
async function openItem($: EngineInterface, ref: string) {
  const wanted = ref.trim().replace(/^#/, '')
  if (!wanted) return null
  const find = (list: InboxItem[]) => list.find(item => String(item.number) === wanted || item.id === wanted)
  const waiting = find(await read($, items))
  const withChat = waiting ? undefined : find(await read($, agents))
  const item = waiting ?? withChat
  if (!item) return null
  await update($, view, () => (waiting ? 'waiting' : 'agents'))
  await update($, filter, () => null)
  await update($, query, () => '')
  await update($, selected, () => item.id)
  return item
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'askito-panel', description: 'Show the askito inbox beside the chat. /askito-panel 42 opens item #42' })
    void $.ui.open({ id: PANE, title: 'ask++' })
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'askito-panel' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'ask++' })
    await refresh($)
    const ref = (e.args ?? '').trim()
    if (!ref) return { text: 'ask++ panel opened.' }
    const item = await openItem($, ref)
    if (item) return { text: `Opened askito ${itemNumber(item)} "${item.title}".` }
    const number = ref.replace(/^#/, '')
    return { text: `askito #${number} is not waiting for you or with a chat. Run askito open ${number} to see it in the inbox.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select, Markdown, Link, Svg } = $.ui.resolve(e)
    const list = await read($, items)
    const picked = await read($, selected)
    const chosen = await read($, filter)
    const searching = await read($, query)
    const others = await read($, agents)
    const saved = await read($, links)
    const sorting = await read($, sortMode)
    const mode = await read($, view)
    const words = await read($, catalog)
    const state = await read($, status)
    const failed = await read($, error)
    const t = (key: string) => words[key] ?? key
    const inbox = <Link href={inboxHref} label={t('openInbox')} />

    if (state === 'offline') {
      return (
        <Box flexDirection="column" padding="md">
          <Text>{t('panelOffline')}</Text>
        </Box>
      )
    }
    const source = mode === 'agents' ? others : list
    const wantFiles = mode === 'files'
    const linkSource = saved.filter(entry => Boolean(entry.path) === wantFiles).map(entry => ({ ...entry, createdAt: entry.updatedAt }))
    const linkMode = mode === 'links' || mode === 'files'
    const projects = [...new Set((linkMode ? linkSource : source).map(item => item.project))].sort((a, b) => a.localeCompare(b))
    const active = chosen && projects.includes(chosen) ? chosen : null
    const shown = (active ? source.filter(item => item.project === active) : source).filter(item => matches(item, searching))
    // Nothing opens by itself: answering one item must not unfold the next.
    const openId = shown.some(item => item.id === picked) ? picked : null
    const { sections, older } = sectionItems(sortItems(shown, sorting))
    const showOlder = await read($, olderOpen)
    const projectName = (name: string) => (name === 'unsorted' ? t('unsorted') : name)
    const chip = (key: string, label: string, count: number, value: string | null) => (
      <Button key={`project-${key}`} variant={active === value ? 'primary' : 'secondary'} onPress={() => void update($, filter, () => value)}>
        {label} <Text dimColor>{count}</Text>
      </Button>
    )

    // Panel text cannot be selected; a field can. "Select text" shows the item's text in a
    // field, where any part can be selected and copied, and "Copy all" takes the whole item.
    const plain = await read($, plainText)
    const copyButton = (item: InboxItem) => (
      <Button
        key={`copy-${item.id}`}
        dimColor
        label={t('copy')}
        onPress={press => {
          void $.ui.copy({ text: [item.title, item.body].filter(Boolean).join('\n\n'), surface: press.surface }).then(() => $.ui.toast(t('copied')))
        }}
      />
    )
    const plainButton = (item: InboxItem) =>
      item.body ? (
        <Button
          key={`plain-${item.id}`}
          dimColor
          label={plain === item.id ? t('showFormatted') : t('selectText')}
          onPress={() => void update($, plainText, () => (plain === item.id ? null : item.id))}
        />
      ) : null
    const bodyView = (item: InboxItem) => {
      if (!item.body) return null
      if (plain !== item.id) return <Markdown text={item.body} />
      const text = [item.title, item.body].join('\n\n')
      return (
        <Input
          key={`plain-text-${item.id}`}
          value={text}
          rows={Math.min(24, Math.max(4, text.split('\n').length))}
          submitLabel={t('copy')}
          // Enter copies the whole text; typing here changes nothing in the item.
          onSubmit={(_value, e) => void $.ui.copy({ text, surface: e.surface }).then(() => $.ui.toast(t('copied')))}
        />
      )
    }

    // A script: the command, a Run button, and what the last run printed.
    const scriptDetail = (item: InboxItem) => {
      const run = item.run
      const running = run?.state === 'running'
      const output = run?.output ? run.output.slice(-PANEL_OUTPUT) : ''
      return (
        <Box flexDirection="column" gap="sm" marginTop="sm" paddingLeft="xs">
          {bodyView(item)}
          <Text size="caption" dimColor>
            {t('scriptIntro')}
          </Text>
          <Markdown text={codeBlock((item.script?.command ?? []).map(shellWord).join(' '), 'bash')} />
          <Text size="caption" dimColor>
            {`${t('scriptFolder')} ${item.script?.cwd ?? ''}`}
          </Text>
          {run ? (
            <Text weight="semibold" color={running ? undefined : run.error || run.signal || run.exitCode !== 0 ? 'red' : 'green'}>
              {runSummary(run, t)}
            </Text>
          ) : null}
          {run ? <Markdown text={codeBlock(output || t('noOutput'))} /> : null}
          <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="center">
            {running ? (
              <Button key={`stop-${item.id}`} variant="secondary" label={t('stop')} onPress={() => void act($, item.id, 'stop', {})} />
            ) : item.status === 'answered' ? (
              [
                <Button key={`complete-${item.id}`} variant="primary" label={t('complete')} onPress={() => void act($, item.id, 'close', {})} />,
                <Button key={`again-${item.id}`} variant="secondary" label={t('runAgain')} onPress={() => void act($, item.id, 'run', {})} />,
              ]
            ) : (
              [
                <Button key={`run-${item.id}`} variant="primary" label={t('run')} onPress={() => void act($, item.id, 'run', {})} />,
                <Button key={`later-${item.id}`} variant="secondary" label={t('later')} onPress={() => void act($, item.id, 'later', { later: true })} />,
              ]
            )}
            <Box flexGrow={1} />
            {copyButton(item)}
            {running ? null : <Button key={`remove-${item.id}`} dimColor label={t('remove')} onPress={() => void act($, item.id, 'dismiss', {})} />}
          </Box>
          {failed ? (
            <Text size="caption" color="red">
              {t('errorGeneric')}
            </Text>
          ) : null}
        </Box>
      )
    }

    const detail = (item: InboxItem) => {
      if (item.kind === 'script') return scriptDetail(item)
      const comment = () => drafts[item.id]?.trim() || undefined
      const answer = (body: object) => () => void act($, item.id, 'answer', { ...body, comment: comment() })
      const remove = <Button key={`remove-${item.id}`} dimColor label={t('remove')} onPress={() => void act($, item.id, 'dismiss', {})} />
      const choices =
        item.kind === 'question' && !item.multi && item.options.length ? (
          <Box flexDirection="column" gap="xs">
            {item.options.map(option => (
              <Button key={`option-${item.id}-${option.id}`} label={option.label} variant={option.recommended ? 'primary' : 'secondary'} onPress={answer({ decision: 'option', choices: [option.id] })}>
                {option.recommended ? <Text color="success" weight="semibold">★ {option.label}</Text> : option.label}
                {option.recommended ? <Text color="success"> · {t('recommended')}</Text> : ''}
              </Button>
            ))}
          </Box>
        ) : null
      const actions = {
        approval: [
          <Button key={`yes-${item.id}`} variant="primary" label={item.yes || t('approve')} onPress={answer({ decision: 'approved' })}>
            <Text color="success" weight="semibold">✓ {item.yes || t('approve')}</Text>
          </Button>,
          <Button key={`no-${item.id}`} variant="secondary" label={item.no || t('reject')} onPress={answer({ decision: 'rejected' })}>
            <Text color="error" weight="semibold">✕ {item.no || t('reject')}</Text>
          </Button>,
        ],
        task: [
          <Button key={`did-${item.id}`} variant="primary" label={t('markDone')} onPress={answer({ decision: 'done' })}>
            <Text color="success" weight="semibold">✓ {t('markDone')}</Text>
          </Button>,
          <Button key={`cant-${item.id}`} variant="secondary" label={t('cantDo')} onPress={answer({ decision: 'blocked' })}>
            <Text color="warning" weight="semibold">✕ {t('cantDo')}</Text>
          </Button>,
        ],
        question: [],
      }[item.kind]

      return (
        <Box flexDirection="column" gap="sm" marginTop="sm" paddingLeft="xs">
          {bodyView(item)}
          <Text size="caption" dimColor>
            {item.agentWaiting ? t('chatWaiting') : t('chatAway')}
          </Text>
          {item.kind === 'question' && item.multi ? (
            <Text size="caption" dimColor>
              {t('panelMulti')}
            </Text>
          ) : null}
          {choices}
          <Input
            key={`comment-${item.id}`}
            placeholder={item.kind === 'question' ? t('commentLabel') : `${t('noteLabel')}. ${t('notePlaceholder')}`}
            value={drafts[item.id] ?? ''}
            rows={2}
            submitLabel={t('commentOnly')}
            onInput={value => {
              drafts[item.id] = value
            }}
            onSubmit={value => {
              drafts[item.id] = value
              if (value.trim()) void act($, item.id, 'answer', { decision: 'comment', comment: value.trim() })
            }}
          />
          <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="center">
            {actions}
            <Box flexGrow={1} />
            {plainButton(item)}
            {copyButton(item)}
            <Button key={`later-${item.id}`} variant="secondary" label={t('later')} onPress={() => void act($, item.id, 'later', { later: true })} />
            {remove}
          </Box>
          {failed ? (
            <Text size="caption" color="red">
              {t('errorGeneric')}
            </Text>
          ) : null}
        </Box>
      )
    }

    const agentDetail = (item: InboxItem) => item.kind === 'script' ? scriptDetail(item) : (
      <Box flexDirection="column" gap="xs" marginTop="sm" paddingLeft="xs">
        {bodyView(item)}
        {eventLines(item, t).map(line => (
          <Text size="caption">{line}</Text>
        ))}
        <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="center" marginTop="xs">
          <Button key={`complete-${item.id}`} variant="primary" label={t('complete')} onPress={() => void act($, item.id, 'close', {})} />
          <Button key={`change-${item.id}`} variant="secondary" label={t('changeAnswer')} onPress={() => void act($, item.id, 'reopen', {})} />
          {plainButton(item)}
          {copyButton(item)}
        </Box>
      </Box>
    )

    const viewChip = (value: 'waiting' | 'agents' | 'links' | 'files', label: string, count: number) => (
      <Button key={`view-${value}`} variant={mode === value ? 'primary' : 'secondary'} onPress={() => void update($, view, () => value)}>
        {label} <Text dimColor>{count}</Text>
      </Button>
    )

    const row = (item: InboxItem) => {
      const state = mode === 'agents' ? chatState(item, t) : null
      const isOpen = item.id === openId
      const toggle = () => void update($, selected, () => (isOpen ? null : item.id))
      return (
        <Box flexDirection="row" gap="sm" alignItems="flex-start">
          <Box width={5} flexShrink={0} paddingTop="xs">
            <Text tabular weight="semibold" dimColor>
              {itemNumber(item)}
            </Text>
          </Box>
          <Svg source={kindSvg(item.kind)} alt={t(KIND_LABEL[item.kind])} width={32} height={32} />
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Button key={`toggle-${item.id}`} plain onPress={toggle}>
              <Text weight="semibold">{item.title}</Text>
            </Button>
            <Button key={`toggle-meta-${item.id}`} plain onPress={toggle}>
              <Text size="caption" weight="medium" backgroundColor={badgeColor(item.project)}>
                {` ${projectName(item.project)} `}
              </Text>
              {'  '}
              <Text size="caption" weight="medium">
                {t(KIND_LABEL[item.kind])}
              </Text>
              {item.urgent ? (
                <Text size="caption" weight="medium" color="red">
                  {`  ${t('urgent')}`}
                </Text>
              ) : (
                ''
              )}
              <Text size="caption" dimColor>
                {`${item.chatTitle || item.chat ? `  ${item.chatTitle || item.chat}` : ''}  ${stamp(item.createdAt)}`}
              </Text>
            </Button>
            {state ? (
              <Button key={`toggle-state-${item.id}`} plain onPress={toggle}>
                <Text size="caption" weight="medium" color={TONE[state.tone]}>
                  {state.note ? `${state.label}: ${state.note}` : state.label}
                </Text>
              </Button>
            ) : null}
            {isOpen && item.chatLink ? (
              // The panel only follows https links, so askito opens the claude:// one.
              <Button
                key={`chat-${item.id}`}
                plain
                label={(words.openChat ?? 'Open the chat “{title}” in Claude').replace('{title}', item.chatTitle || item.chat || '')}
                onPress={() => void act($, item.id, 'chat', {})}
              />
            ) : null}
            {isOpen ? (mode === 'agents' ? agentDetail(item) : detail(item)) : null}
          </Box>
        </Box>
      )
    }

    const linkRow = (entry: LinkEntry) => (
      <Box flexDirection="row" gap="sm" alignItems="flex-start">
        <Svg source={kindSvg(entry.path ? 'file' : 'link')} alt={t(entry.path ? 'tabFiles' : 'tabLinks')} width={32} height={32} />
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap="xs">
          {entry.path ? (
            <Button key={`file-${entry.id}`} plain onPress={() => void openFile($, entry.id, 'open')}>
              <Text weight="semibold">{entry.title}</Text>
            </Button>
          ) : (
            <Link href={entry.url ?? ''} label={entry.title} />
          )}
          <Text size="caption" dimColor>
            <Text size="caption" weight="medium" backgroundColor={badgeColor(entry.project)}>
              {` ${projectName(entry.project)} `}
            </Text>
            {`${entry.account ? `  ${entry.account}` : ''}${entry.chat ? `  ${entry.chat}` : ''}  ${stamp(entry.updatedAt)}`}
          </Text>
          {entry.body ? (
            <Text size="caption" dimColor>
              {entry.body}
            </Text>
          ) : null}
          {entry.path ? (
            <Box flexDirection="column" gap="xs">
              <Text size="caption" dimColor>
                {entry.exists === false ? `${t('fileMissing')}: ${entry.path}` : entry.path}
              </Text>
              <Box flexDirection="row" flexWrap="wrap" gap="xs">
                <Button key={`open-${entry.id}`} variant="primary" label={t('openFile')} onPress={() => void openFile($, entry.id, 'open')} />
                <Button key={`reveal-${entry.id}`} variant="secondary" label={t('revealFile')} onPress={() => void openFile($, entry.id, 'reveal')} />
              </Box>
            </Box>
          ) : null}
        </Box>
      </Box>
    )
    const shownLinks = sortLinks(active ? linkSource.filter(entry => entry.project === active) : linkSource, sorting)
    const linkGroups = groupItems(shownLinks)
    // Built only when shown, so the waiting list keeps its own numbering.
    const linksBody = !linkMode ? null : shownLinks.length ? (
      linkGroups.map(group => (
        <Box flexDirection="column" gap="md">
          {projects.length > 1 && !active ? <Text weight="bold">{projectName(group.project)}</Text> : null}
          {group.days.map(day => (
            <Box flexDirection="column" gap="md">
              <Text size="caption" weight="semibold" dimColor>
                {day.label}
              </Text>
              {day.items.map(entry => linkRow(entry))}
            </Box>
          ))}
        </Box>
      ))
    ) : (
      <Box flexDirection="column" gap="xs">
        <Text weight="semibold">{t(wantFiles ? 'emptyFilesTitle' : 'emptyLinksTitle')}</Text>
        <Text size="caption" dimColor>
          {t(wantFiles ? 'emptyFilesBody' : 'emptyLinksBody')}
        </Text>
      </Box>
    )
    const heading = mode === 'files' ? 'headFiles' : mode === 'links' ? 'headLinks' : mode === 'agents' ? 'headAgents' : 'headWaiting'

    return (
      <Box flexDirection="column" padding="md" gap="lg">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap="sm">
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Text size="title" weight="bold" tabular>
              {linkMode ? shownLinks.length : shown.length}
            </Text>
            <Text size="heading">{t(heading)}</Text>
          </Box>
          {inbox}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap="xs">
          {viewChip('waiting', t('tabWaiting'), list.length)}
          {viewChip('agents', t('tabAgents'), others.length)}
          {viewChip('links', t('tabLinks'), saved.filter(entry => !entry.path).length)}
          {viewChip('files', t('tabFiles'), saved.filter(entry => Boolean(entry.path)).length)}
        </Box>
        {projects.length > 1 ? (
          <Box flexDirection="row" flexWrap="wrap" gap="xs">
            {chip('all', t('allProjects'), linkMode ? linkSource.length : source.length, null)}
            {projects.map(name => chip(name, projectName(name), (linkMode ? linkSource : source).filter(item => item.project === name).length, name))}
          </Box>
        ) : null}
        <Select
          key="sort"
          label={t('sortLabel')}
          value={sorting}
          options={['newest', 'oldest', 'urgent', 'project'].map(value => ({ value, label: t(`sort_${value}`) }))}
          onSelect={value => void update($, sortMode, () => value)}
        />
        {linkMode ? null : (
          <Input
            key="search"
            placeholder={t('searchPlaceholder')}
            value={searching}
            submitLabel={t('openItem')}
            onInput={value => void update($, query, () => value)}
            // Enter on a number opens that item even when it sits in the other list.
            onSubmit={value => void openItem($, value)}
          />
        )}
        {linkMode ? (
          linksBody
        ) : shown.length ? (
          <Box flexDirection="column" gap="lg">
            {sections.map(section => (
              <Box key={`section-${section.kind}`} flexDirection="column" gap="md">
                <Box flexDirection="row" alignItems="center" gap="sm">
                  <Text weight="bold">{t(section.label)}</Text>
                  <Text size="caption" dimColor tabular>
                    {section.items.length}
                  </Text>
                </Box>
                {section.items.map(item => row(item))}
              </Box>
            ))}
            {older.length ? (
              <Box key="section-older" flexDirection="column" gap="md">
                <Box flexDirection="row" alignItems="center" gap="sm">
                  <Text weight="bold" dimColor>
                    {t('sectionOlder')}
                  </Text>
                  <Text size="caption" dimColor tabular>
                    {older.length}
                  </Text>
                  <Button
                    key="toggle-older"
                    dimColor
                    label={showOlder ? t('hideOlder') : t('showOlder')}
                    onPress={() => void update($, olderOpen, open => !open)}
                  />
                </Box>
                {showOlder ? older.map(item => row(item)) : null}
              </Box>
            ) : null}
          </Box>
        ) : (
          <Box flexDirection="column" gap="xs">
            <Text weight="semibold">{searching.trim() ? t('noMatch') : t(mode === 'agents' ? 'emptyAgentsTitle' : 'emptyWaitingTitle')}</Text>
            {searching.trim() ? null : (
              <Text size="caption" dimColor>
                {t(mode === 'agents' ? 'emptyAgentsBody' : 'emptyWaitingBody')}
              </Text>
            )}
          </Box>
        )}
      </Box>
    )
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Catalog, InboxItem } from '../types'

const PANE = 'askito-inbox'
const POLL_MS = 4000
const KIND_LABEL = { question: 'kindQuestion', approval: 'kindApproval', task: 'kindTask' } as const

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
} as const

// Translucent, so one project keeps its color on the light and the dark theme.
const BADGE_COLORS = ['#4f8fe838', '#2fa36b38', '#c9922e38', '#a678e238', '#e0607038', '#2aa5b838']

function badgeColor(project: string) {
  const sum = Array.from(project).reduce((total, char) => total + (char.codePointAt(0) ?? 0), 0)
  return BADGE_COLORS[sum % BADGE_COLORS.length]
}

function kindSvg(kind: InboxItem['kind']) {
  const { color, shapes } = KIND_ICON[kind]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${color}" fill-opacity="0.18"/><g transform="translate(6 6) scale(0.8333)" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</g></svg>`
}

const items = atom({ plugin: 'askito-panel', key: 'items' } as const, [], { shape: 'items-1' })
const selected = atom({ plugin: 'askito-panel', key: 'selected' } as const, null, { shape: 'selected-1' })
const filter = atom({ plugin: 'askito-panel', key: 'filter' } as const, null, { shape: 'filter-1' })
const agents = atom({ plugin: 'askito-panel', key: 'agents' } as const, [], { shape: 'agents-1' })
const view = atom({ plugin: 'askito-panel', key: 'view' } as const, 'waiting', { shape: 'view-1' })
const sortMode = atom({ plugin: 'askito-panel', key: 'sort' } as const, 'newest', { shape: 'sort-1' })
const catalog = atom({ plugin: 'askito-panel', key: 'catalog' } as const, {}, { shape: 'catalog-1' })
const status = atom({ plugin: 'askito-panel', key: 'status' } as const, 'loading', { shape: 'status-1' })
const error = atom({ plugin: 'askito-panel', key: 'error' } as const, false, { shape: 'error-1' })

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
function groupItems(items: InboxItem[]) {
  const projects = new Map<string, Map<string, InboxItem[]>>()
  for (const item of items) {
    const days = projects.get(item.project) ?? new Map<string, InboxItem[]>()
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
  let config: { port?: number; language?: string } = {}
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
    locale = config.language
    return { port, token, language: config.language }
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

async function loadCatalog($: EngineInterface, link: Connection) {
  const wanted = link.language ?? new Intl.DateTimeFormat().resolvedOptions().locale.slice(0, 2)
  const language = ['en', 'tr'].includes(wanted) ? wanted : 'en'
  const res = await request($, link, `/i18n/${language}.json`)
  if (!res.ok) return
  // Read every time: a stored copy from an older version shows new wording as raw keys.
  const next = JSON.parse(res.text) as Catalog
  if (JSON.stringify(await read($, catalog)) !== JSON.stringify(next)) await update($, catalog, () => next)
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
    if ((await read($, status)) !== 'ready') await update($, status, () => 'ready')
  } catch {
    if ((await read($, status)) !== 'offline') await update($, status, () => 'offline')
  }
}

async function act($: EngineInterface, id: string, action: 'answer' | 'dismiss' | 'later' | 'close' | 'reopen', body: object) {
  const link = await connect($)
  const res = link ? await request($, link, `/api/items/${id}/${action}`, body).catch(() => null) : null
  // A 409 means the page answered first; the refresh below shows that.
  const failed = !res || (!res.ok && res.status !== 409)
  await update($, error, () => failed)
  if (!failed) delete drafts[id]
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'askito-panel', description: 'Show the askito inbox beside the chat' })
    void $.ui.open({ id: PANE, title: 'Ask·ito' })
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'askito-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Ask·ito' })
    await refresh($)

    return { text: 'Ask·ito panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select, Markdown, Link, Svg } = $.ui.resolve(e)
    const list = await read($, items)
    const picked = await read($, selected)
    const chosen = await read($, filter)
    const others = await read($, agents)
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
    const projects = [...new Set(source.map(item => item.project))].sort((a, b) => a.localeCompare(b))
    const active = chosen && projects.includes(chosen) ? chosen : null
    const shown = active ? source.filter(item => item.project === active) : source
    // Nothing opens by itself: answering one item must not unfold the next.
    const openId = shown.some(item => item.id === picked) ? picked : null
    const groups = groupItems(sortItems(shown, sorting))
    const projectName = (name: string) => (name === 'unsorted' ? t('unsorted') : name)
    const chip = (key: string, label: string, count: number, value: string | null) => (
      <Button key={`project-${key}`} variant={active === value ? 'primary' : 'secondary'} onPress={() => void update($, filter, () => value)}>
        {label} <Text dimColor>{count}</Text>
      </Button>
    )

    // Panel text cannot be selected, so the question gets a copy button.
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

    const detail = (item: InboxItem) => {
      const comment = () => drafts[item.id]?.trim() || undefined
      const answer = (body: object) => () => void act($, item.id, 'answer', { ...body, comment: comment() })
      const remove = <Button key={`remove-${item.id}`} dimColor label={t('remove')} onPress={() => void act($, item.id, 'dismiss', {})} />
      const choices =
        item.kind === 'question' && !item.multi && item.options.length ? (
          <Box flexDirection="column" gap="xs">
            {item.options.map(option => (
              <Button key={`option-${item.id}-${option.id}`} variant={option.recommended ? 'primary' : 'secondary'} onPress={answer({ decision: 'option', choices: [option.id] })}>
                {option.label}
                {option.recommended ? <Text dimColor> {t('recommended')}</Text> : ''}
              </Button>
            ))}
          </Box>
        ) : null
      const actions = {
        approval: [
          <Button key={`yes-${item.id}`} variant="primary" label={t('approve')} onPress={answer({ decision: 'approved' })} />,
          <Button key={`no-${item.id}`} variant="secondary" label={t('reject')} onPress={answer({ decision: 'rejected' })} />,
        ],
        task: [
          <Button key={`did-${item.id}`} variant="primary" label={t('markDone')} onPress={answer({ decision: 'done' })} />,
          <Button key={`cant-${item.id}`} variant="secondary" label={t('cantDo')} onPress={answer({ decision: 'blocked' })} />,
        ],
        question: [],
      }[item.kind]

      return (
        <Box flexDirection="column" gap="sm" marginTop="sm" paddingLeft="xs">
          {item.body ? <Markdown text={item.body} /> : null}
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
            placeholder={t('commentLabel')}
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

    const agentDetail = (item: InboxItem) => (
      <Box flexDirection="column" gap="xs" marginTop="sm" paddingLeft="xs">
        {item.body ? <Markdown text={item.body} /> : null}
        {eventLines(item, t).map(line => (
          <Text size="caption">{line}</Text>
        ))}
        <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="center" marginTop="xs">
          <Button key={`complete-${item.id}`} variant="primary" label={t('complete')} onPress={() => void act($, item.id, 'close', {})} />
          <Button key={`change-${item.id}`} variant="secondary" label={t('changeAnswer')} onPress={() => void act($, item.id, 'reopen', {})} />
          {copyButton(item)}
        </Box>
      </Box>
    )

    const viewChip = (value: 'waiting' | 'agents', label: string, count: number) => (
      <Button key={`view-${value}`} variant={mode === value ? 'primary' : 'secondary'} onPress={() => void update($, view, () => value)}>
        {label} <Text dimColor>{count}</Text>
      </Button>
    )

    let number = 0
    const row = (item: InboxItem, index: number) => {
      const state = mode === 'agents' ? chatState(item, t) : null
      const isOpen = item.id === openId
      const toggle = () => void update($, selected, () => (isOpen ? null : item.id))
      return (
        <Box flexDirection="row" gap="sm" alignItems="flex-start">
          <Box width={3} flexShrink={0} paddingTop="xs">
            <Text tabular weight="semibold" dimColor>
              {index}
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
                {`${item.chat ? `  ${item.chat}` : ''}  ${stamp(item.createdAt)}`}
              </Text>
            </Button>
            {state ? (
              <Button key={`toggle-state-${item.id}`} plain onPress={toggle}>
                <Text size="caption" weight="medium" color={TONE[state.tone]}>
                  {state.note ? `${state.label}: ${state.note}` : state.label}
                </Text>
              </Button>
            ) : null}
            {isOpen ? (mode === 'agents' ? agentDetail(item) : detail(item)) : null}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" padding="md" gap="lg">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap="sm">
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Text size="title" weight="bold" tabular>
              {shown.length}
            </Text>
            <Text size="heading">{t(mode === 'agents' ? 'headAgents' : 'headWaiting')}</Text>
          </Box>
          {inbox}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap="xs">
          {viewChip('waiting', t('tabWaiting'), list.length)}
          {viewChip('agents', t('tabAgents'), others.length)}
        </Box>
        {projects.length > 1 ? (
          <Box flexDirection="row" flexWrap="wrap" gap="xs">
            {chip('all', t('allProjects'), source.length, null)}
            {projects.map(name => chip(name, projectName(name), source.filter(item => item.project === name).length, name))}
          </Box>
        ) : null}
        <Select
          key="sort"
          label={t('sortLabel')}
          value={sorting}
          options={['newest', 'oldest', 'urgent', 'project'].map(value => ({ value, label: t(`sort_${value}`) }))}
          onSelect={value => void update($, sortMode, () => value)}
        />
        {shown.length ? (
          groups.map(group => (
            <Box flexDirection="column" gap="md">
              {projects.length > 1 && !active ? (
                <Box flexDirection="row" alignItems="center" gap="sm">
                  <Text weight="bold">{projectName(group.project)}</Text>
                  <Text size="caption" dimColor tabular>
                    {group.days.reduce((sum, day) => sum + day.items.length, 0)}
                  </Text>
                </Box>
              ) : null}
              {group.days.map(day => (
                <Box flexDirection="column" gap="md">
                  <Text size="caption" weight="semibold" dimColor>
                    {day.label}
                  </Text>
                  {day.items.map(item => row(item, (number += 1)))}
                </Box>
              ))}
            </Box>
          ))
        ) : (
          <Box flexDirection="column" gap="xs">
            <Text weight="semibold">{t(mode === 'agents' ? 'emptyAgentsTitle' : 'emptyWaitingTitle')}</Text>
            <Text size="caption" dimColor>
              {t(mode === 'agents' ? 'emptyAgentsBody' : 'emptyWaitingBody')}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Catalog, InboxItem } from '../types'

const PANE = 'askito-inbox'
const POLL_MS = 4000
const KIND_LABEL = { question: 'kindQuestion', approval: 'kindApproval', task: 'kindTask' } as const

const items = atom({ plugin: 'askito-panel', key: 'items' } as const, [], { shape: 'items-1' })
const selected = atom({ plugin: 'askito-panel', key: 'selected' } as const, null, { shape: 'selected-1' })
const catalog = atom({ plugin: 'askito-panel', key: 'catalog' } as const, {}, { shape: 'catalog-1' })
const status = atom({ plugin: 'askito-panel', key: 'status' } as const, 'loading', { shape: 'status-1' })
const error = atom({ plugin: 'askito-panel', key: 'error' } as const, false, { shape: 'error-1' })

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

function order(list: InboxItem[]) {
  return [...list].sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.createdAt.localeCompare(b.createdAt))
}

async function loadCatalog($: EngineInterface, link: Connection) {
  if (Object.keys(await read($, catalog)).length) return
  const wanted = link.language ?? new Intl.DateTimeFormat().resolvedOptions().locale.slice(0, 2)
  const language = ['en', 'tr'].includes(wanted) ? wanted : 'en'
  const res = await request($, link, `/i18n/${language}.json`)
  if (res.ok) await update($, catalog, () => JSON.parse(res.text) as Catalog)
}

async function refresh($: EngineInterface) {
  try {
    const link = await connect($)
    if (!link) throw new Error('not installed')
    await loadCatalog($, link)
    const res = await request($, link, '/api/items?status=open')
    if (!res.ok) throw new Error(String(res.status))
    const next = order((JSON.parse(res.text) as { items: InboxItem[] }).items)
    const current = await read($, items)
    if (JSON.stringify(current) !== JSON.stringify(next)) await update($, items, () => next)
    const picked = await read($, selected)
    if (!next.some(item => item.id === picked)) await update($, selected, () => next[0]?.id ?? null)
    if ((await read($, status)) !== 'ready') await update($, status, () => 'ready')
  } catch {
    if ((await read($, status)) !== 'offline') await update($, status, () => 'offline')
  }
}

async function act($: EngineInterface, id: string, action: 'answer' | 'dismiss', body: object) {
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
    void $.ui.open({ id: PANE, title: 'askito' })
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'askito-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'askito' })
    await refresh($)

    return { text: 'askito panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Markdown, Link } = $.ui.resolve(e)
    const list = await read($, items)
    const picked = await read($, selected)
    const words = await read($, catalog)
    const state = await read($, status)
    const failed = await read($, error)
    const t = (key: string) => words[key] ?? key
    const inbox = <Link href={inboxHref} label={t('openInbox')} />

    if (state === 'offline') {
      return (
        <Box flexDirection="column">
          <Text>{t('panelOffline')}</Text>
        </Box>
      )
    }
    if (!list.length) {
      return (
        <Box flexDirection="column">
          <Text bold>{t('emptyWaitingTitle')}</Text>
          <Text dimColor>{t('emptyWaitingBody')}</Text>
          {inbox}
        </Box>
      )
    }

    const detail = (item: InboxItem) => {
      const comment = () => drafts[item.id]?.trim() || undefined
      const answer = (body: object) => () => void act($, item.id, 'answer', { ...body, comment: comment() })
      const box = (
        <Input
          key={`comment-${item.id}`}
          label={t('commentLabel')}
          value={drafts[item.id] ?? ''}
          submitLabel={t('commentOnly')}
          onInput={value => {
            drafts[item.id] = value
          }}
          onSubmit={value => {
            drafts[item.id] = value
            if (value.trim()) void act($, item.id, 'answer', { decision: 'comment', comment: value.trim() })
          }}
        />
      )
      const controls = {
        approval: [
          <Button key={`yes-${item.id}`} variant="primary" label={t('approve')} onPress={answer({ decision: 'approved' })} />,
          <Button key={`no-${item.id}`} label={t('reject')} onPress={answer({ decision: 'rejected' })} />,
        ],
        task: [
          <Button key={`did-${item.id}`} variant="primary" label={t('markDone')} onPress={answer({ decision: 'done' })} />,
          <Button key={`cant-${item.id}`} label={t('cantDo')} onPress={answer({ decision: 'blocked' })} />,
        ],
        // A press sends at once, so a question with several answers goes to the page.
        question: item.multi
          ? [<Text dimColor>{t('panelMulti')}</Text>]
          : item.options.map(option => (
              <Button
                key={`option-${item.id}-${option.id}`}
                variant={option.recommended ? 'primary' : 'secondary'}
                label={option.recommended ? `${option.label} (${t('recommended')})` : option.label}
                onPress={answer({ decision: 'option', choices: [option.id] })}
              />
            )),
      }[item.kind]

      return (
        <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
          {item.body ? <Markdown text={item.body} /> : null}
          <Text dimColor>{item.agentWaiting ? t('chatWaiting') : t('chatAway')}</Text>
          <Box flexDirection="column">{controls}</Box>
          {box}
          <Button key={`remove-${item.id}`} dimColor label={t('remove')} onPress={() => void act($, item.id, 'dismiss', {})} />
          {failed ? <Text color="red">{t('errorGeneric')}</Text> : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>
          {list.length} {t('headWaiting')}
        </Text>
        {inbox}
        {list.map((item, index) => (
          <Box flexDirection="column" marginTop={1}>
            <Button key={`row-${item.id}`} plain onPress={() => void update($, selected, () => item.id)}>
              {index + 1}. {t(KIND_LABEL[item.kind])}
              {item.urgent ? `, ${t('urgent')}` : ''}: {item.title}
            </Button>
            <Text dimColor>{[item.project, item.chat].filter(Boolean).join(', ')}</Text>
            {item.id === picked ? detail(item) : null}
          </Box>
        ))}
      </Box>
    )
  })
}

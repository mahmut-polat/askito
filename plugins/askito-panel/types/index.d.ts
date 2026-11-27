export type InboxOption = { id: string; label: string; description: string | null; recommended: boolean }

export type InboxMessage = { from: 'human' | 'agent'; kind?: string; decision?: string; choices?: string[]; text: string | null; at: string }

export type InboxItem = {
  id: string
  // The number people see and type, such as 42 for #42.
  number?: number
  kind: 'question' | 'approval' | 'task' | 'script'
  // Where the item stands; Done shows answered and closed ones together.
  status?: 'open' | 'answered' | 'done' | 'dismissed'
  title: string
  // A script item: what Run starts, and how its last run went.
  script?: { command: string[]; cwd: string } | null
  run?: { state: 'running' | 'finished'; exitCode: number | null; signal: string | null; error: string | null; output: string } | null
  body: string | null
  options: InboxOption[]
  multi: boolean
  // An approval's own button words, such as "Yes, delete it" and "No, keep it".
  yes?: string | null
  no?: string | null
  urgent: boolean
  project: string
  chat: string | null
  chatTitle?: string | null
  chatLink?: string | null
  // The Claude Code session that asked; its panel wakes it when the answer comes.
  sessionId?: string | null
  account?: string | null
  agentWaiting: boolean
  createdAt: string
  laterAt?: string | null
  answer?: { decision: string; choices: string[]; comment: string | null; at: string } | null
  deliveredAt?: string | null
  orphaned?: boolean
  messages?: InboxMessage[]
}

export type LinkEntry = {
  id: string
  title: string
  url: string | null
  path?: string | null
  exists?: boolean
  body: string | null
  project: string
  chat: string | null
  account: string | null
  createdAt: string
  updatedAt: string
}

export type Catalog = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'askito-panel': {
      items: Shaped<InboxItem[]>
      selected: Shaped<string | null>
      plainText: Shaped<string | null>
      filter: Shaped<string | null>
      query: Shaped<string>
      agents: Shaped<InboxItem[]>
      view: Shaped<'waiting' | 'agents' | 'links' | 'files'>
      links: Shaped<LinkEntry[]>
      sort: Shaped<string>
      catalog: Shaped<Catalog>
      status: Shaped<'loading' | 'ready' | 'offline'>
      error: Shaped<boolean>
      // Answers already sent into this chat, as "id@answeredAt", so a reload does not send them twice.
      woken: Shaped<string[]>
    }
  }
}

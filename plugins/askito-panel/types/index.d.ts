export type InboxOption = { id: string; label: string; description: string | null; recommended: boolean }

export type InboxMessage = { from: 'human' | 'agent'; kind?: string; decision?: string; choices?: string[]; text: string | null; at: string }

export type InboxItem = {
  id: string
  // The number people see and type, such as 42 for #42.
  number?: number
  kind: 'question' | 'approval' | 'task'
  title: string
  body: string | null
  options: InboxOption[]
  multi: boolean
  urgent: boolean
  project: string
  chat: string | null
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
    }
  }
}

export type InboxOption = { id: string; label: string; description: string | null; recommended: boolean }

export type InboxMessage = { from: 'human' | 'agent'; kind?: string; decision?: string; choices?: string[]; text: string | null; at: string }

export type InboxItem = {
  id: string
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

export type Catalog = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'askito-panel': {
      items: Shaped<InboxItem[]>
      selected: Shaped<string | null>
      filter: Shaped<string | null>
      agents: Shaped<InboxItem[]>
      view: Shaped<'waiting' | 'agents'>
      sort: Shaped<string>
      catalog: Shaped<Catalog>
      status: Shaped<'loading' | 'ready' | 'offline'>
      error: Shaped<boolean>
    }
  }
}

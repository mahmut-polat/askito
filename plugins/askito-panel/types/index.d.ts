export type InboxOption = { id: string; label: string; description: string | null; recommended: boolean }

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
}

export type Catalog = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'askito-panel': {
      items: Shaped<InboxItem[]>
      selected: Shaped<string | null>
      catalog: Shaped<Catalog>
      status: Shaped<'loading' | 'ready' | 'offline'>
      error: Shaped<boolean>
    }
  }
}

export type Thread = {
  readonly id: number
  readonly text: string
  readonly origin: 'claude' | 'user'
  readonly openedAt: string
  readonly closedAt?: string
  readonly note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'loose-ends': {
      threads: Shaped<Thread[]>
      toolsReady: boolean
      // The open thread the pane's tie and drop act on; 0 is none picked.
      picked: number
      // The open thread a first drop press armed; 0 is none.
      dropArmed: number
      // Whether the person closed the pane by hand this session.
      paneDismissed: boolean
    }
  }
}

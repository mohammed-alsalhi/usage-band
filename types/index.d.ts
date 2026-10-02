export type Sample = [at: number, percent: number]

export type UsageWindow = { resetsAt?: string; percent: number; samples: Sample[] }

export type Windows = Record<string, UsageWindow>

export type Cost = { session: number; today: number; month: number }

export type Usage = { at: number; windows: Windows; cost?: Cost }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { usage: Usage | null }
  }
}

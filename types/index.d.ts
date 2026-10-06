/** What a session is doing, as that session last wrote it. */
export type Status = 'running' | 'waiting' | 'idle' | 'ended'

/** CI on the pull request's head: every check passed, one failed, some still run, or none. */
export type Ci = 'pass' | 'fail' | 'pending' | 'none'

/** The open pull request for a session's branch, read with the gh CLI. */
export type PrInfo = {
  number: number
  url: string
  state: string
  isDraft: boolean
  ci: Ci
  /** The latest "Confidence: N/5" from the Claude review comment. */
  review?: number
  /** Review threads not yet resolved. */
  openThreads?: number
  checkedAt: number
}

/** One session's file in the shared folder. Each session writes only its own. */
export type SessionRecord = {
  v: 1
  id: string
  /** A random secret. A stop message must carry it, so only a reader of this folder can stop the session. */
  token: string
  root: string
  project: string
  branch?: string
  status: Status
  activity?: string
  prompt?: string
  startedAt: number
  turnStartedAt?: number
  /** When the status last changed. */
  since: number
  /** The heartbeat. A session that stops writing for two minutes shows as lost. */
  updatedAt: number
  pr?: PrInfo
}

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      sessions: SessionRecord[]
      filter: string
      self: SessionRecord | null
      turnId: string | null
      now: number
    }
  }
}

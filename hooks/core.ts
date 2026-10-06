// The parts of Mission Control that need no engine: how a session's file
// becomes a row, how rows group into projects, and how gh's output becomes
// the PR column. register.tsx wires these to events.

import type { Ci, PrInfo, SessionRecord, Status } from '../types'

/** No heartbeat for this long and a session shows as lost. */
export const STALE_MS = 2 * 60_000
/** Ended and lost sessions stay on the board this long. */
export const KEEP_MS = 24 * 60 * 60_000
export const HEARTBEAT_MS = 30_000
export const SCAN_MS = 4_000
/** At most one gh lookup per session in this window. */
export const PR_EVERY_MS = 2 * 60_000

export type Shown = Status | 'lost'

export const SHOWN_ORDER: readonly Shown[] = ['waiting', 'running', 'idle', 'lost', 'ended']

export const LABEL: Record<Shown, string> = {
  waiting: 'waiting on you',
  running: 'running',
  idle: 'idle',
  lost: 'lost',
  ended: 'done',
}

export function shownStatus(record: SessionRecord, now: number): Shown {
  if (record.status === 'ended') return 'ended'

  return now - record.updatedAt > STALE_MS ? 'lost' : record.status
}

export function isKept(record: SessionRecord, now: number): boolean {
  const shown = shownStatus(record, now)

  return (shown !== 'ended' && shown !== 'lost') || now - record.updatedAt < KEEP_MS
}

export type Counts = Record<Shown, number>

export function count(records: readonly SessionRecord[], now: number): Counts {
  const counts: Counts = { waiting: 0, running: 0, idle: 0, lost: 0, ended: 0 }
  for (const record of records) counts[shownStatus(record, now)] += 1

  return counts
}

/** The status line, such as "1 waiting · 2 running · 3 idle". The engine puts the plugin's name before it. */
export function statusLine(counts: Counts): string {
  const parts = (['waiting', 'running', 'idle', 'lost'] as const)
    .filter(shown => counts[shown] > 0)
    .map(shown => `${counts[shown]} ${shown}`)

  return parts.length === 0 ? 'no sessions' : parts.join(' · ')
}

export function matches(record: SessionRecord, query: string, now: number): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true

  const haystack = [
    record.project,
    record.branch,
    record.prompt,
    record.activity,
    record.root,
    LABEL[shownStatus(record, now)],
    record.pr ? `#${record.pr.number}` : undefined,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return terms.every(term => haystack.includes(term))
}

export type Group = { project: string; rows: SessionRecord[] }

/** The group a project shows under: the desktop app's scratch folders share one. */
export const SCRATCH_GROUP = 'Quick sessions'

export function groupName(project: string): string {
  return /^scratch-\d{4}-\d{2}-\d{2}-[0-9a-f]+$/i.test(project) ? SCRATCH_GROUP : project
}

/**
 * A prompt as the person wrote it: the engine's own notes, such as a
 * <system-reminder> block, are dropped, even one cut off by an earlier clip.
 */
export function cleanPrompt(text: string): string {
  return clip(text.replace(/<(system-reminder|command-[a-z-]+)>[\s\S]*?(<\/\1>|$)/g, ' '), 140)
}

/**
 * Groups kept sessions by project. Projects with a session waiting on you
 * come first, then running ones, then the most recently active.
 */
export function group(records: readonly SessionRecord[], query: string, now: number): Group[] {
  const rank = (record: SessionRecord) => SHOWN_ORDER.indexOf(shownStatus(record, now))
  const byProject = new Map<string, SessionRecord[]>()

  for (const record of records) {
    if (!isKept(record, now) || !matches(record, query, now)) continue
    const name = groupName(record.project)
    const rows = byProject.get(name) ?? []
    rows.push(record)
    byProject.set(name, rows)
  }

  const groups = [...byProject].map(([project, rows]) => ({
    project,
    rows: rows.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt),
  }))

  const best = (g: Group) => Math.min(...g.rows.map(rank))
  const latest = (g: Group) => Math.max(...g.rows.map(row => row.updatedAt))

  return groups.sort(
    (a, b) => best(a) - best(b) || latest(b) - latest(a) || a.project.localeCompare(b.project),
  )
}

export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`

  return `${Math.round(seconds / 86_400)}d`
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)

  return parts.at(-1) ?? path
}

/**
 * The project a session belongs to. Every worktree of a repository shares
 * one git common dir, so worktrees group under the main checkout's name.
 */
export function projectName(root: string, commonDir?: string): string {
  const dir = commonDir?.trim()
  if (!dir) return basename(root)

  const parts = dir.split(/[\\/]+/).filter(Boolean)
  const last = parts.at(-1)

  return last === '.git' && parts.length > 1 ? (parts.at(-2) ?? basename(root)) : basename(dir).replace(/\.git$/, '')
}

/** One short line on what a tool call is doing. */
export function activityFor(tool: string, input: Readonly<Record<string, unknown>>): string {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined)
  const file = text('file_path') ?? text('notebook_path') ?? text('path')
  const detail =
    text('description') ??
    text('command') ??
    (file ? basename(file) : undefined) ??
    text('pattern') ??
    text('url') ??
    text('query') ??
    text('skill')

  return detail ? `${tool}: ${clip(detail, 60)}` : tool
}

export const STOP_TAG = '[mission-control] stop'

export function stopText(token: string): string {
  return `${STOP_TAG} ${token}`
}

/** The token a stop message carries, wherever the engine's envelope puts the text. */
export function stopToken(text: string): string | undefined {
  const at = text.indexOf(STOP_TAG)
  if (at < 0) return undefined

  return /^\s+([A-Za-z0-9_-]{16,})/.exec(text.slice(at + STOP_TAG.length))?.[1]
}

export function resumeCommand(record: SessionRecord): string {
  return `cd "${record.root}" && claude --resume ${record.id}`
}

export function newToken(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)

  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

type RollupItem = { status?: string; conclusion?: string; state?: string }

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

export function ciFrom(rollup: readonly RollupItem[] | undefined): Ci {
  if (!rollup || rollup.length === 0) return 'none'

  const outcomes = rollup.map(item => (item.conclusion || item.state || item.status || '').toUpperCase())
  if (outcomes.some(outcome => FAILED.has(outcome))) return 'fail'

  return outcomes.every(outcome => PASSED.has(outcome)) ? 'pass' : 'pending'
}

/** The score from the newest "### Claude review" comment that ends in "Confidence: N/5". */
export function reviewFrom(comments: readonly { body?: string }[] | undefined): number | undefined {
  for (const comment of [...(comments ?? [])].reverse()) {
    const body = comment.body ?? ''
    if (!body.includes('Claude review')) continue
    const found = /Confidence:\s*([1-5])\s*\/\s*5/.exec(body)
    if (found) return Number(found[1])
  }

  return undefined
}

/** Reads `gh pr view --json number,url,state,isDraft,statusCheckRollup,comments`. */
export function prFrom(json: string, now: number): PrInfo | undefined {
  try {
    const view = JSON.parse(json) as {
      number?: number
      url?: string
      state?: string
      isDraft?: boolean
      statusCheckRollup?: RollupItem[]
      comments?: { body?: string }[]
    }
    if (typeof view.number !== 'number' || typeof view.url !== 'string') return undefined

    return {
      number: view.number,
      url: view.url,
      state: view.state ?? 'OPEN',
      isDraft: view.isDraft === true,
      ci: ciFrom(view.statusCheckRollup),
      review: reviewFrom(view.comments),
      checkedAt: now,
    }
  } catch {
    return undefined
  }
}

export function repoFromPrUrl(url: string): { owner: string; repo: string; number: number } | undefined {
  const found = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url)
  if (!found) return undefined

  return { owner: found[1] ?? '', repo: found[2] ?? '', number: Number(found[3]) }
}

export const THREADS_QUERY =
  'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}'

export function openThreadsFrom(json: string): number | undefined {
  try {
    const nodes = (
      JSON.parse(json) as {
        data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: { isResolved?: boolean }[] } } } }
      }
    ).data?.repository?.pullRequest?.reviewThreads?.nodes
    if (!Array.isArray(nodes)) return undefined

    return nodes.filter(node => node.isResolved === false).length
  } catch {
    return undefined
  }
}

/** The PR column, such as "#12 draft · CI pass · review 4/5 · 2 open". */
export function prLine(pr: PrInfo): string {
  const parts = [`#${pr.number}${pr.isDraft ? ' draft' : ''}`]
  if (pr.state !== 'OPEN') parts.push(pr.state.toLowerCase())
  if (pr.ci !== 'none') parts.push(`CI ${pr.ci}`)
  if (pr.review !== undefined) parts.push(`review ${pr.review}/5`)
  if (pr.openThreads) parts.push(`${pr.openThreads} open`)

  return parts.join(' · ')
}

/** Parses a session file; anything else (a half-written file, a stranger's JSON) is skipped. */
export function parseRecord(text: string): SessionRecord | undefined {
  try {
    const record = JSON.parse(text) as Partial<SessionRecord>
    const isValid =
      record.v === 1 &&
      typeof record.id === 'string' &&
      typeof record.token === 'string' &&
      typeof record.root === 'string' &&
      typeof record.project === 'string' &&
      typeof record.status === 'string' &&
      typeof record.updatedAt === 'number'

    return isValid ? (record as SessionRecord) : undefined
  } catch {
    return undefined
  }
}

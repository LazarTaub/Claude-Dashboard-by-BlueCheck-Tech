// Mission Control: every Claude Code session on this computer in one pane.
//
// Each session writes its own small JSON file to a shared folder
// (~/.claude/mission-control/sessions) when a turn starts, a tool runs, a
// turn ends, and every 30 seconds as a heartbeat. Every session reads the
// whole folder every few seconds to draw the pane and the status line.
//
// Stop works across sessions by message: the pane sends the target session
// a stop line carrying the secret token from that session's file, and the
// target's own copy of this mod takes the message and ends its turn.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { SessionRecord } from '../types'
import { MARK, MARK_WHITE, NAVY, ROYAL, SKY } from './brand'
import {
  HEARTBEAT_MS,
  KEEP_MS,
  LABEL,
  PR_EVERY_MS,
  SCAN_MS,
  STALE_MS,
  THREADS_QUERY,
  activityFor,
  ago,
  basename,
  clip,
  count,
  group,
  isKept,
  newToken,
  parseRecord,
  prFrom,
  prLine,
  projectName,
  repoFromPrUrl,
  resumeCommand,
  shownStatus,
  statusLine,
  stopText,
  stopToken,
  openThreadsFrom,
} from './core'
import type { Shown } from './core'

type Dollar = EngineInterface

const PANE = 'mission-control'
const ROWS_PER_PROJECT = 6

const sessions = atom({ plugin: 'mission-control', key: 'sessions' } as const, [])
const filter = atom({ plugin: 'mission-control', key: 'filter' } as const, '')
const self = atom({ plugin: 'mission-control', key: 'self' } as const, null)
const turn = atom({ plugin: 'mission-control', key: 'turnId' } as const, null)
const tick = atom({ plugin: 'mission-control', key: 'now' } as const, 0)

const COLOR: Record<Shown, string> = {
  waiting: 'warning',
  running: 'suggestion',
  idle: 'success',
  lost: 'error',
  ended: 'inactive',
}

const CI_COLOR = { pass: 'success', fail: 'error', pending: 'warning', none: 'inactive' } as const

// Module values start over on a reload; each is rebuilt from disk or state.
let folder = ''
let lastJson = ''
let lastStatus = ''
let lastPrAt = 0
let isPrBusy = false
let hasGh = true
/** The tool call a permission prompt is holding, until it starts running. */
let lastToolId: string | undefined
let awaitingId: string | undefined
const cache = new Map<string, { mtimeMs: number; record: SessionRecord }>()

async function folderOf($: Dollar): Promise<string> {
  if (folder) return folder

  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  const base = (config ?? `${home}/.claude`).replace(/[\\/]+$/, '')
  folder = `${base}/mission-control/sessions`

  return folder
}

async function fileFor($: Dollar, id: string): Promise<string> {
  return `${await folderOf($)}/${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`
}

/** Drops undefined fields, so state and the file hold plain JSON. */
function plain(record: SessionRecord): SessionRecord {
  return JSON.parse(JSON.stringify(record)) as SessionRecord
}

async function gitInfo($: Dollar, root: string): Promise<{ project: string; branch?: string }> {
  const git = (args: string[]) =>
    $.process.run(['git', ...args], { cwd: root, timeoutMs: 5_000 }).catch(() => undefined)
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const branch = await git(['branch', '--show-current'])
  const name = branch?.exitCode === 0 ? branch.stdout.trim() : ''

  return {
    project: projectName(root, common?.exitCode === 0 ? common.stdout : undefined),
    ...(name ? { branch: name } : {}),
  }
}

/** Writes this session's record to state and to its file. */
async function save($: Dollar, patch: Partial<SessionRecord>): Promise<void> {
  const now = await $.clock.now()
  const record = await update($, self, current => {
    if (current === null) return null
    const since = patch.status !== undefined && patch.status !== current.status ? now : current.since

    return plain({ ...current, ...patch, since, updatedAt: now })
  })
  if (record) await $.fs.write(await fileFor($, record.id), JSON.stringify(record))
}

/** Starts this session's record, or picks it up again after a reload. */
async function begin($: Dollar): Promise<void> {
  const id = await $.session.id()
  const now = await $.clock.now()
  const root = await $.session.root()
  const prior = await read($, self)
  const git = await gitInfo($, root)

  const record: SessionRecord =
    prior !== null && prior.id === id
      ? { ...prior, root, ...git, updatedAt: now }
      : { v: 1, id, token: newToken(), root, ...git, status: 'idle', startedAt: now, since: now, updatedAt: now }

  if (prior !== null && prior.id !== id && prior.status !== 'ended') {
    // A /clear starts a new session id in the same process: close the old one.
    const ended = plain({ ...prior, status: 'ended', since: now, updatedAt: now })
    await $.fs.write(await fileFor($, prior.id), JSON.stringify(ended))
  }

  const saved = await update($, self, () => plain(record))
  if (saved) await $.fs.write(await fileFor($, id), JSON.stringify(saved))
}

async function heartbeat($: Dollar): Promise<void> {
  const me = await read($, self)
  if (me === null || me.id !== (await $.session.id())) return begin($)

  return save($, {})
}

/** Reads every session file and redraws when something changed. */
async function scan($: Dollar): Promise<void> {
  const dir = await folderOf($)
  const entries = await $.fs.list(dir).catch(() => [])
  const now = await $.clock.now()
  const seen = new Set<string>()
  const records: SessionRecord[] = []

  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (now - entry.mtimeMs > KEEP_MS + STALE_MS) continue
    seen.add(entry.name)

    const cached = cache.get(entry.name)
    let record = cached?.record
    if (cached?.mtimeMs !== entry.mtimeMs) {
      const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => undefined)
      const parsed = text === undefined ? undefined : parseRecord(text)
      // A file caught mid-write fails to parse: keep the last good copy and read it again next time.
      if (parsed) {
        cache.set(entry.name, { mtimeMs: entry.mtimeMs, record: parsed })
        record = parsed
      }
    }
    // Tokens stay in the files. State is readable by other plugins, so it never holds them.
    if (record && isKept(record, now)) records.push({ ...record, token: '' })
  }
  for (const name of cache.keys()) if (!seen.has(name)) cache.delete(name)

  const me = await read($, self)
  const all = me ? [...records.filter(r => r.id !== me.id), { ...me, token: '' }] : records
  all.sort((a, b) => a.id.localeCompare(b.id))

  const json = JSON.stringify(all)
  if (json !== lastJson) {
    lastJson = json
    await update($, sessions, () => all)
  }
  await update($, tick, () => now)

  const line = statusLine(count(all, now))
  if (line !== lastStatus) {
    lastStatus = line
    $.ui.status(line)
  }
}

/** Looks up the branch's pull request with gh: CI, the Claude review score, open threads. */
async function refreshPr($: Dollar, isForced = false): Promise<void> {
  const now = await $.clock.now()
  if (isPrBusy || !hasGh || (!isForced && now - lastPrAt < PR_EVERY_MS)) return
  isPrBusy = true
  lastPrAt = now

  try {
    const me = await read($, self)
    if (me === null) return
    const git = await gitInfo($, me.root)
    const gh = (args: string[]) =>
      $.process.run(['gh', ...args], { cwd: me.root, timeoutMs: 20_000 }).catch(() => {
        hasGh = false

        return undefined
      })

    const view = await gh(['pr', 'view', '--json', 'number,url,state,isDraft,statusCheckRollup,comments'])
    let pr = view?.exitCode === 0 ? prFrom(view.stdout, now) : undefined
    const where = pr ? repoFromPrUrl(pr.url) : undefined
    if (pr && where) {
      const threads = await gh([
        'api', 'graphql',
        '-f', `query=${THREADS_QUERY}`,
        '-f', `owner=${where.owner}`,
        '-f', `repo=${where.repo}`,
        '-F', `number=${where.number}`,
      ])
      const open = threads?.exitCode === 0 ? openThreadsFrom(threads.stdout) : undefined
      if (open !== undefined) pr = { ...pr, openThreads: open }
    }

    await update($, self, current => (current === null ? null : plain({ ...current, pr: undefined })))
    await save($, { ...git, ...(pr ? { pr } : {}) })
  } finally {
    isPrBusy = false
  }
}

async function stop($: Dollar, id: string): Promise<void> {
  const me = await read($, self)

  if (me?.id === id) {
    const turnId = await read($, turn)
    if (turnId === null) return $.ui.toast('This session has no turn running.')
    await $.turn.abort({ turnId }).catch(() => undefined)

    return $.ui.toast('Stopped this session.')
  }

  const text = await $.fs.read(await fileFor($, id)).catch(() => undefined)
  const target = text === undefined ? undefined : parseRecord(text)
  if (target === undefined) return $.ui.toast('That session left no file to reach it by.')

  const sent = await $.session
    .send({ to: { sessionId: id }, text: stopText(target.token) })
    .catch((error: unknown) => ({ isDelivered: false as const, reason: String(error) }))

  $.ui.toast(
    sent.isDelivered
      ? `Asked ${target.project} (${target.branch ?? basename(target.root)}) to stop.`
      : `Could not reach that session: ${clip(sent.reason, 120)}`,
  )
}

async function resume($: Dollar, record: SessionRecord, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text: resumeCommand(record), surface })
  $.ui.toast(
    copied.isCopied
      ? `Copied. Paste it in a terminal to reopen ${record.project}.`
      : `Run: ${resumeCommand(record)}`,
  )
}

function stamp(now: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(now)
  } catch {
    return new Date(now).toISOString().slice(0, 16).replace('T', ' ')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mc',
      description: 'Mission Control: every Claude session on this computer',
      argumentHint: '[search]',
    })
    await begin($)
    $.clock.every(HEARTBEAT_MS, () => void heartbeat($))
    $.clock.every(SCAN_MS, () => void scan($))
    $.clock.every(PR_EVERY_MS, () => void refreshPr($))
    $.clock.after(1_000, () => void refreshPr($, true))
    await scan($)

    return next(e)
  })

  on('command.run', { command: 'mc' }, async ($, e) => {
    await update($, filter, () => e.args.trim())
    await scan($)
    const opened = await $.ui.open({ id: PANE, title: 'Mission Control', focus: true })

    return { text: opened.isPlaced ? 'Mission Control is open.' : `Mission Control did not open: ${opened.reason}` }
  })

  on('turn.start', async ($, e, next) => {
    await update($, turn, () => e.turnId)
    await save($, {
      status: 'running',
      activity: 'Thinking',
      turnStartedAt: await $.clock.now(),
      ...(e.text.trim() ? { prompt: clip(e.text, 140) } : {}),
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    await update($, turn, () => null)
    await save($, { status: 'idle', activity: undefined })
    $.clock.after(500, () => void refreshPr($, true))

    return next(e)
  })

  // The three observers below end in .catch(next): if one fails, the call or
  // message goes on as if the mod were absent, and nothing runs twice.
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Readonly<Record<string, unknown>>
    const activity = activityFor(String(e.tool), input)
    const isQuestion = String(e.tool) === 'AskUserQuestion'
    if (e.agentId === undefined) lastToolId = e.tool_use_id
    await save($, {
      activity: e.agentId === undefined ? activity : `agent · ${activity}`,
      ...(isQuestion ? { status: 'waiting' } : {}),
    }).catch(() => undefined)

    const ran = await next(e)

    // Back to running once a permission prompt or a question is answered.
    if ((await read($, self))?.status === 'waiting' && (await read($, turn)) !== null) {
      await save($, { status: 'running' }).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog') {
      awaitingId = lastToolId
      await save($, { status: 'waiting' })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    const token = stopToken(e.text)
    if (token === undefined) return next(e)

    // The token is the guard: the sender's plugin name is only a claim.
    const me = await read($, self)
    if (me === null || token !== me.token) return next(e)

    const turnId = await read($, turn)
    if (turnId !== null) await $.turn.abort({ turnId }).catch(() => undefined)
    $.ui.toast('Mission Control stopped this session.')

    return { consumed: 'stopped by Mission Control' }
  }).catch(($, e, next) => next(e))

  // A Bash command draws its "run in background" hint once it starts, which
  // is after its permission prompt was approved: back to running then, not
  // when the command ends. The terminal draws the hint; render hooks must
  // not write, so the save runs on a timer.
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => {
    if (awaitingId !== undefined && e.props.tool_use_id === awaitingId) {
      awaitingId = undefined
      $.clock.after(1, () => void save($, { status: 'running' }))
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await save($, { status: 'ended', activity: undefined }).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const all = await read($, sessions)
    const query = await read($, filter)
    const me = await read($, self)
    const now = (await read($, tick)) || (await $.clock.now())
    const width = Math.max(20, e.props.bodyColumns)
    const isTerminal = e.surface === 'terminal'
    const groups = group(all, query, now)
    const counts = count(all, now)
    const surface = e.surface

    // Never name a parameter h: JSX compiles to calls of the global h.
    const mark = (source: string, across: number, down: number) =>
      !isTerminal && 'Svg' in ui ? <ui.Svg source={source} alt="BlueCheck Technology" width={across} height={down} /> : null

    const header = (
      <Box flexDirection="column">
        <Box backgroundColor={NAVY} paddingX={1} flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" alignItems="center" gap={1}>
            {mark(MARK_WHITE, 20, 25) ?? (
              <Text color="#FFFFFF" backgroundColor={NAVY} bold>
                ✓
              </Text>
            )}
            <Box flexDirection={isTerminal ? 'row' : 'column'} gap={isTerminal ? 1 : 0}>
              <Text color="#FFFFFF" backgroundColor={NAVY} bold>
                BlueCheck
              </Text>
              <Text color={SKY} backgroundColor={NAVY}>
                TECHNOLOGY
              </Text>
            </Box>
          </Box>
          <Text color={SKY} backgroundColor={NAVY}>
            MISSION CONTROL
          </Text>
        </Box>
        <Text color={ROYAL}>{'━'.repeat(width)}</Text>
      </Box>
    )

    const summary = (['waiting', 'running', 'idle', 'lost'] as const).filter(shown => counts[shown] > 0)

    const search =
      'Input' in ui ? (
        <ui.Input
          key="search"
          label="Search"
          placeholder="project, branch, prompt or status"
          value={query}
          onInput={text => void update($, filter, () => text)}
          onSubmit={text => void update($, filter, () => text)}
        />
      ) : null

    const row = (record: SessionRecord) => {
      const shown = shownStatus(record, now)
      const isMe = record.id === me?.id
      const canStop = shown === 'running' || shown === 'waiting'
      const where = record.branch ?? basename(record.root)
      const detail =
        shown === 'running' || shown === 'waiting'
          ? (record.activity ?? record.prompt ?? '')
          : (record.prompt ?? record.activity ?? '')

      return (
        <Box key={`row-${record.id}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" flexShrink={1}>
              <Text color={COLOR[shown]}>● </Text>
              <Text bold color={COLOR[shown]}>
                {LABEL[shown]}
              </Text>
              <Text dimColor wrap="truncate-end">
                {` · ${where} · ${ago(now - record.since)}${isMe ? ' · this session' : ''}`}
              </Text>
            </Box>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {canStop && <Button key={`stop-${record.id}`} label="Stop" onPress={() => void stop($, record.id)} />}
              {!isMe && (
                <Button key={`resume-${record.id}`} label="Resume" onPress={() => void resume($, record, surface)} />
              )}
            </Box>
          </Box>
          {detail !== '' && (
            <Text dimColor wrap="truncate-end">
              {`   ${detail}`}
            </Text>
          )}
          {record.pr && (
            <Text color={CI_COLOR[record.pr.ci]} wrap="truncate-end">
              {`   ${prLine(record.pr)}`}
            </Text>
          )}
        </Box>
      )
    }

    const body =
      groups.length === 0 ? (
        <Text dimColor>{query ? `No session matches "${query}".` : 'No sessions yet.'}</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {groups.map(({ project, rows }) => {
            const shownRows = query ? rows : rows.slice(0, ROWS_PER_PROJECT)
            const hidden = rows.length - shownRows.length

            return (
              <Box key={`project-${project}`} flexDirection="column">
                <Box flexDirection="row">
                  <Text bold color={ROYAL}>
                    {project}
                  </Text>
                  <Text dimColor>{`  ${rows.length} session${rows.length === 1 ? '' : 's'}`}</Text>
                </Box>
                {shownRows.map(row)}
                {hidden > 0 && <Text dimColor>{`   ${hidden} more. Search to see them.`}</Text>}
              </Box>
            )
          })}
        </Box>
      )

    const footer = (
      <Box flexDirection="column">
        <Text dimColor>{'─'.repeat(width)}</Text>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1} alignItems="center">
            {mark(MARK, 18, 22)}
            <Text dimColor>Prepared by BlueCheck Technology</Text>
          </Box>
          <Text dimColor>{`${stamp(now)} · this computer`}</Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box flexDirection="row" flexWrap="wrap">
          {summary.length === 0 ? (
            <Text dimColor>No sessions running.</Text>
          ) : (
            summary.map((shown, index) => (
              <Text key={`count-${shown}`} color={COLOR[shown]}>
                {`${index === 0 ? '' : '  ·  '}${counts[shown]} ${LABEL[shown]}`}
              </Text>
            ))
          )}
        </Box>
        {search}
        {body}
        {footer}
      </Box>
    )
  })
}

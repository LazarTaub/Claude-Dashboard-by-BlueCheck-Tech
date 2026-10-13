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
import {
  COLUMNS,
  LINK_KEY,
  SWITCH_KEY,
  boardFor,
  cardDescription,
  columnAfterTurn,
  columnsOf,
  contextFor,
  idOf,
  isPersonsRequest,
  named,
  payload,
  serverNames,
  summaryPrompt,
  titleFrom,
  titlePrompt,
  turnComment,
} from './boards'
import type { CardLink, Column } from './boards'
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
  cleanPrompt,
  count,
  group,
  groupName,
  SCRATCH_GROUP,
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

// BlueCheck Boards. The calls live here: $ is only handed to functions in this file.
let card: CardLink | undefined
let boardServer: string | null | undefined
/** Why the last board update failed, for /mc-boards; shown once as a toast. */
let boardProblem: string | undefined
let hasToldProblem = false
let boardMissedAt = 0
let boardQueue: Promise<unknown> = Promise.resolve()

function currentCard(): CardLink | undefined {
  return card
}

/** Runs board work one call at a time, so a move never overtakes the card it moves. */
function enqueueBoard<T>(work: () => Promise<T>): Promise<T | undefined> {
  const run = boardQueue.then(work, work)
  boardQueue = run.catch(() => undefined)

  return run.catch(() => undefined)
}

async function isBoardsOn($: Dollar): Promise<boolean> {
  return (await $.store.get(SWITCH_KEY).catch(() => undefined)) !== 'off'
}

/**
 * The connector's name in this session, found once; null when it is not
 * connected. Connectors can still be connecting at the first prompt, so a
 * miss is asked again after a minute.
 */
async function serverOf($: Dollar): Promise<string | null> {
  const now = await $.clock.now()
  if (boardServer === null && now - boardMissedAt < 60_000) return null
  if (boardServer) return boardServer
  const names = serverNames(await $.tool.list().catch(() => []))
  for (const name of names) {
    const answer = await $.mcp.call(name, 'list_boards', {}).catch(() => undefined)
    if (answer && !answer.isError) return (boardServer = name)
  }
  boardMissedAt = now
  boardProblem = `No BlueCheck connector answered in this session. Tried: ${names.join(', ')}.`

  return (boardServer = null)
}

async function bluecheck($: Dollar, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const name = await serverOf($)
  if (name === null) throw new Error('the BlueCheck connector is not connected')

  return payload(await $.mcp.call(name, tool, args))
}

async function haiku($: Dollar, prompt: string, maxTokens: number): Promise<string | undefined> {
  const answer = await $.model.complete({ model: 'haiku', prompt, maxTokens }).catch(() => undefined)

  return answer?.isAnswered ? answer.text : undefined
}

/** The session's card: found again after a reload or resume, or made now, with its board and columns. */
async function ensureCard(
  $: Dollar,
  session: { id: string; project: string; branch?: string; prompt: string },
): Promise<CardLink | undefined> {
  if (card?.sessionId === session.id) return card

  const stored = (await $.store.get(LINK_KEY + session.id).catch(() => undefined)) as CardLink | undefined
  if (stored?.cardId) return (card = stored)

  const name = await serverOf($)
  if (name === null) return undefined

  const boards = named(await bluecheck($, 'list_boards', {}), 'boards')
  let board = boardFor(boards, session.project)
  if (!board) {
    const made = await bluecheck($, 'create_board', {
      title: session.project,
      description: `Claude Code work on ${session.project}. Mission Control keeps the cards up to date.`,
    })
    const id = idOf(made, 'board')
    if (!id) throw new Error('create_board answered with no id')
    board = { id, title: session.project }
  }

  const lists = columnsOf(named(await bluecheck($, 'get_board', { board_id: board.id }), 'lists'))
  for (const column of COLUMNS) {
    if (lists[column]) continue
    const id = idOf(await bluecheck($, 'create_list', { board_id: board.id, title: column }), 'list')
    if (!id) throw new Error('create_list answered with no id')
    lists[column] = id
  }

  const title = titleFrom(await haiku($, titlePrompt(session.prompt), 40), session.prompt)
  const made = await bluecheck($, 'create_card', {
    board_id: board.id,
    list_id: lists['In progress'],
    title,
    description: cardDescription(session.prompt, session.id, session.branch),
    labels: ['Claude Code:blue'],
  })
  const cardId = idOf(made, 'card')
  if (!cardId) throw new Error('create_card answered with no id')

  card = {
    sessionId: session.id,
    server: name,
    boardId: board.id,
    boardTitle: board.title,
    cardId,
    title,
    lists: lists as Record<Column, string>,
    column: 'In progress',
  }
  await $.store.set(LINK_KEY + session.id, card)

  return card
}

/** Moves the card to a column; a card in Done is marked done, and unmarked when it leaves. */
async function moveCard($: Dollar, column: Column): Promise<void> {
  if (!card || card.column === column || !(await isBoardsOn($))) return
  const from = card.column
  await bluecheck($, 'move_card', { card_id: card.cardId, list_id: card.lists[column], position: 'top' })
  if (column === 'Done' || from === 'Done') {
    await bluecheck($, 'update_card', { card_id: card.cardId, done: column === 'Done' })
  }
  card = { ...card, column }
  await $.store.set(LINK_KEY + card.sessionId, card)
}

/** Ends a turn on the board: a comment on what was done, then the card's next column. */
async function finishTurn(
  $: Dollar,
  turn: { answer: string; durationMs: number; isAborted: boolean; pr?: { url: string; state: string; ci: string } },
): Promise<void> {
  if (!card || !(await isBoardsOn($))) return
  const summary = turn.isAborted ? '' : ((await haiku($, summaryPrompt(turn.answer), 300)) ?? clip(turn.answer, 1500))
  await bluecheck($, 'comment_on_card', {
    card_id: card.cardId,
    text: turnComment({ ...turn, summary, ...(turn.pr ? { pr: turn.pr } : {}) }),
  })
  await moveCard($, columnAfterTurn({ isAborted: turn.isAborted, hasOpenPr: turn.pr?.state === 'OPEN' }))
}

/** Writes this session's record to state and to its file. */
async function save($: Dollar, patch: Partial<SessionRecord>): Promise<void> {
  const now = await $.clock.now()
  const before = (await read($, self))?.status
  const record = await update($, self, current => {
    if (current === null) return null
    const since = patch.status !== undefined && patch.status !== current.status ? now : current.since

    return plain({ ...current, ...patch, since, updatedAt: now })
  })
  if (record) await $.fs.write(await fileFor($, record.id), JSON.stringify(record))

  // The card follows the session: waiting on the person, or back at work.
  if (record && record.status !== before && currentCard()) {
    if (record.status === 'waiting') void enqueueBoard(() => moveCard($, 'Waiting on you'))
    if (record.status === 'running') void enqueueBoard(() => moveCard($, 'In progress'))
  }
}

/** Records why the board could not be updated, and says so once per session. */
function boardFailed($: Dollar, problem: string): void {
  boardProblem = problem
  if (hasToldProblem) return
  hasToldProblem = true
  $.ui.toast(`BlueCheck Boards could not update: ${clip(problem, 160)} Type /mc-boards for details.`)
}

/** Gives up waiting on the board after a while, so a slow connector never holds a prompt. */
async function within<T>($: Dollar, ms: number, work: Promise<T>): Promise<T | undefined> {
  let timer: { cancel: () => void } | undefined
  const late = new Promise<undefined>(done => {
    timer = $.clock.after(ms, () => done(undefined))
  })
  const result = await Promise.race([work, late])
  timer?.cancel()

  return result
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

function openPane($: Dollar) {
  return $.ui.open({ id: PANE, title: 'Mission Control', focus: true })
}

// The button above the prompt always opens the full list, like a bare /mc,
// and says why when the pane can't open.
async function openFromButton($: Dollar): Promise<void> {
  try {
    await update($, filter, () => '')
    const opened = await openPane($)
    if (!opened.isPlaced) $.ui.toast(`Mission Control did not open: ${opened.reason}`)
  } catch (error) {
    $.ui.toast(`Mission Control did not open: ${clip(String(error), 120)}`)
  }
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
    await $.command.register({
      name: 'mc-boards',
      description: 'BlueCheck Boards: show this session\'s card, or turn the board updates on or off',
      argumentHint: '[on|off]',
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
    const opened = await openPane($)

    return { text: opened.isPlaced ? 'Mission Control is open.' : `Mission Control did not open: ${opened.reason}` }
  })

  on('command.run', { command: 'mc-boards' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    if (word === 'on' || word === 'off') await $.store.set(SWITCH_KEY, word)
    const isOn = await isBoardsOn($)
    const linked = currentCard()
    const where = linked
      ? ` This session's card: "${linked.title}" on the board "${linked.boardTitle}", in ${linked.column}.`
      : ' This session has no card yet.'
    const via = boardServer ? ` Connector: ${boardServer}.` : ''
    const problem = boardProblem ? ` Last problem: ${boardProblem}` : ''

    return { text: `BlueCheck Boards is ${isOn ? 'on' : 'off'}.${where}${via}${problem}` }
  })

  // The first request makes the session's card; every request puts it back
  // in progress and tells the model where the card is.
  on('prompt.submit', async ($, e, next) => {
    // Opening the dashboard or asking about the card is not work for the board.
    const isOwnCommand = /^\/mc(-boards)?(\s|$)/.test(e.text.trim())
    if (!isPersonsRequest(e.origin) || !e.text.trim() || isOwnCommand || !(await isBoardsOn($))) return next(e)
    const me = await read($, self)
    if (me === null) return next(e)

    const linked = await within(
      $,
      10_000,
      enqueueBoard(async () => {
        try {
          const made = await ensureCard($, { id: me.id, project: me.project, branch: me.branch, prompt: e.text })
          if (made) boardProblem = undefined
          else boardFailed($, boardProblem ?? 'the BlueCheck connector is not connected.')

          return made
        } catch (error) {
          boardFailed($, error instanceof Error ? error.message : String(error))

          return undefined
        }
      }),
    )
    if (!linked) return next(e)
    void enqueueBoard(() => moveCard($, 'In progress'))

    return next({ ...e, context: [...(e.context ?? []), contextFor(linked)] })
  }).catch(($, e, next) => next(e))

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
    const ended = { answer: e.answer, durationMs: e.durationMs, isAborted: e.isAborted }
    // The PR is read first, so the card goes to Review when one is open.
    $.clock.after(500, () => {
      void refreshPr($, true).then(async () => {
        if (!currentCard()) return
        const pr = (await read($, self))?.pr
        await enqueueBoard(() => finishTurn($, { ...ended, ...(pr ? { pr } : {}) }))
      })
    })

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

  // The row above the prompt: the counts and a button that opens the pane,
  // so the dashboard is one click away without typing /mc. It steps aside
  // for a survey, and the person can fold it with the engine's [-].
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const all = await read($, sessions)
    const now = (await read($, tick)) || (await $.clock.now())
    const counts = count(all, now)
    const shown = (['waiting', 'running', 'idle', 'lost'] as const).filter(state => counts[state] > 0)
    const isNarrow = e.props.bodyColumns < 70
    const mark =
      e.surface !== 'terminal' && 'Svg' in ui ? (
        <ui.Svg source={MARK_WHITE} alt="BlueCheck Technology" width={14} height={17} />
      ) : (
        <Text color="#FFFFFF" backgroundColor={NAVY} bold>
          ✓
        </Text>
      )

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box backgroundColor={NAVY} paddingX={1} flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
          {mark}
          <Text color="#FFFFFF" backgroundColor={NAVY} bold>
            {isNarrow ? 'MC' : 'Mission Control'}
          </Text>
        </Box>
        <Box flexDirection="row" flexShrink={1}>
          {shown.length === 0 ? (
            <Text dimColor>no sessions</Text>
          ) : (
            shown.map((state, index) => (
              <Text key={`band-${state}`} color={COLOR[state]} wrap="truncate-end">
                {`${index === 0 ? '' : ' · '}${counts[state]} ${isNarrow ? state : LABEL[state]}`}
              </Text>
            ))
          )}
        </Box>
        <Button
          key="open"
          label={isNarrow ? 'Open' : 'Open Mission Control'}
          hotkey="m"
          variant="primary"
          onPress={() => void openFromButton($)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const all = await read($, sessions)
    const query = await read($, filter)
    const me = await read($, self)
    const now = (await read($, tick)) || (await $.clock.now())
    const width = Math.max(20, e.props.bodyColumns)
    // Each project sits in a framed card: a border and a column of padding a side.
    const inner = width - 4
    // Below this the buttons get lines of their own.
    const isNarrow = inner < 60
    // The credit line and the date need about 72 columns side by side.
    const isFooterStacked = width < 76
    const isTerminal = e.surface === 'terminal'
    // The status column fits the longest label, "● WAITING ON YOU", and a space.
    const LABEL_COLUMNS = Math.max(...Object.values(LABEL).map(label => label.length)) + 3
    const groups = group(all, query, now)
    const counts = count(all, now)
    const surface = e.surface

    // Never name a parameter h: JSX compiles to calls of the global h.
    const mark = (source: string, across: number, down: number) =>
      !isTerminal && 'Svg' in ui ? <ui.Svg source={source} alt="BlueCheck Technology" width={across} height={down} /> : null

    const header = (
      <Box
        backgroundColor={NAVY}
        paddingX={2}
        paddingY={isTerminal ? 0 : 1}
        flexDirection={width < 44 ? 'column' : 'row'}
        justifyContent="space-between"
        alignItems={width < 44 ? 'flex-start' : 'center'}
      >
        <Box flexDirection="row" alignItems="center" gap={1}>
          {mark(MARK_WHITE, 22, 27) ?? (
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
    )

    // A ledger of the four states: the figure in its color, the name in capitals.
    const ledger = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
        {(['waiting', 'running', 'idle', 'lost'] as const).map(shown => (
          <Box key={`count-${shown}`} flexDirection="row" gap={1}>
            <Text bold color={counts[shown] > 0 ? COLOR[shown] : 'inactive'}>
              {String(counts[shown])}
            </Text>
            <Text dimColor>{LABEL[shown].toUpperCase()}</Text>
          </Box>
        ))}
      </Box>
    )

    const title = (
      <Box flexDirection="column" gap={isTerminal ? 0 : 1}>
        <Box flexDirection={isFooterStacked ? 'column' : 'row'} justifyContent="space-between">
          <Text bold color={ROYAL}>
            Sessions on this computer
          </Text>
          <Text dimColor italic wrap="truncate-end">
            {stamp(now)}
          </Text>
        </Box>
        {ledger}
      </Box>
    )

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
      const isScratch = groupName(record.project) === SCRATCH_GROUP
      const where = isScratch ? '' : `${record.branch ?? basename(record.root)} · `
      const prompt = record.prompt ? cleanPrompt(record.prompt) : ''
      const detail =
        shown === 'running' || shown === 'waiting' ? (record.activity ?? prompt) : prompt || (record.activity ?? '')

      const buttons =
        canStop || !isMe ? (
          <Box flexDirection="row" gap={1} flexShrink={0} paddingLeft={isNarrow ? 2 : 0}>
            {canStop && <Button key={`stop-${record.id}`} label="Stop" onPress={() => void stop($, record.id)} />}
            {!isMe && (
              <Button key={`resume-${record.id}`} label="Resume" onPress={() => void resume($, record, surface)} />
            )}
          </Box>
        ) : null

      return (
        <Box key={`row-${record.id}`} flexDirection="column">
          <Box flexDirection="row" alignItems="center">
            {/* The label never wraps; the branch and age give way first. */}
            <Box flexShrink={0} width={LABEL_COLUMNS}>
              <Text bold color={COLOR[shown]}>
                {`● ${LABEL[shown].toUpperCase()}`}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} flexDirection="row">
              <Text dimColor wrap="truncate-end">
                {`${where}${ago(now - record.since)} ago`}
              </Text>
              {isMe && (
                <Text italic color={ROYAL}>
                  {'  this session'}
                </Text>
              )}
            </Box>
            {!isNarrow && buttons}
          </Box>
          {detail !== '' && (
            <Box paddingLeft={2}>
              <Text italic={shown === 'ended'} dimColor={shown === 'ended'} wrap="truncate-end">
                {detail}
              </Text>
            </Box>
          )}
          {record.pr && (
            <Box paddingLeft={2}>
              <Text color={CI_COLOR[record.pr.ci]} wrap="truncate-end">
                {prLine(record.pr)}
              </Text>
            </Box>
          )}
          {isNarrow && buttons}
        </Box>
      )
    }

    const body =
      groups.length === 0 ? (
        <Text dimColor italic>
          {query ? `No session matches "${query}".` : 'No sessions yet.'}
        </Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {groups.map(({ project, rows }) => {
            const shownRows = query ? rows : rows.slice(0, ROWS_PER_PROJECT)
            const hidden = rows.length - shownRows.length

            return (
              <Box
                key={`project-${project}`}
                flexDirection="column"
                borderStyle="single"
                borderColor="subtle"
                paddingX={1}
                gap={isTerminal ? 0 : 1}
              >
                <Box flexDirection="row" justifyContent="space-between">
                  <Text bold color={ROYAL} wrap="truncate-end">
                    {project}
                  </Text>
                  <Text dimColor>{`${rows.length} SESSION${rows.length === 1 ? '' : 'S'}`}</Text>
                </Box>
                {shownRows.map(row)}
                {hidden > 0 && (
                  <Text dimColor italic>
                    {`${hidden} more. Search to see them.`}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
      )

    const footer = (
      <Box
        flexDirection={isFooterStacked ? 'column' : 'row'}
        justifyContent="space-between"
        alignItems={isFooterStacked ? 'flex-start' : 'center'}
      >
        <Box flexDirection="row" gap={1} alignItems="center">
          {mark(MARK, 16, 20)}
          <Text dimColor wrap="truncate-end">
            Prepared by BlueCheck Technology
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          Mission Control · this computer
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box flexDirection="column" gap={1} paddingX={1}>
          {title}
          {search}
          {body}
          {footer}
        </Box>
      </Box>
    )
  })
}

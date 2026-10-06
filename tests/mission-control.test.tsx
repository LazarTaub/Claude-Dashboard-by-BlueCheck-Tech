import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SessionRecord } from '../types'

const HOME = '/home/lazar'
const DIR = `${HOME}/.claude/mission-control/sessions`
const START = 50_000_000
const PEER_TOKEN = 'peer0123456789abcdef0123'

/** A disk, a git that knows nothing, and a peer session's file already in the folder. */
function world(on: On, options: { openFails?: string } = {}) {
  const toasts: string[] = []
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const sent: { to: string; text: string }[] = []
  const opened: string[] = []
  const aborted: string[] = []
  const clock = mock.clock(on, { now: START })
  mock.env(on, { HOME })

  on('fs.write', ($, e) => {
    files.set(e.path, { text: e.text, mtimeMs: clock.now() })

    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const file = files.get(e.path)
    if (!file) throw new Error(`ENOENT ${e.path}`)

    return { value: file.text }
  })
  on('fs.list', ($, e) => ({
    value: [...files]
      .filter(([path]) => path.startsWith(`${e.path}/`))
      .map(([path, file]) => ({
        name: path.slice(e.path.length + 1),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      })),
  }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.id', () => ({ value: 'me-0001' }))
  on('session.root', () => ({ value: '/work/App' }))
  on('session.send', ($, e) => {
    sent.push({ to: e.to, text: e.text })

    return { isDelivered: true }
  })
  // The engine's own ends of the events the tests raise.
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.receive', ($, e) => ({ text: e.text }))
  on('command.register', () => ({ value: { isRegistered: true } }) as never)
  on('command.run', () => ({ text: '' }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    if (options.openFails) return { value: { isPlaced: false as const, reason: options.openFails } } as never

    return { value: { isPlaced: true as const } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(typeof e === 'string' ? e : JSON.stringify(e))

    return { value: undefined }
  })
  on('turn.abort', ($, e) => {
    aborted.push(e.turnId)

    return { value: undefined }
  })

  const peer: SessionRecord = {
    v: 1,
    id: 'peer-0002',
    token: PEER_TOKEN,
    root: '/work/Breev',
    project: 'Breev',
    branch: 'feature/invoices',
    status: 'running',
    activity: 'Bash: Run the tests',
    prompt: 'Add invoice export',
    startedAt: START - 600_000,
    since: START - 120_000,
    updatedAt: START - 5_000,
    pr: { number: 7, url: 'https://github.com/lazartaub/breev/pull/7', state: 'OPEN', isDraft: false, ci: 'fail', review: 3, openThreads: 2, checkedAt: START },
  }
  files.set(`${DIR}/peer-0002.json`, { text: JSON.stringify(peer), mtimeMs: START - 5_000 })

  const own = () => JSON.parse(files.get(`${DIR}/me-0001.json`)?.text ?? 'null') as SessionRecord | null

  return { files, sent, opened, aborted, clock, own, toasts }
}

const PANE = (bodyColumns: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    props: {
      title: 'Mission Control',
      isFocused: true,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

describe('mission control', () => {
  test('a session writes its own file and follows its turns', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    expect(w.own()).toMatchObject({ id: 'me-0001', project: 'App', status: 'idle' })
    expect(w.own()?.token.length).toBeGreaterThan(20)

    await $.turn.start({ text: 'Fix the login redirect', turnId: 't-1' })
    expect(w.own()).toMatchObject({ status: 'running', prompt: 'Fix the login redirect' })

    await $.turn.complete({ answer: 'Done', durationMs: 10, isAborted: false, turnId: 't-1', reason: 'answer' })
    expect(w.own()).toMatchObject({ status: 'idle' })
  })

  test('the pane shows the BlueCheck stationery and every project, on terminal and desktop', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE(100), surface })
      expect(await ui.find({ type: 'Text', text: 'BlueCheck' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'MISSION CONTROL' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Prepared by BlueCheck Technology' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Breev' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /#7 · CI fail · review 3\/5 · 2 open/ })).toBeDefined()
      expect(await ui.find({ key: 'stop-peer-0002' })).toBeDefined()
      if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a narrow pane keeps each status label whole and still offers Stop', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE(40), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '● running' })).toBeDefined()
    expect(await ui.find({ key: 'stop-peer-0002' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Prepared by BlueCheck Technology' })).toBeDefined()
  })

  test('the row above the prompt shows the counts and its button opens the dashboard', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'mission-control',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
      })
      expect(await ui.find({ type: 'Text', text: 'Mission Control' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
      await ui.press({ key: 'open' })
      await ui.unmount()
    }
    expect(w.opened).toEqual(['mission-control', 'mission-control'])
  })

  test('the button opens the full list, even after a /mc search', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'mc', args: 'breev', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
    const row = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
    await row.press({ key: 'open' })
    await row.unmount()
    const ui = await $.ui.mount({ ...PANE(100), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Breev' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^App$/ })).toBeDefined()
  })

  test('the button says why when the dashboard cannot open', async ($, on) => {
    const w = world(on, { openFails: 'no room for a dock' })
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    const row = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
    await row.press({ key: 'open' })
    expect(w.toasts.some(text => text.includes('no room for a dock'))).toBe(true)
  })

  test('Stop on another session sends it that session\'s token', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE(100), surface: 'terminal' })

    await ui.press({ key: 'stop-peer-0002' })
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]?.text).toContain(PEER_TOKEN)
  })

  test('a stop message with this session\'s token ends its turn; any other text passes', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'Long job', turnId: 't-9' })
    const token = w.own()?.token ?? ''

    const wrong = await $.session.receive({ origin: { kind: 'peer', plugin: 'mission-control' }, text: '[mission-control] stop 0000000000000000000000' })
    expect(wrong).not.toHaveProperty('consumed')
    expect(w.aborted).toEqual([])

    const right = await $.session.receive({ origin: { kind: 'peer' }, text: `[mission-control] stop ${token}` })
    expect(right).toHaveProperty('consumed')
    expect(w.aborted).toEqual(['t-9'])
  })

  test('/mc with words filters the pane', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'mc', args: 'breev', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
    const ui = await $.ui.mount({ ...PANE(100), surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Breev' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^App$/ })).toBeUndefined()
  })
})

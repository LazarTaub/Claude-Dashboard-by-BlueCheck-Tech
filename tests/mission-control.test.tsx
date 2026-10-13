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

/** A fake BlueCheck connector: one existing board, and a log of every call. */
function bluecheck(on: On, options: { isConnected?: boolean; server?: string; boards?: { id: string; title: string; lists: { id: string; title: string }[] }[] } = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  const store = new Map<string, unknown>()
  const boards = options.boards ?? [{ id: 'b-road', title: 'BlueCheck Roadmap', lists: [{ id: 'l-p1', title: 'Phase 1' }] }]
  const answer = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } })

  on('mcp.call', ($, e) => {
    if (options.isConnected === false || e.server !== (options.server ?? 'claude.ai BlueCheck')) {
      return { value: { content: [{ type: 'text', text: 'not connected' }], isError: true } }
    }
    calls.push({ tool: e.tool, args: e.args })
    const board = boards.find(b => b.id === e.args.board_id)
    switch (e.tool) {
      case 'list_boards':
        return answer({ boards: boards.map(b => ({ id: b.id, title: b.title })) })
      case 'create_board': {
        const made = { id: `b-${boards.length + 1}`, title: String(e.args.title), lists: [] }
        boards.push(made)

        return answer({ board: { id: made.id, title: made.title } })
      }
      case 'get_board':
        return answer({ board: { id: board?.id }, lists: board?.lists ?? [] })
      case 'create_list': {
        const list = { id: `l-${String(e.args.title)}`, title: String(e.args.title) }
        board?.lists.push(list)

        return answer({ list })
      }
      case 'create_card':
        return answer({ card: { id: 'c-1', title: e.args.title } })
      default:
        return answer({ ok: true })
    }
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Add invoice export', usage: {} } }) as never)
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text, ...(e.context ? { context: e.context } : {}) }))

  on('classic.Notification', () => ({}) as never)
  on('tool.list', () => ({
    value: options.server ? [{ name: `mcp__${options.server}__list_boards`, description: '', mcp: true }] : [],
  }))

  return { calls, boards, store, tools: () => calls.map(c => c.tool) }
}

const typed = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false }) as never

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
    expect(await ui.find({ type: 'Text', text: '● RUNNING' })).toBeDefined()
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

  test('the first request makes the board, its columns and the card, and tells the model where it is', async ($, on) => {
    world(on)
    const bc = bluecheck(on)
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })

    const sent = await $.prompt.submit(typed('Add an invoice export to the billing page'))

    expect(bc.calls.find(c => c.tool === 'create_board')?.args.title).toBe('App')
    expect(bc.boards.find(b => b.title === 'App')?.lists.map(l => l.title)).toEqual(['To do', 'In progress', 'Waiting on you', 'Review', 'Done'])
    const card = bc.calls.find(c => c.tool === 'create_card')
    expect(card?.args).toMatchObject({ title: 'Add invoice export', list_id: 'l-In progress' })
    expect(sent.context?.join('\n')).toContain('card_id c-1')

    // A second request reuses the card.
    await $.prompt.submit(typed('Also add a CSV option'))
    expect(bc.tools().filter(t => t === 'create_card')).toHaveLength(1)
  })

  test('an existing board named like the project is used, and only missing columns are added', async ($, on) => {
    world(on)
    const bc = bluecheck(on, { boards: [{ id: 'b-app', title: 'app', lists: [{ id: 'l-todo', title: 'To Do' }, { id: 'l-done', title: 'Done' }] }] })
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('Fix the login redirect'))

    expect(bc.tools()).not.toContain('create_board')
    expect(bc.calls.filter(c => c.tool === 'create_list').map(c => c.args.title)).toEqual(['In progress', 'Waiting on you', 'Review'])
  })

  test('the card waits on you at a permission prompt, then gets a summary and goes to Done', async ($, on) => {
    const w = world(on)
    const bc = bluecheck(on)
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('Add an invoice export'))
    await $.turn.start({ text: 'Add an invoice export', turnId: 't-1' })

    await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
    await w.clock.advance(10)
    expect(bc.calls.find(c => c.tool === 'move_card' && c.args.list_id === 'l-Waiting on you')).toBeDefined()

    await $.turn.complete({ answer: 'I added the export button and a test.', durationMs: 120_000, isAborted: false, turnId: 't-1', reason: 'answer' })
    await w.clock.advance(1_000)
    for (let i = 0; i < 20 && !bc.tools().includes('update_card'); i++) await w.clock.advance(10)

    const comment = bc.calls.find(c => c.tool === 'comment_on_card')
    expect(String(comment?.args.text)).toContain('2 min')
    expect(bc.calls.at(-2)).toMatchObject({ tool: 'move_card', args: { list_id: 'l-Done' } })
    expect(bc.calls.at(-1)).toMatchObject({ tool: 'update_card', args: { done: true } })
  })

  test('the connector is found by its tools, whatever it is called', async ($, on) => {
    world(on)
    const bc = bluecheck(on, { server: 'claude_ai_BlueCheck_Technology' })
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('Fix the login redirect'))

    expect(bc.tools()).toContain('create_card')
  })

  test('a failed update says so once, and /mc-boards says why', async ($, on) => {
    const w = world(on)
    bluecheck(on, { isConnected: false })
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('Fix the login redirect'))
    await $.prompt.submit(typed('And the logout'))

    expect(w.toasts.filter(t => t.includes('BlueCheck Boards could not update'))).toHaveLength(1)
    const told = await $.command.run({ command: 'mc-boards', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
    expect(told.text).toContain('Tried: claude.ai BlueCheck, BlueCheck')
  })

  test('typing /mc makes no card', async ($, on) => {
    world(on)
    const bc = bluecheck(on)
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('/mc breev'))
    expect(bc.tools()).not.toContain('create_card')
  })

  test('without the connector, or switched off, a request goes through untouched', async ($, on) => {
    world(on)
    const bc = bluecheck(on, { isConnected: false })
    await $.session.start({ cwd: '/work/App', surface: 'terminal', isInteractive: true })
    const sent = await $.prompt.submit(typed('Fix the login redirect'))
    expect(sent.context).toBeUndefined()
    expect(bc.calls).toHaveLength(0)

    await $.command.run({ command: 'mc-boards', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
    expect(bc.store.get('boards')).toBe('off')
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

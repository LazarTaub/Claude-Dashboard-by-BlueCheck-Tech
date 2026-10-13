import { describe, expect, test } from 'claude-code/testing'

import { columnAfterTurn, columnsOf, contextFor, idOf, payload, plainWords, titleFrom, turnComment } from '../hooks/boards'

describe('board answers', () => {
  test('an id is read from the answer however the tool wraps it', () => {
    expect(idOf({ card: { id: 'c-1', title: 'x' } }, 'card')).toBe('c-1')
    expect(idOf({ id: 'b-1' }, 'board')).toBe('b-1')
    expect(idOf({ result: { list: { id: 'l-1' } } }, 'list')).toBe('l-1')
    expect(idOf('no id here')).toBeUndefined()
  })

  test('a tool answer is its JSON, and a failed call throws', () => {
    expect(payload({ content: [{ type: 'text', text: '{"boards":[]}' }], isError: false })).toEqual({ boards: [] })
    expect(() => payload({ content: [{ type: 'text', text: 'no access' }], isError: true })).toThrow('no access')
  })

  test('work columns are found by name, whatever the case', () => {
    const found = columnsOf([
      { id: 'l-1', title: 'to do' },
      { id: 'l-2', title: 'Phase 1' },
      { id: 'l-3', title: 'DONE' },
    ])
    expect(found).toEqual({ 'To do': 'l-1', Done: 'l-3' })
  })
})

describe('board rules', () => {
  test('a finished turn goes to Review with an open PR, Done without, and back to you when stopped', () => {
    expect(columnAfterTurn({ isAborted: false, hasOpenPr: true })).toBe('Review')
    expect(columnAfterTurn({ isAborted: false, hasOpenPr: false })).toBe('Done')
    expect(columnAfterTurn({ isAborted: true, hasOpenPr: true })).toBe('Waiting on you')
  })

  test('text on the board never carries an em dash', () => {
    expect(plainWords('Fixed the login — and the logout')).toBe('Fixed the login, and the logout')
  })

  test('the title is the model\'s first line, or the request cut short', () => {
    expect(titleFrom('Add invoice export\nmore', 'x')).toBe('Add invoice export')
    expect(titleFrom(undefined, '<system-reminder>note</system-reminder> Fix the calendar sync')).toBe('Fix the calendar sync')
  })

  test('the turn comment names the time, the summary and the PR', () => {
    const text = turnComment({
      summary: '- Added the export',
      durationMs: 180_000,
      isAborted: false,
      pr: { url: 'https://github.com/o/r/pull/7', ci: 'pass' },
    })
    expect(text).toContain('3 min')
    expect(text).toContain('- Added the export')
    expect(text).toContain('Pull request: https://github.com/o/r/pull/7 (CI pass)')
  })

  test('the model is told its card and the To do list, and not to move the card itself', () => {
    const lists = { 'To do': 'l-todo', 'In progress': 'l-2', 'Waiting on you': 'l-3', Review: 'l-4', Done: 'l-5' }
    const text = contextFor({ sessionId: 's', server: 'BlueCheck', boardId: 'b-1', boardTitle: 'Breev', cardId: 'c-1', title: 'Export', lists, column: 'In progress' })
    expect(text).toContain('card_id c-1')
    expect(text).toContain('list_id l-todo')
    expect(text).toContain('do not do that yourself')
  })
})

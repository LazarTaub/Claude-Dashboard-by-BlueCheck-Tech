// BlueCheck Boards: each session's work is one card on its project's board.
// The card is made on the session's first request, moves between columns as
// the session's status changes, and gets a summary comment each time a turn
// ends. The board and any missing columns are made the first time.

import type { McpToolResult } from 'claude-code'

import { cleanPrompt, clip } from './core'

export const COLUMNS = ['To do', 'In progress', 'Waiting on you', 'Review', 'Done'] as const
export type Column = (typeof COLUMNS)[number]

export type CardLink = {
  sessionId: string
  server: string
  boardId: string
  boardTitle: string
  cardId: string
  title: string
  lists: Record<Column, string>
  column: Column
}

/** How the BlueCheck connector is named: from claude.ai, or added by hand. */
export const SERVERS = ['claude.ai BlueCheck', 'BlueCheck'] as const
export const SWITCH_KEY = 'boards'
export const LINK_KEY = 'card:'

/** A tool's answer as data: its structured result, or the JSON its text holds. */
export function payload(result: McpToolResult): unknown {
  const text = result.content.map(block => block.text ?? '').join('')
  if (result.isError) throw new Error(clip(text || 'the BlueCheck tool failed', 200))
  if (result.structuredContent !== undefined) return result.structuredContent
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** The id in an answer: `answer[kind].id`, `answer.id`, or the first id inside. */
export function idOf(value: unknown, kind?: 'board' | 'list' | 'card'): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (kind && record[kind] && typeof record[kind] === 'object') {
    const inner = idOf(record[kind])
    if (inner) return inner
  }
  if (typeof record.id === 'string') return record.id
  for (const child of Object.values(record)) {
    const found = typeof child === 'object' ? idOf(child) : undefined
    if (found) return found
  }

  return undefined
}

export type Named = { id: string; title: string }

/** The `key` array of an answer, keeping the items with an id and a title. */
export function named(value: unknown, key: string): Named[] {
  const list = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined

  return Array.isArray(list)
    ? list.filter((item): item is Named => typeof item?.id === 'string' && typeof item?.title === 'string')
    : []
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The board named like the project, if there is one. */
export function boardFor(boards: readonly Named[], project: string): Named | undefined {
  return boards.find(board => same(board.title, project))
}

/** The board's lists that are work columns, by column. */
export function columnsOf(lists: readonly Named[]): Partial<Record<Column, string>> {
  const found: Partial<Record<Column, string>> = {}
  for (const column of COLUMNS) {
    const list = lists.find(item => same(item.title, column))
    if (list) found[column] = list.id
  }

  return found
}

/** Where the card goes when a turn ends. */
export function columnAfterTurn(turn: { isAborted: boolean; hasOpenPr: boolean }): Column {
  if (turn.isAborted) return 'Waiting on you'

  return turn.hasOpenPr ? 'Review' : 'Done'
}

/** The user's own words, never an em dash: the person's house style. */
export function plainWords(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ', ').trim()
}

export function fallbackTitle(prompt: string): string {
  return clip(cleanPrompt(prompt), 80) || 'Claude Code session'
}

/** What the model reads beside each request, so it can use the board too. */
export function contextFor(link: CardLink): string {
  return [
    `BlueCheck Boards: this session's work is the card "${link.title}" (card_id ${link.cardId})`,
    `on the BlueCheck board "${link.boardTitle}" (board_id ${link.boardId}).`,
    'Mission Control moves this card between columns and comments a summary when each turn ends, so do not do that yourself.',
    'Use the BlueCheck tools to keep the boards useful:',
    `- for work with several steps, keep a checklist on this card;`,
    `- for follow-up work you find and do not do now, add a card to "To do" (list_id ${link.lists['To do']});`,
    '- when this work moves a card on another board forward (such as the BlueCheck Roadmap), comment on that card or update it.',
  ].join('\n')
}

export function titlePrompt(prompt: string): string {
  return (
    'Write a title for a task card, at most 8 words, plain words, no quotes and no full stop at the end. ' +
    `Answer with the title alone. The task:\n\n${clip(cleanPrompt(prompt), 2000)}`
  )
}

/** The model's title, one line, or the request itself cut short. */
export function titleFrom(answer: string | undefined, prompt: string): string {
  return clip(plainWords(answer ?? '').split('\n')[0] ?? '', 120) || fallbackTitle(prompt)
}

export function cardDescription(prompt: string, sessionId: string, branch?: string): string {
  return [
    plainWords(clip(cleanPrompt(prompt), 2000)),
    '',
    `Claude Code session \`${sessionId}\`${branch ? ` on branch \`${branch}\`` : ''}.`,
  ].join('\n')
}

export function summaryPrompt(answer: string): string {
  return (
    'Summarize this for a progress note on a task card: 1 to 4 short bullet points, each starting with "- ", ' +
    'past tense, plain words. Name anything left open or waiting on the person. Answer with the bullets alone.' +
    `\n\n${clip(answer, 6000)}`
  )
}

/** The comment a finished turn leaves on its card. */
export function turnComment(turn: {
  summary: string
  durationMs: number
  isAborted: boolean
  pr?: { url: string; ci: string }
}): string {
  const minutes = Math.max(1, Math.round(turn.durationMs / 60_000))
  const body = turn.isAborted ? 'Stopped before it finished.' : plainWords(turn.summary) || 'No summary.'
  const lines = [`**Turn finished** · ${minutes} min`, '', body]
  if (turn.pr) lines.push('', `Pull request: ${turn.pr.url} (CI ${turn.pr.ci})`)

  return lines.join('\n')
}

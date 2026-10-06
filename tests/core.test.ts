import { describe, expect, test } from 'claude-code/testing'

import type { SessionRecord } from '../types'
import {
  STALE_MS,
  activityFor,
  ciFrom,
  group,
  matches,
  openThreadsFrom,
  parseRecord,
  prFrom,
  prLine,
  projectName,
  reviewFrom,
  shownStatus,
  statusLine,
  count,
  stopText,
  stopToken,
} from '../hooks/core'

const NOW = 10_000_000

function record(over: Partial<SessionRecord>): SessionRecord {
  return {
    v: 1,
    id: 'a',
    token: 'tok',
    root: '/work/App',
    project: 'App',
    status: 'idle',
    startedAt: NOW - 60_000,
    since: NOW - 60_000,
    updatedAt: NOW - 1_000,
    ...over,
  }
}

describe('status', () => {
  test('a session that stops sending heartbeats shows as lost', () => {
    expect(shownStatus(record({ status: 'running', updatedAt: NOW - STALE_MS - 1 }), NOW)).toBe('lost')
    expect(shownStatus(record({ status: 'running' }), NOW)).toBe('running')
    expect(shownStatus(record({ status: 'ended', updatedAt: NOW - STALE_MS * 5 }), NOW)).toBe('ended')
  })

  test('the status line counts only live states, waiting first', () => {
    const all = [
      record({ id: '1', status: 'running' }),
      record({ id: '2', status: 'waiting' }),
      record({ id: '3', status: 'idle' }),
      record({ id: '4', status: 'idle' }),
      record({ id: '5', status: 'ended' }),
    ]
    expect(statusLine(count(all, NOW))).toBe('1 waiting · 1 running · 2 idle')
  })
})

describe('grouping and search', () => {
  test('projects with a session waiting on you come first', () => {
    const groups = group(
      [
        record({ id: '1', project: 'Breev', status: 'idle', updatedAt: NOW - 10 }),
        record({ id: '2', project: 'Liach', status: 'waiting', updatedAt: NOW - 5_000 }),
        record({ id: '3', project: 'Breev', status: 'running', updatedAt: NOW - 3_000 }),
      ],
      '',
      NOW,
    )
    expect(groups.map(g => g.project)).toEqual(['Liach', 'Breev'])
    expect(groups[1]?.rows.map(r => r.id)).toEqual(['3', '1'])
  })

  test('done sessions drop off after a day', () => {
    const groups = group([record({ status: 'ended', updatedAt: NOW - 25 * 3600_000 })], '', NOW)
    expect(groups).toEqual([])
  })

  test('search matches every word across project, branch, prompt and status', () => {
    const r = record({ project: 'Volkn', branch: 'fix/login', prompt: 'Fix the sign-in redirect', status: 'waiting' })
    expect(matches(r, 'volkn login', NOW)).toBe(true)
    expect(matches(r, 'waiting', NOW)).toBe(true)
    expect(matches(r, 'volkn checkout', NOW)).toBe(false)
  })
})

describe('git', () => {
  test('worktrees group under the main checkout', () => {
    expect(projectName('/work/App-wt/feature-x', '/work/App/.git\n')).toBe('App')
    expect(projectName('/work/App', '/work/App/.git')).toBe('App')
    expect(projectName('C:\\Users\\l\\Breev', 'C:/Users/l/Breev/.git')).toBe('Breev')
    expect(projectName('/srv/mirror', '/srv/mirror.git')).toBe('mirror')
    expect(projectName('/tmp/notes', undefined)).toBe('notes')
  })
})

describe('activity', () => {
  test('a tool call becomes one short line', () => {
    expect(activityFor('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('Bash: Run the tests')
    expect(activityFor('Edit', { file_path: '/work/App/src/page.tsx' })).toBe('Edit: page.tsx')
    expect(activityFor('TodoWrite', {})).toBe('TodoWrite')
  })
})

describe('stop messages', () => {
  test('the token is found inside whatever envelope the engine wraps around it', () => {
    const token = 'abcdef0123456789abcdef'
    expect(stopToken(stopText(token))).toBe(token)
    expect(stopToken(`<message from="peer">\n${stopText(token)}\n</message>`)).toBe(token)
    expect(stopToken('please stop')).toBe(undefined)
    expect(stopToken('[mission-control] stop short')).toBe(undefined)
  })
})

describe('pull requests', () => {
  // The summary comment .github/workflows/claude-review.yml posts.
  const REVIEW = [
    '<!-- claude-review sha=abc -->',
    '### Claude review',
    '',
    'Adds the terms page.',
    '',
    'Issues: None.',
    '',
    'Confidence: 4/5',
  ].join('\n')

  test('CI reads fail over pending over pass', () => {
    expect(ciFrom([{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('pass')
    expect(ciFrom([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }])).toBe('pending')
    expect(ciFrom([{ conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }])).toBe('fail')
    expect(ciFrom([])).toBe('none')
  })

  test('the review score comes from the newest Claude review comment', () => {
    const older = REVIEW.replace('4/5', '2/5')
    expect(reviewFrom([{ body: older }, { body: 'thanks' }, { body: REVIEW }])).toBe(4)
    expect(reviewFrom([{ body: 'Confidence: 5/5 in my opinion' }])).toBe(undefined)
  })

  test('gh pr view output becomes the PR column', () => {
    const json = JSON.stringify({
      number: 52,
      url: 'https://github.com/lazartaub/app/pull/52',
      state: 'OPEN',
      isDraft: false,
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      comments: [{ body: REVIEW }],
    })
    const pr = prFrom(json, NOW)
    expect(pr).toMatchObject({ number: 52, ci: 'pass', review: 4 })
    expect(prLine({ ...pr!, openThreads: 2 })).toBe('#52 · CI pass · review 4/5 · 2 open')
    expect(prFrom('no pull requests found', NOW)).toBe(undefined)
  })

  test('open threads count the unresolved ones', () => {
    const json = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] } } } },
    })
    expect(openThreadsFrom(json)).toBe(1)
  })
})

describe('session files', () => {
  test('a half-written or foreign file is skipped', () => {
    expect(parseRecord(JSON.stringify(record({})))).toMatchObject({ id: 'a' })
    expect(parseRecord('{"v":1,"id":"a"')).toBe(undefined)
    expect(parseRecord('{"hello":"world"}')).toBe(undefined)
  })
})

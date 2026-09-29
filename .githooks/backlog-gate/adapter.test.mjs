// node --test .githooks/backlog-gate/adapter.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalize } from './adapter.mjs'

const row = (comments, status = 'in_progress') => ({
  id: 'nocx-a',
  title: 'A',
  issue_type: 'task',
  status,
  created_at: '2026-09-26T10:00:00Z',
  updated_at: '2026-09-26T10:00:00Z',
  comments,
})

test('a work record comment is exported raw, with the tracker id, time and author', () => {
  // Damaged on purpose: the gate judges a record, so the adapter must not.
  const body = '[shady2k-time v1] claim\nitem: nocx-a\nspan: 1234abcd\n  trailing  \n'
  const [issue] = normalize([
    row([
      { id: 7, author: 'claude-worker', text: body, created_at: '2026-09-26T10:01:00Z' },
      { id: 8, author: 'dev', text: 'an ordinary note', created_at: '2026-09-26T10:02:00Z' },
    ]),
  ])
  assert.deepEqual(issue.comments, [
    { id: '7', at: '2026-09-26T10:01:00Z', author: 'claude-worker', body },
  ])
})

test('an issue with no work record carries an empty comment list', () => {
  const [issue] = normalize([row([{ id: 1, author: 'dev', text: 'note', created_at: 'x' }])])
  assert.deepEqual(issue.comments, [])
  const [bare] = normalize([row(undefined)])
  assert.deepEqual(bare.comments, [])
})

test('a native submitted status takes its record from the latest submitted comment', () => {
  const [issue] = normalize([
    row(
      [
        { id: 1, author: 'c', text: 'submitted: old111 -- go build', created_at: 't1' },
        { id: 2, author: 'c', text: 'implemented: nope -- not this kind', created_at: 't2' },
        { id: 3, author: 'c', text: 'submitted: abc123 -- go vet', created_at: 't3' },
      ],
      'submitted',
    ),
  ])
  assert.equal(issue.status, 'submitted')
  assert.deepEqual(issue.delivery, { revision: 'abc123', evidence: 'go vet' })
  assert.equal(issue.integration, undefined)
})

test('a native implemented status takes its record from the latest implemented comment', () => {
  const [issue] = normalize([
    row(
      [{ id: 1, author: 'c', text: 'implemented: def456 -- go test ./x', created_at: 't1' }],
      'implemented',
    ),
  ])
  assert.equal(issue.status, 'implemented')
  assert.deepEqual(issue.integration, { revision: 'def456', evidence: 'go test ./x' })
})

test('a native status with no usable record still reaches the gate, with an empty record', () => {
  // The gate's *-without-evidence check reports it; dropping the status would hide it.
  const [bare] = normalize([row([], 'implemented')])
  assert.equal(bare.status, 'implemented')
  assert.deepEqual(bare.integration, { revision: '', evidence: '' })
  const [half] = normalize([
    row([{ id: 1, author: 'c', text: 'submitted: abc123', created_at: 't1' }], 'submitted'),
  ])
  assert.deepEqual(half.delivery, { revision: '', evidence: '' })
})

test('in_progress is active whatever marker comments it carries', () => {
  // A reopen is a status change now; a leftover marker is history, not status.
  const [issue] = normalize([
    row([{ id: 1, author: 'c', text: 'implemented: abc123 -- go vet', created_at: 't1' }]),
  ])
  assert.equal(issue.status, 'active')
  assert.equal(issue.integration, undefined)
  assert.equal(issue.delivery, undefined)
})

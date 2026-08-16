// OSC 9 and OSC 777 notification parsing (nocx-c6ef). The parser runs inside
// a terminal parser callback on untrusted bytes, so these tests pin three
// things: the happy paths come back byte-for-byte (presentation data — no
// normalising, trimming or escaping), everything that is not a notification
// request is null, and nothing ever throws.
//
// No `// @vitest-environment` pragma here on purpose: the suite's default is
// node (vitest.config.ts), and that is itself one of the assertions — the
// module must import and run in a plain node environment, with no window,
// document or terminal. The renderer feeds this module `data` as xterm hands
// it over: everything AFTER the ident and its semicolon, so `ESC]9;hello BEL`
// arrives as the string "hello", not "9;hello".
import { describe, it, expect } from 'vitest'
import { parseOscNotification, type OscNotification } from './osc-notification'

const notify = (title: string, body: string): OscNotification => ({ title, body })

describe('OSC 9 — one field, the body is the whole payload verbatim', () => {
  it.each([
    ['hello', notify('', 'hello')],
    ['сборка завершена', notify('', 'сборка завершена')],
    ['🔔 build done', notify('', '🔔 build done')],
    ['make -j4; echo done', notify('', 'make -j4; echo done')],
    ['a;b;c', notify('', 'a;b;c')],
    ['  spaced  ', notify('', '  spaced  ')],
    [';a', notify('', ';a')],
    ['40', notify('', '40')],
    ['4x', notify('', '4x')],
    ['44;x', notify('', '44;x')],
  ])('%j is a notification with that exact body and an empty title', (data, expected) => {
    expect(parseOscNotification(9, data)).toEqual(expected)
  })

  it.each(['4', '4;', '4;1;50', '4;0', '4;3;100', '4;1', '4;hello'])(
    '%j is the ConEmu progress family (4 followed by a separator or end) — null',
    (data) => {
      expect(parseOscNotification(9, data)).toBeNull()
    },
  )

  it('the progress guard is on 4 FOLLOWED BY a separator, not on a leading 4', () => {
    // The pair that makes the boundary real: 40 and 4x are notifications,
    // 4;1;50 is progress. The first two would be caught by a naive
    // starts-with-4 rule.
    expect(parseOscNotification(9, '40')).toEqual(notify('', '40'))
    expect(parseOscNotification(9, '4x')).toEqual(notify('', '4x'))
  })
})

describe('OSC 9 — malformed and hostile payloads are null and never throw', () => {
  it.each(['', ' ', '\t\n ', ';', ';;', '; ;', ' ; '])(
    '%j has nothing to present — null',
    (data) => {
      expect(parseOscNotification(9, data)).toBeNull()
    },
  )

  it('a payload at 1 MiB is hostile input, not a notification — null', () => {
    expect(parseOscNotification(9, 'a'.repeat(1024 * 1024))).toBeNull()
  })

  it('a payload just under 1 MiB is still a notification — the cap is the guard, not the norm', () => {
    const body = 'a'.repeat(1024 * 1024 - 1)
    expect(parseOscNotification(9, body)).toEqual(notify('', body))
  })

  it.each(['\uD800', '\uDC00', 'a\uD800b', 'hello\uD800', '\uDC00hello'])(
    'invalid UTF-16 (%j) is null',
    (data) => {
      expect(parseOscNotification(9, data)).toBeNull()
    },
  )
})

describe('OSC 777 — notify subtype, split on the first two semicolons only', () => {
  it.each([
    ['notify;title;body', notify('title', 'body')],
    ['notify;title;make -j4; echo done', notify('title', 'make -j4; echo done')],
    ['notify;title;body;extra', notify('title', 'body;extra')],
    ['notify;title;body;', notify('title', 'body;')],
    ['notify;сборка;завершена 🔔', notify('сборка', 'завершена 🔔')],
    ['notify; title ; body ', notify(' title ', ' body ')],
  ])('%j carries title and body separated at the first two semicolons', (data, expected) => {
    expect(parseOscNotification(777, data)).toEqual(expected)
  })

  it.each([
    ['notify;title', notify('title', '')],
    ['notify;title;', notify('title', '')],
  ])('a missing body (%j) is an empty body, not null', (data, expected) => {
    expect(parseOscNotification(777, data)).toEqual(expected)
  })
})

describe('OSC 777 — missing title, wrong subtype, and hostile payloads are null', () => {
  it.each(['notify', 'notify;', 'notify;;body'])('%j has no title to present — null', (data) => {
    expect(parseOscNotification(777, data)).toBeNull()
  })

  it.each(['precmd;x', 'notifyx;title;body', '7;notify;title;body'])(
    'a subtype other than exactly "notify" (%j) is not ours — null',
    (data) => {
      expect(parseOscNotification(777, data)).toBeNull()
    },
  )

  it.each(['', ' ', ';', ';;', '\uD800'])('%j is malformed — null', (data) => {
    expect(parseOscNotification(777, data)).toBeNull()
  })

  it('a 1 MiB payload is hostile input — null', () => {
    expect(parseOscNotification(777, 'x'.repeat(1024 * 1024))).toBeNull()
  })

  it('an unpaired surrogate inside an otherwise well-formed 777 payload is null', () => {
    expect(parseOscNotification(777, 'notify;title;\uD800')).toBeNull()
  })
})

describe('a pure function of its input', () => {
  it('returns an equal, fresh result on every call for the same input', () => {
    const first = parseOscNotification(777, 'notify;t;make -j4; echo done')
    const second = parseOscNotification(777, 'notify;t;make -j4; echo done')
    expect(second).toEqual(first)
    expect(second).not.toBe(first) // no shared mutable object
  })

  it('holds no state between calls — an intervening parse changes nothing', () => {
    expect(parseOscNotification(9, '4;1;50')).toBeNull()
    expect(parseOscNotification(9, 'hello')).toEqual(notify('', 'hello'))
    expect(parseOscNotification(777, 'notify;t;b')).toEqual(notify('t', 'b'))
    // The same inputs again, after the above — same outputs.
    expect(parseOscNotification(9, '4;1;50')).toBeNull()
    expect(parseOscNotification(9, 'hello')).toEqual(notify('', 'hello'))
  })

  it('never throws on arbitrary input — null or a well-formed notification, nothing else', () => {
    // The totality contract: this sits on the wire, so every input a program
    // can emit must resolve without an exception. Some of these are valid
    // notification bodies by design ("zzz" on ident 9); the invariant is the
    // shape of the answer, not the answer.
    const corpus = [
      '',
      ';',
      ';;;',
      '4',
      '4;',
      '40',
      '4x',
      'zzz',
      'a b c',
      'a;b;c;d;e',
      'notify',
      'notify;',
      'notify;title',
      'notify;title;',
      'notify;title;body',
      'precmd',
      '0',
      '9;',
      '777',
      '9;777;notify;title;body',
      '🔔',
      'сборка',
      '\uD83D\uDE00',
      'x'.repeat(4096),
    ]
    for (const data of corpus) {
      for (const ident of [9, 777] as const) {
        const out = parseOscNotification(ident, data)
        if (out !== null) {
          expect(typeof out.title).toBe('string')
          expect(typeof out.body).toBe('string')
        }
      }
    }
  })
})

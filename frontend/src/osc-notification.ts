// OSC 9 and OSC 777 notification requests (nocx-c6ef). One parser for the two
// sequences a program can use to raise a desktop notification, kept out of the
// renderer because the renderer is just the wire — the same rule xterm.ts
// states for the OSCs it already handles (7, 52, 133, 636, 1337): parse and
// policy live in their own module.
//
// OSC 9 is overloaded, and that is the trap this module exists to disarm:
// ESC]9;<text> is a notification request (iTerm2, Windows Terminal), but
// ESC]9;4;<state>;<pct> is the ConEmu progress protocol, which shells and
// progress bars emit continuously — data there looks like "4;1;50" (state 1,
// 50 percent). A naive handler turns every progress tick into a notification
// and any `npm install` becomes a notification storm. So "4" followed by a
// semicolon or by end-of-string is progress and yields null; everything else
// on ident 9 is a notification whose body is the whole payload verbatim and
// whose title is the empty string — OSC 9 carries one field, and inventing a
// title from the body would be choosing content the terminal did not send.
//
// The overload makes a genuine notification whose text starts with "4;"
// unreachable. That is inherent in the protocol, not a defect here; a program
// that wants to say "4;..." must use OSC 777, which is exactly what this
// comment is for — the next person needs to know it was considered.
//
// OSC 777: ESC]777;notify;<title>;<body> — the subtype must be exactly
// "notify", the split is on the FIRST TWO semicolons only (a body legitimately
// contains semicolons: "make -j4; echo done"), a missing body is an empty
// body, and a missing title is nothing to present.
//
// This runs inside a terminal parser callback on untrusted bytes from
// whatever the user ran, so null is never an exception: a throw here would
// take the renderer down. The parser is a pure function of its input — no
// state between calls, no window, no document, no terminal.

export interface OscNotification {
  title: string
  body: string
}

/** The longest payload this parser accepts. A payload at or beyond 1 MiB is
 *  hostile input, not a notification — nothing a real program legitimately
 *  sends — and handing a megabyte to the toast sink would be the notification
 *  storm this module exists to prevent. */
const MAX_PAYLOAD_LENGTH = 1024 * 1024

/** True when the string contains an unpaired surrogate — invalid UTF-16 that
 *  renders as nothing but replacement glyphs. Valid astral characters (emoji)
 *  are surrogate PAIRS and pass. */
function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return true
      const next = s.charCodeAt(i + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      i++ // skip the matched pair
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true // a low surrogate with no preceding high surrogate
    }
  }
  return false
}

/** True when the payload has nothing to present: empty, whitespace-only, or
 *  made solely of the protocol's `;` separator. A stray ESC]9; or a payload
 *  of a single space must not raise a blank toast. Shared by both idents so
 *  the refusal policy cannot drift between them. */
function hasNoContent(data: string): boolean {
  return data.replaceAll(';', '').trim().length === 0
}

/** OSC 9: `ESC]9;<text>`. One field — the body is the whole payload verbatim,
 *  the title is always empty. */
function parseOsc9(data: string): OscNotification | null {
  if (hasNoContent(data)) return null
  // The ConEmu progress family: "4" at end-of-string, or "4;..." with state
  // and percent after. Anything else starting with 4 ("40", "4x") is a
  // genuine notification: the guard is on 4 followed by a separator, not on
  // a leading 4. A literal notification reading "4;..." is unreachable by
  // design — see the header.
  if (data[0] === '4' && (data.length === 1 || data[1] === ';')) return null
  if (data.length >= MAX_PAYLOAD_LENGTH) return null
  if (hasUnpairedSurrogate(data)) return null
  return { title: '', body: data }
}

/** OSC 777: `ESC]777;notify;<title>;<body>`. */
function parseOsc777(data: string): OscNotification | null {
  if (hasNoContent(data)) return null
  if (data.length >= MAX_PAYLOAD_LENGTH) return null
  if (hasUnpairedSurrogate(data)) return null
  const first = data.indexOf(';')
  const subtype = first === -1 ? data : data.slice(0, first)
  if (subtype !== 'notify') return null
  // `notify` alone has no title — nothing to present.
  if (first === -1) return null
  const second = data.indexOf(';', first + 1)
  const title = data.slice(first + 1, second === -1 ? data.length : second)
  // An empty title presents nothing (the missing-body asymmetry: an empty
  // BODY is a valid notification, an empty TITLE is not).
  if (title.length === 0) return null
  const body = second === -1 ? '' : data.slice(second + 1)
  return { title, body }
}

/** The one public way in: the renderer calls this once per ident, so a second
 *  entry point would invite a second policy. Returns null for anything that
 *  is not a notification request — never throws. */
export function parseOscNotification(ident: 9 | 777, data: string): OscNotification | null {
  switch (ident) {
    case 9:
      return parseOsc9(data)
    case 777:
      return parseOsc777(data)
    default:
      // Unreachable by type; defended anyway because this sits on the wire.
      return null
  }
}

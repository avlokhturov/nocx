// uuid7 — the renderer's minter for every durable layout id (nocx-isoph.4,
// design .internal/specs/2026-08-16-tabs-panes-and-blocks-design.md §7).
//
// WHY THIS FILE EXISTS AT ALL. §7's table says a workspace, a tab and a pane
// id are minted by the frontend as UUIDv7, and the wire validates that
// strictly — the version nibble AND the RFC 4122 variant — because a schema
// that says v7 while accepting a v4 advertises what it does not deliver. The
// platform's crypto.randomUUID() produces a v4. So every id the renderer had
// been minting was refused by the methods it now has to call, and this is the
// first line of code the epic needed.
//
// THE TIMESTAMP IS NOT DECORATION. It is the first 48 bits, big-endian
// milliseconds, and it is what makes an id SORTABLE — ids minted in order
// compare in order as plain strings, which is why §7 chose v7 over v4 for the
// three objects that end up as primary keys in an index.
//
// AND IT IS EVIDENCE OF NOTHING (§7, third consequence). A UUIDv7 embeds a
// timestamp and is guessable by construction, so knowing an id confers no
// right to use it. Nothing here or on the other side of the wire may read a
// decision out of the time inside one — the backend deliberately does not
// parse it.

/** The last millisecond a mint was stamped with, and the counter inside it. */
let lastMillis = -1
let counter = 0

/** rand_a is 12 bits: the sub-millisecond counter's whole range. */
const COUNTER_BITS = 12
const COUNTER_MAX = (1 << COUNTER_BITS) - 1
/** Where a fresh millisecond's counter starts, so that a burst inside one
 *  millisecond has room to increase without overflowing into the next. The
 *  seed is random rather than 0 so two renderers minting in the same
 *  millisecond do not produce the same sequence. */
const COUNTER_SEED_MAX = 1 << 8

/**
 * Mint one UUIDv7 as the canonical lower-case 8-4-4-4-12 string.
 *
 * Monotonic within a millisecond: ids minted in the same tick carry an
 * increasing counter in `rand_a`, so `a < b` as strings whenever a was minted
 * before b. Without that, two panes created in one frame — which is exactly
 * what "open a tab" plus "the tab's first pane" is — would sort arbitrarily,
 * and the sortability is the whole reason for the version.
 */
export function uuidv7(now: () => number = Date.now): string {
  const millis = now()
  if (millis === lastMillis) {
    // 4096 ids in one millisecond is not a rate this application can reach;
    // if it ever did, borrowing the next millisecond keeps the order intact
    // rather than wrapping the counter and producing a smaller id than the
    // one before it.
    if (counter >= COUNTER_MAX) {
      lastMillis = millis + 1
      counter = randomInt(COUNTER_SEED_MAX)
    } else {
      counter += 1
    }
  } else if (millis > lastMillis) {
    lastMillis = millis
    counter = randomInt(COUNTER_SEED_MAX)
  } else {
    // The clock went backwards (an NTP step, a suspended laptop). Keep
    // minting from the last stamp rather than emitting an id that sorts
    // before ones already stored: an id is a key, and a key that moves
    // backwards breaks the ordering the version exists for.
    counter = counter >= COUNTER_MAX ? 0 : counter + 1
  }

  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  // 48 bits of big-endian milliseconds. Split rather than shifted: a
  // bitwise << on a 48-bit value in JavaScript truncates to 32 bits, which is
  // a defect that would only show as ids that stop sorting in 2038.
  const stamp = lastMillis
  bytes[0] = Math.floor(stamp / 2 ** 40) & 0xff
  bytes[1] = Math.floor(stamp / 2 ** 32) & 0xff
  bytes[2] = Math.floor(stamp / 2 ** 24) & 0xff
  bytes[3] = Math.floor(stamp / 2 ** 16) & 0xff
  bytes[4] = Math.floor(stamp / 2 ** 8) & 0xff
  bytes[5] = stamp & 0xff

  // Version 7 in the high nibble of byte 6, the counter in the 12 bits below.
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f)
  bytes[7] = counter & 0xff
  // RFC 4122 variant: the top two bits of byte 8 are 10.
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return format(bytes)
}

/**
 * Whether a string is a canonical UUIDv7 — the SAME question the wire asks
 * (internal/transport/ws_layout_handlers.go validLayoutID), and it is here so
 * a test can assert the two agree rather than trusting that they do.
 *
 * The renderer does not call this on its own ids in production: it mints them
 * and the backend checks them. Validating what we just minted would be the
 * renderer marking its own homework.
 */
export function isUuidv7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** The 48-bit millisecond stamp inside an id — for tests and for nothing
 *  else. It is not evidence: see the file header. */
export function timestampOf(id: string): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
}

function randomInt(bound: number): number {
  const buf = new Uint16Array(1)
  crypto.getRandomValues(buf)
  return buf[0] % bound
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

function format(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < 16; i++) {
    out += HEX[b[i]]
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-'
  }
  return out
}

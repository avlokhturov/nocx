/**
 * Logging seam — the single owner of the Wails logging FFI.
 *
 * ADR-0011 design intent:
 * The `fields` parameter is where structured data lives, and once the
 * Secret type lands (bead nocx-l7o, PR11-T7) the fields type must reject
 * it — secrets must never reach the serialised log string. That check is
 * NOT implemented here yet; this seam is shaped so it can be added.
 */

import { Log } from '../wailsjs/go/main/WailsApp'

/** The Wails runtime augments `window` with a `go` bridge object. */
interface WailsWindow extends Window {
  go?: { main?: { WailsApp?: { Log?: (message: string) => Promise<void> } } }
}

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

/** Structured fields for a log entry — must reject Secret when that type lands. */
type LogFields = Record<string, unknown>

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  const parts = [msg]
  if (fields && Object.keys(fields).length > 0) {
    try {
      parts.push(JSON.stringify(fields))
    } catch {
      parts.push('[unserializable fields]')
    }
  }
  const full = parts.join(' ')

  if (
    typeof window !== 'undefined' &&
    typeof (window as WailsWindow).go?.main?.WailsApp?.Log === 'function'
  ) {
    // Swallow the FFI rejection — callers never see a floating promise.
    Log(full).catch(() => {
      /* swallowed */
    })
  } else {
    const fn =
      level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : level === 'debug'
            ? console.debug
            : console.log
    fn(full)
  }
}

export const log = {
  info(msg: string, fields?: LogFields): void {
    write('info', msg, fields)
  },
  warn(msg: string, fields?: LogFields): void {
    write('warn', msg, fields)
  },
  error(msg: string, fields?: LogFields): void {
    write('error', msg, fields)
  },
  debug(msg: string, fields?: LogFields): void {
    write('debug', msg, fields)
  },
}

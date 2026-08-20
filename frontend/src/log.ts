/**
 * Logging seam — the single owner of the Wails logging FFI.
 *
 * ADR-0011 design intent:
 * The `fields` parameter is where structured data lives, and once the
 * Secret type lands (bead nocx-l7o, PR11-T7) the fields type must reject
 * it — secrets must never reach the serialised log string. That check is
 * NOT implemented here yet; this seam is shaped so it can be added.
 */

import { Log } from '../bindings/github.com/shady2k/nocx/wailsapp'
import { bindingReachable } from './wails-runtime'

/** The generated bindings are named, so this is the key both the browser
 *  shim and the reachability probe split. */
const LOG_BINDING = 'main.WailsApp.Log'

/** Devtools flip for decision tracing: `window.nocxDebug = true`. Read
 *  live so it takes effect without a reload. */
interface WailsWindow extends Window {
  nocxDebug?: unknown
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

  // Which side takes the line is decided synchronously, before any call.
  // v2 probed window.go for the Log method; v3 asks the same question of
  // the runtime it actually has (shim bridge, or the webview's invoke
  // bridge). Deciding it by catching the call's rejection instead would
  // put every browser log line a microtask after the event that caused it
  // — invisible to a synchronous reader, and to a test.
  if (!bindingReachable(LOG_BINDING)) {
    consoleFor(level)(full)
    return
  }

  // Backend path. A rejection here is the soft degrade — the line still
  // reaches the console rather than vanishing — and callers never see a
  // floating promise.
  Log(full).catch(() => {
    consoleFor(level)(full)
  })
}

/** The console sink for a level. */
function consoleFor(level: LogLevel): (msg: string) => void {
  switch (level) {
    case 'error':
      return console.error
    case 'warn':
      return console.warn
    case 'debug':
      return console.debug
    default:
      return console.log
  }
}

/**
 * Decision tracing (the `nocx:decide` stream) is OFF by default. The
 * arbiter-grant and ghost-refusal logs are per-keystroke when enabled, so
 * nothing is emitted — and no fields are built — until a person opts in.
 * Flip it from the devtools console with `window.nocxDebug = true`; the
 * flag is read live, so it takes effect on the next keystroke.
 */
let decisionTracingEnabled = false

/** Programmatic switch (tests, a future settings surface). */
export function setDecisionTracing(enabled: boolean): void {
  decisionTracingEnabled = enabled
}

/** Whether decision tracing is on: the programmatic flag OR the devtools
 *  `window.nocxDebug` flag. Cheap enough to call on the hot path — it is
 *  the gate that keeps per-keystroke tracing off when nobody asked for it. */
export function isDecisionTracing(): boolean {
  if (decisionTracingEnabled) return true
  if (typeof window !== 'undefined' && (window as WailsWindow).nocxDebug === true) return true
  return false
}

/** The stable prefix every decision trace carries — filter the devtools
 *  console on exactly this string to see the whole decision stream. */
export const DECISION_PREFIX = 'nocx:decide'

/** Emit one decision trace through the existing seam (Wails FFI, or the
 *  console when no runtime). No-op without even building the message while
 *  decision tracing is off — the hot-path guarantee. */
export function logDecision(msg: string, fields?: LogFields): void {
  if (!isDecisionTracing()) return
  write('debug', `${DECISION_PREFIX} ${msg}`, fields)
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

// The assembled-session seam for the stream-adversary harness. One interface,
// two implementations in spirit: `assembleTodaySession` wires the modules that
// exist today (the input-state machine, the command ledger, the passport
// tracker), and the ADR-0024 renderer work replaces its internals with the
// lifecycle reducer + published-fact projections without touching the
// projection contract below. That is what makes the corpus reusable: the
// snapshot shape is the contract the later bead tests against.
//
// Deliberately NOT authority: today's projections are the live vulnerability
// (a hostile cycle drives keyboardRoute to 'editor'). The harness only records
// them; the judgment lives in conformance.test.ts / authority-expectations.ts.
import { CommandLedger } from '../../command-ledger'
import { InputStateController } from '../../input-state'
import { EnvironmentPassportTracker } from '../../environment-passport'
import { parseOsc133, parseOsc7 } from '../../renderers/xterm'
import type { CorpusFrame } from './corpus'

/** The nine security-sensitive projections, captured before and after each
 *  case. Plain data — deep-cloned by the harness, never shared by reference. */
export interface SessionProjection {
  /** Lifecycle axis. Today: the InputState enum. Under ADR-0024 §6: the
   *  two-axis LifecycleState (Native | PromptReady(domain) | Running(attempt)
   *  | Desynchronized(domain) | Lost). */
  lifecycle: string
  /** Who owns keyboard input: 'editor' or 'raw'. */
  keyboardRoute: 'editor' | 'raw'
  /** The accepted domain/environment id, if any. */
  activeDomain: string | null
  /** Serialized attempt state from the ledger (status + exit code). */
  attemptState: string
  /** Running/frozen block counts (scrollback projection). */
  blockState: string
  /** History records persisted (history.record calls) during the case. */
  historyCalls: number
  /** Environment-stack dispositions observed (passport tracker). */
  environmentStack: string
  /** Integration-sensitive ssh rewriting enabled? Pre-ADR: always false. */
  rewriteAuthority: boolean
  /** Re-run authorized? Pre-ADR: always false. */
  rerunAuthority: boolean
  /** OSC 7 cwd (render-only location metadata). */
  cwd: string | null
}

/** The seam the harness replays against. One instance per corpus case. */
export interface SessionAssembly {
  /** Observable delivery log — every dispatched frame appends here, so the
   *  conformance test can prove a case reached the session and was not
   *  silently dropped. */
  readonly events: string[]
  dispatch(frame: CorpusFrame): void
  snapshot(): SessionProjection
}

const INBAND_READY = '1337;NOCX_IB_READY'

/**
 * Wires today's real modules the way terminal-content does, minus the DOM:
 * OSC 133 markers feed both the ledger and the input-state machine, OSC 636
 * passports feed the tracker, OSC 7 updates cwd, and the alt-buffer CSI
 * sequence drives the buffer axis. 'app' frames model the editor submit that
 * synchronously creates the attempt before any bytes are written (ADR-0024 §5)
 * and the app-minted environment id.
 *
 * All state is real module state — no mocks, no hand-rolled reducer. The only
 * fake is the history sink behind the ledger's onComplete, which counts the
 * persistence calls the real system would make.
 */
export function assembleTodaySession(): SessionAssembly {
  const input = new InputStateController()
  const passport = new EnvironmentPassportTracker()
  const events: string[] = []

  let frozenBlocks = 0
  let historyCalls = 0
  let acceptedDomain: string | null = null
  const passportDispositions: string[] = []
  let cwd: string | null = null

  passport.subscribe((d) => {
    passportDispositions.push(d.status)
    if (d.status === 'accepted') {
      acceptedDomain = d.passport.environmentId
    }
  })

  const ledger = new CommandLedger({
    now: () => 1000,
    onComplete: () => {
      frozenBlocks += 1
      historyCalls += 1
    },
  })

  function dispatch(frame: CorpusFrame): void {
    switch (frame.channel) {
      case 'app': {
        if (frame.payload.startsWith('submit:')) {
          const command = frame.payload.slice('submit:'.length)
          ledger.open(command, '/tmp', '', () => undefined)
          input.dispatch({ type: 'submit' })
          events.push(`app:submit:${command}`)
        } else if (frame.payload.startsWith('mint-env:')) {
          const id = frame.payload.slice('mint-env:'.length)
          passport.setExpectedEnvironmentId(id)
          events.push(`app:mint-env:${id}`)
        } else {
          events.push(`app:unknown:${frame.payload}`)
        }
        return
      }
      case 'osc133': {
        const marker = parseOsc133(frame.payload)
        if (marker === null) {
          events.push('osc133:rejected')
          return
        }
        ledger.onMarker(marker.kind, marker.exitCode)
        input.dispatch({ type: 'marker', kind: marker.kind })
        events.push(
          `marker:${marker.kind}${marker.exitCode !== undefined ? `:${marker.exitCode}` : ''}`,
        )
        return
      }
      case 'osc636': {
        const disposition = passport.ingest(frame.payload)
        events.push(`passport:${disposition.status}`)
        return
      }
      case 'osc7': {
        const parsed = parseOsc7(frame.payload)
        if (parsed !== null) {
          cwd = parsed.path
          events.push('cwd')
        } else {
          events.push('osc7:rejected')
        }
        return
      }
      case 'csi': {
        if (frame.payload === '?1049h') {
          input.dispatch({ type: 'buffer', buffer: 'alternate' })
          events.push('buffer:alternate')
        } else if (frame.payload === '?1049l') {
          input.dispatch({ type: 'buffer', buffer: 'normal' })
          events.push('buffer:normal')
        } else {
          events.push(`csi:ignored:${frame.payload}`)
        }
        return
      }
      case 'private-osc': {
        // The renderer registers exactly one private OSC: the in-band READY.
        // It confirms the wrapper's echo mode; it is not lifecycle authority.
        events.push(frame.payload === INBAND_READY ? 'inband:ready' : 'private-osc:ignored')
        return
      }
      case 'dcs': {
        events.push('dcs:ignored')
        return
      }
    }
  }

  function snapshot(): SessionProjection {
    const records = ledger.records()
    const last = records[records.length - 1]
    const running = records.some((r) => r.status === 'running') ? 1 : 0
    return {
      lifecycle: input.state,
      keyboardRoute: input.owned && input.state === 'PROMPT_READY' ? 'editor' : 'raw',
      activeDomain: acceptedDomain,
      attemptState:
        last === undefined
          ? 'none'
          : `id:${last.id} ${last.status}${last.exitCode !== null ? `:${last.exitCode}` : ''}`,
      blockState: `${running} running, ${frozenBlocks} frozen`,
      historyCalls,
      environmentStack: passportDispositions.join(','),
      rewriteAuthority: false,
      rerunAuthority: false,
      cwd,
    }
  }

  return { events, dispatch, snapshot }
}

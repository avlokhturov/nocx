// Input-ownership state (ADR-0024 §1, §6) — SEVERED. No sequence parsed from
// the byte stream — standard OSC, private OSC, DCS, title, terminal mode —
// may grant DOM keyboard ownership or declare prompt readiness. Every session
// is a conventional terminal: raw input, a visible native prompt, lifecycle
// always 'Native'. The only axis that remains is the buffer (ADR-0024 §6),
// driven by the xterm alt-buffer event — a renderer-owned presentation fact,
// never an authority. The lifecycle axis (PromptReady(domain) / Running /
// Desynchronized / Lost) is the migration bead's work and lives elsewhere.
export type InputState = 'Native' | 'ALT_SCREEN'

export type InputEvent =
  { type: 'buffer'; buffer: 'normal' | 'alternate' } | { type: 'reset' } | { type: 'exit' }

export interface Machine {
  state: InputState
}

export function initialMachine(): Machine {
  return { state: 'Native' }
}

export class InputStateController {
  private machine = initialMachine()
  private subs: Array<(m: Machine) => void> = []

  get state(): InputState {
    return this.machine.state
  }

  dispatch(e: InputEvent): void {
    const next = reduce(this.machine, e)
    if (next.state === this.machine.state) {
      this.machine = next
      return
    }
    this.machine = next
    for (const cb of this.subs) cb(next)
  }

  onChange(cb: (m: Machine) => void): void {
    this.subs.push(cb)
  }
}

export function reduce(m: Machine, e: InputEvent): Machine {
  switch (e.type) {
    case 'buffer':
      return { state: e.buffer === 'alternate' ? 'ALT_SCREEN' : 'Native' }
    case 'reset':
    case 'exit':
      return { state: 'Native' }
  }
}

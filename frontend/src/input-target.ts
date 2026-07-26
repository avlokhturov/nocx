// Pluggable input targets (ADR-0004 §3). The editor is a passive surface; a
// registered InputTarget decides where a submitted document goes. New kinds
// (shell now, LLM agent later) are added by registering a target, never by
// editing the editor.
export interface SubmitContext {
  readonly targetId: string
}

export interface InputTarget {
  readonly id: string
  readonly label: string
  submit(doc: string, ctx: SubmitContext): Promise<void>
}

export interface InputTargetRegistry {
  register(target: InputTarget): void
  setActive(id: string): void
  active(): InputTarget
}

// ShellInputTarget routes a submitted document to the active PTY using the
// ADR-0004 §2 atomic handoff: the editor hides itself (caller's job), then the
// whole command is sent in one write followed by CR. zle/readline paints the
// accepted command once as the committed transcript — no per-key echo, no
// stty, no readline mirroring.
//
// Bracketed paste is a HANDSHAKE, not a one-way convention: the shell announces
// support by setting DECSET 2004, and only then may the wrappers be sent. A
// shell that never sets it does not consume them, so they arrive as ordinary
// characters and are absorbed into the command name. That is not cosmetic —
// macOS ships /bin/bash 3.2, which predates readline 6.1 and has no bracketed
// paste at all, so `read` became `0~read` and the command did not run
// (nocx-hi2; it is what made e2e red on main, nocx-5zl4).
//
// So the mode decides, and it is read AT SUBMIT because it is dynamic — the
// shell sets it at its prompt and clears it while a full-screen program runs.
// A value cached at construction would reintroduce the race recorded in
// lesson-nocx-input-editor-do-not-hand-roll, where a fast second submit raced
// the prompt and leaked wrappers because 2004 was not enabled yet.
//
// Mode ON:  \n inside the paste stays a literal separator, so a multi-line
//           composition runs every line rather than only the last (nocx-4ff.14).
// Mode OFF: no wrappers, and newlines normalise to CR so each line executes
//           exactly once — the same normalisation the terminal engine applies
//           before wrapping. Multi-line therefore degrades to N sequential
//           commands instead of one bracketed unit, which is the deliberate
//           trade for never corrupting the command itself.
//
// Why not simply delegate to the engine's paste(), as the renderer seam's own
// comment recommends? Two measured obstacles, both to be resolved under
// nocx-hi2 rather than assumed away: term.paste() routes through
// triggerDataEvent, which returns early while options.disableStdin is set — and
// the terminal is exactly that at the moment the editor owns input — and it
// rewrites \n to \r before wrapping, which would silently change the ON path
// that works today.
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export class ShellInputTarget implements InputTarget {
  readonly id = 'shell'
  readonly label = 'Shell'

  /**
   * @param sendRaw         writes bytes to the active PTY
   * @param bracketedPaste  reports whether the shell has DECSET 2004 set right
   *                        now; called once per submit, never cached
   */
  constructor(
    private readonly sendRaw: (data: string) => void,
    private readonly bracketedPaste: () => boolean,
  ) {}

  submit(doc: string): Promise<void> {
    if (this.bracketedPaste()) {
      this.sendRaw(`${PASTE_START}${doc}${PASTE_END}\r`)
    } else {
      this.sendRaw(`${doc.replace(/\r?\n/g, '\r')}\r`)
    }
    return Promise.resolve()
  }
}

export function createRegistry(): InputTargetRegistry {
  const targets = new Map<string, InputTarget>()
  let activeId: string | undefined
  return {
    register(target) {
      targets.set(target.id, target)
      if (activeId === undefined) activeId = target.id
    },
    setActive(id) {
      if (!targets.has(id)) throw new Error(`input-target: unknown id ${id}`)
      activeId = id
    },
    active() {
      if (activeId === undefined) throw new Error('input-target: no target registered')
      return targets.get(activeId)!
    },
  }
}

// DOM scrollback block manager.
// Creates, freezes, and manages DOM command blocks in the scrollback area.
// Flat warp-style design (P0-1): no card borders, dividers between blocks,
// subtle background tint on hover/select.

import { serializeRange, serializeRangeSGR, serializeRangeText, fromITheme } from './serializer'
import type { CapturedBody } from '../capture-client'
import { getCurrentTheme } from '../renderers/theme-adapter'
import type { CommandSnapshotStore } from '../command-snapshot'
import type { IBufferLine } from '@xterm/xterm'
import { wordRangeIn } from '../word-selection'
import { createSecretChipUnresolved } from '../ui/secret-chip'
import { type ToolCallEffect } from '../ui/tool-call-line'
import { createReasoningNote, type ReasoningNote } from '../ui/reasoning-note'
import { reasoningStartsExpanded } from '../reasoning-expanded'
import { showToast } from '../ui/toast'
import { findReferences } from '../secret-reference'
import { commandFragment } from '../command-text'
import { KIND_LABELS, type SecretKind } from '../secret-kind'
import type { ExecutionAttempt } from '../lifecycle/state'
import type { CommandAuthor } from '../command-ledger'
import { createAnswerBody, type AnswerBody } from './answer-body'
import { createToolCallStrip, type ToolCallStrip } from './turn-flow'
import { paintShellInto } from './shell-paint'
// ── Clipboard helper ────────────────────────────────────────────────────────

function clipboardFallback(text: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* silent */
      }
      document.body.removeChild(ta)
    })
  }
}

// ── Render fence rendezvous (ADR-0024 §7 carve-out, bead nocx-u7uh.8) ──
// The lifecycle channel and the pty are independent streams, so an
// authenticated completion can reach nocx before the command's last output
// bytes do. The shell writes a 32-random-byte nonce (64 hex chars) to the
// pty AFTER the output and carries the same nonce in the `complete` event;
// the block's VISUAL freeze waits for both, while the LOGICAL completion
// (exit status, history) lands on the event alone.

/** How long a completed attempt's VISUAL boundary waits for its fence bytes
 *  before the visual freeze settles at the current output end. The LOGICAL
 *  freeze (status, exit code) lands on the event alone; the fence is printed
 *  by the shell immediately after the output on the same pty channel, so it
 *  lands within the same write burst — this window is generous for a slow
 *  link and only bounds how long a finished command keeps its running look
 *  when the fence never arrives. Named: the deferral is a policy, not a
 *  magic number, and the no-fence path is a degrade, never a truncation. */
export const FENCE_DEFER_MS = 500

/** Upper bound on remembered fence sightings (hex → line). Sightings are
 *  kept only so a completion that lands after its fence can match it; a
 *  crypto-random nonce makes collisions impossible, so a small ring is
 *  more than enough and bounds the memory of a hostile stream. */
const MAX_FENCE_SIGHTINGS = 8

/** Deferral-timer handle — named so the pending-fence contract never
 *  couples to setTimeout's implementation type. */
type FenceTimer = ReturnType<typeof setTimeout>

/** A block status that has left `running` — the terminal set the DOM
 *  freeze and the block record share. The LOGICAL freeze produces it and
 *  hands it to the VISUAL freeze, so serialization is typed to follow a
 *  terminalized record. */
export type FrozenStatus = 'success' | 'failure' | 'entered' | 'unknown'

/** Where a block is, as its HEADER reports it (nocx-hoeq3).
 *
 *  `settled` is the one that had to be named. It means: this block is
 *  finished and the outcome is NOT HERE — a fragment of a turn that ended
 *  further down. It used to be spelled `success`, on both the live path and
 *  the restored one, because nothing read the value and any settled-looking
 *  status would do. That stops being true the moment the header derives a
 *  terminal chip from the status, which is what the group's one owner below
 *  does: a continuation spelled `success` would state an outcome it does not
 *  have, and tell a reader the turn finished halfway down itself. */
type HeaderStatus = 'running' | 'waiting' | 'settled' | FrozenStatus

/** The statuses a BUILT block can be handed — everything a header knows
 *  except `running`, which belongs to createRunningBlock's element and never
 *  to a block built with its rows already fixed. */
type BuiltStatus = Exclude<HeaderStatus, 'running'>

// ── Block kind ─────────────────────────────────────────────────────────────

/** A block's content grammar (nocx-ex636). The FRAME — a header, a body,
 *  selection, the overflow menu — is shared by every block; the grammar is
 *  not. A question is prose and a command is a command line, and a fourth
 *  kind must declare itself in the rules table instead of inheriting the
 *  command's rules by accident. */
export type BlockKind = 'command' | 'ask'

/** The rules the owner named — highlighting, wrapping, the status
 *  vocabulary — read from ONE table, keyed by the kind the block declared.
 *  No call site checks "is this an answer", and no builder defaults to the
 *  command rules. */
export interface BlockKindRules {
  /** The header's text is a command line: shell-highlight it. A question
   *  is prose and never runs through the lexer. */
  readonly highlightHeader: boolean
  /** The class the body element carries — the CSS owner of the wrap
   *  policy: `.cmd-output` freezes rows at the terminal grid width
   *  (nocx-juau), `.cmd-output-ask` wraps prose at the block's width. */
  readonly outputClass: string
  /** The header's status vocabulary. The command kind has none — its
   *  header states are the record's and render structurally (spinner,
   *  duration, exit chips). The ask kind names its lifecycle with words:
   *  in progress, then the terminal word from the close path. */
  readonly statusChips: {
    /** Shown while the work is in progress — the ask block says it is
     *  thinking until the first delta lands. Kept SHORT: it sits beside
     *  the live pulse, which is what carries "something is happening", so
     *  the word only has to name what the pulse is about. */
    readonly inProgress: string
    readonly done: string
    readonly failed: string
  } | null
  /** WHAT THE HEADER'S RIGHT-HAND GROUP HOLDS when the block has settled,
   *  and in what order (nocx-hoeq3).
   *
   *  Here rather than at the call sites because there are two of them and
   *  they were hundreds of lines apart: the builder filled the group for a
   *  command, and the answer flow's close filled it again for a turn. They
   *  agreed on nothing except by accident — the turn's chip was missing the
   *  `-ok`/`-fail` modifier, and the turn had no duration chip at all
   *  because it was built with `durationMs = null` and never given one. The
   *  owner saw the result as two headers whose chips differ in number and
   *  placement, which is what they were.
   *
   *  A kind that declares nothing here does not get the command's group by
   *  default; it fails in blockKindRules like every other rule. */
  readonly headerRight: HeaderRightRules
}

/** The right-hand group's per-kind rules. */
interface HeaderRightRules {
  /** The slots the group holds, in DOM order. A slot renders nothing when
   *  the block has no such fact — no duration known, no outcome here — so
   *  the order is stable whether one chip is drawn or both. */
  readonly chips: readonly HeaderChipSlot[]
  /** The block's outcome as this kind SAYS it, or null when the block has
   *  none of its own: still running, still waiting, or a fragment of a turn
   *  that ended further down.
   *
   *  The two kinds read different facts on purpose, and that is the whole
   *  of what is per-kind here (nocx-ex636). A command's outcome is the
   *  shell's exit code and its words are the shell's. A turn's outcome is
   *  the run's terminal status and its words are its own — an answer is not
   *  a command's output and does not borrow "ok". The CHIP the two produce
   *  is one chip, built once, below. */
  readonly terminal: (outcome: BlockOutcome) => TerminalChipSpec | null
}

/** One slot in the header's right-hand group. */
type HeaderChipSlot = 'duration' | 'terminal'

/** The facts a settled block's header decides its terminal chip from. */
interface BlockOutcome {
  readonly status: BuiltStatus
  /** The shell's code, and null for everything that is not a shell command
   *  — which is what the store sends for an assistant turn, because the
   *  exit code lives in the shell arm of an entry's payload and a turn has
   *  no shell arm (content.ShellExitCodeOf). */
  readonly exitCode: number | null
}

/** What a terminal chip says: its tone and its word. The tone is the
 *  block's outcome; the word is the kind's vocabulary. */
interface TerminalChipSpec {
  readonly ok: boolean
  readonly text: string
}

/** The ask kind's words, named once so the in-progress chip and the terminal
 *  chip cannot drift apart: they are one vocabulary. */
const ASK_STATUS_CHIPS = {
  inProgress: 'thinking',
  done: 'completed',
  failed: 'failed',
} as const

const BLOCK_KIND_RULES: Record<BlockKind, BlockKindRules> = {
  command: {
    highlightHeader: true,
    outputClass: 'cmd-output',
    statusChips: null,
    headerRight: {
      chips: ['duration', 'terminal'],
      terminal: ({ status, exitCode }) => {
        // An 'entered' block froze on environment entry (N6): it carries no
        // exit code and must never paint success or failure, whatever code
        // the local D later delivers to the ledger.
        if (status === 'entered' || exitCode === null) return null
        return exitCode === 0 ? { ok: true, text: 'ok' } : { ok: false, text: `exit ${exitCode}` }
      },
    },
  },
  ask: {
    highlightHeader: false,
    outputClass: 'cmd-output cmd-output-ask',
    statusChips: ASK_STATUS_CHIPS,
    headerRight: {
      chips: ['duration', 'terminal'],
      // From the STATUS, never from the exit code. A turn's outcome is the
      // run's, and the store sends no exit code for one; deriving the chip
      // from the code left a restored turn saying nothing at all about
      // whether it finished, while the live one said `completed` from a
      // second construction (nocx-hoeq3).
      terminal: ({ status }) => {
        if (status === 'success') return { ok: true, text: ASK_STATUS_CHIPS.done }
        if (status === 'failure') return { ok: false, text: ASK_STATUS_CHIPS.failed }
        return null
      },
    },
  },
}

/** A kind's rules, or a loud failure: a kind that declares nothing must
 *  never inherit the command rules by default (nocx-ex636). */
export function blockKindRules(kind: BlockKind): BlockKindRules {
  const rules = BLOCK_KIND_RULES[kind]
  if (!rules) throw new Error(`unknown block kind: ${String(kind)}`)
  return rules
}
// ── Block model ────────────────────────────────────────────────────────────

/** The handle the ask surface drives one answer block with (nocx-x8s2.2).
 *  The answer is NOT xterm output — it arrives as plain text over the
 *  control plane — so the body is rendered as escaped term-lines (the
 *  flow's one text vocabulary). The handle is the ONLY way the block's
 *  body and status change; the ask surface never touches the block DOM
 *  directly. */
export interface AnswerBlockHandle {
  readonly id: number
  readonly el: HTMLElement
  /** Append one streamed chunk (agent.runDelta text) to the answer body.
   *  `this: void` — the target holds the handle and calls the method
   *  detached from any receiver (unbound-method contract). */
  append(this: void, text: string): void
  /** Draw one tool call (agent.runToolCall) in the answer's flow, AT THE
   *  POSITION IT ARRIVED (nocx-shxv0). Not a top-level block: the call
   *  belongs to the answer that was streaming when it happened, and that
   *  is what fixes the ordering the owner saw inverted — a run tool's
   *  block sitting below the answer written from its output.
   *
   *  Idempotent per `callId`: the backend announces a call once per
   *  EXECUTION, and an approved egress resume puts the same call through
   *  the pipeline a second time. One call, one line. */
  toolCall(this: void, call: AnswerToolCall): void
  /** Append one chunk of the model's thinking (agent.runReasoning) — into
   *  its own collapsed note, never into the answer text (nocx-s92so). The
   *  note is created at the FIRST chunk, so a model that returns no
   *  reasoning renders nothing at all. */
  reasoning(this: void, text: string): void
  /** Close the block: success, or failure with the renderable reason.
   *  `model` names the model that answered (the ask result's pinned
   *  run fact, nocx-e6kn2): painted as the block's provenance on
   *  success, so a person can tell which model answered. */
  close(this: void, status: 'success' | 'failure', error?: string, model?: string): void
}

/** One tool call as the answer flow draws it — the wire's facts
 *  (contracts/agent.runToolCall.schema.json), narrowed to what this surface
 *  needs. Deliberately no result and no raw arguments: see ui/tool-call-line
 *  for why. */
export interface AnswerToolCall {
  callId: string
  tool: string
  effect: ToolCallEffect
  resource?: { kind: string; id: string }
  /** Whether this call's work becomes a TOP-LEVEL BLOCK of its own — the
   *  tool declaration's fact, off the wire (nocx-9sqii). True and the flow
   *  draws NO line: the block the command opened is the account of the call,
   *  and the fragment being written stops so the block can stand at the
   *  point the call happened. False and the line is the only thing that says
   *  the call occurred.
   *
   *  Never derived here from `tool`: which tools open blocks is a fact of
   *  the tool table (internal/agenttools), and a renderer holding its own
   *  copy would disagree with it the day a tool is added — the same reason
   *  the effect beside it is sent rather than inferred (ADR-0028 decision
   *  4). */
  opensBlock: boolean
}

/** One answer block's bookkeeping (nocx-x8s2.2): the question it answers
 *  and its DOM element. Deliberately NOT a BlockRecord — no xterm lines,
 *  no freeze lifecycle; the command paths must never see it. */
interface AnswerBlockRecord {
  id: number
  question: string
  el: HTMLElement
}

export interface BlockRecord {
  id: number
  command: string
  cwd: string
  /** Who submitted the command — the minted author from the submitting
   *  target (design §3.1, nocx-iadtt), defaulting to the human's shell
   *  for a shell-originated block. The header renders the mark from this;
   *  the freeze path reuses it, so the mark survives the running → frozen
   *  replacement. */
  author: CommandAuthor
  /** Duration in ms: C marker to D marker. */
  durationMs: number | null
  exitCode: number | null
  /** Presentation state. 'entered' = frozen on environment entry (N6):
   *  neither success nor failure, no exit code — the block the ssh command
   *  froze into when the remote session began. 'unknown' = the bound
   *  attempt was abandoned (ADR-0024 §5): frozen, never successful, no
   *  reported exit code. */
  status: 'running' | 'success' | 'failure' | 'entered' | 'unknown'
  /** Run once, after the VISUAL freeze has replaced `el`.
   *
   *  The two freezes are separate moments (u7uh.8): the logical one lands on
   *  the authenticated completion and sets `status` above, while the visual
   *  one waits up to FENCE_DEFER_MS for the fence bytes and REPLACES `el`
   *  when it lands. Between them the block is finished but its element still
   *  reads `cmd-block-running`, and anything written onto that element is
   *  discarded by the replacement.
   *
   *  So a decoration arriving in that window parks here instead of being
   *  applied to an element about to be discarded, or dropped. The receipt is
   *  the case that needed it: the history.record ack raced the fence, was
   *  refused for looking unfinished, and was gone for good — a captured
   *  secret with nothing offering to save it (nocx-ggha). */
  afterVisualFreeze?: () => void
  /** What the VISUAL freeze produced for the store (nocx-2f0f): the block's
   *  rows as SGR and as characters, with the grid the serializer saw.
   *
   *  PARKED HERE rather than sent, because the artifact hangs on an ENTRY
   *  and the entry id arrives with the history.record ack — a different
   *  event that may land before or after this freeze. Whoever sends it
   *  clears the field, so a block cannot be captured twice.
   *
   *  Undefined until the visual freeze runs, and after the capture has been
   *  handed over. */
  captured?: CapturedBody
  /** The authenticated attempt this block is bound to (ADR-0024 §7
   *  projection): set when the running block binds to the published
   *  attempt, kept when the block freezes. Absent only for a block that
   *  never bound (cleared scrollback, never seen running). */
  attemptId?: string
  /** IMarker line for C boundary — the absolute buffer line where the
   *  block was CREATED: the prompt line at app-owned submit, or the cursor
   *  line when a shell-originated attempt's running fact landed. The
   *  published running fact binds to the block by this line's lifetime,
   *  never by its value (ADR-0024 §5 attachment semantics). */
  startLine: number
  /** The absolute buffer line where the block's OUTPUT begins — the first
   *  row serialized at freeze. Differs from `startLine` exactly when the
   *  creation line carries the shell's echo of the command: the app-owned
   *  submit opens the block BEFORE the bytes, and the echo lands on the
   *  creation line, so the output range starts one row later (nocx-4yhi).
   *  The range and the creation time are two different things, and this
   *  is the record of that; a shell-originated block opens after its echo
   *  and defaults to `startLine`. */
  outputStart: number
  /** IMarker line for D boundary (approx). */
  endLine: number
  /** Whether OSC 133 C was received for this command. False when the
   *  block was started from the app-owned submit (nocx-atyf.4). */
  cReceived: boolean
  el: HTMLElement
}

/** Line accessor function — matches xterm's IBufferLine.getLine(). */
export type GetLineFn = (y: number) => IBufferLine | undefined

// ── DOM helpers ────────────────────────────────────────────────────────────

function div(className: string, ...children: (string | HTMLElement)[]): HTMLElement {
  const el = document.createElement('div')
  el.className = className
  for (const c of children) {
    if (typeof c === 'string') {
      el.appendChild(document.createTextNode(c))
    } else {
      el.appendChild(c)
    }
  }
  return el
}

// ── Duration formatters ────────────────────────────────────────────────────

/**
 * The elapsed time of a command that is still running.
 *
 * Whole seconds, unlike the finished-command format. The ticker fires once a
 * second, so a tenths digit could only ever read `.0` — a decimal place that
 * never varies is not precision, it is noise that makes the number wider and
 * harder to read at a glance.
 */
function formatRunningDuration(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `${min}m ${sec}s`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = ((ms % 60000) / 1000).toFixed(0)
  return `${min}m ${sec}s`
}

// ── The header's right-hand group: one owner (nocx-hoeq3) ──────────────────

/** THE construction of a header's duration chip, for every kind and for both
 *  of the states that show one.
 *
 *  A turn takes time and that is as worth knowing as `df` taking 27ms, so it
 *  is drawn with the same chip and the same identity class a command's is —
 *  which is also what makes the two headers line up, since the width floor
 *  lives on `.cmd-header-duration`.
 *
 *  The TEXT is the caller's, because the two formatters are deliberately
 *  different: a running command shows whole seconds (the ticker fires once a
 *  second, so a tenths digit could only read `.0`) and a finished one shows
 *  the precise figure. Two formatters, one chip. */
function durationChip(text: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'nocx-chip nocx-chip-muted cmd-header-duration'
  el.textContent = text
  return el
}

/** THE construction of a header's TERMINAL chip, for every kind.
 *
 *  There were two. The command's carried `cmd-header-exit-ok`/`-fail` and the
 *  turn's did not, which was invisible only because no stylesheet paints
 *  those modifiers — the two would have disagreed the day one did. The WORD
 *  still comes from the kind (nocx-ex636); the element does not. */
function terminalChip(spec: TerminalChipSpec): HTMLElement {
  const el = document.createElement('span')
  el.className = spec.ok
    ? 'nocx-chip nocx-chip-ok cmd-header-exit cmd-header-exit-ok'
    : 'nocx-chip nocx-chip-fail cmd-header-exit cmd-header-exit-fail'
  el.textContent = spec.text
  return el
}

/**
 * Fill a header's right-hand group with what a SETTLED block of this kind
 * shows, in the order the kind declared (nocx-hoeq3).
 *
 * Called from the two moments a block settles, so there is one answer for
 * both: at BUILD, for a block whose outcome was already known (a frozen
 * command, a restored anything), and at CLOSE, for a turn that was built
 * while it was still being written. Before this the close built its own chip
 * and never a duration, so a turn's header held one chip where a command's
 * held two — the difference in number and placement the owner reported.
 *
 * IDEMPOTENT: the settled chips are cleared first, so settling a header twice
 * re-states the group rather than growing a second copy of it. The ⋮ is not
 * ours — placeHeaderChip keeps it last, whether or not it exists yet.
 */
function settleHeaderRight(
  right: Element,
  kind: BlockKind,
  durationMs: number | null,
  outcome: BlockOutcome,
): void {
  for (const stale of right.querySelectorAll('.cmd-header-duration, .cmd-header-exit')) {
    stale.remove()
  }
  const rules = blockKindRules(kind).headerRight
  for (const slot of rules.chips) {
    if (slot === 'duration') {
      if (durationMs !== null) placeHeaderChip(right, durationChip(formatDuration(durationMs)))
      continue
    }
    const spec = rules.terminal(outcome)
    if (spec) placeHeaderChip(right, terminalChip(spec))
  }
}

// ── CWD display ────────────────────────────────────────────────────────────

function cwdLabel(cwd: string): string {
  const path = cwd.trim().replace(/\/+$/, '') || '~'
  const parts = path.split('/').filter(Boolean)
  if (path === '~' || parts.length === 0) return path
  return parts.slice(-2).join('/')
}

/**
 * Create the header row for a block — flat, warp-style (P0-1).
 * No card background, no pill/chip styling. Plain muted small text.
 * The grammar (highlighting, the status vocabulary) is the kind's
 * (nocx-ex636).
 */
function createHeader(
  kind: BlockKind,
  command: string,
  cwd: string,
  location: string,
  durationMs: number | null,
  exitCode: number | null,
  status: HeaderStatus,
  store: CommandSnapshotStore,
  author: CommandAuthor = 'shell',
): HTMLElement {
  const header = div('cmd-header')
  const rules = blockKindRules(kind)

  // ── Chips row (above command text): cwd left, duration+exit right ──
  const chipsRow = div('cmd-header-chips')

  // Who ran it, when it was not the human (design §3.1, nocx-iadtt): the
  // kit's badge in its info tone — the same "informational provenance"
  // register the secret chip speaks. A human's block carries no mark at
  // all; only a non-human author is worth saying out loud. Never a
  // hand-rolled chip: this is the kit's badge, placed like any other chip.
  if (author !== 'shell') {
    const mark = document.createElement('span')
    mark.className = 'ui-badge'
    mark.dataset.tone = 'info'
    mark.dataset.author = author
    mark.textContent = author
    chipsRow.appendChild(mark)
  }

  // Where the command ran, when it is somewhere other than this machine. Warp
  // puts `user@host` at the head of every block header and it is the attribute
  // ours was missing: a scrollback full of blocks with no host in them reads
  // the same whether you were on your laptop or three hops away (nocx-6w4z).
  if (location) {
    const loc = document.createElement('span')
    loc.className = 'nocx-chip nocx-chip-muted cmd-header-location'
    loc.textContent = location
    chipsRow.appendChild(loc)
  }

  // CWD — standard chip component
  if (cwd) {
    const cwdEl = document.createElement('span')
    cwdEl.className = 'nocx-chip cmd-header-cwd'
    cwdEl.textContent = `📁 ${cwdLabel(cwd)}`
    chipsRow.appendChild(cwdEl)
  }

  // Right: duration + exit status (or spinner while running)
  const right = div('cmd-header-right')

  if (status === 'running') {
    // The elapsed time, ticking. It used to appear only once the command had
    // finished, which is the one moment you no longer need it — the question
    // "how long has this been going" is asked WHILE it is going. Warp shows it
    // live and so does this (nocx-6w4z).
    const spinner = document.createElement('span')
    spinner.className = 'cmd-header-spinner'
    right.appendChild(spinner)
    right.appendChild(durationChip(formatRunningDuration(0)))
  } else if (status === 'waiting') {
    // The kind's own in-progress vocabulary: the ask block says it is
    // thinking until the first delta lands, and the answer
    // lifecycle removes it at exactly that moment (nocx-ex636). The
    // command kind has no in-progress WORD — its running state is the
    // spinner above — so a command handed this status shows nothing.
    if (rules.statusChips) {
      // The SAME pulse a running command's header carries, in the SAME
      // place: a bare dot in the chip row, left of the chip (AD-8 — one
      // owner for "this block is in progress", and one shape for it). A
      // static word is a label; a word beside a live pulse is a report
      // that something is happening right now. It sat INSIDE the chip for
      // one round and read as a different control from the command's,
      // which is two vocabularies for one concept.
      const pulse = document.createElement('span')
      // Its own identity class beside the shared appearance: the pulse is a
      // SIBLING of the chip now, so whoever ends the wait has to be able to
      // find it. Removing only the chip left a dot pulsing next to
      // `completed` — the report half that nobody owned.
      pulse.className = 'cmd-header-spinner cmd-answer-waiting-pulse'
      right.appendChild(pulse)
      const wait = document.createElement('span')
      wait.className = 'nocx-chip nocx-chip-muted cmd-answer-waiting'
      wait.textContent = rules.statusChips.inProgress
      right.appendChild(wait)
    }
  } else {
    // Settled: the group is the kind's, from its one owner. A block whose
    // outcome arrives LATER — a turn, which is written before it ends —
    // settles the same group through the same function at its close.
    settleHeaderRight(right, kind, durationMs, { status, exitCode })
  }

  chipsRow.appendChild(right)
  header.appendChild(chipsRow)
  // ── Header text (below chips) ──────────────────────────────────────
  // The grammar is the kind's (nocx-ex636): a command header carries the
  // same syntactic highlight pass as the live editor (same lexer, same
  // classes — see shell-highlight.ts); a question is prose and renders
  // plain, never through the lexer. A running header stays plain: the
  // command is still being executed, and the static pass is for reading a
  // finished command back. The frozen branch is innerHTML by design, but
  // the pass escapes every byte of the text, so command content can never
  // inject markup.
  const cmdSpan = document.createElement('span')
  cmdSpan.className = 'cmd-header-text'
  if (!rules.highlightHeader) {
    cmdSpan.textContent = command || '(empty)'
  } else {
    const refs = command ? findReferences(command) : []
    if (refs.length > 0) {
      // A vault reference reads as a chip here, exactly as it does in the
      // editor — it is the same fact about the same text, and showing
      // `{{secret:openrouter.ai}}` raw in the block made the block look like
      // a different thing from the line the user typed.
      //
      // Chips and shell highlighting do not compose: the highlighter emits
      // one HTML string for the whole command, and cutting chips into it
      // would mean tokenising the fragments between them, where a quote
      // opened before a reference closes after it. A command carrying a
      // reference therefore renders plain, the way a masked one already does
      // (renderRecordedCommand) — the chip is the emphasis.
      cmdSpan.replaceChildren(commandFragment(command))
    } else if (status === 'running') {
      cmdSpan.textContent = command || '(empty)'
    } else {
      if (command) paintShellInto(cmdSpan, command, store)
      else cmdSpan.textContent = '(empty)'
    }
  }
  header.appendChild(cmdSpan)

  return header
}

/**
 * Returns true when the serialized output HTML is effectively empty.
 */
function isOutputEmpty(html: string): boolean {
  const stripped = html.replace(/<[^>]*>/g, '').replace(/\s/g, '')
  return stripped.length === 0
}

/**
 * A block's output as text, with the line breaks put back.
 *
 * Asked of the BLOCK, because which element holds the output is the
 * block's own fact (nocx-ex636): a command block's output is the
 * `.cmd-output` its builder created, while an answer block's body is
 * appended after the frame — the overflow menu must resolve it from the
 * block at READ time, never hold a builder-time reference that was empty
 * or null. The extraction itself is kind-agnostic: every block's output
 * is `.term-line` rows or plain text.
 *
 * The serializer emits one `<span class="term-line">` per logical line and
 * nothing between them — the line breaks you see are `display: block` in
 * CSS, not characters in the DOM. So `outputEl.textContent` returned the
 * whole block as a single run, and "Copy output" pasted a hundred rows of
 * `top` onto one line (nocx-6w4z).
 *
 * Falls back to `textContent` when there are no line spans, which is what
 * a block with plain text content would give.
 */
export function blockOutputText(blockEl: HTMLElement | null): string {
  if (!blockEl) return ''
  const outputEl = blockEl.querySelector('.cmd-output')
  if (!outputEl) return ''
  const lines = outputEl.querySelectorAll('.term-line')
  if (lines.length === 0) return outputEl.textContent ?? ''
  return Array.from(lines)
    .map((line) => line.textContent ?? '')
    .join('\n')
}

/** The block's command as text, for a human label naming the block (the
 *  ask chip's value — nocx-x8s2.2). After history.record acks, the header
 *  renders the MASKED command and data-recorded-command holds the full
 *  stored text: the label reads the same source the block shows (ADR-0021),
 *  never a second derivation of the line. */
export function blockCommandText(blockEl: HTMLElement): string {
  const recorded = blockEl.getAttribute('data-recorded-command')
  if (recorded) return recorded
  return blockEl.querySelector('.cmd-header-text')?.textContent ?? ''
}

/** Place a chip in a header's right group, and keep the "⋮" last (nocx-kez4m).
 *
 *  The overflow button is appended when the block is BUILT, so a chip added
 *  by a later lifecycle step — the ask kind's terminal word is the only one
 *  today — lands to its RIGHT unless somebody says otherwise. The owner saw
 *  an answer block reading "⋮ failed" above a command block reading
 *  "50ms ok ⋮" and asked why one row runs backwards.
 *
 *  So the rule lives HERE rather than in each caller: chips go left of the
 *  button, whether or not the button exists yet. A kind added later inherits
 *  the order by using this, instead of learning the button's position by
 *  luck. */
/**
 * Mark one block as a fragment of a turn (nocx-9sqii).
 *
 * A turn is drawn as SEVERAL blocks when it ran commands — the answer stops
 * where a block took its place and continues below it — and a reader has to
 * be able to tell a continuation of one answer from a second answer. Two
 * facts do that, and neither is a colour:
 *
 *  - `data-turn-fragment`, the fragment's index, beside the `data-entry-id`
 *    every fragment of one turn shares. That is the STORED identity: the
 *    ledger entry the question and the answer both belong to.
 *  - the kit's badge reading `continued`, for the person, on every fragment
 *    but the first.
 *
 * ONE OWNER, because the live flow and the restore both mark fragments and
 * two markers would agree until the day one of them changed.
 */
export function markTurnFragment(el: HTMLElement, index: number): void {
  el.dataset.turnFragment = String(index)
  if (index === 0) return
  const badge = document.createElement('span')
  badge.className = 'ui-badge'
  badge.dataset.tone = 'neutral'
  // Its own identity attribute, so the assertion "this is a continuation"
  // is on the fact and not on the word — the word can be translated, the
  // attribute is what the tests and the CSS read.
  badge.dataset.turnContinuation = ''
  badge.textContent = 'continued'
  const chips = el.querySelector('.cmd-header-chips')
  if (chips) chips.insertBefore(badge, chips.firstChild)
  else el.prepend(badge)
}

function placeHeaderChip(right: Element, chip: Element): void {
  right.insertBefore(chip, right.querySelector('.cmd-overflow-btn'))
}

/**
 * Build the "⋮" overflow menu button + dropdown (P2-9, P1-6 fix).
 * The menu is rendered as a child of document.body with position:fixed
 * so it floats above ALL blocks and scroll containers. Position is
 * calculated from the button's bounding rect. Closes on outside click
 * and Escape key.
 */
/** Fetch the DURABLE text of one answer entry, or null when it is not
 *  stored any more. Injected, never constructed here: this module has no
 *  socket, and the one that does is wired at the composition root. */
export type AnswerTextSource = (entryId: string) => Promise<string | null>

/** What a RUNNING block's ⋮ menu can do about the command in it, beyond
 *  copying its text (nocx-92gfl, nocx-23rph).
 *
 *  Injected, never constructed here, for the same reason `answerText` is:
 *  this module owns block DOM and holds neither an editor nor a socket. Both
 *  entries also exist as a keystroke — ⌘/Ctrl+Enter summons, Ctrl+C
 *  interrupts — and the menu is deliberately a SECOND DOOR to the same
 *  handlers rather than a second implementation: a gesture nobody can see is
 *  a gesture nobody uses, and two implementations of one action are two
 *  behaviours waiting to diverge. */
export interface RunningBlockActions {
  /** Summon the editor to ask about this command — what ⌘/Ctrl+Enter does. */
  ask(): void
  /** Stop it, through the backend's escalation ladder. */
  stop(): void
}

function buildOverflowMenu(
  blockEl: HTMLElement,
  command: string,
  answerText?: AnswerTextSource,
  running?: RunningBlockActions,
): HTMLElement {
  const btn = document.createElement('button')
  btn.className = 'cmd-overflow-btn'
  btn.textContent = '\u22EE' // ⋮ vertical ellipsis
  btn.setAttribute('aria-label', 'Block actions')

  let menu: HTMLElement | null = null
  let closeOnEscape: ((e: KeyboardEvent) => void) | null = null
  let closeOnClick: ((ev: MouseEvent) => void) | null = null

  const closeMenu = () => {
    if (menu) {
      menu.remove()
      menu = null
    }
    if (closeOnEscape) {
      document.removeEventListener('keydown', closeOnEscape)
      closeOnEscape = null
    }
    if (closeOnClick) {
      document.removeEventListener('click', closeOnClick)
      closeOnClick = null
    }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    e.preventDefault()

    // If menu is already open, close it.
    if (menu) {
      closeMenu()
      return
    }

    // Build the dropdown.
    menu = document.createElement('div')
    menu.className = 'cmd-overflow-menu'
    const copyCmd = document.createElement('button')
    copyCmd.className = 'cmd-overflow-menu-item'
    copyCmd.textContent = 'Copy command'
    copyCmd.addEventListener('click', (ev) => {
      ev.stopPropagation()
      // Once history.record acks, the block shows — and therefore copies —
      // the MASKED command: what you see is what went to the store, and the
      // renderer no longer holds the plaintext for that block (ADR-0021,
      // the receipt round's named trade). The full masked text lives in
      // data-recorded-command; the chips in the header are labels.
      const recorded = btn.closest('.cmd-block')?.getAttribute('data-recorded-command')
      clipboardFallback(recorded ?? command)
      closeMenu()
    })

    // WHERE A BLOCK'S OUTPUT COMES FROM, AND WHY THE TWO KINDS DIFFER
    // (nocx-v13pd).
    //
    // A COMMAND block copies what the terminal DREW. The rows in the DOM are
    // the artefact — the serializer put them there from the grid — so
    // scraping them is not a shortcut, it is reading the thing itself.
    //
    // An ANSWER block copies what was RECORDED. Since nocx-swoje the answer
    // flow RENDERS the model's markdown: `# ` becomes a heading and the
    // marker is consumed, `**bold**` becomes weight and the asterisks are
    // gone. The DOM is therefore a rendering of the answer and no longer the
    // answer, and a copy scraped from it would quietly differ from what the
    // model said. The durable text is right there — SubmitAgentAsk writes a
    // text/plain artifact for every answer — and the block already knows its
    // entry id, because the deltas were routed by it.
    //
    // Which makes copying an answer ASYNC, and that has two consequences the
    // menu has to honour: the item says it is working (a control that looks
    // clicked and does nothing reads as broken), and a fetch that comes back
    // empty REFUSES rather than falling back to the painted text. A copy
    // that quietly differs from the record is worse than one that did not
    // happen.
    const isAnswer = () => blockEl.dataset.blockKind === 'ask'

    /** The answer's stored text, or null — retention took it, the store is
     *  unreachable, or this window has no source wired. All three are the
     *  same fact to a person: it is not here. */
    const storedAnswer = async (): Promise<string | null> => {
      const entryId = blockEl.dataset.entryId
      if (!entryId || !answerText) return null
      return answerText(entryId)
    }

    const refuseCopy = (): void => {
      showToast({
        level: 'warning',
        message: 'The stored answer is not available, so nothing was copied.',
      })
    }

    /** Run an async menu action with the item reporting the work, and close
     *  the menu when it settles either way. */
    const whileFetching = async (item: HTMLButtonElement, work: () => Promise<void>) => {
      item.disabled = true
      item.dataset.busy = ''
      item.textContent = 'Copying…'
      try {
        await work()
      } finally {
        closeMenu()
      }
    }

    const copyOut = document.createElement('button')
    copyOut.className = 'cmd-overflow-menu-item'
    copyOut.textContent = 'Copy output'
    copyOut.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (!isAnswer()) {
        // The copyable text is asked of the BLOCK at read time (nocx-ex636):
        // an answer block's body is appended after the frame, so the
        // builder-time output reference is null — the block knows where its
        // output lives.
        clipboardFallback(blockOutputText(blockEl))
        closeMenu()
        return
      }
      void whileFetching(copyOut, async () => {
        const stored = await storedAnswer()
        if (stored === null) refuseCopy()
        else clipboardFallback(stored)
      })
    })
    const copyAll = document.createElement('button')
    copyAll.className = 'cmd-overflow-menu-item'
    copyAll.textContent = 'Copy all'
    copyAll.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const intent = () =>
        btn.closest('.cmd-block')?.getAttribute('data-recorded-command') ?? command
      if (!isAnswer()) {
        clipboardFallback(`${intent()}\n${blockOutputText(blockEl)}`)
        closeMenu()
        return
      }
      // The same source as Copy output, deliberately: two items on one block
      // reading one thing from two places is how they start to disagree.
      void whileFetching(copyAll, async () => {
        const stored = await storedAnswer()
        if (stored === null) refuseCopy()
        else clipboardFallback(`${intent()}\n${stored}`)
      })
    })

    // Wrap is a per-block override of the kind's default, and it lives here
    // rather than as a control on the block because it is rare: the kind is
    // right nearly always (a command's grid must not re-wrap — nocx-juau —
    // and an answer's prose must). What it is for is the exception the kind
    // cannot know about: one wide table in otherwise ordinary output, or one
    // answer a person wants to read as it came. The override is the DOM
    // state `data-wrap` on the block, so the CSS reads one attribute and the
    // kind's own rule stays the default underneath it.
    //
    // The label names the EFFECTIVE state, not the attribute: with the
    // `terminal.wrapOutput` setting deciding untouched blocks, a block that
    // is already wrapping carries no attribute at all, and a menu offering
    // to "Wrap lines" on a wrapped block is a control you have to try in
    // order to understand. So the attribute answers when it is there, and
    // the rendered style answers when it is not — one question, asked of
    // whoever actually decided it.
    const wrapOn = (): boolean => {
      const attr = blockEl.getAttribute('data-wrap')
      if (attr === 'on') return true
      if (attr === 'off') return false
      const out = blockEl.querySelector<HTMLElement>('.cmd-output')
      return out ? getComputedStyle(out).whiteSpace.startsWith('pre-wrap') : false
    }
    const wrapItem = document.createElement('button')
    wrapItem.className = 'cmd-overflow-menu-item'
    wrapItem.textContent = wrapOn() ? 'Do not wrap' : 'Wrap lines'
    wrapItem.addEventListener('click', (ev) => {
      ev.stopPropagation()
      blockEl.setAttribute('data-wrap', wrapOn() ? 'off' : 'on')
      closeMenu()
    })

    // THE TWO THINGS A PERSON CAN DO ABOUT A COMMAND THAT IS STILL RUNNING
    // (nocx-92gfl, nocx-23rph). Present only while it runs, and only when
    // the host supplied the handlers: a finished block has nothing to ask
    // about that the transcript does not already show, and nothing to stop.
    //
    // FIRST in the menu, above the copy group, because they act on the
    // command while the copy items act on its text — and because they are
    // the only items here that are time-limited.
    if (running) {
      const ask = document.createElement('button')
      ask.className = 'cmd-overflow-menu-item'
      // The identity is the attribute, not the word: the word can be
      // translated and the CSS and the tests read this.
      ask.dataset.action = 'ask'
      ask.textContent = 'Ask about this command'
      ask.addEventListener('click', (ev) => {
        ev.stopPropagation()
        closeMenu()
        running.ask()
      })
      const stop = document.createElement('button')
      stop.className = 'cmd-overflow-menu-item'
      stop.dataset.action = 'stop'
      stop.textContent = 'Stop'
      stop.addEventListener('click', (ev) => {
        ev.stopPropagation()
        closeMenu()
        running.stop()
      })
      menu.append(ask, stop)
    }
    menu.append(copyCmd, copyOut, copyAll, wrapItem)

    // Render at body level so it floats above all scroll containers (P1-6).
    document.body.appendChild(menu)

    // Position relative to the button using fixed coordinates.
    const btnRect = btn.getBoundingClientRect()
    menu.style.position = 'fixed'
    menu.style.top = `${btnRect.bottom + 2}px`
    menu.style.right = `${window.innerWidth - btnRect.right}px`

    // Close on outside click (after this event finishes).
    closeOnClick = (ev: MouseEvent) => {
      if (!menu?.contains(ev.target as Node) && ev.target !== btn) {
        closeMenu()
      }
    }
    setTimeout(() => document.addEventListener('click', closeOnClick!), 0)

    // Close on Escape.
    closeOnEscape = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        closeMenu()
      }
    }
    document.addEventListener('keydown', closeOnEscape)
  })

  return btn
}

// ── Selection helpers ──────────────────────────────────────────────────────

const SELECTED_CLASS = 'cmd-block-selected'

/**
 * Get the currently selected block's DOM element, if any.
 */
export function getSelectedBlock(container: HTMLElement): HTMLElement | null {
  return container.querySelector(`.${SELECTED_CLASS}`)
}

/**
 * Deselect all blocks inside the container. Returns true if a block was deselected.
 */
export function deselectAllBlocks(container: HTMLElement): boolean {
  const sel = getSelectedBlock(container)
  if (sel) {
    sel.classList.remove(SELECTED_CLASS)
    return true
  }
  return false
}

/**
 * Wire full-block click-to-select (P1-7).
 * Click (mousedown+up without significant movement) selects the block.
 * Drag (mousedown+move) starts text selection and does NOT select the block.
 * @param onSelect callback(id, selected) — notifies the manager of selection changes.
 */
function wireBlockSelection(
  blockEl: HTMLElement,
  container: HTMLElement,
  overflowBtn: HTMLElement,
  blockId: number,
  onSelect: (id: number, selected: boolean) => void,
): void {
  let mouseMoved = false

  blockEl.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.cmd-overflow-btn, .cmd-overflow-menu')) return
    mouseMoved = false
  })

  blockEl.addEventListener('mousemove', () => {
    mouseMoved = true
  })

  blockEl.addEventListener('mouseup', (e) => {
    if ((e.target as HTMLElement).closest('.cmd-overflow-btn, .cmd-overflow-menu')) return
    if (mouseMoved) return

    // Toggle selection: if already selected, deselect; otherwise select
    const currentlySelected = blockEl.classList.contains(SELECTED_CLASS)
    if (currentlySelected) {
      blockEl.classList.remove(SELECTED_CLASS)
      onSelect(blockId, false)
    } else {
      // Deselect others first (single-select P1-8)
      const prev = getSelectedBlock(container)
      if (prev) prev.classList.remove(SELECTED_CLASS)
      blockEl.classList.add(SELECTED_CLASS)
      onSelect(blockId, true)
    }
    mouseMoved = false
  })
}

// ── Block builders ─────────────────────────────────────────────────────────

/**
 * Create a frozen command block DOM element with header + serialized output.
 * `status` 'entered' (N6) is the block the ssh command froze into when the
 * remote session began: painted as neither success nor failure, no exit code.
 * The block DECLARES its kind (nocx-ex636); the rendering rules —
 * highlighting, wrapping, the status vocabulary — are read from it.
 */
export function createCommandBlock(
  kind: BlockKind,
  id: number,
  command: string,
  cwd: string,
  location: string,
  outputHtml: string,
  durationMs: number | null,
  exitCode: number | null,
  status: BuiltStatus,
  getContainer: () => HTMLElement,
  onSelect: (id: number, selected: boolean) => void,
  store: CommandSnapshotStore,
  // REQUIRED, and deliberately not defaulted (nocx-4em1z). Who wrote a
  // block is a fact every caller holds and none may shrug off: the restore
  // path defaulted it by omission and every restored tab forgot that the
  // assistant had run the command. This is the shape that hid the close
  // wrapper's dropped model too — an arity the type system was happy to
  // accept. A call site that forgets it must not compile.
  author: CommandAuthor,
  answerText?: AnswerTextSource,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cmd-block'
  // The block declares its kind once, in the DOM a person's tools can see:
  // the flow can tell a question from a command without reading the text
  // (nocx-ex636).
  wrapper.dataset.blockKind = kind
  const rules = blockKindRules(kind)
  // The entered block's own visual state (N6): frozen on environment entry,
  // neither success nor failure. The hook a stylesheet styles; the header
  // itself already refuses to paint an exit code or a failure for it.
  if (status === 'entered') wrapper.classList.add('cmd-block-entered')
  // A command carrying a vault reference renders its references as chips,
  // so the header's own text no longer spells the command. Copy reads the
  // full text from here — the reference intact, which is what the user
  // typed, what the store keeps, and what pastes usefully onto another
  // machine. renderRecordedCommand overwrites it with the masked text when
  // the ack lands, which is the same rule one step later.
  if (command && findReferences(command).length > 0) wrapper.dataset.recordedCommand = command
  wrapper.setAttribute('data-block-id', String(id))

  const header = createHeader(
    kind,
    command,
    cwd,
    location,
    durationMs,
    exitCode,
    status,
    store,
    author,
  )

  let outputEl: HTMLElement | null = null
  if (outputHtml && !isOutputEmpty(outputHtml)) {
    outputEl = document.createElement('div')
    outputEl.className = rules.outputClass
    outputEl.innerHTML = outputHtml
  }

  // Overflow menu (P2-9) — always the LAST element of the header-right
  // group (owner directive: ⋮ never shifts position). It reads the block's
  // copyable text from the BLOCK, at click time (nocx-ex636).
  const overflow = buildOverflowMenu(wrapper, command, answerText)
  const right = header.querySelector('.cmd-header-right')
  if (right) right.appendChild(overflow)
  wrapper.appendChild(header)
  if (outputEl) wrapper.appendChild(outputEl)

  // Full-block click-to-select with drag distinction (P1-7, P1-8).
  wireBlockSelection(wrapper, getContainer(), overflow, id, onSelect)

  // Double-click selects a whole token the way xterm does it (nocx-w7h.11,
  // spec v9 §2): xterm's SelectionService.handleMouseDown calls
  // preventDefault() FIRST — "Tell the browser not to start a regular
  // selection" — and only then branches on event.detail, computing the word
  // bounds from its own model and applying the selection once. The frozen
  // block mirrors that ordering. The browser's native word selection would
  // otherwise be created on the SECOND MOUSEDOWN (event.detail === 2),
  // before the dblclick event fires — observed by copy-on-select on mouseup
  // and copied, one word, before any later expansion could run. Intercepting
  // the mousedown means exactly one selection state exists, already correct,
  // and there is no race to order. A single mousedown (detail 1) is not
  // intercepted: drag selection and click-to-select keep working.
  wrapper.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.cmd-overflow-btn, .cmd-overflow-menu')) return
    if (e.detail !== 2) return
    e.preventDefault()
    const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY)
    if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return
    const line = caret.startContainer.parentElement?.closest<HTMLElement>(
      '.term-line, .cmd-header-text',
    )
    if (!line) return
    const range = wordRangeIn(line, caret.startContainer as Text, caret.startOffset)
    if (!range) return
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(range)
  })

  return wrapper
}

/**
 * Create a "running" block element — shows a spinner, no output area.
 */
export function createRunningBlock(
  id: number,
  command: string,
  cwd: string,
  location: string,
  getContainer: () => HTMLElement,
  onSelect: (id: number, selected: boolean) => void,
  store: CommandSnapshotStore,
  author: CommandAuthor = 'shell',
  /** What this block's ⋮ menu can do about the command while it runs. Absent
   *  in a bare-bones embedding, and then the menu is exactly what it was. */
  running?: RunningBlockActions,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cmd-block cmd-block-running'
  // A running block is a command in flight; it declares the command kind
  // like the block it will freeze into (nocx-ex636).
  wrapper.dataset.blockKind = 'command'
  if (command && findReferences(command).length > 0) wrapper.dataset.recordedCommand = command
  wrapper.setAttribute('data-block-id', String(id))

  const header = createHeader(
    'command',
    command,
    cwd,
    location,
    null,
    null,
    'running',
    store,
    author,
  )

  // Overflow menu — copying the command, plus what can be done ABOUT the
  // command while it is still running (nocx-92gfl, nocx-23rph).
  // Always the LAST element of header-right (owner directive).
  const overflow = buildOverflowMenu(wrapper, command, undefined, running)
  const right = header.querySelector('.cmd-header-right')
  if (right) right.appendChild(overflow)

  wrapper.appendChild(header)
  wireBlockSelection(wrapper, getContainer(), overflow, id, onSelect)

  return wrapper
}

/**
 * Freeze a running block: replace it with a frozen version.
 *
 * `status` is the presentation, never derived from the exit code: 'entered'
 * (N6) freezes on environment entry — neither success nor failure, no exit
 * code — and the old exitCode === null → 'failure' mapping is exactly the
 * bug this must not inherit. The D path passes 'success'/'failure' from the
 * real code; entry passes 'entered' with a null code.
 */
export function freezeBlock(
  el: HTMLElement,
  id: number,
  command: string,
  cwd: string,
  location: string,
  outputHtml: string,
  durationMs: number,
  exitCode: number | null,
  getContainer: () => HTMLElement,
  onSelect: (id: number, selected: boolean) => void,
  store: CommandSnapshotStore,
  status: 'success' | 'failure' | 'entered' | 'unknown',
  author: CommandAuthor = 'shell',
): HTMLElement {
  const newEl = createCommandBlock(
    'command',
    id,
    command,
    cwd,
    location,
    outputHtml,
    durationMs,
    exitCode,
    status,
    getContainer,
    onSelect,
    store,
    author,
  )
  if (el.parentNode) {
    el.parentNode.replaceChild(newEl, el)
  }

  return newEl
}

/**
 * Re-render a frozen block's command line once history.record acks: the
 * MASKED command with an unresolved chip at every redaction span — what
 * you see in the block is what went to the store, and the receipt has
 * something to point at when a row is hovered. The chips carry their
 * redaction span (data-redaction-start/end) so the receipt's hover can
 * emphasise exactly one.
 *
 * Copying the block copies the MASKED text: the full masked command lives
 * in data-recorded-command (the chips in the header are labels, never the
 * stored text), and the overflow menu prefers it over the pre-ack line.
 * This is the round's named trade — after the ack the renderer no longer
 * holds the plaintext for this block, and neither does the clipboard.
 */
export function renderRecordedCommand(
  blockEl: HTMLElement,
  maskedCommand: string,
  redactions: ReadonlyArray<{ kind: SecretKind; start: number; end: number }>,
): void {
  blockEl.dataset.recordedCommand = maskedCommand
  const headerText = blockEl.querySelector<HTMLElement>('.cmd-header-text')
  if (!headerText) return
  // The segments are plain text (no shell highlighting): a mask breaks the
  // token the highlighter would colour anyway, and the chips are the
  // emphasis now. Offsets are UTF-16 units into maskedCommand, clamped so
  const frag = document.createDocumentFragment()
  let pos = 0
  redactions.forEach((r, i) => {
    const from = Math.max(pos, Math.min(r.start, maskedCommand.length))
    const to = Math.max(from, Math.min(r.end, maskedCommand.length))
    if (from > pos) frag.appendChild(document.createTextNode(maskedCommand.slice(pos, from)))
    if (to > from) {
      const chip = createSecretChipUnresolved(KIND_LABELS[r.kind])
      chip.dataset.redactionIndex = String(i)
      chip.dataset.redactionStart = String(r.start)
      chip.dataset.redactionEnd = String(r.end)
      frag.appendChild(chip)
    }
    pos = to
  })
  if (pos < maskedCommand.length) {
    frag.appendChild(document.createTextNode(maskedCommand.slice(pos)))
  }
  headerText.replaceChildren(frag)
}

// ── Block manager ──────────────────────────────────────────────────────────

export interface BlockManagerOpts {
  now?: () => number
  /** The tab's command-existence snapshot store (OSC 636), passed through to
   *  every frozen header this manager creates. */
  snapshotStore: CommandSnapshotStore
  /** Fired when a DEFERRED freeze lands — the fence arrived, or the
   *  FENCE_DEFER_MS window elapsed and the block settled at the current
   *  output end. The freeze originated inside the manager (sightFence /
   *  the deferral timer), so the caller learns to settle the live region. */
  onDeferredFreeze?: () => void
  /** Fired at the end of EVERY visual freeze — the moment the frozen
   *  element replaces the running one and the block's output rows are fixed
   *  in the DOM (nocx-tjppv: the run tool's completion wait reads the
   *  output window from the frozen block, so it must observe this exact
   *  moment, not the logical freeze, which may still be waiting on the
   *  render fence). Fires after afterVisualFreeze, so a waiter that sets
   *  that slot and an observer here never race. */
  onBlockFrozen?: (rec: BlockRecord) => void
  /** The terminal grid, read at freeze time. It is capture PROVENANCE
   *  (ADR-0019 §6): the same rows serialized at a different width are a
   *  different rendering, and a reader that cannot tell has to guess. The
   *  manager holds no renderer, so the caller that does supplies it. */
  dimensions?: () => { cols: number; rows: number }
  /** What a session is called TO A PERSON, for a tool-call line that named
   *  one (nocx-vnzek). The manager holds no pane list, so the caller that
   *  does supplies the tab strip's own derivation
   *  (PaneManager.sessionDisplayName); the paint rule built on it lives in
   *  ui/tool-call-line.ts. Absent in a bare-bones embedding, and then a
   *  session simply cannot be named — never rendered as its id. */
  sessionName?: (sessionId: string) => string | null
  /** The durable text of one ANSWER entry, for the copy path (nocx-v13pd).
   *  The manager holds no socket, so the caller that does supplies the
   *  reader (restore-client.answerTextForEntry). Absent in a bare-bones
   *  embedding, and then copying an answer refuses rather than falling back
   *  to the painted text. */
  answerText?: AnswerTextSource
  /** What a RUNNING block's ⋮ menu can do about the command in it
   *  (nocx-92gfl, nocx-23rph). Passed straight to every running block this
   *  manager opens; this manager neither summons nor signals anything.
   *  Absent in a bare-bones embedding, and then the menu is what it was. */
  runningActions?: RunningBlockActions
}

export class BlockManager {
  private _blocks: BlockRecord[] = []
  /** Answer blocks (nocx-x8s2.2): the assistant's streamed replies, kept
   *  OUT of _blocks because they have no xterm line range — the freeze,
   *  serialize and reconstruction paths iterate _blocks and must never see
   *  a record with sentinel lines. They share the id space and the DOM
   *  selection API; the ask surface drives them through AnswerBlockHandle
   *  only. */
  private _answerBlocks: AnswerBlockRecord[] = []
  /** EVERY element this manager has put into `.scrollback-inner`: live
   *  command blocks, answer blocks, the restored past and the boundary that
   *  labels it. The typed lists above exist for what each KIND of block
   *  needs (a freeze range, a question); this exists for the one thing they
   *  share — they are the scrollback, and `clear` empties the scrollback.
   *
   *  So `clearAll` walks this and nothing else. Before it, restored blocks
   *  were inserted straight into the container by the controller, past the
   *  manager, and `clear` left the whole previous session on screen under
   *  its "Previous session" line because `clearAll` had no list that named
   *  it (nocx-0zb1m). A second list to look in would have been the same
   *  defect with a third thing to keep in step. */
  private _owned = new Set<HTMLElement>()
  private _nextId = 1
  private _now: () => number
  private _onBlockFrozen?: (rec: BlockRecord) => void
  private _scrollbackInner: HTMLElement
  private _xtermContainer: HTMLElement
  private _runningBlock: BlockRecord | null = null
  private _cmdStartTime: number | null = null
  /** Currently selected block id, or null if none selected (P1-8). */
  private _selectedBlockId: number | null = null
  private _snapshotStore: CommandSnapshotStore
  private _onDeferredFreeze?: () => void
  private _dimensions?: () => { cols: number; rows: number }
  /** The tab strip's answer to "what is this session called to a person",
   *  handed to every tool-call line this manager draws (nocx-vnzek). */
  private _sessionName?: (sessionId: string) => string | null
  /** Reader for an answer's durable text — handed to the copy menu of every
   *  answer block this manager frames (nocx-v13pd). */
  private _answerText?: AnswerTextSource
  private _runningActions?: RunningBlockActions
  /** The attempt id the running block is bound to (ADR-0024 §7 projection).
   *  Set when the published running fact binds the block; cleared when the
   *  block freezes or the scrollback is cleared. */
  private _attemptId: string | null = null
  /** Recent fence sightings keyed by hex (the buffer line they landed on),
   *  bounded by MAX_FENCE_SIGHTINGS. A sighting already present is a replay
   *  and is ignored; an entry is consumed when a completion's fence matches.
   *  This is the render-only half of the rendezvous — a fence with no
   *  authenticated event behind it changes nothing (ADR-0024 §1). */
  private _fences = new Map<string, number>()
  /** A completion whose LOGICAL freeze has landed but whose output boundary
   *  (the VISUAL freeze) is still waiting on the render fence: the rows are
   *  serialized when the fence bytes are sighted (hex set), or when the
   *  FENCE_DEFER_MS window settles at the current output end. A completion
   *  that carried no fence at all (hex null — unreachable from the kernel,
   *  which requires the nonce on completed attempts) still defers by the
   *  window rather than truncating at the event-time end: the boundary is
   *  never cut on the event alone. Only the settle path fires
   *  onDeferredFreeze, and only while no newer command owns the running
   *  slot. */
  private _pendingFence: {
    hex: string | null
    /** The block whose boundary is pending — already logically frozen,
     *  still in `_blocks`, never the running block. */
    rec: BlockRecord
    /** The output end at completion time — the fallback boundary when a
     *  newer command owns the cursor and `getEndLine` would serialize
     *  the newer command's output into this block. */
    endLine: number
    /** The terminal status the logical freeze already applied — the
     *  visual freeze hands it to the DOM exactly as the event decided. */
    status: FrozenStatus
    getLine: GetLineFn
    getEndLine: () => number
    timer: FenceTimer
  } | null = null
  /** The fence hex consumed by the last freeze — a replay of it (one seen
   *  for an already-frozen block) does nothing. */
  private _consumedFence: string | null = null

  constructor(scrollbackInner: HTMLElement, xtermContainer: HTMLElement, opts: BlockManagerOpts) {
    this._scrollbackInner = scrollbackInner
    this._xtermContainer = xtermContainer
    this._now = opts.now ?? (() => performance.now())
    this._snapshotStore = opts.snapshotStore
    this._onDeferredFreeze = opts.onDeferredFreeze
    this._onBlockFrozen = opts.onBlockFrozen
    this._dimensions = opts.dimensions
    this._sessionName = opts.sessionName
    this._answerText = opts.answerText
    this._runningActions = opts.runningActions
  }

  /** THE ONE DOOR into `.scrollback-inner`. Everything this manager shows
   *  goes through here and is remembered, so a new kind of child cannot be
   *  added without `clearAll` already knowing how to take it away. */
  private _own(el: HTMLElement, before: ChildNode | null): void {
    this._scrollbackInner.insertBefore(el, before)
    this._owned.add(el)
  }

  /** The visual freeze REPLACES a block's element (`freezeBlock` swaps it in
   *  the DOM), so ownership moves with it. Without this the set would hold a
   *  detached element and miss the attached one — the exact shape of the
   *  defect this ownership was written to close. */
  private _reown(oldEl: HTMLElement, newEl: HTMLElement): void {
    this._owned.delete(oldEl)
    this._owned.add(newEl)
  }

  /**
   * Draw blocks the STORE holds ABOVE everything the live session has, and
   * mark where the past ends (nocx-m3fqk).
   *
   * Inserted before the first child rather than appended, so restored blocks
   * keep the order they are given and a session that has already printed
   * something does not find its past underneath its present.
   *
   * The boundary is an element of its own rather than a class on the last
   * restored block: ADR-0019 §3 asks for the difference to be VISIBLE, and a
   * line saying where the previous session ended is what a person reads — a
   * block that merely looks a little different is not an answer to "is this
   * shell still running".
   *
   * It lives HERE, beside the live blocks, because one container may have
   * only one owner: the caller builds the elements, the manager is what puts
   * them on screen and what takes them off again (nocx-0zb1m). The caller
   * keeps the scroll decision, which is about the view and not about the
   * blocks.
   */
  restorePast(blocks: HTMLElement[]): void {
    if (blocks.length === 0) return
    const anchor = this._scrollbackInner.firstChild
    for (const el of blocks) this._own(el, anchor)
    const boundary = document.createElement('div')
    boundary.className = 'scrollback-restore-boundary'
    boundary.dataset.restoreBoundary = 'true'
    boundary.textContent = 'Previous session'
    this._own(boundary, anchor)
  }

  /** An id for a block this manager did not create: a RESTORED one, built
   *  from the store and handed back to `restorePast` (nocx-m3fqk).
   *
   *  From the same counter as every other block, because the id space is what
   *  selection and the DOM address blocks by — two spaces would let a
   *  restored block and a live one answer to the same number, and the
   *  selection would follow whichever the query found first. */
  nextRestoredId(): number {
    return this._nextId++
  }

  get blocks(): readonly BlockRecord[] {
    return this._blocks
  }

  get runningBlock(): BlockRecord | null {
    return this._runningBlock
  }

  /** A completed attempt whose DOM output boundary still awaits its fence. */
  get visualFreezePending(): boolean {
    return this._pendingFence !== null
  }

  get cmdStartTime(): number | null {
    return this._cmdStartTime
  }

  /** The currently selected block id, or null (P1-8). */
  get selectedBlockId(): number | null {
    return this._selectedBlockId
  }

  /** Lazy container supplier bound to this manager's scrollback inner. */
  private _getContainer = (): HTMLElement => this._scrollbackInner

  /**
   * Deselect the currently selected block without clearing the block list.
   * Safe to call from keyboard handlers (P0-4: Escape deselects).
   */
  deselectAll(): void {
    if (this._selectedBlockId !== null) {
      const el = this._scrollbackInner.querySelector('.cmd-block-selected')
      if (el) el.classList.remove('cmd-block-selected')
      this._selectedBlockId = null
    }
  }

  /** Programmatic single-select, NON-toggle (the ask affordance's visual
   *  anchor — nocx-x8s2.2). The mouse path owns toggling; activation
   *  selects so the block the chip names reads as selected, but selection
   *  NEVER activates (AD-8: selection is copy). The single-select
   *  invariant (P1-8) holds: the id and the DOM class move together. */
  selectBlock(blockEl: HTMLElement): void {
    const prev = getSelectedBlock(this._scrollbackInner)
    if (prev && prev !== blockEl) prev.classList.remove(SELECTED_CLASS)
    if (!blockEl.classList.contains(SELECTED_CLASS)) blockEl.classList.add(SELECTED_CLASS)
    const rec = this._blocks.find((b) => b.el === blockEl)
    this._selectedBlockId = rec?.id ?? null
  }

  /**
   * Called by wireBlockSelection when a block's selection state changes.
   * Keeps _selectedBlockId in sync with single-select semantics (P1-8).
   */
  _onBlockSelected(blockId: number): void {
    if (this._selectedBlockId === blockId) {
      // Clicking the already-selected block deselects it
      this._selectedBlockId = null
      return
    }
    // Deselect previous
    if (this._selectedBlockId !== null) {
      for (const b of this._blocks) {
        if (b.id === this._selectedBlockId) {
          b.el.classList.remove('cmd-block-selected')
        }
      }
    }
    this._selectedBlockId = blockId
  }

  /**
   * Called by wireBlockSelection when a block is deselected.
   */
  _onBlockDeselected(blockId: number): void {
    if (this._selectedBlockId === blockId) {
      this._selectedBlockId = null
    }
  }
  /**
   * Bind the running block to an authenticated attempt (ADR-0024 §7
   *  projection): the block opened at app submit binds when the published
   *  running fact arrives, and the freeze/abandon paths require the match.
   */
  bindAttempt(attemptId: string): void {
    this._attemptId = attemptId
    if (this._runningBlock) this._runningBlock.attemptId = attemptId
  }

  /** The block bound to an attempt id — running or frozen. */
  blockForAttempt(attemptId: string): BlockRecord | null {
    return this._blocks.find((b) => b.attemptId === attemptId) ?? null
  }

  /**
   * Start a new running block. Called on OSC 133 C.
   */
  /** Where this session is — `user@host`, or empty for a local shell. */
  private _location = ''

  setLocation(location: string): void {
    this._location = location
  }

  startBlock(
    command: string,
    cwd: string,
    startLine: number,
    outputStart = startLine,
    /** Who submitted the command (design §3.1, nocx-iadtt): the app-owned
     *  submit passes the minted author; a shell-originated block is the
     *  human's shell and defaults to 'shell'. */
    author: CommandAuthor = 'shell',
  ): BlockRecord {
    if (this._runningBlock) {
      this._finalizeRunningUnsafe()
    }

    const id = this._nextId++
    this._cmdStartTime = this._now()

    const el = createRunningBlock(
      id,
      command,
      cwd,
      this._location,
      this._getContainer,
      (bid, sel) => {
        if (sel) this._onBlockSelected(bid)
        else this._onBlockDeselected(bid)
      },
      this._snapshotStore,
      author,
      this._runningActions,
    )
    this._own(el, this._xtermContainer)

    const rec: BlockRecord = {
      id,
      command,
      cwd,
      author,
      durationMs: null,
      exitCode: null,
      status: 'running',
      startLine,
      // The output range and the creation line are two different things
      // (nocx-4yhi): the app-owned submit opens the block before the bytes
      // and passes outputStart = startLine + 1, because the shell's echo
      // of the command lands on the creation line and the block's body
      // must not repeat the command its header already shows. A
      // shell-originated block opens after its echo and keeps the default.
      outputStart,
      endLine: startLine,
      cReceived: false,
      el,
    }
    this._blocks.push(rec)
    this._runningBlock = rec
    this._startTicker(el)

    return rec
  }

  /**
   * Tick the running block's duration chip once a second.
   *
   * One timer for the one running block, cleared the moment it stops running —
   * there is never more than one, so this cannot accumulate the way a per-block
   * timer would.
   */
  private _ticker: ReturnType<typeof setInterval> | null = null

  private _startTicker(el: HTMLElement): void {
    this._stopTicker()
    const chip = el.querySelector('.cmd-header-duration')
    const started = this._cmdStartTime
    if (!chip || started === null) return
    this._ticker = setInterval(() => {
      chip.textContent = formatRunningDuration(this._now() - started)
    }, 1000)
  }

  private _stopTicker(): void {
    if (this._ticker === null) return
    clearInterval(this._ticker)
    this._ticker = null
  }
  freezeBlock(getLine: GetLineFn, endLine: number, exitCode: number | null): BlockRecord | null {
    const rec = this._runningBlock
    if (!rec) return null
    const status = this._logicalFreeze(rec, exitCode, exitCode === 0 ? 'success' : 'failure')
    this._freezeVisual(rec, getLine, endLine, status)
    return rec
  }

  /**
   * Freeze the running block on environment entry (N6): the ssh block freezes
   * with NO exit code, painted as neither success nor failure, and the
   * manager's running slot is freed for the remote commands that follow. The
   * model-level completion (history.record) happens later, at the local D,
   * via the ledger's completeTransition — this only paints the block.
   */
  freezeEntered(getLine: GetLineFn, endLine: number): BlockRecord | null {
    const rec = this._runningBlock
    if (!rec) return null
    const status = this._logicalFreeze(rec, null, 'entered')
    this._freezeVisual(rec, getLine, endLine, status)
    return rec
  }

  /** The LOGICAL freeze (u7uh.8): flip the block's record to its terminal
   *  state — status, exit code and duration land on the authenticated event
   *  alone; the running slot is freed and the ticker stops. The DOM is
   *  untouched: which rows belong to the block is the VISUAL freeze's
   *  question, and it waits for the render fence or the deferral window. */
  private _logicalFreeze(
    rec: BlockRecord,
    exitCode: number | null,
    status: FrozenStatus,
  ): FrozenStatus {
    this._stopTicker()
    rec.durationMs = this._cmdStartTime !== null ? this._now() - this._cmdStartTime : null
    this._cmdStartTime = null
    rec.exitCode = exitCode
    rec.status = status
    this._runningBlock = null
    return status
  }

  /** The VISUAL freeze: serialize the block's output region up to a boundary
   *  line and replace its running element with the frozen one. The boundary
   *  is the render fence's line when it was sighted, or the current output
   *  end when the deferral window settles; until this runs the block's rows
   *  are not yet fixed. */
  private _freezeVisual(
    rec: BlockRecord,
    getLine: GetLineFn,
    endLine: number,
    status: FrozenStatus,
  ): void {
    rec.endLine = endLine
    const snapshot = fromITheme(getCurrentTheme())
    const outputHtml = serializeRange(snapshot, getLine, rec.outputStart, endLine)
    // The DURABLE bodies, from the same rows and the same walk the frozen
    // block on screen is made of — so what comes back after a restart is
    // what was there, not a second reading of the buffer taken later.
    const dims = this._dimensions?.()
    if (dims) {
      rec.captured = {
        sgr: serializeRangeSGR(getLine, rec.outputStart, endLine),
        text: serializeRangeText(getLine, rec.outputStart, endLine),
        cols: dims.cols,
        rows: dims.rows,
      }
    }

    const newEl = freezeBlock(
      rec.el,
      rec.id,
      rec.command,
      rec.cwd,
      this._location,
      outputHtml,
      rec.durationMs ?? 0,
      rec.exitCode,
      this._getContainer,
      (bid, sel) => {
        if (sel) this._onBlockSelected(bid)
        else this._onBlockDeselected(bid)
      },
      this._snapshotStore,
      status,
      rec.author,
    )

    this._reown(rec.el, newEl)
    rec.el = newEl
    // Anything that wanted to decorate this block had to wait for THIS
    // moment, because the line above threw the running element away. One
    // shot, cleared before it runs so a callback that re-enters cannot loop.
    const after = rec.afterVisualFreeze
    if (after !== undefined) {
      rec.afterVisualFreeze = undefined
      after()
    }
    // The visual freeze is complete: the frozen element is in the DOM with
    // its output rows fixed. Observers (the run tool's completion wait,
    // nocx-tjppv) read the block's output window from THIS element. Fires
    // after afterVisualFreeze, so a waiter that sets that slot and an
    // observer here never race.
    this._onBlockFrozen?.(rec)
  }

  /** Freeze the block bound to the attempt, from the attempt's authenticated
   *  completion (ADR-0024 §5, §7). Guards itself: only a COMPLETED attempt
   *  may freeze a block as success/failure, and only the block bound to that
   *  attempt — the kernel derivation freezeBlock() is the authority, and
   *  this keeps the DOM operation honest if a caller bypasses it.
   *
   *  Render fence (u7uh.8): the LOGICAL freeze — status, exit code,
   *  duration, freeing the running slot — lands on the authenticated event
   *  ALONE; the ledger and history have already landed (the projection
   *  order guarantees it). Only the VISUAL freeze — which rows belong to
   *  the block — waits for the fence bytes: when the fence was already
   *  sighted, this serializes at its line and returns the record; otherwise
   *  it defers (returns null) and `sightFence` resolves the boundary, or
   *  the FENCE_DEFER_MS window settles it at the current output end. The
   *  caller keeps the live region up while the boundary is pending, so the
   *  in-flight tail renders live instead of vanishing; `getEndLine`
   *  supplies the fresh output end for the no-fence settle. */
  freezeFromAttempt(
    attempt: ExecutionAttempt,
    getLine: GetLineFn,
    endLine: number,
    getEndLine: () => number,
  ): BlockRecord | null {
    if (attempt.state !== 'completed') return null
    if (this._attemptId !== attempt.id) return null
    const code = attempt.exitCode ?? null
    const status = code === 0 ? 'success' : 'failure'
    const fence = attempt.fence
    const sighted = fence !== undefined ? this._fences.get(fence) : undefined
    const rec = this._runningBlock
    if (!rec) return null

    if (this._pendingFence !== null) {
      // Another completion wants the slot while one is pending. The pty
      // order means the older fence should have landed already; if it has
      // not, settle the older block at its completion-time end (never at
      // the newer command's cursor) rather than stranding it, then defer
      // this completion the same way. The newer block is still running
      // here, so the settle does not touch the live region.
      this._settlePendingFence()
    }

    // LOGICAL freeze — the authenticated event alone flips the block's
    // status, exit code and duration and frees the running slot.
    const terminal = this._logicalFreeze(rec, code, status)
    this._attemptId = null

    if (fence !== undefined && sighted !== undefined) {
      // Rendezvous complete: the fence bytes landed before the completion.
      // Its line IS the output end — serialize now, boundary included.
      this._fences.delete(fence)
      this._consumedFence = fence
      this._freezeVisual(rec, getLine, sighted, terminal)
      return rec
    }

    // The fence bytes are still in flight — or the completion carried no
    // fence at all (hex null; unreachable from the kernel, which requires
    // the nonce on completed attempts). Either way the visual freeze
    // defers: a sighting resolves a non-null fence, and the FENCE_DEFER_MS
    // window settles both at the current output end. The boundary is never
    // cut on the event alone. Null tells the caller the live region stays
    // up until the boundary settles.
    this._pendingFence = {
      hex: fence ?? null,
      rec,
      endLine,
      status: terminal,
      getLine,
      getEndLine,
      timer: setTimeout(() => this._settlePendingFence(), FENCE_DEFER_MS),
    }
    return null
  }

  /** Report where a fence landed. A fence with no authenticated event behind
   *  it changes nothing at all (ADR-0024 §1): the sighting is remembered for
   *  a completion that arrives later, and consumed — never applied — when
   *  it matches. A replay (the same hex twice, or one for an already-frozen
   *  block) does nothing. */
  sightFence(hex: string, line: number): void {
    if (this._consumedFence === hex) return // already-frozen block's fence
    if (this._fences.has(hex)) return // same value seen twice — a replay

    const pending = this._pendingFence
    if (pending !== null && pending.hex === hex) {
      // The deferred boundary's fence landed: serialize the block at the
      // fence's line. The block's STATUS flipped on the completion event —
      // this settles only which rows belong to it. A fence for a block that
      // has since been cleared changes nothing.
      this._pendingFence = null
      clearTimeout(pending.timer)
      if (!this._blocks.includes(pending.rec)) return
      this._freezeVisual(pending.rec, pending.getLine, line, pending.status)
      this._consumedFence = hex
      // Settle the live region only if no newer command owns the running
      // slot — a new command's live region must stay up.
      if (this._runningBlock === null) this._onDeferredFreeze?.()
      return
    }

    this._fences.set(hex, line)
    if (this._fences.size > MAX_FENCE_SIGHTINGS) {
      const oldest = this._fences.keys().next().value
      if (oldest !== undefined) this._fences.delete(oldest)
    }
  }

  /** The FENCE_DEFER_MS window elapsed with no fence: settle the visual
   *  freeze. While no newer command owns the running slot, the boundary is
   *  the CURRENT output end — the tail that was in flight at the completion
   *  has had the window to arrive, so this defers the boundary rather than
   *  truncating it. If a newer command owns the cursor, the current end
   *  would serialize the newer command's output into this block, so the
   *  boundary falls back to the completion-time end. The cost of a fence
   *  that never arrived is that the boundary is approximate. */
  private _settlePendingFence(): void {
    const pending = this._pendingFence
    if (pending === null) return
    this._pendingFence = null
    if (!this._blocks.includes(pending.rec)) return // block moved on (cleared)
    const boundary = this._runningBlock === null ? pending.getEndLine() : pending.endLine
    this._freezeVisual(pending.rec, pending.getLine, boundary, pending.status)
    this._consumedFence = pending.hex
    if (this._runningBlock === null) this._onDeferredFreeze?.()
  }

  private _cancelPendingFence(): void {
    if (this._pendingFence === null) return
    clearTimeout(this._pendingFence.timer)
    this._pendingFence = null
  }

  /** Freeze the running block bound to the attempt as abandoned: the
   *  attempt went `unknown` (loss, closure, native escape) — frozen, never
   *  successful, no reported exit code (ADR-0024 §5). Abandonment carries
   *  no fence and waits for none. */
  abandonAttempt(
    attempt: ExecutionAttempt,
    getLine: GetLineFn,
    endLine: number,
  ): BlockRecord | null {
    if (attempt.state !== 'unknown') return null
    if (this._attemptId !== attempt.id) return null
    const rec = this._runningBlock
    if (!rec) return null
    // No pending-boundary cancel here: a pending fence belongs to an older,
    // already logically frozen block (a lost fence), never to the running
    // block being abandoned — its timer settles it independently.
    const status = this._logicalFreeze(rec, null, 'unknown')
    this._freezeVisual(rec, getLine, endLine, status)
    this._attemptId = null
    return rec
  }

  /** Freeze a running block that never bound to an attempt at all. The
   *  block opened at the app-owned submit and the domain it was submitted
   *  under has ended, so no start and no completion can ever name it: `exit`
   *  destroys the shell that would have sent both, and against a real sshd
   *  the start frame does not get out before the transport dies (nocx-mlyu).
   *  A BOUND block is not this method's business — its attempt goes unknown
   *  and abandonAttempt freezes it, with the attempt as the authority. */
  abandonUnbound(getLine: GetLineFn, endLine: number): BlockRecord | null {
    if (this._attemptId !== null) return null
    const rec = this._runningBlock
    if (!rec) return null
    const status = this._logicalFreeze(rec, null, 'unknown')
    this._freezeVisual(rec, getLine, endLine, status)
    return rec
  }

  /**
   * Append an assistant answer block to the flow (nocx-x8s2.2): the
   * question as the header, the streamed answer text as the body. The
   * answer is plain text, NOT xterm output — it is rendered as escaped
   * term-lines at this boundary. The block declares the ask kind, so the
   * prose grammar (no shell highlight, wrapping body, its own status
   * words) follows from the kind's rules rather than from command rules
   * borrowed by accident (nocx-ex636). Returns the handle the ask surface
   * appends to and closes.
   *
   * A TURN IS DRAWN AS FRAGMENTS (nocx-9sqii), and this is what makes it
   * one. The block a `run` call opens is submitted through the ordinary
   * path and lands at the TAIL of the scrollback, which is where every new
   * block lands; so the only way an answer can read in the order it
   * happened is for it to stop at that point and continue below the block.
   * The turn therefore opens more than one block: the first carries the
   * question, each continuation carries the same stored identity, and every
   * one of them is an ordinary top-level block with a block's own selection,
   * copy and header.
   *
   * A turn that ran nothing opens exactly one, and it is the block this
   * method always returned.
   */
  addAnswerBlock(question: string, cwd: string): AnswerBlockHandle {
    /** One fragment: the block, its answer body, and the run of tool calls
     *  currently at the tail of that body. */
    interface Fragment {
      id: number
      el: HTMLElement
      outputEl: HTMLElement
      body: AnswerBody
      strip: ToolCallStrip
    }

    // Every fragment this turn has drawn, in the order it drew them — the
    // list the waiting state and the typing dots are retired across, because
    // both are facts about the TURN and the turn is now in several places.
    const fragments: HTMLElement[] = []
    let next = 0
    // Sealed: a call that opens a block took this position, so the fragment
    // that was being written is finished and the next content opens a new
    // one BELOW whatever the scrollback has grown since — which is the
    // block. Nothing is ever repainted into a position it has left.
    let sealed = false
    // Captured here rather than read off `this` inside the returned handle:
    // the handle's methods are declared `this: void` and are called as bare
    // functions.
    const sessionName = this._sessionName
    // WHEN THE TURN STARTED. A turn takes time — the model thinks, the tools
    // run — and a person wants to know how long as much as they want to know
    // that `df` took 27ms (nocx-hoeq3). Measured on the RENDERER's clock,
    // from the question being submitted to the run terminalizing, which is
    // exactly how a command's duration is measured a few hundred lines up
    // (_cmdStartTime); a restored turn shows the store's own figure, and a
    // restored command already does the same.
    const now = this._now
    const startedAt = now()

    // The waiting chip says the model has not answered yet; it stops the
    // moment the first delta lands, and a run that fails before any text
    // must stop waiting too (the timeout sentence and the waiting state are
    // two ends of one fact, nocx-ex636).
    //
    // The dots stand in for TEXT THAT IS NOT THERE YET, so anything that
    // puts content in the body retires them — a tool call and the thinking
    // note both do, and the header's "thinking" chip deliberately does NOT
    // go with them: the model has done something, and it has not answered.
    // Retiring the chip there would leave the corner silent while the run is
    // still working.
    //
    // ACROSS EVERY FRAGMENT, because both are facts about the TURN: an
    // answer whose first prose landed in a continuation would otherwise
    // leave the dots typing forever under the question.
    const stopTyping = (): void => {
      for (const el of fragments) el.querySelector('.cmd-answer-typing')?.remove()
    }

    const stopWaiting = (): void => {
      for (const el of fragments) {
        el.querySelector('.cmd-answer-waiting')?.remove()
        el.querySelector('.cmd-answer-waiting-pulse')?.remove()
      }
      // Both ends of one fact: the corner stops reporting work and the body
      // stops standing in for text. A run that fails before any delta clears
      // both, or the dots would go on typing an answer that will never
      // arrive.
      stopTyping()
    }

    const buildFragment = (index: number): Fragment => {
      const id = this._nextId++
      const el = createCommandBlock(
        'ask',
        id,
        question,
        cwd,
        this._location,
        '',
        null,
        null,
        // The question is out and no answer has arrived: the header paints
        // the ask kind's in-progress word ("thinking") beside a live pulse,
        // and the body shows the typing dots — both of which the first delta
        // — or a terminal close — removes.
        //
        // A CONTINUATION is opened only once the turn is already writing
        // into it, so it never waits: it is drawn as SETTLED — finished, with
        // no outcome of its own — and the duration and the terminal chip land
        // on whichever fragment is last when the turn closes. It used to say
        // `success` here, which was harmless only while nothing read the
        // value; the header reads it now, and a continuation claiming an
        // outcome would tell a reader the turn ended halfway down itself
        // (nocx-hoeq3).
        index === 0 ? 'waiting' : 'settled',
        this._getContainer,
        (bid, sel) => {
          if (sel) this._onBlockSelected(bid)
          else this._onBlockDeselected(bid)
        },
        this._snapshotStore,
        // The default author, named because the parameter after it is the one
        // that matters here: an answer block's copy reads the ledger.
        'shell',
        this._answerText,
      )
      // The turn's stored identity, on every fragment: the ledger entry the
      // question and the answer both belong to. The ask surface sets it on
      // the FIRST fragment when agent.ask resolves; a continuation opened
      // later copies it, so the copy path finds the same stored answer from
      // any fragment of the turn and a reader can tell one turn's fragments
      // from a second answer.
      const first = fragments[0]
      if (first?.dataset.entryId !== undefined) el.dataset.entryId = first.dataset.entryId
      if (first?.dataset.answeredBy !== undefined) el.dataset.answeredBy = first.dataset.answeredBy
      markTurnFragment(el, index)
      const outputEl = document.createElement('div')
      // The ask kind's body class comes from the kind's rules — the wrap
      // policy is owned there, never a second copy (nocx-ex636).
      outputEl.className = blockKindRules('ask').outputClass
      outputEl.dataset.answerBody = ''
      if (index === 0) {
        // The answer's body says it is being written, WHERE it will be
        // written. The header chip is in the corner a person checks; the body
        // is where they are already looking, and an empty body under a
        // finished question is indistinguishable from a product that did
        // nothing. Removed by the first delta, so the dots are replaced by
        // the text they stood in for.
        const typing = document.createElement('span')
        typing.className = 'cmd-answer-typing'
        typing.setAttribute('aria-label', blockKindRules('ask').statusChips!.inProgress)
        for (let i = 0; i < 3; i++) typing.appendChild(document.createElement('i'))
        outputEl.appendChild(typing)
      }
      el.appendChild(outputEl)
      this._own(el, this._xtermContainer)
      this._answerBlocks.push({ id, question, el })
      fragments.push(el)
      // The body is drawn by its ONE owner (answer-body.ts) — the same
      // function a RESTORED answer draws through, so a turn that comes back
      // after a restart is painted by the code that painted it live
      // (nocx-4em1z). What stays here is the block: its header, its chips,
      // the waiting state, and the elements this flow places through the body
      // in arrival order.
      const body = createAnswerBody(outputEl, {
        store: this._snapshotStore,
        onContent: stopTyping,
      })
      return { id, el, outputEl, body, strip: createToolCallStrip(body, { sessionName }) }
    }

    let current = buildFragment(next++)
    const head = current.el
    const headId = current.id

    /** The fragment the turn is writing into — opening a continuation when a
     *  block has taken the position the last one ended at. */
    const writable = (): Fragment => {
      if (!sealed) return current
      sealed = false
      current = buildFragment(next++)
      return current
    }

    // The flow's non-text elements (nocx-shxv0, nocx-s92so). Both are placed
    // in the SAME body as the prose, in arrival order, because that order is
    // the product fact: a call rendered anywhere else stops saying when it
    // happened.
    const seenCalls = new Set<string>()
    let reasoningNote: ReasoningNote | null = null

    return {
      id: headId,
      el: head,
      toolCall(call: AnswerToolCall): void {
        if (seenCalls.has(call.callId)) return
        seenCalls.add(call.callId)
        if (call.opensBlock) {
          // THE BLOCK IS THE ACCOUNT OF THIS CALL (nocx-9sqii). The command
          // is submitted through the ordinary path and opens a top-level
          // block at the tail; a line here would restate the command, the
          // output and the exit status that block already owns, and it was
          // the EMPTY half of the two positions one command used to occupy.
          //
          // What the line owned is WHEN, and the block owns that too by
          // standing exactly here: the fragment being written stops, and the
          // answer continues below the block.
          current.strip.end()
          current.body.finish()
          sealed = true
          return
        }
        const frag = writable()
        frag.strip.add({ tool: call.tool, effect: call.effect, resource: call.resource })
      },
      reasoning(text: string): void {
        if (text === '') return
        const frag = writable()
        if (!reasoningNote) {
          // Open or shut as the setting says at the moment the model starts
          // thinking (nocx-y9e88). A note built while the setting was off and
          // then switched on is caught by the applier, which walks what is
          // already on screen — this is the other half of the same rule.
          reasoningNote = createReasoningNote({ expanded: reasoningStartsExpanded() })
          frag.strip.end()
          frag.body.insert(reasoningNote.el)
        }
        reasoningNote.append(text)
      },
      append(text: string): void {
        if (text === '') return
        stopWaiting()
        const frag = writable()
        // Prose ends the run of calls above it: a run is CONSECUTIVE, or it
        // is two runs with something between them.
        frag.strip.end()
        frag.body.append(text)
      },
      close(status: 'success' | 'failure', error?: string, model?: string): void {
        stopWaiting()
        current.strip.end()
        current.body.finish()
        // The terminal state lands on the LAST fragment the turn drew, which
        // is where the turn ended. A turn sealed by a call that produced no
        // further prose closes on the fragment above its block — the turn did
        // stop there, and opening an empty continuation to carry a chip would
        // put a block on screen with nothing in it.
        const el = current.el
        // The header's right-hand group, from its ONE owner (nocx-hoeq3):
        // how long the turn took and how it ended, as the ask kind's rules
        // say them. This used to build a chip of its own here — with the
        // right words and the wrong class list, and no duration beside it —
        // so a turn's header held one chip where a command's held two.
        const right = el.querySelector('.cmd-header-right')
        if (right) settleHeaderRight(right, 'ask', now() - startedAt, { status, exitCode: null })
        // The model that answered, on the answer itself (nocx-e6kn2): the
        // person must be able to tell which model answered without going to
        // look it up. The value is the ask result's pinned model — this run's
        // fact, never a re-derivation.
        if (status === 'success' && model) {
          const note = document.createElement('div')
          note.className = 'cmd-answer-provenance'
          note.textContent = `answered by ${model}`
          current.outputEl.appendChild(note)
        }
        if (error) {
          const note = document.createElement('div')
          note.className = 'cmd-answer-error'
          note.textContent = error
          current.outputEl.appendChild(note)
        }
      },
    }
  }

  clearAll(): void {
    this._stopTicker()
    this._cancelPendingFence()
    // ONE list, because there is one owner: whatever this manager put in
    // the container comes out, whether it was a live block, an answer or a
    // restored one under its boundary (nocx-0zb1m).
    for (const el of this._owned) el.remove()
    this._owned.clear()
    this._blocks = []
    this._answerBlocks = []
    this._runningBlock = null
    this._cmdStartTime = null
    this._selectedBlockId = null
    this._attemptId = null
    this._fences.clear()
    this._consumedFence = null
  }

  private _finalizeRunningUnsafe(): void {
    // Note: a pending render-fence boundary belongs to an ALREADY logically
    // frozen block, never to the running block this finalizes — its timer
    // settles it independently, guarded by the running slot.
    this._stopTicker()
    if (!this._runningBlock) return
    this._runningBlock.status = 'failure'
    this._runningBlock.exitCode = null
    this._runningBlock = null
    this._cmdStartTime = null
    this._attemptId = null
  }

  dispose(): void {
    this.clearAll()
  }
}

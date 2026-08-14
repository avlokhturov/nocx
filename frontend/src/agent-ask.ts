// The ask transaction's renderer half (nocx-x8s2.2): an AgentInputTarget
// routes a submitted question through InputTargetRegistry.active() — the
// ADR-0004 §3 seam (the editor stays passive; the target decides where a
// submitted document goes). Submitting mints the frozen frame from the
// selected block through mintFrozenFrame (the ONE derivation — a frozen
// block has no xterm cells left, and its text was already transformed by
// the serializer), ingests it with agent.captureFrame, asks with
// agent.ask, and streams the answer into an answer block in the flow.
//
// The wire shapes are declared once in contracts/agent.*.schema.json; the
// types here are generated from them.

import { Dispatcher } from './dispatcher'
import { frozenFrameSourceFromBlock, mintFrozenFrame } from './frame/frozen'
import type { AgentAsk } from './generated/agent.ask'
import type { AgentCaptureFrame } from './generated/agent.captureFrame'
import type { AgentRunDelta } from './generated/agent.runDelta'
import type { AgentRunState } from './generated/agent.runState'
import type { InputTarget } from './input-target'
import type { AnswerBlockHandle } from './scrollback/blocks'
import { SERIALIZER_VERSION } from './scrollback/serializer'

export interface AgentAskSeams {
  /** The tab's JSON-RPC dispatcher (agent.* methods + notifications). */
  dispatcher: Dispatcher
  /** The tab's session id — backend-authoritative, never the renderer's own. */
  sessionId: () => string
  /** The block the ask is about — the ask chip's block, resolved from the
   *  chip (the mode's scope), never re-derived from DOM selection (AD-8:
   *  selection is copy; the chip is the mode). The surface keeps this in
   *  lockstep with the chip's lifecycle: non-null exactly while the agent
   *  target is active. */
  askBlock: () => HTMLElement | null
  cwd: () => string
  /** Render the answer block for one ask; the returned handle is the ONLY
   *  way the block's body and status change. */
  openAnswer: (question: string, cwd: string) => AnswerBlockHandle
  /** A refusal the surface must render (e.g. "no endpoint configured") —
   *  the product's rule: a soft degrade is visible, never only in a log.
   *  The ask surface raises it through the kit's one notification
   *  affordance. */
  onRefusal: (message: string) => void
}

/** The wire params of agent.captureFrame for a frozen frame (design §2.2:
 *  text rows, no cursor, no identity/range — the backend's validation
 *  enforces exactly this shape). */
interface FrozenCaptureParams {
  captureId: string
  sessionId: string
  source: 'frozen'
  rows: { kind: 'text'; text: string }[]
  serializerVersion: number
  cwd: string
}

/** The wire params of agent.ask. */
interface AskParams {
  askId: string
  sessionId: string
  question: string
  cwd: string
  references: { frameId: string; region: { rowStart: number; rowEnd: number } }[]
}

/**
 * The agent input target: a submitted document is a QUESTION about the
 * selected block. Constructed with its seams (like ShellInputTarget); it
 * holds no store and no editor.
 */
export class AgentInputTarget implements InputTarget {
  readonly id = 'agent'
  readonly label = 'Agent'
  /** A question is not a shell command: the composition root must not run
   *  the shell submit orchestration (keyboard handoff, ledger record,
   *  running block, attempt) for it (nocx-x8s2.2). */
  readonly routesToShell = false
  /** runId → the answer block the deltas append to. The renderer routes by
   *  runId AND entryId (both are on every delta) — "the current answer" is
   *  not an identity, and two overlapping asks land on their own blocks. */
  private readonly runs = new Map<number, AnswerBlockHandle>()
  private subscribed = false

  constructor(private readonly seams: AgentAskSeams) {}

  /** Submit a question about the selected block: ingest the frozen frame
   *  FIRST (the backend mints the frame id), then ask, then stream. */
  async submit(doc: string): Promise<void> {
    const block = this.seams.askBlock()
    if (!block) return // no block selected — the ask has nothing to point at
    this.ensureSubscribed()

    const frame = mintFrozenFrame(frozenFrameSourceFromBlock(block))
    // A frozen frame's rows are text BY CONSTRUCTION (the frozen mint never
    // emits cells — design §2.2). A cells row here means the minting
    // invariant broke; that is a loud failure, never silently-empty text.
    const rows = frame.rows.map((r): { kind: 'text'; text: string } => {
      if (r.kind !== 'text') {
        throw new Error('agent-ask: a frozen frame minted a non-text row')
      }
      return { kind: 'text', text: r.text }
    })
    const captureId = crypto.randomUUID()
    const sessionId = this.seams.sessionId()
    const cwd = this.seams.cwd()

    const captureParams: FrozenCaptureParams = {
      captureId,
      sessionId,
      source: 'frozen',
      rows,
      serializerVersion: SERIALIZER_VERSION,
      cwd,
    }
    const capture = await this.seams.dispatcher.call<AgentCaptureFrame>(
      'agent.captureFrame',
      captureParams,
    )
    const frameId = capture.frameId

    const askParams: AskParams = {
      askId: crypto.randomUUID(),
      sessionId,
      question: doc,
      cwd,
      references: [
        {
          frameId,
          region: { rowStart: 0, rowEnd: frame.rows.length },
        },
      ],
    }
    const ask = await this.seams.dispatcher
      .call<AgentAsk>('agent.ask', askParams)
      .catch((err: unknown) => {
        // A refusal (no endpoint configured) is a renderable condition, not a
        // server fault: the surface says so instead of leaving the editor
        // accepting questions nothing answers.
        const message = err instanceof Error ? err.message : String(err)
        this.seams.onRefusal(message)
        throw err
      })

    const handle = this.seams.openAnswer(doc, cwd)
    // The answer entry id is KNOWN here, before the first delta — a run
    // that fails before any text still has its block associated, and the
    // terminal state closes the right one.
    handle.el.dataset.answerEntryId = ask.answerEntryId
    this.runs.set(ask.runId, handle)
  }

  /** Subscribe once: deltas append to the run's block; the terminal state
   *  closes it. A runState with no prior delta (a failure before any text)
   *  still has a block — the ask result's answerEntryId opened it. */
  private ensureSubscribed(): void {
    if (this.subscribed) return
    this.subscribed = true
    this.seams.dispatcher.subscribe('agent.runDelta', (params: unknown) => {
      const d = params as AgentRunDelta
      const handle = this.runs.get(d.runId)
      if (!handle) return
      // Both ids are on every delta on purpose (design §7): the run id
      // finds the ask, the entry id confirms the deltas land on the right
      // answer block — a mismatch is a stale or misrouted notification and
      // must not append to the wrong block.
      if (handle.el.dataset.answerEntryId !== d.entryId) return
      handle.append(d.text)
    })
    this.seams.dispatcher.subscribe('agent.runState', (params: unknown) => {
      const s = params as AgentRunState
      const handle = this.runs.get(s.runId)
      if (!handle) return
      if (handle.el.dataset.answerEntryId === undefined) {
        // A run that failed before its first delta never carried the entry
        // id on a delta — but the block was opened from the ask result, and
        // the entry id was recorded there. If it is still missing, the
        // block was never associated: nothing to close.
        return
      }
      if (s.state === 'completed' || s.state === 'cancelled') {
        handle.close('success')
      } else if (s.state === 'failed' || s.state === 'interrupted') {
        handle.close('failure', s.error ?? s.state)
      }
      this.runs.delete(s.runId)
    })
  }
}

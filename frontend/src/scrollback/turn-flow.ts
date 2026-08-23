// The turn's flow: one causal sequence, projected as itself (nocx-9sqii).
//
// WHAT WAS WRONG. A turn was ONE block (ADR-0036) and the command it ran was
// another, appended at the tail of the scrollback — so the reader met the
// answer before the evidence it was distilled from:
//
//     causal:  question -> tool call -> evidence -> answer
//     drawn:   question -> call marker -> answer  -> evidence
//
// The `▸ run` line was empty for the same reason the block was in the wrong
// place: one command occupied two positions and the useful half was in the
// one nobody reads first.
//
// WHAT THIS OWNS. The projection, and only the projection: given the answer's
// prose and what the turn caused, in what order does a reader meet them. The
// arrangement is a projection OF the relation and never a fact the renderer
// stores (ADR-0019) — every input here is the ledger's, including the anchor
// that says where in the prose each cause sat.
//
// THE ARRANGEMENT IS FLAT, AND THE ALTERNATIVES WERE REJECTED DELIBERATELY.
// The command stays an ORDINARY top-level block, drawn between the fragments
// of the answer at the point the call happened. Nesting it inside the turn's
// body would put a fixed VT grid, which must not re-wrap, inside reflowing
// prose — and the nested block would then have to be argued back into being a
// first-class block for selection, copy and block navigation. Hoisting it
// above the question would claim the command preceded the intent that caused
// it, and in a terminal vertical position is a claim about time.
//
// WHAT SURVIVES FROM nocx-shxv0. Its ownership rule, unchanged: the BLOCK
// owns the command, the answer's LINE owns WHEN. What was wrong was never
// that rule — it was that the two owners were drawn in different
// neighbourhoods. So for a tool that opens a block the line is gone and the
// block stands in its position, and for a tool that opens none the line is
// still the only thing that says the call occurred.
import {
  createToolCallLine,
  type ToolCallEffect,
  type ToolCallLineSpec,
} from '../ui/tool-call-line'
import type { ToolCallLineDeps } from '../ui/tool-call-line'
import { createToolCallGroup, type ToolCallGroup } from '../ui/tool-call-group'

/** One entry a turn caused, as the flow places it — the ledger's `caused`
 *  row (contracts/ledger.get.schema.json), narrowed to what placing needs.
 *  Nothing here is derived: the anchor, the order, the effect, the resource
 *  and "did this open a block" are all the store's. */
export interface TurnCause {
  entryId: string
  /** How much of the answer had been written when this happened, in UTF-16
   *  code units — the offset the prose is cut at. */
  at: number
  kind: 'shell' | 'agent' | 'action'
  /** The caused row's own intent: the command line for a shell entry, the
   *  declared tool name for an action. */
  intent: string
  /** The effect the gate decided, for an action. Null on every other kind. */
  effect: ToolCallEffect | null
  resource: { kind: string; id: string } | null
  /** Whether this call's work became a top-level block of its own. */
  opensBlock: boolean
}

/** One thing a reader meets, in the order they meet it. */
export type TurnPiece =
  | { kind: 'text'; text: string }
  | { kind: 'call'; call: ToolCallLineSpec }
  | { kind: 'block'; entryId: string }

/**
 * How many consecutive calls it takes before the run is compacted.
 *
 * FOUR, and the number is a reading judgement rather than a law. One, two or
 * three calls read as sentences about what the assistant did and belong in
 * the flow; the bead's own criterion is that FIVE must not read as five lines
 * of log above the answer. Four is the first count where the run is longer
 * than the answer it precedes more often than not.
 */
export const TOOL_CALL_GROUP_THRESHOLD = 4

/**
 * The pieces of one turn, in the order a reader meets them.
 *
 * `answer` is the prose — null when there is none to show (retention took
 * it, or it was never stored), which costs the cuts and nothing else: the
 * calls a turn made are entries of their own and survive the loss of the
 * text, and a turn that went silent about work that really happened is the
 * defect, not the degrade.
 *
 * `causes` arrive in the causal order the turn assigned. The anchors are
 * clamped forward-only into the prose: an anchor behind the one before it,
 * or past the end of the text, places the cause where the prose actually is
 * rather than cutting backwards. Neither can happen from a run that wrote its
 * own anchors, and both can happen to a page that mixes a rewritten answer
 * with the causes of the run that wrote the first one.
 */
export function turnPieces(answer: string | null, causes: readonly TurnCause[]): TurnPiece[] {
  const text = answer ?? ''
  const pieces: TurnPiece[] = []
  let cut = 0
  for (const c of causes) {
    const at = Math.max(cut, Math.min(c.at, text.length))
    if (at > cut) {
      pieces.push({ kind: 'text', text: text.slice(cut, at) })
      cut = at
    }
    // An ACTION whose work became a block has no line: the block beside it —
    // the shell entry of the command it ran, one cause further along — is the
    // account of that call, and a line would restate the command, the output
    // and the exit status the block already owns.
    if (c.kind === 'action') {
      if (c.opensBlock) continue
      pieces.push({
        kind: 'call',
        call: {
          tool: c.intent,
          // The effect the backend decided. A row carrying none is drawn as
          // an observation rather than not at all — the line says a call
          // happened, which is the fact — and the renderer may never derive
          // an effect from a tool name (ADR-0028 decision 4).
          effect: c.effect ?? 'observe',
          resource: c.resource ?? undefined,
        },
      })
      continue
    }
    pieces.push({ kind: 'block', entryId: c.entryId })
  }
  if (cut < text.length) pieces.push({ kind: 'text', text: text.slice(cut) })
  return pieces
}

/** Where a strip puts what it draws — the answer body's own placement seam,
 *  narrowed to the one method, so a strip can be driven by a test with no
 *  answer body at all. */
export interface StripTarget {
  insert(node: HTMLElement): void
}

/** A run of consecutive tool calls in one flow. */
export interface ToolCallStrip {
  /** Draw one call at the tail of the run. */
  add(call: ToolCallLineSpec): void
  /** Something that is not a call arrived: the run ends here, and the next
   *  call starts a new one. */
  end(): void
}

/**
 * Draw a run of tool calls, compacting it once it is long enough to read as
 * a log (TOOL_CALL_GROUP_THRESHOLD).
 *
 * The compaction happens IN PLACE, at the position the run began: the lines
 * already drawn move into the group and the group takes the first line's
 * slot. Appending the group at the tail instead would move the run below
 * prose that was written after it, which is the defect this whole bead is
 * about in miniature.
 */
export function createToolCallStrip(
  target: StripTarget,
  deps: ToolCallLineDeps = {},
): ToolCallStrip {
  let run: HTMLElement[] = []
  let group: ToolCallGroup | null = null
  return {
    add(call: ToolCallLineSpec): void {
      const line = createToolCallLine(call, deps)
      if (group) {
        group.add(line)
        return
      }
      target.insert(line)
      run.push(line)
      if (run.length < TOOL_CALL_GROUP_THRESHOLD) return
      const first = run[0]
      const parent = first.parentElement
      if (!parent) return
      // The slot is read BEFORE the group is built: building it ADOPTS every
      // line out of this parent, so a reference to one of them is no longer a
      // place here. What stays is whatever followed the run — usually
      // nothing, since a run is drawn at the tail.
      const after = run[run.length - 1].nextSibling
      const built = createToolCallGroup(run)
      parent.insertBefore(built.el, after)
      group = built
    },
    end(): void {
      run = []
      group = null
    },
  }
}

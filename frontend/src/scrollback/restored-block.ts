// A block built from the STORE rather than from a terminal buffer
// (nocx-cjct0, design §6).
//
// The live path builds a block from IBufferLines it can still read. A
// restored block has no buffer — the process that drew it is gone (D5) — so
// it is built from the entry's facts and the body the capture stored, and it
// goes through the SAME createCommandBlock the live path ends at. One owner
// of what a block looks like; only where the rows come from differs.
//
// ADR-0019 §3: nothing in the UI may imply live resumption. Every block this
// makes carries `data-restored`, which is what the surrounding CSS and any
// action gate read — a restored block offers nothing that needs a process.
import {
  blockKindRules,
  createCommandBlock,
  markTurnFragment,
  type BlockKind,
  type FrozenStatus,
} from './blocks'
import { createAnswerBody } from './answer-body'
import { createToolCallStrip, turnPieces, type TurnCause } from './turn-flow'
import { type ToolCallLineDeps, type ToolCallLineSpec } from '../ui/tool-call-line'
import type { CommandAuthor } from '../command-ledger'
import type { CommandSnapshotStore } from '../command-snapshot'
import { attrsToStyle, type TerminalSnapshot } from './serializer'
import { runsFromSGR } from './sgr-read'

/** What a restored block is made of: the entry's facts, and its body. */
export interface RestoredBlockFacts {
  /** The renderer-local block id, minted by the caller like a live one. */
  id: number
  command: string
  cwd: string
  /** `user@host` for a block that ran on a far host, '' for a local one.
   *  Restored from the entry's own environment: a block keeps saying where it
   *  ran even when the pane it is in is local again (design §7). */
  location: string
  /** How long it took, or NULL for no duration chip at all — which is what
   *  an intermediate fragment of a turn carries: the turn's outcome belongs
   *  to where the turn ended, not halfway down it (nocx-9sqii). */
  durationMs: number | null
  exitCode: number | null
  status: FrozenStatus
  /**
   * The stored SGR body, or NULL when there is none to show.
   *
   * Null is a real state and it is not "printed nothing": retention evicts
   * bodies while their entries stay (ADR-0019 §7), so a block whose artifact
   * is gone must say the output is gone. An empty STRING is the other thing —
   * a command that printed nothing — and the two must not render alike.
   */
  body: string | null
  /** WHO submitted it. Restored from the entry's own kind, which is what
   *  that column means — and dropping it is the whole of the badge half of
   *  nocx-4em1z: this call omitted the argument, the parameter defaulted to
   *  'shell', and every restored tab forgot that the assistant had run the
   *  command. The parameter is required now, so the omission cannot come
   *  back silently. */
  author: CommandAuthor
  /** What the block IS, read from the body the entry actually has
   *  (restore-client.ts restoredBody): a terminal body is a command, a
   *  text/plain original with no terminal body beside it is an assistant
   *  turn. It decides the grammar — a grid must not re-wrap and prose must
   *  (nocx-ex636) — and it is the half of nocx-4em1z that brings dialogues
   *  back as the blocks they were. */
  kind: BlockKind
  /** The ledger entry this was built from. Carried into the DOM because the
   *  copy path reads the STORED answer by it (nocx-v13pd) rather than
   *  scraping the painted rows, and a restored turn must copy exactly as a
   *  live one does. */
  entryId?: string
  /**
   * What goes in this block's answer body, in the order a reader meets it —
   * the prose and the tool-call lines of ONE fragment of a turn
   * (scrollback/turn-flow.ts owns the projection that produces them).
   *
   * Ignored for a COMMAND block: an action belongs to the turn that made it,
   * and a command that grew a call line would be a second owner of it.
   */
  pieces?: FragmentPiece[]
  /** Which fragment of its turn this block is, when the turn was drawn as
   *  several (nocx-9sqii). Absent for a command. */
  fragment?: number
}

/** One thing inside a fragment's answer body. A `block` piece is not here:
 *  a block is not IN a fragment, it is what ends one. */
type FragmentPiece = { kind: 'text'; text: string } | { kind: 'call'; call: ToolCallLineSpec }

/** The sentence a block shows where its output used to be. */
const EVICTED = 'Output is no longer kept'

/** Render a stored body as the rows the live path produces: one term-line
 *  per logical row, its runs styled through the serializer's own mapping. */
export function bodyToHTML(snapshot: TerminalSnapshot, body: string): string {
  if (body === '') return ''
  return body
    .split('\n')
    .map((row) => {
      const inner = runsFromSGR(snapshot, row)
        .map((run) => {
          const style = attrsToStyle(snapshot, run.attrs)
          return style ? `<span style="${style}">${run.chars}</span>` : run.chars
        })
        .join('')
      return `<span class="term-line">${inner}</span>`
    })
    .join('')
}

/**
 * Build one restored block.
 *
 * The snapshot is the CURRENT theme's, not one stored with the block: that is
 * the whole reason the durable body keeps colour as SGR (nocx-2f0f). A
 * restored block repaints with everything else when the theme changes.
 */
export function restoredBlock(
  facts: RestoredBlockFacts,
  snapshot: TerminalSnapshot,
  getContainer: () => HTMLElement,
  onSelect: (id: number, selected: boolean) => void,
  store: CommandSnapshotStore,
  deps: ToolCallLineDeps = {},
): HTMLElement {
  // A TURN's body is prose and is drawn by the answer body's own renderer —
  // the one the live stream draws through (nocx-4em1z). A COMMAND's body is
  // an SGR grid and is rendered here, from the bytes the capture stored.
  // Neither is built twice; this only chooses which owner draws.
  const isTurn = facts.kind === 'ask'
  const pieces = isTurn ? (facts.pieces ?? []) : []
  const html =
    facts.body === null
      ? `<span class="term-line cmd-output-evicted">${EVICTED}</span>`
      : isTurn
        ? ''
        : bodyToHTML(snapshot, facts.body)
  const el = createCommandBlock(
    facts.kind,
    facts.id,
    facts.command,
    facts.cwd,
    facts.location,
    html,
    facts.durationMs,
    facts.exitCode,
    facts.status,
    getContainer,
    onSelect,
    store,
    facts.author,
  )
  el.dataset.restored = 'true'
  if (facts.entryId) el.dataset.entryId = facts.entryId
  if (facts.body === null) el.dataset.outputEvicted = 'true'
  // Which fragment of its turn this is, and — past the first — the badge
  // that says so. The SAME marker the live flow places, so a person and a
  // test read one turn's fragments the same way after a restart as during
  // the run (nocx-9sqii).
  if (isTurn && facts.fragment !== undefined) markTurnFragment(el, facts.fragment)
  if (isTurn && (facts.body !== null || pieces.length > 0)) {
    // The same body element the live answer builds — the class comes from
    // the kind's rules, which own the wrap policy, so a restored answer
    // wraps exactly as a live one does.
    const outputEl = document.createElement('div')
    outputEl.className = blockKindRules('ask').outputClass
    outputEl.dataset.answerBody = ''
    el.appendChild(outputEl)
    const body = createAnswerBody(outputEl, { store })
    // The SAME strip the live flow draws its calls through, so a run of five
    // compacts here exactly as it did live and the two views agree.
    const strip = createToolCallStrip(body, deps)
    for (const piece of pieces) {
      if (piece.kind === 'call') {
        strip.add(piece.call)
        continue
      }
      // Prose ends the run of calls above it, as it does live.
      strip.end()
      // The whole chunk in one call: the renderer takes chunks, and a caller
      // that has all of it is simply a caller with one chunk.
      body.append(piece.text)
    }
    body.finish()
  }
  return el
}

/** What a restored TURN is made of: the block's own facts, plus what it
 *  caused — which is what decides how many blocks it becomes. */
export interface RestoredTurnFacts extends Omit<RestoredBlockFacts, 'pieces' | 'fragment' | 'id'> {
  /**
   * Everything this turn caused, in the causal order the ledger stored, each
   * carrying WHERE IN THE PROSE it happened (nocx-h1l4o + nocx-9sqii).
   *
   * The relation and its order are the store's; the anchor is the run's. The
   * one thing decided here is the projection of them, and that lives in
   * turn-flow.ts so the live path and this one cannot disagree.
   */
  causes?: TurnCause[]
}

/**
 * Build one restored TURN: the fragments of its answer, with the blocks it
 * caused standing between them (nocx-9sqii).
 *
 * Returns the elements in the order they are drawn, which is the order the
 * turn happened in: the question and the prose before the first command, that
 * command's own block, the prose written from it, and so on. A turn that
 * caused nothing returns exactly one element and is the block a turn has
 * always been.
 *
 * `id` is asked for per element rather than passed once: every fragment is an
 * ordinary top-level block with a block's own identity, selection and copy,
 * and minting them is the caller's (the manager owns the counter).
 *
 * `drawCaused` turns one caused entry id into the block to place. NULL is the
 * DANGLING case and it is deliberate: the entry is older than the page limit,
 * or retention took it, and the turn then loses that fragment boundary and
 * nothing else. Never a placeholder — a block that is not there is not drawn.
 */
export function restoredTurn(
  facts: RestoredTurnFacts,
  snapshot: TerminalSnapshot,
  nextId: () => number,
  getContainer: () => HTMLElement,
  onSelect: (id: number, selected: boolean) => void,
  store: CommandSnapshotStore,
  drawCaused: (entryId: string) => HTMLElement | null,
  deps: ToolCallLineDeps = {},
): HTMLElement[] {
  const pieces = turnPieces(facts.body, facts.causes ?? [])
  // The fragments' contents first, then the blocks between them — so the
  // LAST fragment can be given the turn's own outcome (its duration and
  // status) while the earlier ones carry none, which is where the live path
  // puts the terminal chip too.
  const groups: { pieces: FragmentPiece[]; after: string | null }[] = [{ pieces: [], after: null }]
  for (const piece of pieces) {
    const last = groups[groups.length - 1]
    if (piece.kind === 'block') {
      // A block ENDS a fragment. The next content opens the next one — and
      // if none comes, there is no next fragment, exactly as live.
      last.after = piece.entryId
      groups.push({ pieces: [], after: null })
      continue
    }
    last.pieces.push(piece)
  }
  // A trailing empty group is a turn whose last act was a command: it opens
  // no fragment below it, because there is nothing to put there.
  if (groups.length > 1 && groups[groups.length - 1].pieces.length === 0) groups.pop()

  // WHICH groups become fragments. The first always does — it carries the
  // question. A later one does only if it has something in it: two commands
  // one after another leave an empty group between them, and live there is no
  // fragment there at all, because a continuation is opened by CONTENT and
  // nothing arrived between the two calls.
  const drawn = groups.map((g, i) => i === 0 || g.pieces.length > 0)
  let lastDrawn = 0
  drawn.forEach((yes, i) => {
    if (yes) lastDrawn = i
  })

  const out: HTMLElement[] = []
  let index = 0
  groups.forEach((group, i) => {
    if (drawn[i]) {
      const last = i === lastDrawn
      out.push(
        restoredBlock(
          {
            ...facts,
            id: nextId(),
            // The turn's outcome belongs to where the turn ENDED. An earlier
            // fragment carries no duration and no exit code, so a reader is
            // never told the turn finished halfway down it.
            durationMs: last ? facts.durationMs : null,
            exitCode: last ? facts.exitCode : null,
            status: last ? facts.status : 'success',
            // Only the first fragment says the output was evicted: one turn,
            // one sentence about its missing prose.
            body: i === 0 ? facts.body : '',
            pieces: group.pieces,
            fragment: index,
          },
          snapshot,
          getContainer,
          onSelect,
          store,
          deps,
        ),
      )
      index++
    }
    if (group.after === null) return
    const caused = drawCaused(group.after)
    if (caused) out.push(caused)
  })
  return out
}

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
import { blockKindRules, createCommandBlock, type BlockKind, type FrozenStatus } from './blocks'
import { createAnswerBody } from './answer-body'
import {
  createToolCallLine,
  type ToolCallLineDeps,
  type ToolCallLineSpec,
} from '../ui/tool-call-line'
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
  durationMs: number
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
   * The tool calls this TURN made, in the causal order the ledger stored
   * (nocx-h1l4o) — the `caused-by` relation, resolved by the backend.
   *
   * Each becomes the same kit line the live flow places (ui/tool-call-line),
   * from the same three facts the live wire carries: the tool, the effect the
   * gate decided, and the resource the backend derived. Nothing here derives
   * any of them — an effect guessed from a tool name is exactly what
   * ADR-0028 decision 4 forbids, and the resource has one derivation, in Go.
   *
   * WHERE THEY GO, and what is not reproduced. Live, a call is placed in the
   * body AT THE POINT IT ARRIVED, between the prose before it and the prose
   * written from its result. A restored turn has the answer as ONE artifact
   * and no stream, so the offset a call arrived at is not a stored fact: the
   * calls go at the head of the flow, in causal order, which is where they
   * are for the ordinary shape of a turn (the model reaches for its tools,
   * then answers). A turn whose prose preceded a call restores with that
   * call above the prose. That is a known and deliberate difference, of the
   * same kind ADR-0036 already accepted for the reasoning note, which is not
   * persisted at all.
   *
   * Ignored for a COMMAND block: an action belongs to the turn that made it,
   * and a command that grew a call line would be a second owner of it.
   */
  calls?: ToolCallLineSpec[]
}

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
  // The calls, first, so they sit above the prose in the flow — see
  // RestoredBlockFacts.calls for what that reproduces and what it does not.
  // They are drawn for a turn whose answer is GONE too: a call is an entry of
  // its own and survives the loss of the prose, and a block that went silent
  // about work that really happened is the shape this bead exists to close.
  const calls = isTurn ? (facts.calls ?? []) : []
  if (isTurn && (facts.body !== null || calls.length > 0)) {
    // The same body element the live answer builds — the class comes from
    // the kind's rules, which own the wrap policy, so a restored answer
    // wraps exactly as a live one does.
    const outputEl = document.createElement('div')
    outputEl.className = blockKindRules('ask').outputClass
    outputEl.dataset.answerBody = ''
    el.appendChild(outputEl)
    const body = createAnswerBody(outputEl, { store })
    for (const call of calls) body.insert(createToolCallLine(call, deps))
    // The whole answer in one call: the renderer takes chunks, and a caller
    // that has all of it is simply a caller with one chunk.
    if (facts.body !== null) body.append(facts.body)
    body.finish()
  }
  return el
}

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
  /** How long it took, or NULL for no duration chip at all. */
  durationMs: number | null
  exitCode: number | null
  /** Where the block ended — or `settled`, which is finished with no outcome
   *  of its own (nocx-hoeq3). */
  status: FrozenStatus | 'settled'
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
  if (isTurn && facts.body !== null) {
    // The same body element the live answer builds — the class comes from
    // the kind's rules, which own the wrap policy, so a restored answer
    // wraps exactly as a live one does.
    const outputEl = document.createElement('div')
    outputEl.className = blockKindRules('ask').outputClass!
    outputEl.dataset.answerBody = ''
    el.appendChild(outputEl)
    const body = createAnswerBody(outputEl, { store })
    // The whole chunk in one call: the renderer takes chunks, and a caller
    // that has all of it is simply a caller with one chunk.
    body.append(facts.body)
    body.finish()
  }
  return el
}

/** One child of a restored turn, as the ledger returns it (`ledger.get`'s
 *  `caused` row, narrowed to what placing needs). */
export interface RestoredCause {
  entryId: string
  kind: 'shell' | 'agent' | 'action' | 'text'
}

/** What a restored TURN is made of: the block's own facts, plus the children
 *  the ledger holds for it. */
export interface RestoredTurnFacts extends Omit<RestoredBlockFacts, 'id'> {
  /** The turn's children, in the seat order the ledger stored (ADR-0037). */
  causes?: RestoredCause[]
}

/**
 * Build one restored TURN: its block, then the blocks it caused.
 *
 * THIS IS AN INTERMEDIATE STATE AND IT IS DELIBERATE. ADR-0037 makes a turn
 * ONE block that CARRIES its children in seat order, and the live path draws
 * exactly that. Drawing the same tree from the store is the task that owns
 * this surface next: it needs a body per `text` child, which is a read this
 * page does not do yet, and the `tool` child of a call needs the arguments
 * `ledger.get` has only just started sending. Until then the turn is drawn
 * with the prose it has and its caused blocks after it — an honest, flat
 * arrangement rather than a guess at an order it cannot yet read.
 *
 * `id` is asked for per element rather than passed once: every block is an
 * ordinary block with its own identity, selection and copy, and minting them
 * is the caller's (the manager owns the counter).
 *
 * `drawCaused` turns one caused entry id into the block to place. NULL is the
 * DANGLING case and it is deliberate: the entry is older than the page limit,
 * or retention took it. Never a placeholder — a block that is not there is
 * not drawn.
 */
export function restoredTurn(
  facts: RestoredTurnFacts,
  snapshot: TerminalSnapshot,
  nextId: () => number,
  getContainer: () => HTMLElement,
  onSelect: (id: number, selected: boolean) => void,
  store: CommandSnapshotStore,
  drawCaused: (entryId: string) => HTMLElement | null,
): HTMLElement[] {
  const out: HTMLElement[] = [
    restoredBlock({ ...facts, id: nextId() }, snapshot, getContainer, onSelect, store),
  ]
  for (const cause of facts.causes ?? []) {
    const el = drawCaused(cause.entryId)
    if (el) out.push(el)
  }
  return out
}

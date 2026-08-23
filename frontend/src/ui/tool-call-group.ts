// ToolCallGroup — several tool-call lines compacted into one expandable
// line (nocx-9sqii, ui/README table).
//
// WHY IT EXISTS. A turn that reaches for one tool reads as a sentence about
// what the assistant did; a turn that reaches for five reads as a log, and
// the answer the person came for is below it. ToolCallLine is right for the
// one and wrong for the five, and the fix is not a smaller line — it is that
// a RUN of calls is itself a thing, with a count and a way in.
//
// A NATIVE <details>, for exactly the reason ReasoningNote is one: it is the
// browser's own disclosure, keyboard-operable and announced without a line of
// our script, and a hand-rolled toggle is the kit rule's exact prohibition.
// Closed by default — the calls are how the answer was reached, not the
// answer.
//
// THE SUMMARY STAYS A REPORT, NOT A LABEL. It carries the count AND the name
// of the most recent call, because live this group is what a person watches
// while the assistant works: "5 tool calls" alone would hide the very thing
// that is happening right now. The lines inside carry everything else — each
// one is an ordinary ToolCallLine, built by its own owner and never restated
// here.
//
// IT HOLDS LINES, NOT CALLS. What a call looks like has one owner
// (tool-call-line.ts), and a group that took specs would be a second place
// deciding how a call is painted.

/** A run of tool calls, drawn as one line that opens. */
export interface ToolCallGroup {
  /** The disclosure itself, typed as what it is so a caller that opens or
   *  closes one needs no cast. */
  readonly el: HTMLDetailsElement
  /** How many lines it holds. */
  readonly size: number
  /** Add one more line: it goes to the end, and the summary restates the
   *  count and names it. */
  add(line: HTMLElement): void
}

/** What a line is CALLED in the summary — the tool it names, read off the
 *  line's own identity class rather than passed in beside it, so the group
 *  can never disagree with the line it is summarising. */
function toolOf(line: HTMLElement): string {
  return line.querySelector('.ui-tool-call__tool')?.textContent ?? ''
}

export function createToolCallGroup(lines: HTMLElement[]): ToolCallGroup {
  if (lines.length === 0) {
    // A group of nothing is a control that says nothing and opens on
    // nothing. The caller decides when a run is worth compacting; building
    // one from an empty run is a bug in that decision, not a state to
    // render.
    throw new Error('tool-call-group: a group needs at least one line')
  }
  const root = document.createElement('details')
  root.className = 'ui-tool-calls'

  const summary = document.createElement('summary')
  summary.className = 'ui-tool-calls__summary'
  root.appendChild(summary)

  const body = document.createElement('div')
  body.className = 'ui-tool-calls__body'
  root.appendChild(body)

  let count = 0
  const restate = (last: HTMLElement): void => {
    const plural = count === 1 ? 'tool call' : 'tool calls'
    const tool = toolOf(last)
    summary.textContent = tool ? `${count} ${plural} · ${tool}` : `${count} ${plural}`
    // The count is the sentence; the tool name is the live half and changes
    // under the reader, so the label a screen reader announces is the count
    // alone rather than a string that rewrites itself mid-run.
    root.setAttribute('aria-label', `${count} ${plural}`)
  }

  const push = (line: HTMLElement): void => {
    body.appendChild(line)
    count++
    restate(line)
  }
  for (const line of lines) push(line)

  return {
    el: root,
    get size(): number {
      return count
    },
    add: push,
  }
}

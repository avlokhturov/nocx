// ToolCallLine — one line naming something the assistant DID, inside the
// answer it did it in (nocx-shxv0, ui/README table).
//
// Vanilla-emitted, like SecretChip and BlockReceipt, because its only home
// is the scrollback's answer block: the flow is imperative DOM built by
// scrollback/blocks.ts, and a React island inside it would be a second
// rendering model for one body.
//
// WHY IT EXISTS AT ALL. On 2026-08-22 the assistant called readScreen and the
// call left no trace whatsoever; the run tool's command opened a block that
// landed BELOW the answer written from its output, so the flow read
// "answered first, ran the command afterwards". The fix is not a bigger
// block — it is that a tool call is an ELEMENT OF THE ANSWER'S FLOW, drawn
// where it happened. Get that right and the ordering fixes itself.
//
// WHAT IT SHOWS, AND WHAT IT DELIBERATELY DOES NOT. The tool, and the
// resource the backend derived (contracts/agent.runToolCall.schema.json;
// internal/assistant/policy.go namedResource is the ONE derivation, shared
// with the policy's scope check and the approval prompt). NOT the raw
// arguments blob — that is JSON, not a sentence — and NOT the tool's result:
// the result has an owner already (the ledger's attempt, and for the run
// tool the block the command really opened), and a second copy here would be
// two surfaces owning one set of bytes.
//
// The effect is a typed `data-effect`, the kit's way of carrying variance: a
// destructive call must not look like a read, and the renderer must never
// derive an effect from a tool name (ADR-0028 decision 4) — the backend
// sends it.
//
// AND A SESSION IS NAMED, NEVER NUMBERED (nocx-vnzek). The derived resource
// is the right thing to show for a path — a path is the person's own word —
// and the wrong thing for a session, where the derivation IS the session id
// and the line read `readScreen 9bb9a7602c27e8ba0741972c7049b54b`. The id is
// an internal handle; a person's word for that session is the pane's name,
// which the tab strip already derives (panes.ts sessionDisplayName →
// Pane.displayTitle → layout/tab-label). That derivation is INJECTED here
// rather than repeated: this module owns the paint rule ("a session shows
// its name"), the pane layer owns the name. The id stays on the wire, where
// the renderer routes and dedupes on it — this is paint only.

/** The effect classes the ledger names (content.Effect) — the closed set the
 *  wire's enum declares. */
export type ToolCallEffect =
  | 'observe'
  | 'mutate-reversible'
  | 'mutate-destructive'
  | 'privilege-change'
  | 'disclose'
  | 'cross-boundary'
  | 'delegate'

// Named `…Spec` and taken as `call`, not `props`: this is a one-shot DOM
// builder, not a Solid component, and the reactivity lint reads a parameter
// called `props` as a reactive store whose fields must be read inside a
// tracked scope.
export interface ToolCallLineSpec {
  /** The declared tool name, e.g. 'files.read'. */
  tool: string
  /** The effect class the gate decided on — the backend's fact. */
  effect: ToolCallEffect
  /** What the call touched, as the backend derived it. Absent when the tool
   *  names no resource in its parameters at all (git.status's repository IS
   *  the grant's path scope) — the line then names the tool alone rather
   *  than inventing a placeholder. */
  resource?: { kind: string; id: string }
}

/** What the line needs from outside itself to paint a resource. */
export interface ToolCallLineDeps {
  /** What a SESSION is called to a person — the pane's own display title,
   *  the same words the tab strip and the tab's tooltip show. Null when no
   *  pane in this window holds that session (it was closed, or it belongs
   *  to another window), and null is a real answer: see resourceText. */
  sessionName?: (sessionId: string) => string | null
}

/**
 * What the resource is CALLED on this line, or null when it cannot be named.
 *
 * A path, an environment variable, a destination: shown verbatim, because
 * the derived id IS the person's own word for them.
 *
 * A session: the pane's name, and NEVER the id. When nothing can name the
 * session the line falls back to naming the tool alone — the shape it
 * already has for a call that named no resource at all — rather than to the
 * id, because printing the id back is the whole defect. What is lost is
 * which of several sessions was touched, in the one case where that session
 * is no longer on screen to be looked at; what is gained is that the line
 * never shows a person a number that means nothing to them.
 */
function resourceText(
  resource: { kind: string; id: string },
  deps: ToolCallLineDeps,
): string | null {
  if (resource.kind === 'session') return deps.sessionName?.(resource.id) || null
  return resource.id
}

export function createToolCallLine(
  call: ToolCallLineSpec,
  deps: ToolCallLineDeps = {},
): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ui-tool-call'
  root.dataset.effect = call.effect
  root.dataset.tool = call.tool

  // The marker is decorative: it says "this is a thing the assistant did"
  // and carries no information the text does not. Hidden from the
  // accessibility tree so a screen reader hears the sentence, not the glyph.
  const marker = document.createElement('span')
  marker.className = 'ui-tool-call__marker'
  marker.setAttribute('aria-hidden', 'true')
  marker.textContent = '▸' // ▸
  root.appendChild(marker)

  const tool = document.createElement('span')
  tool.className = 'ui-tool-call__tool'
  tool.textContent = call.tool
  root.appendChild(tool)

  const named = call.resource ? resourceText(call.resource, deps) : null
  if (call.resource && named) {
    const res = document.createElement('span')
    res.className = 'ui-tool-call__resource'
    res.textContent = named
    // A path is long and the line must stay one line (the scrollback hangs
    // from the block and a wrapping line moves it). The whole value lives
    // in the title, so nothing is only in the ellipsis — and the title
    // carries the SAME name the line does, never the id behind it.
    res.title = `${call.resource.kind}: ${named}`
    root.appendChild(res)
    root.setAttribute('aria-label', `used ${call.tool} on ${named}`)
  } else {
    root.setAttribute('aria-label', `used ${call.tool}`)
  }
  return root
}

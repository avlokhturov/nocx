import { Show, createSignal } from 'solid-js'
import { Button } from './ui/button'
import { ContextMenu } from './ui/context-menu'
import { ChevronDownIcon, LayersIcon } from './ui/icons'

/**
 * WorkspaceChip — how a window says which workspace it is showing, and how
 * you get to another one (nocx-isoph.5; workspaces UX design §4.3).
 *
 * A WINDOW IS A VIEWPORT, NOT A CONTAINER (tabs/panes design §10). It shows
 * one workspace at a time and owns no tabs — this chip and its switcher ARE
 * that sentence in the UI. The horizontal strip therefore draws the current
 * workspace's tabs and no others, and the chip is the way back.
 *
 * IN THE DEFAULT WORKSPACE IT IS A NEUTRAL GLYPH WITH NO LABEL (§4.2). Not a
 * different control, not a hidden one: the same chip, without a name, because
 * the default never renders a name and the chip still has to exist or there
 * is no way back from a named workspace. Nothing here counts workspaces — the
 * label is absent because `name` is null, which is a fact about which
 * workspace this is and never about how many there are.
 *
 * IT ADVERTISES NAVIGATION AND NOTHING ELSE (§5.5). Epic B ships membership,
 * not a fence: no shield, no lock, no "safe", "isolated" or "contained". The
 * glyph is a stack of plates — several things taken together — and the copy
 * says where you are and where you can go. When enforcement lands (nocx-mp2vd)
 * this same component gains a state-backed status; until then a badge would
 * be a promise with no mechanism behind it.
 *
 * It PLACES kit components and repaints none: the control is the kit's ghost
 * Button, the switcher is the kit's ContextMenu, and this file's own class is
 * a wrapper that positions them in the strip.
 */

/** One row of the switcher: a workspace, and what to call it. `name` is null
 *  for the default workspace, which has none. */
interface WorkspaceChoice {
  readonly id: string
  readonly name: string | null
}

/** What the strip is told about the chip. Null anywhere there is no chain to
 *  draw one from. */
export interface WorkspaceChipView {
  /** The current workspace's name, or null in the default workspace. */
  readonly name: string | null
  /** WHICH workspace is in front, as an id. The name cannot stand in for it:
   *  the default has none, and two workspaces may share one. It is what the
   *  actions below are built for (nocx-isoph.7). */
  readonly currentId: string
  /** Every workspace, in the order the switcher shows them. */
  readonly workspaces: readonly WorkspaceChoice[]
}

export interface WorkspaceChipProps extends WorkspaceChipView {
  onSwitch: (workspaceId: string) => void
  onNew: () => void
  /** What the CURRENT workspace can have done to it, built by
   *  workspace-menu.ts and handed in (nocx-isoph.7). The chip does not build
   *  them and does not decide which exist: a vertical strip's heading opens
   *  the same rows for the workspace it heads, and one owner is what keeps
   *  the two from disagreeing — first of all about the default, which is
   *  offered none. Empty is the ordinary state in the default workspace. */
  actions: readonly { id: string; label: string; onSelect: () => void }[]
}

/**
 * What the switcher calls the default workspace.
 *
 * IT IS A DESCRIPTION OF A DESTINATION, NOT A NAME THE DEFAULT ACQUIRES, and
 * the distinction is load bearing: it is never drawn as a heading, never
 * shown on the chip, cannot be renamed, and is not read from the row's stored
 * name — the backend's `name` for that row is never rendered anywhere (see
 * layout/strip-groups.ts). What it solves is the one thing §4.3 requires and
 * §4.2 does not name: from a named workspace there has to be a way back, and
 * a menu row with an empty label is not one.
 */
const UNGROUPED_LABEL = 'Ungrouped tabs'

export function WorkspaceChip(props: WorkspaceChipProps) {
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null)

  const items = () => {
    const rows = props.workspaces.map((w) => ({
      id: `workspace-${w.id}`,
      label: w.name ?? UNGROUPED_LABEL,
      onSelect: () => props.onSwitch(w.id),
    }))
    rows.push({ id: 'workspace-new', label: 'New workspace…', onSelect: () => props.onNew() })
    // The actions come last, after navigation: the switcher's first job is to
    // get you somewhere (§4.3), so rows acting on where you already are must
    // not sit between you and the place you were reaching for. Closing is
    // among them now rather than being built here — `closable` was the chip's
    // own reading of "not the default", and that rule belongs to
    // workspace-menu.ts, which answers it identically for both placements.
    rows.push(...props.actions.map((a) => ({ ...a })))
    return rows
  }

  return (
    <div class="nocx-workspace-chip">
      <Button
        variant="ghost"
        size="sm"
        // The accessible name says what the control DOES when the chip
        // carries no visible label, and gets out of the way when it does —
        // an aria-label over a visible name is a control announced as
        // something other than what it reads as.
        ariaLabel={props.name === null ? 'Workspaces' : undefined}
        title={props.name === null ? 'Workspaces' : `Workspace: ${props.name}`}
        onClick={(e: MouseEvent) => {
          const anchor = e.currentTarget
          if (!(anchor instanceof HTMLElement)) return
          const rect = anchor.getBoundingClientRect()
          setMenu({ x: rect.left, y: rect.bottom })
        }}
      >
        <LayersIcon />
        <Show when={props.name}>
          {(name) => <span class="nocx-workspace-chip__name">{name()}</span>}
        </Show>
        <ChevronDownIcon />
      </Button>
      <Show when={menu()} keyed>
        {(open) => (
          <ContextMenu
            open
            x={open.x}
            y={open.y}
            items={items()}
            onClose={() => setMenu(null)}
            data-testid="workspace-switcher"
          />
        )}
      </Show>
    </div>
  )
}

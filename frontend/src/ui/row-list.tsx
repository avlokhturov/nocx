/**
 * EditableRowList — a repeating editable row list (nocx-wzc4.3).
 *
 * The kit primitive for "a list of rows the user edits": each row renders
 * the caller's controls (which must be kit fields), a per-row remove
 * control, and an add control at the foot. Repeating editable rows are
 * exactly the control surfaces hand-roll as a bespoke div stack; the kit
 * owns the row rhythm, the separator and the two affordances so every
 * surface's list reads as one vocabulary.
 *
 * Identities: `ui-row-list` (the list), `ui-row-list__row` (one row),
 * `ui-row-list__content` (the caller's fields), `ui-row-list__remove`
 * (placement wrapper for the per-row remove IconButton),
 * `ui-row-list__empty` (the empty message), `ui-row-list__add` (placement
 * wrapper for the foot add Button). The remove and add are kit Buttons —
 * the wrappers only place them, they never repaint them.
 *
 * The rows are controlled: the caller owns the data and passes `rows`,
 * `renderRow`, `onRemove` and `onAdd`. Nothing here mutates state.
 */
import { For, Show, type JSX } from 'solid-js'
import { Button } from './button'
import { IconButton } from './icon-button'
import { CloseIcon, PlusIcon } from './icons'

export interface EditableRowListProps<T> {
  /** The rows being edited. Read-only: the caller owns the data. */
  rows: readonly T[]
  /** Renders one row's fields. Called per row; keep it cheap. */
  renderRow: (row: T, index: number) => JSX.Element
  /** Called with the row's index when its remove control is activated. */
  onRemove: (index: number) => void
  /** Called when the foot add control is activated. */
  onAdd: () => void
  /** Visible label of the add control, e.g. "Add forward". */
  addLabel: string
  /** Accessible name for one row's remove control, e.g. "Remove forward 2". */
  removeLabel: (index: number) => string
  /** Shown above the add control when there are no rows. */
  emptyLabel?: string
  /** Accessible name for the list itself. */
  ariaLabel: string
  disabled?: boolean
}

export function EditableRowList<T>(props: EditableRowListProps<T>) {
  return (
    <div class="ui-row-list" role="list" aria-label={props.ariaLabel}>
      <For each={props.rows}>
        {(row, i) => (
          <div class="ui-row-list__row" role="listitem">
            <div class="ui-row-list__content">{props.renderRow(row, i())}</div>
            <div class="ui-row-list__remove">
              <IconButton
                size="sm"
                title="Remove"
                ariaLabel={props.removeLabel(i())}
                disabled={props.disabled === true}
                onClick={() => props.onRemove(i())}
              >
                <CloseIcon />
              </IconButton>
            </div>
          </div>
        )}
      </For>
      <Show when={(props.rows?.length ?? 0) === 0 && props.emptyLabel}>
        <p class="ui-row-list__empty">{props.emptyLabel}</p>
      </Show>
      <div class="ui-row-list__add">
        <Button variant="ghost" disabled={props.disabled === true} onClick={props.onAdd}>
          <PlusIcon />
          {props.addLabel}
        </Button>
      </div>
    </div>
  )
}

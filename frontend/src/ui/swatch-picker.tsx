import { For, Show } from 'solid-js'

/**
 * SwatchPicker — choose one colour from a closed set.
 *
 * A radio group whose options are colours rather than words. It exists
 * because the kit had no way to ask that question: Radio is a control with a
 * text label, Select is a list of names, and a colour named in prose ("Amber")
 * is not the thing the person is choosing. The first caller is the workspace
 * create dialog (nocx-2mipw); tab decoration asks the same question today
 * through a context menu of colour words and is the obvious second.
 *
 * IT TAKES A TOKEN NAME, NEVER A COLOUR. Each option carries the NAME of a CSS
 * custom property, and the swatch resolves it with `var()`. That is ADR-0013's
 * own sanctioned shape for carrying a colour through data — §"A settings value
 * may carry a token name (as a string), never a colour literal" — and it is
 * what keeps this component from becoming a place literals leak in. The
 * component therefore knows no palette: which colours exist is the caller's,
 * which is why the workspace set and the tab set can differ without this file
 * having an opinion.
 *
 * KEYBOARD: it is a radio group and behaves like one. Arrows move AND select,
 * which is the WAI-ARIA radio pattern rather than a listbox's move-then-pick;
 * the group is one tab stop, and the stop is on the selected swatch.
 */

export interface SwatchOption {
  /** The stored value this swatch stands for. */
  readonly value: string
  /** The accessible name. A colour word, because that is what the person is
   *  choosing — not the token's role, which is the kit's vocabulary. */
  readonly label: string
  /** The NAME of a CSS custom property, e.g. `--ws-blue`. Never a literal. */
  readonly token: string
}

export interface SwatchPickerProps {
  readonly options: readonly SwatchOption[]
  /** The chosen value, or null: none chosen yet, or — where the caller
   *  offers it — none chosen deliberately. */
  readonly value: string | null
  onChange: (value: string | null) => void
  /** Required — a group of colour buttons with no name is a defect. */
  readonly ariaLabel: string
  /**
   * Offer "no colour" as a swatch of its own.
   *
   * NOT A TENTH COLOUR, and drawn so: an empty ring with a stroke through it,
   * the vocabulary for "none" everywhere it appears. It exists because for
   * some subjects absence is the ORDINARY state rather than a missing answer
   * — an undecorated tab is the common case, and a picker that can only add a
   * colour is a decision a person cannot take back. For a subject whose
   * absence would be a defect (a workspace's identity colour) the caller
   * simply does not ask for it.
   */
  readonly allowNone?: boolean
  /** What the "no colour" swatch is called. */
  readonly noneLabel?: string
}

export function SwatchPicker(props: SwatchPickerProps) {
  const move = (from: number, delta: number) => {
    const n = props.options.length
    if (n === 0) return
    // Wraps, which is the radio pattern: a group of nine colours has no
    // meaningful first or last, so stopping at the ends would only make the
    // ninth colour harder to reach than the second.
    const next = (((from + delta) % n) + n) % n
    props.onChange(props.options[next].value)
  }

  return (
    <div class="ui-swatch-picker" role="radiogroup" aria-label={props.ariaLabel}>
      <Show when={props.allowNone === true}>
        <button
          type="button"
          class="ui-swatch-picker__swatch"
          data-none="true"
          role="radio"
          aria-checked={props.value === null}
          aria-label={props.noneLabel ?? 'No colour'}
          title={props.noneLabel ?? 'No colour'}
          tabIndex={props.value === null ? 0 : -1}
          onClick={() => props.onChange(null)}
        />
      </Show>
      <For each={props.options}>
        {(option, index) => (
          <button
            type="button"
            class="ui-swatch-picker__swatch"
            role="radio"
            aria-checked={props.value === option.value}
            aria-label={option.label}
            title={option.label}
            // The group is ONE tab stop. It falls on the selected swatch, or
            // on the first one when nothing is selected yet — never on all
            // nine, which would make tabbing past a colour picker take nine
            // presses.
            tabIndex={
              props.value === option.value ||
              (props.value === null && props.allowNone !== true && index() === 0)
                ? 0
                : -1
            }
            style={{ '--swatch-colour': `var(${option.token})` }}
            onClick={() => props.onChange(option.value)}
            onKeyDown={(e: KeyboardEvent) => {
              const delta =
                e.key === 'ArrowRight' || e.key === 'ArrowDown'
                  ? 1
                  : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                    ? -1
                    : 0
              if (delta === 0) return
              e.preventDefault()
              move(index(), delta)
              // Focus follows selection, or the roving stop and the selection
              // disagree and the next arrow press starts from the wrong place.
              const group = (e.currentTarget as HTMLElement).parentElement
              const n = props.options.length
              const target = group?.children[(((index() + delta) % n) + n) % n]
              if (target instanceof HTMLElement) target.focus()
            }}
          />
        )}
      </For>
    </div>
  )
}

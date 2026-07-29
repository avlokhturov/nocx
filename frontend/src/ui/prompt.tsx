import { Show, createEffect, onCleanup, type JSX } from 'solid-js'
import { popOverlay, pushOverlay, type OverlayEntry } from './overlay/stack'

export interface PromptProps {
  open: boolean
  title?: string
  ariaLabel: string
  placement?: 'floating' | 'top-sheet'
  onClose: () => void
  children: JSX.Element
  actions: JSX.Element
}

export function Prompt(props: PromptProps) {
  let element: HTMLDivElement | undefined
  let entry: OverlayEntry | null = null

  createEffect(() => {
    if (props.open && !entry) {
      const onClose = props.onClose
      entry = pushOverlay(
        () => {
          onClose()
          return true
        },
        undefined,
        element,
      )
    } else if (!props.open && entry) {
      popOverlay(entry)
      entry = null
    }
  })

  onCleanup(() => {
    if (entry) popOverlay(entry)
  })

  return (
    <Show when={props.open}>
      <div
        ref={element}
        class="ui-prompt-overlay"
        data-placement={props.placement ?? 'floating'}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) props.onClose()
        }}
      >
        <section
          class="ui-prompt"
          data-placement={props.placement ?? 'floating'}
          role="dialog"
          aria-modal="true"
          aria-label={props.ariaLabel}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Show when={props.title}>
            <h2 class="ui-prompt__title">{props.title}</h2>
          </Show>
          <div class="ui-prompt__body">{props.children}</div>
          <div class="ui-prompt__actions">{props.actions}</div>
        </section>
      </div>
    </Show>
  )
}

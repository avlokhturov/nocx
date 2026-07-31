import { Show, createEffect, onCleanup, type JSX } from 'solid-js'
import {
  popOverlay,
  pushOverlay,
  restoreFocus,
  topOverlayElement,
  type OverlayEntry,
} from './overlay/stack'

export interface PromptProps {
  open: boolean
  title?: string
  ariaLabel: string
  placement?: 'floating' | 'top-sheet'
  onClose: () => void
  /**
   * The prompt's affirmative action, fired by Enter in a single-line field.
   *
   * Opt-in, with the same contract as Dialog's `onSubmit`: a caller that
   * passes this is saying "this prompt has one obvious yes". Textareas and
   * buttons own their own Enter; an IME's Enter accepts a candidate.
   */
  onSubmit?: () => void
  children: JSX.Element
  actions: JSX.Element
}

/**
 * Put the caret where the user is about to type — the same preference order
 * a native `<dialog>`'s showModal gives: an explicit autofocus, then the
 * first real field, then the first button. A Prompt is a plain div, so it
 * must do this itself.
 */
function focusInitial(panel: HTMLElement): void {
  const enabled = ':not([disabled]):not([tabindex="-1"])'
  const target =
    panel.querySelector<HTMLElement>('[autofocus]' + enabled) ??
    panel.querySelector<HTMLElement>(
      `input:not([type="hidden"])${enabled}, select${enabled}, textarea${enabled}`,
    ) ??
    panel.querySelector<HTMLElement>('button' + enabled)
  target?.focus()
}

export function Prompt(props: PromptProps) {
  let element: HTMLDivElement | undefined
  let entry: OverlayEntry | null = null
  /**
   * The overlay this prompt renders INSIDE while open, or null to render in
   * place. A modal `<dialog>` lives in the browser's top layer, which is
   * above every z-index in the normal layer by definition — being on top of
   * a top-layer element is not a number, it is a parent. So when the prompt
   * opens over something (a Dialog, another Prompt), its overlay element is
   * moved to be a DOM child of that thing: the same mechanism that makes
   * the connection editor's own password prompt appear above its dialog,
   * which it is by virtue of being a DOM child of the dialog.
   *
   * Captured BEFORE pushOverlay: once the prompt is on the stack, the
   * topmost overlay element is the prompt itself.
   */
  let host: HTMLElement | null = null

  createEffect(() => {
    if (props.open && !entry) {
      const h = topOverlayElement()
      host = h && h !== element ? h : null
      const onClose = props.onClose
      entry = pushOverlay(
        () => {
          onClose()
          return true
        },
        undefined,
        element,
      )
      // Escape is supplied by the overlay stack's document-level handler —
      // it closes the topmost overlay, which is this prompt.
      if (host && element && !host.contains(element)) host.appendChild(element)
      if (element) focusInitial(element)
    } else if (!props.open && entry) {
      popOverlay(entry)
      restoreFocus(entry)
      entry = null
      host = null
    }
  })

  onCleanup(() => {
    if (entry) {
      popOverlay(entry)
      restoreFocus(entry)
    }
  })

  /**
   * Enter in a single-line field means "the obvious yes", the same as it
   * means in Dialog and in every other form. Guarded three ways, mirroring
   * Dialog: only when the caller declared an action, only from a real input
   * (a textarea owns Enter, a button already has its own), and not
   * mid-composition — an IME uses Enter to accept a candidate.
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!props.onSubmit) return
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    const target = e.target as HTMLElement | null
    if (!target || target.tagName !== 'INPUT') return
    if ((target as HTMLInputElement).type === 'button') return
    e.preventDefault()
    props.onSubmit()
  }

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
          onKeyDown={onKeyDown}
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

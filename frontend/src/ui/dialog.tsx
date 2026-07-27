/**
 * Dialog — built on native `<dialog>` + `showModal()`.
 *
 * A native modal `<dialog>` renders in the browser top layer, above every
 * stacking context. It is exempt from the portal-root and z-index clauses.
 * It is NOT exempt from the drag-region, focus-return, and xterm-textarea
 * clauses. That distinction is explicit below.
 *
 * Available at both declared floors (WebKitGTK 2.40, Safari 16.2), which is
 * why ADR-0014 chose it over a library. See ADR-0014 for the full rationale.
 *
 * ## What the platform gives us for free
 * - Top-layer rendering
 * - Background inertness (cannot interact with the rest of the page)
 * - Escape / cancel
 * - Native focus treatment (first focusable element receives focus)
 *
 * ## What we write ourselves
 * - Initial-focus policy (autofocus override)
 * - Nesting policy (overlay stack — only topmost is interactive)
 * - `::backdrop` theming via token variables (in overlay.css)
 * - Wails drag-region guard (--wails-draggable: no-drag on the dialog)
 * - Focus return to invoker on close (incl. xterm hidden textarea)
 *
 * @example
 * ```tsx
 * <Dialog open={show()} onClose={() => setShow(false)} title="Confirm">
 *   <p>Are you sure?</p>
 * </Dialog>
 * ```
 *
 * @example Confirm convenience
 * ```tsx
 * const ok = await showConfirm('Are you sure?')
 * ```
 */

import { createEffect, createSignal, onCleanup, type Component, type JSX, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { pushOverlay, popOverlay, restoreFocus } from './overlay/stack'
import { Button } from './button'

export interface DialogProps {
  /** Whether the dialog is open. */
  open: boolean
  /** Called when the dialog should close (Escape, cancel event, close button). */
  onClose: () => void
  /** Dialog title (optional). Rendered in `.nocx-dialog__title`. */
  title?: string
  /** Dialog body content. */
  children: JSX.Element
  /** Optional footer / action area. Rendered after children. */
  footer?: JSX.Element
}

export const Dialog: Component<DialogProps> = (props) => {
  let ref: HTMLDialogElement | undefined
  const [entry, setEntry] = createSignal<ReturnType<typeof pushOverlay> | null>(null)

  createEffect(() => {
    const d = ref
    if (!d) return

    if (props.open && !d.open) {
      d.showModal()
      // The callback is stored and invoked later, when Escape or an
      // outside interaction reaches the top of the overlay stack — i.e. as an
      // event response, which is where solid/reactivity permits a prop read.
      // The rule cannot see through the indirection.
      // eslint-disable-next-line solid/reactivity
      const e = pushOverlay(() => {
        props.onClose()
        return true
      })
      setEntry(e)
    } else if (!props.open && d.open) {
      const e = entry()
      if (e) popOverlay(e)
      d.close()
      if (e) restoreFocus(e)
    }
  })

  // Handle native cancel event (Escape key).
  const onCancel = () => {
    props.onClose()
  }

  onCleanup(() => {
    const e = entry()
    if (e) {
      popOverlay(e)
      if (e.prevFocus) restoreFocus(e)
    }
    if (ref?.open) ref.close()
  })

  /**
   * Light dismiss — a click outside the panel closes the dialog.
   *
   * The listener is on the `<dialog>` rather than on the backdrop, because
   * `::backdrop` is a pseudo-element and cannot take one. A native modal
   * `<dialog>` fills the viewport with the panel centred inside it, so a click
   * that lands on the dialog element itself landed outside the panel. Comparing
   * against the panel's box rather than checking `e.target === ref` is what
   * makes it survive a click on padding or on a child that stops bubbling.
   */
  const onPointerDown = (e: MouseEvent) => {
    const d = ref
    if (!d) return
    const panel = d.querySelector('.nocx-dialog__panel')
    if (!panel) return
    const r = panel.getBoundingClientRect()
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    // A click with no coordinates is a keyboard-activated one (Enter on a
    // button reports 0,0); those are never a dismiss.
    if (e.clientX === 0 && e.clientY === 0) return
    if (!inside) props.onClose()
  }

  return (
    <dialog ref={ref} class="nocx-dialog" onCancel={onCancel} onMouseDown={onPointerDown}>
      {/* kit-scope on the panel, so a modal's controls are kit controls without
          every caller remembering to say so. This is the base every modal is
          built on; the scope belongs with it. */}
      <div class="nocx-dialog__panel kit-scope">
        <Show when={props.title}>
          <h2 class="nocx-dialog__title">{props.title}</h2>
        </Show>
        {props.children}
        <Show when={props.footer}>
          <div class="nocx-dialog__actions">{props.footer}</div>
        </Show>
      </div>
    </dialog>
  )
}

/** The confirm body, so the imperative helper below owns no markup of its own. */
const ConfirmDialog: Component<{
  message: string
  okLabel: string
  cancelLabel: string
  onResolve: (result: boolean) => void
}> = (props) => (
  <Dialog
    open
    onClose={() => props.onResolve(false)}
    footer={
      <>
        <Button variant="default" onClick={() => props.onResolve(false)}>
          {props.cancelLabel}
        </Button>
        <Button variant="primary" onClick={() => props.onResolve(true)}>
          {props.okLabel}
        </Button>
      </>
    }
  >
    <p class="nocx-dialog__message">{props.message}</p>
  </Dialog>
)

/**
 * Imperative confirm dialog — returns a promise that resolves to true (OK) or
 * false (Cancel).
 *
 * Built on `Dialog`, like every other modal in the app. It used to assemble its
 * own `<dialog>` out of `document.createElement` calls, and the result was a
 * third look: the OK button picked up a kit class, the Cancel button was left
 * with a bare `kit-scope` that matches no rule, and neither the panel nor the
 * type came from the same place as the rest. One base, the way `Page` is the
 * one base for surfaces.
 *
 * The vanilla-DOM version carried a comment justifying itself with ADR-0012 §1,
 * "Solid must not render into the terminal's subtree". That rule is about the
 * terminal's DOM. This mounts its own root on `document.body`, which is not the
 * terminal's subtree — the native `<dialog>` is in the browser top layer no
 * matter where its node sits — so the constraint never applied here.
 *
 * @param message — The text to show (supports newlines, shown as pre-wrap).
 * @param okLabel — Label for the confirm button (default "OK").
 * @param cancelLabel — Label for the cancel button (default "Cancel").
 * @returns Promise<boolean> — true if the user confirmed, false if cancelled.
 */
export function showConfirm(
  message: string,
  okLabel = 'OK',
  cancelLabel = 'Cancel',
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    let dispose: (() => void) | null = null
    let settled = false

    const finish = (result: boolean) => {
      // Escape fires the cancel path and the disposer can run again on unmount;
      // the promise must resolve exactly once.
      if (settled) return
      settled = true
      // Deferred so Dialog's own cleanup — popOverlay and focus restore — runs
      // against a live root before it is torn down.
      queueMicrotask(() => {
        dispose?.()
        host.remove()
      })
      resolve(result)
    }

    dispose = render(
      () => (
        <ConfirmDialog
          message={message}
          okLabel={okLabel}
          cancelLabel={cancelLabel}
          onResolve={finish}
        />
      ),
      host,
    )
  })
}

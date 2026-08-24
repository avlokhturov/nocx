/**
 * CodeBlock — preformatted, monospaced output the user reads but does not edit:
 * a JSON payload, a list of file paths, a captured error.
 *
 * The export page had this as `.st-export-backup-details`, a `<pre>` with its own
 * background, border, radius, padding, type size and scroll cap declared on the
 * surface. Every one of those is an appearance decision, and appearance decisions
 * made in a surface are how two screens end up showing the same kind of thing two
 * different ways. The next surface that has to show a payload gets this instead of
 * writing its own.
 *
 * Scrolls rather than grows: the content is machine output of unknown length, and
 * a section whose height is decided by a backend response is a section that pushes
 * everything under it off screen. The cap lives in `code-block.css` — one number,
 * decided once, not a prop each caller re-answers.
 *
 * `tabIndex={0}` because a scrollable region that only a mouse wheel can move is
 * unreachable by keyboard once the content overflows.
 */
import { Show, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { CopyIcon } from './icons'
import { IconButton } from './icon-button'
import { showToast } from './toast'

export interface CodeBlockProps {
  children: string
  /** Accessible name, when the block needs one beyond its surrounding label. */
  ariaLabel?: string
  /** Injected platform clipboard operation. Existing callers with their own copy
   * affordance may omit this and render only the read-only block. */
  copy?: (text: string) => Promise<void>
}

export interface CodeBlockCopyButtonProps {
  /** Read at click time so an imperative streaming block copies current code. */
  getText: () => string
  copy: (text: string) => Promise<void>
}

function CodeBlockCopyButton(props: CodeBlockCopyButtonProps) {
  const [copied, setCopied] = createSignal(false)

  const copy = async (): Promise<void> => {
    try {
      await props.copy(props.getText())
      setCopied(true)
      showToast({ level: 'success', message: 'Code copied' })
    } catch {
      setCopied(false)
      showToast({ level: 'danger', message: 'Could not copy code' })
    }
  }

  return (
    <IconButton
      ariaLabel={copied() ? 'Copied' : 'Copy code'}
      title={copied() ? 'Copied' : 'Copy code'}
      size="sm"
      onClick={() => void copy()}
    >
      <CopyIcon />
    </IconButton>
  )
}

/** Mount the CodeBlock copy control into an imperative DOM surface. */
export function mountCodeBlockCopyButton(
  host: HTMLElement,
  props: CodeBlockCopyButtonProps,
): () => void {
  return render(() => <CodeBlockCopyButton {...props} />, host)
}

export function CodeBlock(props: CodeBlockProps) {
  return (
    <div class="ui-code-block-wrap" classList={{ 'ui-code-block-wrap--copy': Boolean(props.copy) }}>
      <pre class="ui-code-block" aria-label={props.ariaLabel} tabIndex={0}>
        {props.children}
      </pre>
      <Show when={props.copy}>
        <CodeBlockCopyButton getText={() => props.children} copy={props.copy!} />
      </Show>
    </div>
  )
}

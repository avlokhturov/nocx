/**
 * The degraded-session notice (nocx-5uu5): the card a user sees the first
 * time a shell fails to integrate a given way, and the Details dialog behind
 * it.
 *
 * Owner decisions this implements, taken 2026-08-12 rather than invented
 * here: the fact lives as a persistent mark on the TAB for as long as the
 * session stays degraded (tab.tsx already owns that mark), plus this card
 * shown once per (shell, reason) pair — not once per session, because one
 * shell failing one way is one thing to learn however many tabs it happens
 * in. The message names no third-party program. The Details dialog shows the
 * chain of facts, including the observed process name, labelled as a guess.
 * The actions are how-to-fix, don't-show-again-for-this-shell, and a link to
 * the explanation. "Apply the fix for me" is nocx-cqkg and is deliberately
 * not here.
 *
 * Everything visible is a kit component placed by this surface. The wrapper
 * class positions the card over the terminal (placement — `position`, `top`,
 * `width`, `margin`) and repaints nothing, which is the boundary
 * frontend/src/ui/README.md draws.
 */

import { createSignal, Show, type JSX } from 'solid-js'
import { render } from 'solid-js/web'
import { Button } from '../ui/button'
import { CodeBlock } from '../ui/code-block'
import { Dialog } from '../ui/dialog'
import { IconButton } from '../ui/icon-button'
import { MarkerList, type MarkerListItem } from '../ui/marker-list'
import { StatusCard } from '../ui/status-card'
import { Toolbar } from '../ui/toolbar'
import { showToast } from '../ui/toast'
import type { SessionIntegrationChanged } from '../generated/session.integrationChanged'
import { integrationMessage, type IntegrationMessage } from './status'

/** Where the explanation lives. A link to a page that does not exist is
 *  worse than no link, so this points at the document added with this bead. */
export const INTEGRATION_HELP_URL =
  'https://github.com/shady2k/nocx/blob/main/docs/shell-integration.md'

export interface IntegrationNoticeProps {
  /** The degraded fact. */
  fact: SessionIntegrationChanged
  /** Copy the snippet to the clipboard. Rejects like every clipboard call. */
  copy: (text: string) => Promise<void>
  /** Open the explanation in a browser. Rejects like every opener. */
  openUrl: (url: string) => Promise<void>
  /** The user asked not to be shown this shell's cards again. */
  onSuppressShell: () => void
  /** Dismiss this card. "Not now" — the card is already once-per-pair, so
   *  there is nothing further to remember. */
  onDismiss: () => void
}

/** The chain of facts the Details dialog shows, in the order a person reads
 *  them: what nocx started, what is true now, what worked last, and the
 *  guess. Each item is one sentence. */
function detailItems(fact: SessionIntegrationChanged, msg: IntegrationMessage): MarkerListItem[] {
  const items: MarkerListItem[] = [
    { tone: 'note', text: `nocx started ${fact.shell}` },
    { tone: 'excluded', text: msg.happening },
    { tone: 'included', text: msg.lastGoodStep },
  ]
  if (fact.detail?.observedProcess) {
    // Labelled as a guess in the sentence itself, not by placement. It is
    // derived from the process table, which can be raced, and never from
    // the byte stream, which AD-6 forbids the backend to interpret — so a
    // reader who sees only this line still knows what it is worth.
    items.push({
      tone: 'note',
      text: `Best guess, not a finding: nocx saw "${fact.detail.observedProcess}" running where it expected the shell.`,
    })
  }
  return items
}

export function IntegrationNotice(props: IntegrationNoticeProps): JSX.Element {
  const [detailsOpen, setDetailsOpen] = createSignal(false)
  const [fixOpen, setFixOpen] = createSignal(false)
  const msg = () => integrationMessage(props.fact)

  const copySnippet = (snippet: string) => {
    props.copy(snippet).then(
      () => showToast({ level: 'success', message: 'Copied' }),
      () => showToast({ level: 'danger', message: 'Could not copy to the clipboard' }),
    )
  }

  const openHelp = () => {
    props.openUrl(INTEGRATION_HELP_URL).catch(() => {
      showToast({ level: 'danger', message: 'Could not open the explanation' })
    })
  }

  return (
    <Show when={msg()} keyed>
      {(m) => (
        <div class="nocx-integration-notice">
          <StatusCard
            tone="warning"
            title={m.title}
            description={m.description}
            action={
              <Toolbar ariaLabel="Shell integration">
                <Button onClick={() => setDetailsOpen(true)}>Details</Button>
                <IconButton ariaLabel="Dismiss" size="sm" onClick={() => props.onDismiss()}>
                  {'×'}
                </IconButton>
              </Toolbar>
            }
          />
          <Dialog
            open={detailsOpen()}
            onClose={() => setDetailsOpen(false)}
            title={m.title}
            footer={
              <>
                <Show when={m.snippet}>
                  <Button onClick={() => setFixOpen(true)}>How to fix</Button>
                </Show>
                <Button
                  onClick={() => {
                    props.onSuppressShell()
                    setDetailsOpen(false)
                  }}
                >
                  Don't show again for this shell
                </Button>
                <Button onClick={openHelp}>Learn more</Button>
                <Button variant="primary" onClick={() => setDetailsOpen(false)}>
                  Close
                </Button>
              </>
            }
          >
            <MarkerList items={detailItems(props.fact, m)} />
          </Dialog>
          <Show when={m.snippet} keyed>
            {(snippet) => (
              <Dialog
                open={fixOpen()}
                onClose={() => setFixOpen(false)}
                title="How to fix"
                footer={
                  <>
                    <Button onClick={() => copySnippet(snippet)}>Copy</Button>
                    <Button variant="primary" onClick={() => setFixOpen(false)}>
                      Close
                    </Button>
                  </>
                }
              >
                <CodeBlock ariaLabel="Commands to run">{snippet}</CodeBlock>
              </Dialog>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}

/** Mount the notice over a tab's pane and return its disposer. The card
 *  overlays rather than taking layout space, exactly like the clipboard
 *  banner: a card inserted into the flow shrinks the terminal, and shrinking
 *  the terminal reflows the grid down to the PTY — a message about the
 *  session must not rewrite the session. */
export function mountIntegrationNotice(
  target: HTMLElement,
  props: IntegrationNoticeProps,
): () => void {
  const host = document.createElement('div')
  target.appendChild(host)
  const dispose = render(() => <IntegrationNotice {...props} />, host)
  return () => {
    dispose()
    host.remove()
  }
}

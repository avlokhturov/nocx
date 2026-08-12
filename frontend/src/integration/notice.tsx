/**
 * The degraded-session notice (nocx-5uu5, revised by nocx-0mqs / nocx-rzvq /
 * nocx-qs68 / nocx-aimo): the card a user sees the first time a shell fails
 * to integrate a given way, and the dialog behind it.
 *
 * Owner decisions this implements, taken 2026-08-12 rather than invented
 * here: the fact lives as a persistent mark on the TAB for as long as the
 * session stays degraded (tab.tsx already owns that mark), plus this card
 * shown once per (shell, reason) pair — not once per session, because one
 * shell failing one way is one thing to learn however many tabs it happens
 * in. The message names no third-party program; the observed process name is
 * shown behind the card, labelled as a guess. "Apply the fix for me" is
 * nocx-cqkg and is deliberately not here.
 *
 * Four things the owner measured on the installed build and this file
 * answers:
 *
 *   - The remedy is the card's OWN action, not two clicks away. A user
 *     looking at "Not integrated" wants the fix, and the chain of facts is
 *     what they read when the fix does not apply.
 *   - There is ONE dialog. Details used to be a second surface holding the
 *     chain, the explanation and the silence-this-shell action, so what nocx
 *     knew and what to do about it were different journeys through the same
 *     card. Everything it held is behind the card's primary action now.
 *   - The card sits ABOVE the terminal in the flow (mountIntegrationNotice
 *     below). It used to overlay, and it covered the first prompt line —
 *     a card that hides what it describes is worse than the toast it
 *     replaced.
 *   - The explanation ships in the build rather than at a URL. See
 *     INTEGRATION_EXPLANATION in ./status for why.
 *
 * The card carries three actions and they are three different promises, which
 * is why none of them is a duplicate of another: the primary opens the one
 * dialog, "Don't show again for this shell" silences the card for this shell
 * on this machine for good, and the cross takes THIS card away now. Neither
 * of the last two touches the tab's mark — the mark is the state of the
 * session rather than a notification, and it stays until the session is not
 * degraded any more.
 *
 * Everything visible is a kit component placed by this surface. The identity
 * class positions the card in the pane (placement — `flex`, `margin`) and
 * repaints nothing, which is the boundary frontend/src/ui/README.md draws.
 */

import { createSignal, For, Show, type JSX } from 'solid-js'
import { render } from 'solid-js/web'
import { Button } from '../ui/button'
import { CodeBlock } from '../ui/code-block'
import { Dialog } from '../ui/dialog'
import { IconButton } from '../ui/icon-button'
import { MarkerList, type MarkerListItem } from '../ui/marker-list'
import { Stack } from '../ui/stack'
import { StatusCard } from '../ui/status-card'
import { Toolbar } from '../ui/toolbar'
import { showToast } from '../ui/toast'
import type { SessionIntegrationChanged } from '../generated/session.integrationChanged'
import {
  INTEGRATION_EXPLANATION,
  integrationMessage,
  observationSentence,
  type IntegrationMessage,
} from './status'

export interface IntegrationNoticeProps {
  /** The degraded fact. */
  fact: SessionIntegrationChanged
  /** Copy the snippet to the clipboard. Rejects like every clipboard call. */
  copy: (text: string) => Promise<void>
  /** The user asked not to be shown this shell's cards again. */
  onSuppressShell: () => void
  /** Dismiss this card. "Not now" — the card is already once-per-pair, so
   *  there is nothing further to remember. */
  onDismiss: () => void
}

/** The chain of facts the dialog shows under the remedy, in the order a
 *  person reads them: what nocx started, what is true now, what worked last,
 *  and the guess. One item per fact. */
function detailItems(fact: SessionIntegrationChanged, msg: IntegrationMessage): MarkerListItem[] {
  const items: MarkerListItem[] = [
    { tone: 'note', text: `nocx started ${fact.shell}` },
    { tone: 'excluded', text: msg.happening },
    { tone: 'included', text: msg.lastGoodStep },
  ]
  const observed = observationSentence(fact)
  if (observed) items.push({ tone: 'note', text: observed })
  return items
}

/** What the card's primary action promises, which is the most this reason
 *  can honestly promise. A reason nocx has no remedy for still has a chain
 *  of facts and an explanation worth reading, and it must not be offered
 *  under a label that says nocx can fix it — an empty "How to fix" teaches
 *  the user that the button never helps (nocx-0mqs). One derivation, read by
 *  both the button and the dialog it opens, so the two cannot disagree about
 *  what is behind the click. */
function openLabel(msg: IntegrationMessage): string {
  return msg.fix ? 'How to fix' : 'What happened'
}

function IntegrationNotice(props: IntegrationNoticeProps): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [aboutOpen, setAboutOpen] = createSignal(false)
  const msg = () => integrationMessage(props.fact)

  const copySnippet = (snippet: string) => {
    props.copy(snippet).then(
      () => showToast({ level: 'success', message: 'Copied' }),
      () => showToast({ level: 'danger', message: 'Could not copy to the clipboard' }),
    )
  }

  return (
    <Show when={msg()} keyed>
      {(m) => (
        <>
          <StatusCard
            tone="warning"
            title={m.title}
            description={m.description}
            action={
              <Toolbar ariaLabel="Shell integration">
                {/* The one action this card exists for: the remedy when
                    there is one, and what nocx knows when there is not. */}
                <Button variant="primary" onClick={() => setOpen(true)}>
                  {openLabel(m)}
                </Button>
                {/* Not the same promise as the cross beside it, which is why
                    both are here: this one answers for the shell, on this
                    machine, for good. */}
                <Button
                  onClick={() => {
                    setOpen(false)
                    props.onSuppressShell()
                  }}
                >
                  Don't show again for this shell
                </Button>
                {/* And this one answers only the card in front of the user. */}
                <IconButton ariaLabel="Dismiss" size="sm" onClick={() => props.onDismiss()}>
                  {'×'}
                </IconButton>
              </Toolbar>
            }
          />
          {/* One dialog, in the order a person reads it: what to do, then
              what nocx knows. Details used to hold the second half on a
              surface of its own, so a reader who wanted both took two
              journeys through the same card (nocx-aimo). The observation is
              in the chain and only there — it is one sentence from one
              function (AD-8), and showing it twice on one surface would make
              the same fact look like two. */}
          <Dialog
            open={open()}
            onClose={() => setOpen(false)}
            title={openLabel(m)}
            footer={
              <>
                <Show when={m.fix} keyed>
                  {(fix) => <Button onClick={() => copySnippet(fix.snippet)}>Copy</Button>}
                </Show>
                <Button onClick={() => setAboutOpen(true)}>Learn more</Button>
                <Button variant="primary" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </>
            }
          >
            <Stack>
              <Show when={m.fix} keyed>
                {(fix) => (
                  <>
                    <p>{fix.lead}</p>
                    <CodeBlock ariaLabel="Commands to run">{fix.snippet}</CodeBlock>
                  </>
                )}
              </Show>
              <MarkerList items={detailItems(props.fact, m)} />
            </Stack>
          </Dialog>
          <Dialog
            open={aboutOpen()}
            onClose={() => setAboutOpen(false)}
            title="About shell integration"
            footer={
              <Button variant="primary" onClick={() => setAboutOpen(false)}>
                Close
              </Button>
            }
          >
            <Stack>
              <For each={INTEGRATION_EXPLANATION}>{(para) => <p>{para}</p>}</For>
            </Stack>
          </Dialog>
        </>
      )}
    </Show>
  )
}

/** Mount the notice into a tab's pane and return its disposer.
 *
 *  It goes in the FLOW, as the pane's first child, and the pane is a flex
 *  column — so the card takes its own height off the top and the terminal
 *  below it is laid out in what is left. It used to be `position: absolute`
 *  over the same pane, on the argument that a card in the flow shrinks the
 *  terminal and reflows the grid down to the PTY. That argument was right
 *  about the mechanism and wrong about the cost: the card covered the first
 *  prompt line, which is the line the user is reading when it appears
 *  (nocx-rzvq). The reflow is handled where reflows are handled — the caller
 *  re-measures the live region after mounting and after disposing this.
 *
 *  DOM order carries the placement rather than a CSS `order`, so what a
 *  screen reader walks and what the eye sees stay the same thing. */
export function mountIntegrationNotice(
  target: HTMLElement,
  props: IntegrationNoticeProps,
): () => void {
  const host = document.createElement('div')
  host.className = 'nocx-integration-notice'
  target.insertBefore(host, target.firstChild)
  const dispose = render(() => <IntegrationNotice {...props} />, host)
  return () => {
    dispose()
    host.remove()
  }
}

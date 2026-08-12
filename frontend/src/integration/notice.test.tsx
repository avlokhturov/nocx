// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from 'solid-js/web'
import { IntegrationNotice, INTEGRATION_HELP_URL } from './notice'
import type { SessionIntegrationChanged } from '../generated/session.integrationChanged'

// A test asserts what a user can do (AGENTS.md rule 1): the card exists, the
// actions on it are reachable from the state the user starts in, activating
// one reaches the handler, and the result appears afterwards.

const TIMED_OUT: SessionIntegrationChanged = {
  sessionId: 's1',
  status: 'conventional',
  reason: 'handshake-timeout',
  shell: '/opt/homebrew/bin/bash',
}

let dispose: (() => void) | null = null
let host: HTMLElement | null = null

afterEach(() => {
  dispose?.()
  dispose = null
  host?.remove()
  host = null
  // A dialog left open in the top layer outlives the component's root.
  document.querySelectorAll('dialog').forEach((d) => d.remove())
})

function mount(over: Partial<Parameters<typeof IntegrationNotice>[0]> = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const props = {
    fact: TIMED_OUT,
    copy: vi.fn(() => Promise.resolve()),
    openUrl: vi.fn(() => Promise.resolve()),
    onSuppressShell: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  }
  dispose = render(() => <IntegrationNotice {...props} />, host)
  return { props, root: host }
}

const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  )
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

describe('the degraded-session card', () => {
  it('says what happened, in the agreed words, with no program named', () => {
    const { root } = mount()
    const card = root.querySelector('.ui-status-card')
    expect(card).not.toBeNull()
    expect(card!.getAttribute('data-tone')).toBe('warning')
    expect(root.querySelector('.ui-status-card__title')!.textContent).toBe('Not integrated')
    expect(root.querySelector('.ui-status-card__desc')!.textContent).toBe(
      'Your shell did not answer nocx in time, so this tab is a plain terminal.',
    )
  })

  // It is a kit component placed by the surface, never a hand-rolled div
  // with its own colours — the defect two epics spent themselves unwinding.
  it('is the kit StatusCard, not a private one', () => {
    const { root } = mount()
    expect(root.querySelector('.ui-status-card')).not.toBeNull()
    expect(root.firstElementChild!.className).toBe('nocx-integration-notice')
  })

  it('dismisses when the user closes it', () => {
    const { props } = mount()
    button('×').click()
    expect(props.onDismiss).toHaveBeenCalledOnce()
  })
})

describe('the Details dialog', () => {
  const openDetails = () => button('Details').click()

  it('shows the chain of facts, starting with the shell nocx actually started', () => {
    mount()
    openDetails()
    const items = [...document.querySelectorAll('.ui-marker-list__text')].map((n) =>
      (n.textContent ?? '').trim(),
    )
    expect(items[0]).toBe('nocx started /opt/homebrew/bin/bash')
    expect(items.some((t) => t.includes('plain terminal'))).toBe(true)
    expect(items.some((t) => t.includes('never answered'))).toBe(true)
  })

  // detail.observedProcess is best-effort and MUST be labelled as a guess:
  // it comes from the process table, which can be raced, and never from the
  // byte stream (AD-6). A reader who sees only that line must still know
  // what it is worth.
  it('labels the observed process as a guess, in the sentence itself', () => {
    mount({ fact: { ...TIMED_OUT, detail: { observedProcess: 'some-tui' } } })
    openDetails()
    const guess = [...document.querySelectorAll('.ui-marker-list__text')]
      .map((n) => (n.textContent ?? '').trim())
      .find((t) => t.includes('some-tui'))
    expect(guess).toBeDefined()
    expect(guess!.toLowerCase()).toContain('guess')
  })

  it('omits the guess entirely when the backend observed nothing', () => {
    mount()
    openDetails()
    const texts = [...document.querySelectorAll('.ui-marker-list__text')].map((n) =>
      (n.textContent ?? '').trim(),
    )
    expect(texts.some((t) => t.toLowerCase().includes('guess'))).toBe(false)
  })

  it('silences this shell when the user asks it to', () => {
    const { props } = mount()
    openDetails()
    button("Don't show again for this shell").click()
    expect(props.onSuppressShell).toHaveBeenCalledOnce()
  })

  it('opens the explanation', () => {
    const { props } = mount()
    openDetails()
    button('Learn more').click()
    expect(props.openUrl).toHaveBeenCalledWith(INTEGRATION_HELP_URL)
  })

  // "Apply the fix for me" is nocx-cqkg and is deliberately NOT here: a
  // button that edits the user's startup files needs a backup and a diff
  // they approve first, which is a bead of its own.
  it('offers no apply-it-for-me action', () => {
    mount()
    openDetails()
    const labels = [...document.querySelectorAll('button')].map((b) =>
      (b.textContent ?? '').toLowerCase(),
    )
    expect(labels.some((l) => l.includes('apply') || l.includes('fix it for me'))).toBe(false)
  })
})

describe('the How to fix dialog', () => {
  it('offers a snippet the user can copy', () => {
    const { props } = mount()
    button('Details').click()
    button('How to fix').click()
    const snippet = document.querySelector('.ui-code-block')
    expect(snippet).not.toBeNull()
    expect(snippet!.textContent).toContain('nocx-reached-a-prompt')
    button('Copy').click()
    expect(props.copy).toHaveBeenCalledOnce()
    expect((props.copy as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'nocx-reached-a-prompt',
    )
  })

  // A reason nocx has no honest advice for offers none. An empty "How to
  // fix" that says "try again" is worse than no button: it teaches the user
  // that the button never helps.
  it('is not offered for a reason nocx cannot advise on', () => {
    mount({ fact: { ...TIMED_OUT, reason: 'remote-command' } })
    button('Details').click()
    const labels = [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim())
    expect(labels).not.toContain('How to fix')
  })
})

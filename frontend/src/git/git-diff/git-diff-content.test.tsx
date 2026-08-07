// @vitest-environment jsdom
//
// GitDiffContent tests — the five wire states render distinguishably, the
// line decoration classes land on the rendered lines, the D7 snapshot
// contract (stale offers Reload; a dead binding keeps the content and stops
// all calls), and the frozen-origin capability. The binding is a
// controllable fake: liveness and staleness are real subscriptions with a
// synchronous first call, and every diff call is recorded so "makes no
// client calls" is asserted as a count, not inferred from the absence of a
// message.
import { afterEach, describe, expect, it } from 'vitest'
import type { GitDiffResult } from '../../generated/git.diff'
import type { TabHost } from '../../tab-content'
import { GitDiffContent, type GitDiffDeps } from './git-diff-content'
import type { GitDiffTarget } from './open-git-diff'
import { diffLineClass } from './diff-decoration'

// ── Fake binding ──────────────────────────────────────────────────────────

class FakeBinding {
  live = true
  readonly calls: Array<{ bindingId: string; path: string; side: string; maxBytes: number }> = []
  private readonly livenessCbs = new Set<(live: boolean) => void>()
  private readonly staleCbs = new Set<() => void>()
  private readonly pending: Array<{
    resolve: (r: GitDiffResult) => void
    reject: (e: unknown) => void
  }> = []

  /** The deps object handed to the content; calls route back here. */
  readonly deps: GitDiffDeps = {
    diff: (params) => {
      this.calls.push(params)
      return new Promise<GitDiffResult>((resolve, reject) => {
        this.pending.push({ resolve, reject })
      })
    },
    onBindingLiveness: (_bindingId, cb) => {
      this.livenessCbs.add(cb)
      cb(this.live) // synchronous first call, like the real seam
      return () => {
        this.livenessCbs.delete(cb)
      }
    },
    onDiffStale: (_bindingId, _path, _side, cb) => {
      this.staleCbs.add(cb)
      return () => {
        this.staleCbs.delete(cb)
      }
    },
  }

  setLive(live: boolean): void {
    this.live = live
    for (const cb of [...this.livenessCbs]) cb(live)
  }

  /** The panel's poll saw this row move (D7). */
  fireStale(): void {
    for (const cb of [...this.staleCbs]) cb()
  }

  /** Take the next pending diff. Returns null when none is outstanding. */
  take(): { resolve: (r: GitDiffResult) => void; reject: (e: unknown) => void } | null {
    return this.pending.shift() ?? null
  }

  resolveNext(result: Partial<GitDiffResult>): void {
    const p = this.take()
    if (!p) throw new Error('no pending diff to resolve')
    p.resolve(okResult(result))
  }

  rejectNext(error: Error): void {
    const p = this.take()
    if (!p) throw new Error('no pending diff to reject')
    p.reject(error)
  }
}

function okResult(overrides: Partial<GitDiffResult>): GitDiffResult {
  return { state: 'ok', text: 'hello\nworld\n', truncated: false, ...overrides }
}

const FROZEN_ORIGIN = {
  sessionId: 'sess-1',
  kind: 'local' as const,
  cwd: '/repo',
  cwdVerified: true,
  // The point of the field: a frozen cwd is a snapshot, never a claim about
  // where we are now — activating the tab must never move the panel.
  cwdFollow: false,
  host: null,
}

const TARGET: GitDiffTarget = {
  bindingId: 'b1',
  toplevel: '/repo',
  path: 'src/a.ts',
  side: 'unstaged',
  origin: FROZEN_ORIGIN,
}

// ── Mount helpers ─────────────────────────────────────────────────────────

interface Mounted {
  content: GitDiffContent
  binding: FakeBinding
  host: HTMLElement
}

// CM6 renders each line as a div.cm-line (no newline text nodes), so a raw
// textContent read collapses lines. Joining the line divs reconstructs the
// document exactly, including a trailing empty line for a final newline.
const docText = (host: HTMLElement): string =>
  Array.from(host.querySelectorAll('.cm-line'))
    .map((el) => el.textContent ?? '')
    .join('\n')

async function mount(binding: FakeBinding = new FakeBinding()): Promise<Mounted> {
  const content = new GitDiffContent(TARGET, binding.deps)
  const host = document.createElement('div')
  document.body.append(host)
  const signal = new AbortController().signal
  await content.mount(host, {} as TabHost, signal)
  return { content, binding, host }
}

const line = (host: HTMLElement, state: string): HTMLElement | null =>
  host.querySelector(`.git-diff__line[data-state='${state}']`)

const reloadButton = (host: HTMLElement): HTMLButtonElement | null =>
  host.querySelector('.git-diff__reload button')

const notice = (host: HTMLElement): HTMLElement =>
  host.querySelector('.git-diff__notice') as HTMLElement

const clickReload = async (host: HTMLElement): Promise<void> => {
  reloadButton(host)!.click()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  document.body.innerHTML = ''
})

// ── The classifier (the decoration contract, unit level) ───────────────────

describe('diffLineClass — the load-bearing order', () => {
  it('classifies the four line kinds and leaves context alone', () => {
    expect(diffLineClass('diff --git a/x b/x')).toBe('git-diff-file')
    expect(diffLineClass('index 1111111..2222222 100644')).toBe('git-diff-file')
    expect(diffLineClass('--- a/x')).toBe('git-diff-file')
    expect(diffLineClass('+++ b/x')).toBe('git-diff-file')
    expect(diffLineClass('@@ -1,3 +1,4 @@')).toBe('git-diff-hunk')
    expect(diffLineClass('+added')).toBe('git-diff-add')
    expect(diffLineClass('-removed')).toBe('git-diff-del')
    expect(diffLineClass(' context')).toBeNull()
    expect(diffLineClass('Binary files a/x and b/x differ')).toBeNull()
    expect(diffLineClass('\\ No newline at end of file')).toBeNull()
  })

  it('never mistakes a file-header ---/+++ line for an add or del', () => {
    // `--- a/x` is the old-path header, `-x` is a deletion. The three-dash
    // forms MUST win the order.
    expect(diffLineClass('--- a/x')).toBe('git-diff-file')
    expect(diffLineClass('-x')).toBe('git-diff-del')
    expect(diffLineClass('+++ b/x')).toBe('git-diff-file')
    expect(diffLineClass('+x')).toBe('git-diff-add')
  })
})

// ── The read ───────────────────────────────────────────────────────────────

describe('GitDiffContent — the read', () => {
  it('reads once on a live binding and renders the content', async () => {
    const { content, binding, host } = await mount()
    expect(binding.calls).toEqual([
      { bindingId: 'b1', path: 'src/a.ts', side: 'unstaged', maxBytes: 1 << 20 },
    ])

    binding.resolveNext({ text: 'hello\nworld\n' })
    await Promise.resolve()

    expect(docText(host)).toBe('hello\nworld\n')
    expect(notice(host).hidden).toBe(true)
    content.dispose()
  })

  it('renders nothing and makes no calls when the binding is dead at mount', async () => {
    const binding = new FakeBinding()
    binding.live = false
    const { content, host } = await mount(binding)

    expect(binding.calls).toEqual([])
    expect(line(host, 'unavailable')?.textContent).toContain('Source unavailable')
    expect(docText(host)).toBe('')
    content.dispose()
  })
})

// ── The five wire states ───────────────────────────────────────────────────

describe('GitDiffContent — the five wire states render distinguishably', () => {
  it('ok renders the diff with no notice', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'ok', text: 'a\nb\n', truncated: false })
    await Promise.resolve()

    expect(docText(host)).toBe('a\nb\n')
    expect(notice(host).hidden).toBe(true)
    content.dispose()
  })

  it('binary says so instead of showing an empty editor', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'binary', text: '', truncated: false })
    await Promise.resolve()

    expect(line(host, 'binary')?.textContent).toBe('binary file — nothing to show')
    expect(docText(host)).toBe('')
    // No reload offer: the file did not change, it IS binary.
    expect(reloadButton(host)).toBeNull()
    content.dispose()
  })

  it('tooLarge shows the retained prefix and that it is a prefix', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'tooLarge', text: 'prefix-of-diff', truncated: true })
    await Promise.resolve()

    const t = line(host, 'tooLarge')
    expect(t?.textContent).toContain('1 MiB')
    expect(t?.textContent).toContain('prefix')
    expect(docText(host)).toBe('prefix-of-diff')
    content.dispose()
  })

  it('empty is ordinary: the file changed back, or the poll raced the click', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'empty', text: '', truncated: false })
    await Promise.resolve()

    expect(line(host, 'empty')?.textContent).toContain('no differences')
    expect(docText(host)).toBe('')
    content.dispose()
  })

  it('gone says the path no longer exists on that side', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'gone', text: '', truncated: false })
    await Promise.resolve()

    expect(line(host, 'gone')?.textContent).toContain('no longer exists')
    expect(docText(host)).toBe('')
    content.dispose()
  })

  it('a failed read on a live binding is an error state with a retry', async () => {
    const { content, binding, host } = await mount()
    binding.rejectNext(new Error('unknown binding'))
    await Promise.resolve()

    const e = line(host, 'error')
    expect(e?.textContent).toContain('unknown binding')
    expect(reloadButton(host)?.disabled).toBe(false)

    await clickReload(host)
    expect(binding.calls).toHaveLength(2)
    binding.resolveNext({ state: 'ok', text: 'retried-ok' })
    await Promise.resolve()
    expect(docText(host)).toBe('retried-ok')
    expect(notice(host).hidden).toBe(true)
    content.dispose()
  })
})

// ── Decoration ─────────────────────────────────────────────────────────────

const UNIFIED_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const one = 1',
  '-const two = 2',
  '+const two = 20',
  ' const three = 3',
].join('\n')

describe('GitDiffContent — the lines carry distinct decoration', () => {
  it('renders the unified text with one class per line kind', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'ok', text: UNIFIED_DIFF })
    await Promise.resolve()

    const cmLines = Array.from(host.querySelectorAll('.cm-line'))
    expect(cmLines.length).toBe(9)

    const classesOf = (i: number): string[] =>
      Array.from(cmLines[i].classList).filter((c) => c.startsWith('git-diff-'))
    const kinds = [
      ['git-diff-file'], // diff --git
      ['git-diff-file'], // index
      ['git-diff-file'], // ---
      ['git-diff-file'], // +++
      ['git-diff-hunk'], // @@
      [], // context
      ['git-diff-del'], // -const two = 2
      ['git-diff-add'], // +const two = 20
      [], // context
    ]
    kinds.forEach((expected, i) => {
      expect(classesOf(i)).toEqual(expected)
    })
    content.dispose()
  })
})

// ── Snapshot plus an offer (D7) ────────────────────────────────────────────

describe('GitDiffContent — a stale snapshot offers Reload, never reloads', () => {
  it('a stale snapshot shows the changed line and Reload; the offer is the only re-read', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'ok', text: 'snapshot' })
    await Promise.resolve()
    expect(notice(host).hidden).toBe(true)

    binding.fireStale()
    await Promise.resolve()

    expect(line(host, 'changed')?.textContent).toContain('changed since it was opened')
    expect(reloadButton(host)?.disabled).toBe(false)
    // The offer is the only re-read: nothing was issued by the signal itself.
    expect(binding.calls).toHaveLength(1)
    expect(docText(host)).toBe('snapshot')

    // Reload re-reads exactly once and a fresh result clears the notice.
    await clickReload(host)
    expect(binding.calls).toHaveLength(2)
    binding.resolveNext({ state: 'ok', text: 'fresh' })
    await Promise.resolve()
    expect(docText(host)).toBe('fresh')
    expect(notice(host).hidden).toBe(true)
    content.dispose()
  })

  it('a staleness that lands while the reload is in flight marks the fresh result', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'ok', text: 'old' })
    await Promise.resolve()

    // Stale once so a Reload exists, then re-read while the poll moves
    // again before the reload lands: the fresh snapshot is already stale
    // and must say so rather than presenting itself as current.
    binding.fireStale()
    await Promise.resolve()
    await clickReload(host)
    expect(binding.calls).toHaveLength(2)

    binding.fireStale()
    binding.resolveNext({ state: 'ok', text: 'newer' })
    await Promise.resolve()

    expect(docText(host)).toBe('newer')
    expect(line(host, 'changed')).not.toBeNull()
    expect(reloadButton(host)).not.toBeNull()
    content.dispose()
  })

  it('tooLarge and stale render as two lines, one offer', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'tooLarge', text: 'prefix', truncated: true })
    await Promise.resolve()
    binding.fireStale()
    await Promise.resolve()

    expect(line(host, 'tooLarge')).not.toBeNull()
    expect(line(host, 'changed')).not.toBeNull()
    expect(reloadButton(host)?.disabled).toBe(false)
    content.dispose()
  })
})

// ── A dead binding is terminal for calls ───────────────────────────────────

describe('GitDiffContent — a dead binding is terminal for calls', () => {
  it('keeps the content, shows the unavailable state, and issues no further calls', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'ok', text: 'still-on-screen' })
    await Promise.resolve()
    expect(docText(host)).toBe('still-on-screen')

    binding.setLive(false)
    await Promise.resolve()

    // Content stays; the banner says why; nothing new was called.
    expect(docText(host)).toBe('still-on-screen')
    expect(line(host, 'unavailable')?.textContent).toContain('Source unavailable')
    expect(binding.calls).toHaveLength(1)

    // Reload is present but disabled, and clicking it cannot call.
    const btn = reloadButton(host)
    expect(btn?.disabled).toBe(true)
    expect(btn?.title).toContain('gone')
    btn!.click()
    await Promise.resolve()
    expect(binding.calls).toHaveLength(1)
    content.dispose()
  })

  it('drops an in-flight read when the binding dies before it resolves', async () => {
    const { content, binding, host } = await mount()
    binding.setLive(false)
    // The pending read from mount resolves AFTER the death: it must not paint.
    binding.resolveNext({ state: 'ok', text: 'late-content' })
    await Promise.resolve()

    expect(docText(host)).toBe('')
    expect(line(host, 'unavailable')).not.toBeNull()
    expect(binding.calls).toHaveLength(1)
    content.dispose()
  })

  it('staleness after death is ignored — no notice churn, no calls', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'ok', text: 'kept' })
    await Promise.resolve()
    binding.setLive(false)
    binding.fireStale()
    await Promise.resolve()

    expect(docText(host)).toBe('kept')
    expect(line(host, 'unavailable')).not.toBeNull()
    expect(line(host, 'changed')).toBeNull()
    expect(binding.calls).toHaveLength(1)
    content.dispose()
  })

  it('re-enables Reload when the binding comes back, without auto-reloading', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'ok', text: 'kept' })
    await Promise.resolve()
    binding.setLive(false)
    await Promise.resolve()

    binding.setLive(true)
    await Promise.resolve()

    // Still the stale content, still the banner — but the offer is live
    // again and the user's click is the only thing that reads (D6, D7).
    expect(docText(host)).toBe('kept')
    expect(line(host, 'unavailable')).not.toBeNull()
    expect(reloadButton(host)?.disabled).toBe(false)
    expect(binding.calls).toHaveLength(1)

    await clickReload(host)
    expect(binding.calls).toHaveLength(2)
    binding.resolveNext({ state: 'ok', text: 'fresh' })
    await Promise.resolve()
    expect(docText(host)).toBe('fresh')
    expect(notice(host).hidden).toBe(true)
    content.dispose()
  })

  it('disposal drops an in-flight read and removes the DOM', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'ok', text: 'late' })
    content.dispose()

    await Promise.resolve()
    expect(host.querySelector('.git-diff')).toBeNull()
    // No exception from the late resolution, and nothing painted.
    binding.setLive(false)
  })
})

// ── The frozen origin (design §5.4) ────────────────────────────────────────

describe('GitDiffContent — the activeOrigin capability (design §5.4)', () => {
  it('answers the frozen origin it was opened with, minus the tabId', async () => {
    const { content } = await mount()
    expect(content.activeOrigin()).toEqual(FROZEN_ORIGIN)
    content.dispose()
  })

  it('answers null when the opener had no origin to hand over', async () => {
    const { content } = await mount()
    content.dispose()
    const bare = new GitDiffContent({ ...TARGET, origin: null }, new FakeBinding().deps)
    expect(bare.activeOrigin()).toBeNull()
    bare.dispose()
  })

  it('a frozen origin never says where we are now (cwdFollow: false)', async () => {
    const { content } = await mount()
    const origin = content.activeOrigin()
    expect(origin?.cwdFollow).toBe(false)
    expect(origin?.cwd).toBe('/repo')
    content.dispose()
  })
})

// ── Read-only ──────────────────────────────────────────────────────────────

describe('GitDiffContent — read-only', () => {
  it('no keystroke can reach the document', async () => {
    const { content, binding, host } = await mount()
    binding.resolveNext({ state: 'ok', text: 'frozen\ncontent\n' })
    await Promise.resolve()

    const contentEl = host.querySelector('.cm-content') as HTMLElement
    // The structural guarantees: not an editable region, declared read-only.
    expect(contentEl.getAttribute('contenteditable')).toBe('false')
    expect(contentEl.getAttribute('aria-readonly')).toBe('true')

    const key = (init: KeyboardEventInit): void => {
      contentEl.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      )
    }
    key({ key: 'a' })
    key({ key: 'Enter' })
    key({ key: 'Backspace' })
    key({ key: 'x', ctrlKey: true })
    key({ key: 'z', ctrlKey: true }) // undo history is not even installed

    expect(docText(host)).toBe('frozen\ncontent\n')
    content.dispose()
  })
})

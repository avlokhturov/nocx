// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  normalizePlatform,
  platformFromUserAgent,
  bootstrapPlatform,
  currentPlatform,
} from './platform'

// Partial mock: System.Environment is the only fact this file owns. The rest
// of the runtime stays real, because platform.ts reaches log.ts, which
// reaches the generated bindings, which pull further exports out of this
// module at import time. Listing those here is a list that goes stale the
// next time the binding generator runs.
vi.mock('@wailsio/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wailsio/runtime')>()),
  System: { Environment: vi.fn() },
}))

const { System } = await import('@wailsio/runtime')
const environmentMock = System.Environment as unknown as ReturnType<typeof vi.fn>

describe('normalizePlatform', () => {
  it.each(['darwin', 'linux', 'windows'] as const)('passes %s through', (p) => {
    expect(normalizePlatform(p)).toBe(p)
  })

  it('maps anything unrecognised to web rather than guessing', () => {
    expect(normalizePlatform('freebsd')).toBe('web')
    expect(normalizePlatform('')).toBe('web')
  })
})

describe('platformFromUserAgent', () => {
  it('recognises macOS, the only platform the inset is for', () => {
    expect(
      platformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'),
    ).toBe('darwin')
  })

  // The fallback only ever runs in a browser, where the host draws no window
  // controls over our chrome — so anything not clearly macOS reserves nothing.
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'linux browser'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'windows browser'],
    ['', 'no user agent at all'],
  ])('reports web for %s', (ua) => {
    expect(platformFromUserAgent(ua)).toBe('web')
  })
})

describe('currentPlatform — the capability-facing fact', () => {
  // Declared before the bootstrap tests on purpose: this is the module's
  // initial state, and the first bootstrap call below overwrites it.
  it('is web before the runtime has answered', () => {
    expect(currentPlatform()).toBe('web')
  })

  it('is the GOOS the Wails runtime reports', async () => {
    environmentMock.mockResolvedValue({ OS: 'darwin' })
    await bootstrapPlatform(document.createElement('div'))
    expect(currentPlatform()).toBe('darwin')
  })

  it('stays web when there is no runtime, even when the UA fallback says darwin', async () => {
    // A macOS browser must keep the traffic-light chrome (data-platform
    // darwin) while URL opening takes the web path — the browser has no
    // Wails runtime to open a system browser with. The two facts are both
    // platform.ts's; no consumer re-derives either (AD-8).
    environmentMock.mockRejectedValue(new Error('no wails runtime'))
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    )
    const root = document.createElement('div')
    await expect(bootstrapPlatform(root)).resolves.toBe('darwin')
    expect(root.getAttribute('data-platform')).toBe('darwin')
    expect(currentPlatform()).toBe('web')
  })
})

describe('bootstrapPlatform', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    environmentMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stamps the platform the Wails runtime reports', async () => {
    environmentMock.mockResolvedValue({ OS: 'linux' })
    await expect(bootstrapPlatform(root)).resolves.toBe('linux')
    expect(root.getAttribute('data-platform')).toBe('linux')
  })

  it('reserves the traffic-light inset only on darwin', async () => {
    environmentMock.mockResolvedValue({ OS: 'darwin' })
    await bootstrapPlatform(root)
    expect(root.getAttribute('data-platform')).toBe('darwin')
  })

  // A failure to identify the host must not stop the app mounting, and the
  // fallback has to be the value that adds no chrome.
  it('falls back to the user agent when there is no runtime', async () => {
    environmentMock.mockRejectedValue(new Error('no wails runtime'))
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    )
    await expect(bootstrapPlatform(root)).resolves.toBe('web')
    expect(root.getAttribute('data-platform')).toBe('web')
  })
})

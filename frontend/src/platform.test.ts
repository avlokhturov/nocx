// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { normalizePlatform, platformFromUserAgent, bootstrapPlatform } from './platform'

vi.mock('../wailsjs/runtime/runtime', () => ({
  Environment: vi.fn(),
}))

const { Environment } = await import('../wailsjs/runtime/runtime')
const environmentMock = Environment as unknown as ReturnType<typeof vi.fn>

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
    environmentMock.mockResolvedValue({ platform: 'linux' })
    await expect(bootstrapPlatform(root)).resolves.toBe('linux')
    expect(root.getAttribute('data-platform')).toBe('linux')
  })

  it('reserves the traffic-light inset only on darwin', async () => {
    environmentMock.mockResolvedValue({ platform: 'darwin' })
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

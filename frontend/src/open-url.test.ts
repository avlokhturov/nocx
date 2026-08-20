// @vitest-environment jsdom
// The URL-open capability (brief, nocx-0ybp): a platform capability behind
// one seam (AD-8, the same class of thing as clipboard.ts), exercised in
// BOTH environments. jsdom has no Wails runtime, so the web path is the
// default; the native path is reached the way the packaged app reaches it —
// bootstrapPlatform resolving the GOOS from the (mocked) runtime. The
// platform fact is platform.ts's; this file only consumes it, and the
// macOS-browser case at the bottom proves the two facts stay separate.
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { bootstrapPlatform } from './platform'
import { createUrlOpener, type OpenUrlTransport } from './open-url'

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

const HOSTING_URL = 'https://github.com/shady2k/nocx/tree/main'

/** A transport whose openUrl is observable as a mock — the recorder form
 *  the tests assert on (openUrl is a property on the wire seam, so the
 *  mock is a value the tests can reach and override). */
interface MockedUrlTransport extends OpenUrlTransport {
  openUrl: Mock<(url: string) => Promise<unknown>>
}

function nativeTransport(over: Partial<MockedUrlTransport> = {}): MockedUrlTransport {
  const openUrl = vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({})
  return { openUrl, ...over }
}

/** Reset the runtime fact the way startup does when there is no runtime. */
async function asWeb(): Promise<void> {
  environmentMock.mockRejectedValue(new Error('no wails runtime'))
  await bootstrapPlatform(document.createElement('div'))
}

/** Reset the runtime fact the way the packaged app has it: GOOS from the
 *  runtime, which is exactly what makes the native path reachable. */
async function asNative(platform: 'darwin' | 'linux' | 'windows' = 'linux'): Promise<void> {
  environmentMock.mockResolvedValue({ OS: platform })
  await bootstrapPlatform(document.createElement('div'))
}

describe('web path (no Wails runtime)', () => {
  beforeEach(asWeb)
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens a new tab with noopener,noreferrer and never touches the native transport', async () => {
    const win = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    const native = nativeTransport()
    const { openUrl } = native
    const opener = createUrlOpener(native)

    await expect(opener.open(HOSTING_URL)).resolves.toBeUndefined()
    // A tab opened from the panel must never get a handle back on the
    // app's window — noopener,noreferrer is the whole point of the
    // features string.
    expect(win).toHaveBeenCalledWith(HOSTING_URL, '_blank', 'noopener,noreferrer')
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('opens synchronously in the click gesture — window.open before any microtask', async () => {
    // The regression this guards: a window.open issued after an await has
    // lost the user gesture and popup blockers eat it. If someone later
    // "tidies" the web path into an async chain with an await above the
    // call, this fails — the await yields, the microtask runs, and
    // window.open lands after it.
    const win = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    const opener = createUrlOpener(nativeTransport())

    let microtaskRan = false
    void Promise.resolve().then(() => {
      microtaskRan = true
    })
    const opened = opener.open(HOSTING_URL)
    expect(win).toHaveBeenCalled()
    expect(microtaskRan).toBe(false)
    await opened
  })

  it('a popup blocked by the browser rejects the open, and the ordinary GitHub remote opens', async () => {
    // The paired assertion (AGENTS.md rule 2): for the refusal above,
    // there is the ordinary success — an unblocked browser opens.
    const blocked = vi.spyOn(window, 'open').mockReturnValue(null)
    const opener = createUrlOpener(nativeTransport())
    await expect(opener.open(HOSTING_URL)).rejects.toThrow('popup blocked')
    blocked.mockRestore()

    const win = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    await expect(opener.open(HOSTING_URL)).resolves.toBeUndefined()
    expect(win).toHaveBeenCalled()
  })
})

describe('native path (Wails runtime present)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The brief's contract for BOTH environments: on every native GOOS the
  // URL goes to the transport and window.open is never called; on web it
  // is the other way around (the web describe above).
  it.each(['darwin', 'linux', 'windows'] as const)(
    'on %s the URL goes to the transport and window.open is never called',
    async (platform) => {
      await asNative(platform)
      const win = vi.spyOn(window, 'open')
      const native = nativeTransport()
      const { openUrl } = native
      const opener = createUrlOpener(native)

      await expect(opener.open(HOSTING_URL)).resolves.toBeUndefined()
      expect(openUrl).toHaveBeenCalledWith(HOSTING_URL)
      expect(win).not.toHaveBeenCalled()
    },
  )

  it('a refused transport rejects the open, and on a healthy one it opens', async () => {
    await asNative()
    // Paired assertion: the refusal is not the only story — a working
    // backend hands the URL on.
    const refusing = nativeTransport({
      openUrl: vi.fn().mockRejectedValue(new Error('unavailable')),
    })
    await expect(createUrlOpener(refusing).open(HOSTING_URL)).rejects.toThrow('unavailable')

    const healthy = nativeTransport()
    await expect(createUrlOpener(healthy).open(HOSTING_URL)).resolves.toBeUndefined()
  })

  it('a transport that throws synchronously still rejects, it never throws', async () => {
    await asNative()
    // The panel attaches .catch() to the returned promise; a synchronous
    // throw would escape before the catch attaches and the refusal would
    // be visible only in the console, never to the user.
    const throwing = nativeTransport({
      openUrl: vi.fn(() => {
        throw new Error('boom')
      }),
    })
    const opener = createUrlOpener(throwing)
    await expect(opener.open(HOSTING_URL)).rejects.toThrow('boom')
  })
})

describe('the platform facts stay separate (AD-8)', () => {
  it('a macOS browser routes URL opens through the web path despite the darwin chrome fact', async () => {
    // The exact trap: platformFromUserAgent reports darwin for a macOS
    // browser (traffic-light inset), which must NOT send the click down
    // the shell.openUrl path — the browser has no Wails runtime and the
    // backend answers -32601. The runtime fact is what routes.
    environmentMock.mockRejectedValue(new Error('no wails runtime'))
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    )
    await bootstrapPlatform(document.createElement('div'))

    const win = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    const native = nativeTransport()
    const { openUrl } = native
    await createUrlOpener(native).open(HOSTING_URL)
    expect(win).toHaveBeenCalled()
    expect(openUrl).not.toHaveBeenCalled()
  })
})

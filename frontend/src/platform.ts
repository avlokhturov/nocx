/**
 * Host platform, published to CSS as `data-platform` on the root element.
 *
 * The module owns TWO facts, both resolved at startup and both read
 * synchronously — no consumer may re-derive either (AD-8):
 *
 * 1. The CHROME platform — what `bootstrapPlatform` stamps on the root
 *    element. Exists for one reason so far and it is a real one: the tab
 *    bar reserves 78px on its leading edge for the macOS traffic lights.
 *    macOS is the only platform that puts window controls there — on Linux
 *    and in a browser that reservation is just an empty notch the user has
 *    to look at.
 * 2. The RUNTIME platform — `currentPlatform()`, what capabilities consult
 *    for synchronous path decisions (open-url.ts: web vs native). It is
 *    the GOOS when the Wails runtime is present, `'web'` when it is not.
 *    This is NOT the stamped value: the two can differ — a macOS browser
 *    gets `darwin` from the user-agent fallback (traffic-light chrome is
 *    wanted there) while its runtime platform stays `'web'`, because a
 *    browser has no Wails runtime to open a system browser with.
 *
 * Resolution order:
 *   1. The Wails v3 runtime's System.Environment(), which reports the Go
 *      GOOS and is the authority inside the packaged app.
 *   2. The user agent, for the plain-browser dev path where no runtime
 *      exists. Only ever used where there is no window chrome to match
 *      anyway.
 */

import { System } from '@wailsio/runtime'
import { log } from './log'

export type Platform = 'darwin' | 'linux' | 'windows' | 'web'

/** Map a Wails `platform` string onto our own set. */
export function normalizePlatform(raw: string): Platform {
  switch (raw) {
    case 'darwin':
    case 'linux':
    case 'windows':
      return raw
    default:
      return 'web'
  }
}

/**
 * Best guess from the user agent. Deliberately conservative: anything that is
 * not recognisably macOS is reported as `web`, because the only consumer of
 * this value adds chrome, and adding it wrongly is worse than omitting it.
 */
export function platformFromUserAgent(userAgent: string): Platform {
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'darwin'
  return 'web'
}

/**
 * The runtime platform resolved so far. Starts `'web'` — the safe default
 * before the Wails runtime has answered — and is set once by
 * `bootstrapPlatform`: the GOOS when the runtime exists, `'web'` when it
 * does not. See the module comment for why this is a separate fact from
 * the value stamped on the root element.
 */
let current: Platform = 'web'

/** The platform right now, synchronously. A capability whose path choice
 *  must happen inside a user gesture (open-url.ts) reads THIS — never an
 *  async probe of the runtime, which would lose the gesture. */
export function currentPlatform(): Platform {
  return current
}

/**
 * Resolve the platform and stamp it on `document.documentElement`.
 *
 * Never rejects: a failure to identify the platform must not stop the app from
 * mounting, so the fallback is the value that reserves nothing.
 */
export async function bootstrapPlatform(
  root: HTMLElement = document.documentElement,
): Promise<Platform> {
  let platform: Platform
  try {
    const env = await System.Environment()
    platform = normalizePlatform(env.OS)
    current = platform
  } catch {
    platform = platformFromUserAgent(navigator.userAgent)
    current = 'web'
    log.info('nocx: no Wails runtime, platform guessed from user agent', { platform })
  }
  root.setAttribute('data-platform', platform)
  return platform
}

/**
 * Host platform, published to CSS as `data-platform` on the root element.
 *
 * Exists for one reason so far and it is a real one: the tab bar reserves 78px
 * on its leading edge for the macOS traffic lights. macOS is the only platform
 * that puts window controls there — on Linux and in a browser that reservation
 * is just an empty notch the user has to look at.
 *
 * Resolution order:
 *   1. The Wails runtime's Environment(), which reports the Go GOOS and is the
 *      authority inside the packaged app.
 *   2. The user agent, for the plain-browser dev path where no runtime exists.
 *      Only ever used where there is no window chrome to match anyway.
 */

import { Environment } from '../wailsjs/runtime/runtime'
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
    const env = await Environment()
    platform = normalizePlatform(env.platform)
  } catch {
    platform = platformFromUserAgent(navigator.userAgent)
    log.info('nocx: no Wails runtime, platform guessed from user agent', { platform })
  }
  root.setAttribute('data-platform', platform)
  return platform
}

/**
 * e2e: a connection with nothing to authenticate with no longer dies with
 * "nothing to authenticate with" — the auth ladder raises the connection-
 * password ask, and remembering it makes the next open silent.
 *
 * The acceptance, per the worker brief:
 *
 *   1. first open of a password-only profile against cmd/e2e-sshd
 *      (-password): a prompt appears naming the connection and the account
 *      (nocx-s8jn), the password is entered with remember on, and the
 *      connection opens;
 *   2. the remembered password is stored as a vault secret the profile
 *      references (ADR-0017): profiles.json carries the binding;
 *   3. the second open does NOT prompt — the stored secret answers the
 *      challenge and the connection opens.
 *
 * The backend runs with NO Secret Service, so vault setup is the
 * passphrase dialog driven through the Secrets page (the same flow
 * vault.spec.ts proves). The profile is seeded as a stored document with
 * NO password binding — the exact state "saving a host" produces.
 *
 * One serial test: the second open MUST observe state the first open
 * installed, not an independent fixture.
 */
import { test as base, expect, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VaultBackend, type BackendEndpoint } from './harness'

const DEVHARNESS_BIN = process.env.NOCX_VAULT_BIN ?? '/tmp/nocx-devharness'
const FIXTURE_PASSWORD = 'e2e-password-42'
const PROFILE_NAME = 'Password Proof'
const PROFILE_ID = 'ssh:password-proof'
const FIXTURE_PORT = 19901

const TAB = '.nocx-tab'
const TAB_TITLE = '.nocx-tab-title'
const INPUT = '.pane.active .nocx-editor-input'
const PROMPT = '.ui-prompt'
const CONNECT_BTN = `[aria-label="Connect to ${PROFILE_NAME}"]`
/** A disposable root the backend's whole home lives inside (the harness's
 *  DisposableRoot: createHomeIsolation places HOME at root/home and strips
 *  XDG vars, so the config dir resolves to ~/.config/nocx-dev). */
function createDisposableRoot(): string {
  return mkdtempSync(join(tmpdir(), 'nocx-connpw-'))
}

/** Seed the profile store with ONE password-mode profile and no binding —
 *  the state "saving a host" leaves behind. The store lives under the
 *  backend's isolated home (createHomeIsolation strips XDG vars, so the
 *  config dir resolves to ~/.config/nocx-dev). */
function seedProfile(isolatedHome: string, fixtureAddr: number): string {
  const dir = join(isolatedHome, '.config', 'nocx-dev')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'profiles.json')
  writeFileSync(
    path,
    JSON.stringify({
      profiles: [
        {
          id: PROFILE_ID,
          type: 'ssh',
          name: PROFILE_NAME,
          options: {
            host: '127.0.0.1',
            port: fixtureAddr,
            user: 'e2euser',
            auth: 'password',
          },
        },
      ],
      groups: [],
    }),
  )
  return path
}


/** The e2e-sshd fixture: built once, spawned per run with -password. */
function startSshd(password: string): Promise<{
  proc: ChildProcess
  addr: number
  knownHosts: string
}> {
  const bin = join(tmpdir(), `nocx-e2e-sshd-${process.pid}`)
  if (!existsSync(bin)) {
    execFileSync('go', ['build', '-o', bin, './cmd/e2e-sshd'], {
      cwd: join(__dirname, '..'),
    })
  }
  const proc = spawn(bin, ['-password', password], { stdio: ['ignore', 'pipe', 'inherit'] })
  const { promise, resolve, reject } = Promise.withResolvers<{
    proc: ChildProcess
    addr: number
    knownHosts: string
  }>()
  let stdout = ''
  const timer = setTimeout(() => reject(new Error(`e2e-sshd not ready: ${stdout}`)), 15_000)
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    const addr = stdout.match(/ADDR=127\.0\.0\.1:(\d+)/)
    const knownHosts = stdout.match(/KNOWNHOSTS=(.+)$/m)
    if (stdout.includes('READY') && addr) {
      clearTimeout(timer)
      resolve({
        proc,
        addr: Number(addr[1]),
        knownHosts: (knownHosts?.[1] ?? '').trim(),
      })
    }
  })
  proc.on('exit', (code) => {
    clearTimeout(timer)
    reject(new Error(`e2e-sshd exited (${code}): ${stdout}`))
  })
  return promise
}
/** Inject Wails stubs pointing at the given backend endpoint. */
async function bindEndpoint(page: Page, endpoint: BackendEndpoint): Promise<void> {
  await page.context().addInitScript(
    (opts: { p: number; t: string }) => {
      ;(window as unknown as { go: unknown }).go = {
        main: {
          WailsApp: {
            GetWSPort: () => Promise.resolve(opts.p),
            GetWSToken: () => Promise.resolve(opts.t),
            CheckForUpdate: () => Promise.resolve(null),
            ReportHealthy: () => Promise.resolve(),
            ApplyUpdate: () => Promise.resolve(),
          },
        },
      }
    },
    { p: endpoint.port, t: endpoint.token },
  )
}

const test = base

test.describe('connection password ask: first open prompts, remembered second open is silent', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  let backend: VaultBackend
  let root: string
  let fixture: { proc: ChildProcess; addr: number; knownHosts: string }

  test.beforeAll(async () => {
    root = createDisposableRoot()
    fixture = await startSshd(FIXTURE_PASSWORD)
    backend = new VaultBackend(DEVHARNESS_BIN, { root }, true)
  })

  test.afterAll(() => {
    fixture?.proc.kill('SIGTERM')
    backend?.stop()
  })

  test('first open prompts and connects; after remembering, the second open does not prompt', async ({
    page,
  }) => {
    const ep = await backend.start(FIXTURE_PORT)
    await bindEndpoint(page, ep)
    await page.goto('/')
    await expect(page.locator(TAB_TITLE).first()).not.toHaveText('', { timeout: 15_000 })

    // ── Phase 1: set up the vault (no Secret Service → passphrase dialog) ─
    await page.keyboard.press('Meta+,')
    await expect(page.locator('.ui-page__scroll')).toBeVisible({ timeout: 5000 })
    await page.locator('.ui-settings-section-nav-item[data-section="Secrets"]').click()
    await page.getByRole('button', { name: 'Set up protection' }).click()
    await expect(page.getByRole('dialog').filter({ hasText: 'Set Up Vault' })).toBeVisible({
      timeout: 10_000,
    })
    await page.locator('#vault-setup-passphrase').fill('master-passphrase-7')
    await page.locator('#vault-setup-confirm').fill('master-passphrase-7')
    await page.getByRole('dialog').getByRole('button', { name: /Set Up/i }).click()
    await expect(page.getByRole('dialog').filter({ hasText: 'Recovery Code' })).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('dialog').filter({ hasText: 'Set Up Vault' })).not.toBeVisible({
      timeout: 10_000,
    })

    // ── Phase 2: seed a password-only profile with NO stored secret ──────
    // The backend's known_hosts gets the fixture's host key so the open
    // reaches authentication instead of stopping at the trust prompt.
    const home = backend.isolatedHome
    const profilesPath = seedProfile(home, fixture.addr)
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'known_hosts'), fixture.knownHosts + '\n')

    // ── Phase 3: FIRST open — the ask fires, names the connection ────────
    await page.locator('.ui-settings-section-nav-item[data-section="Connections"]').click()
    await expect(page.locator(CONNECT_BTN)).toBeVisible({ timeout: 10_000 })
    await page.locator(CONNECT_BTN).click()

    // The prompt names which password it is asking for (nocx-s8jn): the
    // connection in the title, the account in the body, the reason too.
    const prompt = page.locator(PROMPT)
    await expect(prompt).toBeVisible({ timeout: 15_000 })
    await expect(prompt.locator('.ui-prompt__title')).toHaveText(`Password for ${PROFILE_NAME}`)
    await expect(prompt).toContainText('e2euser@127.0.0.1')
    await expect(prompt).toContainText('no password is stored for this connection')

    // Type the password and remember it.
    await prompt.locator('#connection-password').fill(FIXTURE_PASSWORD)
    await prompt.locator('input[type="checkbox"]').check()
    await prompt.getByRole('button', { name: 'Connect', exact: true }).click()

    // The connection opens: a tab carrying the profile's name (the other
    // tabs are the initial terminal and the Settings surface opened
    // above). The fixture accepts ONLY the correct password, so the tab
    // appearing IS the proof the ask's answer was used and accepted — a
    // wrong answer or a blocked ask would have errored the open instead.
    const profileTab = page.locator('.nocx-tab', { hasText: PROFILE_NAME })
    await expect(profileTab).toBeVisible({ timeout: 20_000 })
    await expect(prompt).not.toBeVisible()

    // The remember persisted: the profile now references a stored secret
    // (ADR-0017) — the closing event of the remember.
    await expect
      .poll(() => JSON.parse(readFileSync(profilesPath, 'utf8')).profiles[0].options?.passwordSecret, {
        timeout: 10_000,
      })
      .toBeTruthy()

    // ── Phase 4: close the profile tab, SECOND open — silent ────────────
    // The active tab is the profile tab (it opened last); its title may
    // have been replaced by the remote shell's own title, so close it by
    // activeness, not by text.
    await page.locator('.nocx-tab[aria-selected="true"] [aria-label="Close tab"]').click()
    await expect(page.locator('.nocx-tab')).toHaveCount(2, { timeout: 10_000 })
    await page.locator(CONNECT_BTN).click()

    // No prompt may appear: a raised ask would block the open until
    // answered, so the tab appearing within the timeout IS the proof that
    // nothing asked. Assert both halves.
    await expect(page.locator('.nocx-tab')).toHaveCount(3, { timeout: 20_000 })
    await expect(page.locator(PROMPT)).toHaveCount(0)
})
})

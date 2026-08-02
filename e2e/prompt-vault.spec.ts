/**
 * e2e: the vault reaches the prompt (the renderer half of "secrets in the
 * prompt", ADR-0021).
 *
 * The owner's acceptance, one sentence: paste an API key into the prompt, be
 * offered to store it, accept, see a named chip where the key was, run the
 * command and have it WORK, then press Up a week later — figuratively: after
 * a restart — and get a command that still runs, because what came back is
 * the reference and not a mask.
 *
 * The path exercised, end to end through a real backend:
 *   1. set the vault up (Settings -> Secrets -> "Set up protection");
 *   2. type a command carrying a key — the non-modal offer appears, the key
 *      is stored under a name, and the literal becomes `{{secret:NAME}}`,
 *      rendered as the chip;
 *   3. Enter: vault.resolveLine substitutes the live value, the shell runs
 *      the command, and the output proves the VALUE reached the PTY — while
 *      history.record received the reference intact;
 *   4. restart the backend (the vault seals), press Up: the recalled row is
 *      the REFERENCE, not a mask; Enter raises the unlock prompt, and after
 *      unsealing the command runs again.
 *
 * The mask never reaches the PTY and the reference never leaves the ledger:
 * both halves of the invariant are asserted from the outside.
 */
import { test as base, expect, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VaultBackend, type BackendEndpoint, type DisposableRoot } from './harness'

const DEVHARNESS_BIN = process.env.NOCX_VAULT_BIN ?? '/tmp/nocx-devharness-vault'

// Two distinct ports so restart never conflicts with the first instance's
// TIME_WAIT. Both are outside the ranges used by the rest of the suite
// (vault.spec 19876/19877, history-persistence 19878/19879, recall-search
// 19880, wails 34115, the e2e default 9876).
const FIRST_PORT = 19901
const SECOND_PORT = 19902

const TITLE = '.nocx-tab-title'
const INPUT = '.nocx-editor-input'

interface XdgDirsResult {
  root: string
  data: string
  config: string
  cache: string
}

/** Create a temp directory with data/config/cache subdirs for one test case. */
function createXdgDirs(): XdgDirsResult {
  const root = mkdtempSync(join(tmpdir(), 'nocx-prompt-vault-'))
  const data = join(root, 'data')
  const config = join(root, 'config')
  const cache = join(root, 'cache')
  mkdirSync(data, { recursive: true })
  mkdirSync(config, { recursive: true })
  mkdirSync(cache, { recursive: true })
  return { root, data, config, cache }
}

function asDisposableRoot(r: XdgDirsResult): DisposableRoot {
  return { root: r.root }
}

/**
 * Inject Wails stubs pointing at the given backend endpoint. Same shape as
 * vault.spec.ts's helper — context-level so a restart re-binds on reload.
 */
async function bindEndpoint(page: Page, endpoint: BackendEndpoint): Promise<void> {
  await page.context().addInitScript(
    (opts: { p: number; t: string }) => {
      const w = window as unknown as { go?: Record<string, unknown> }
      w.go = {
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

test.describe('vault secrets in the prompt — the owner’s acceptance', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  let backend: VaultBackend
  let xdg: XdgDirsResult

  test.beforeAll(() => {
    xdg = createXdgDirs()
    // `true` = no Secret Service for this backend: the passphrase path is the
    // deterministic one (setup always prompts, unseal always needs the
    // passphrase), exactly like vault.spec.ts's cases 1-2.
    backend = new VaultBackend(DEVHARNESS_BIN, asDisposableRoot(xdg), true)
  })

  test.afterAll(() => {
    backend?.stop()
  })

  const PASS = 'prompt-vault-master-pass'

  test('paste a key -> offered -> chip -> runs -> survives a restart as the reference', async ({
    page,
  }) => {
    // ── Phase 1: set the vault up (Settings -> Secrets) ──────────────────
    const ep = await backend.start(FIRST_PORT)
    await bindEndpoint(page, ep)
    await page.goto('/')
    await expect(page.locator(TITLE).first()).not.toHaveText('', { timeout: 15_000 })

    await page.keyboard.press('Meta+,')
    await expect(page.locator('.ui-page__scroll')).toBeVisible({ timeout: 10_000 })
    await page.locator('.ui-settings-section-nav-item[data-section="Secrets"]').click()
    await expect(page.getByRole('button', { name: 'Set up protection' })).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole('button', { name: 'Set up protection' }).click()

    await expect(page.getByRole('dialog').filter({ hasText: 'Set Up Vault' })).toBeVisible({
      timeout: 10_000,
    })
    await page.locator('#vault-setup-passphrase').fill(PASS)
    await page.locator('#vault-setup-confirm').fill(PASS)
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Set Up/i })
      .click()
    await expect(page.getByRole('dialog').filter({ hasText: 'Recovery Code' })).toBeVisible({
      timeout: 10_000,
    })
    await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click()

    // ── Phase 2: back at the prompt, paste a key, accept the offer ───────
    await page.locator(TITLE).first().click()
    const input = page.locator(INPUT)
    await expect(input).toBeVisible({ timeout: 10_000 })
    await expect(input).toBeFocused({ timeout: 10_000 })

    // The command must WORK with the resolved value, so the proof is the
    // shell echoing it back: the offer fires because sk-proj-... is a
    // detected OpenAI key, and the PTY must receive the live value, not a
    // mask and not the reference.
    const KEY = 'sk-proj-abcdefghijklmnop'
    await input.fill(`echo ${KEY}`)

    // The non-modal offer row settles in, without stealing focus.
    const offer = page.locator('.ui-secret-offer')
    await expect(offer).toBeVisible({ timeout: 5_000 })
    await expect(offer).toContainText('Store this key in the vault?')
    const nameField = page.locator('.ui-secret-offer__name')
    await expect(nameField).toHaveValue('openai-key') // suggested from the kind
    await page.locator('.ui-secret-offer__store').click()

    // The literal became the reference, rendered as the chip. The document
    // holds the reference (the DOM renders the chip in its place), and the
    // pasted key is gone from the surface entirely.
    await expect(page.locator('.ui-secret-chip')).toContainText('openai-key', { timeout: 5_000 })
    await expect(offer).toBeHidden()
    await expect(input).not.toContainText(KEY)
    // ── Phase 3: run it — the VALUE reaches the shell, and works ─────────
    await page.keyboard.press('Enter')
    const block = page.locator('.cmd-block', { hasText: KEY }).first()
    await expect(block).toBeVisible({ timeout: 15_000 })
    // The output IS the resolved value: proof the PTY got the live secret.
    await expect(block).toContainText(KEY)

    // ── Phase 4: restart (the vault seals), Up, run again ────────────────
    const ep2 = await backend.restart(SECOND_PORT)
    await bindEndpoint(page, ep2)
    await page.reload()
    await expect(page.locator(TITLE).first()).not.toHaveText('', { timeout: 15_000 })

    // Up opens recall only from a focused prompt; after a reload the editor
    // takes a moment to own input (the harness's promptReady contract).
    await expect(input).toBeVisible({ timeout: 10_000 })
    await expect(input).toBeFocused({ timeout: 10_000 })
    await page.keyboard.press('ArrowUp')
    const panel = page.locator('.ui-floating-panel[data-variant="recall"]')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await expect(panel).toContainText('{{secret:openai-key}}', { timeout: 10_000 })
    await expect(panel).not.toContainText('...')

    // Enter on the row submits through the same seam: resolveLine hits the
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog').filter({ hasText: 'Unlock the vault' })).toBeVisible({
      timeout: 15_000,
    })
    await page.getByRole('dialog').getByRole('button', { name: 'Passphrase', exact: true }).click()
    await page.locator('#vault-unlock-passphrase').fill(PASS)
    await page.getByRole('dialog').getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(page.getByRole('dialog').filter({ hasText: 'Unlock the vault' })).not.toBeVisible({
      timeout: 10_000,
    })
    const block2 = page.locator('.cmd-block', { hasText: KEY }).last()
    await expect(block2).toBeVisible({ timeout: 15_000 })
    await expect(block2).toContainText(KEY)
  })
})

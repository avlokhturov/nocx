/**
 * e2e: ask the assistant about a frozen block, end to end (nocx-x8s2.2).
 *
 * The feature, stated as behaviour only: with an AI endpoint configured, a
 * person selects a FINISHED (frozen) block in the terminal scrollback, types
 * a question, and an answer streams into the flow beneath it and finishes.
 *
 * This spec is the check that decides whether nocx-x8s2.2 is done, written
 * from the acceptance criteria in the bead — not from the implementation
 * (AGENTS.md testing rule 4). The feature and the surface are MERGED (this
 * tree is 250e464f), so every assertion here is meant to run green; a red
 * assertion is a defect report, never a weakened test.
 *
 * The seam under test, as the binding documents AND the shipped surface
 * decided it:
 *
 * - The gesture on a frozen command block is its ASK CONTROL — the
 *   `Ask about this block` button (`.cmd-ask-btn`) every finished command
 *   block carries (scrollback/blocks.ts createCommandBlock; answer blocks
 *   carry none). It raises the ask chip, anchors the block visually, and
 *   activates the agent input target (terminal-content.ts activateAsk).
 * - The chip is a BlockReceipt ask variant:
 *   `.ui-block-receipt[data-variant="ask"]` mounted INSIDE the block, whose
 *   `.ui-block-receipt__value` names the block by its command text
 *   (blockCommandText). One chip, one mode; activating a second block moves
 *   it. Its primary `Ask` focuses the editor; `Done` returns to shell.
 * - The question is typed in the ORDINARY editor (design §3.1: no second
 *   input surface) and routed by InputTargetRegistry.active()
 *   (terminal-content.ts submit: `const active = inputTargets.active()`;
 *   the agent target declares routesToShell=false, so no shell
 *   orchestration runs for a question).
 * - The answer renders as an ANSWER BLOCK in the flow: a `.cmd-block` whose
 *   header is the QUESTION, whose `.cmd-output[data-answer-body]` streams
 *   the deltas, and whose header gains a `completed` chip
 *   (`.nocx-chip.cmd-header-exit`) when the run terminalizes.
 * - The payload to the model contains the referenced block's output and no
 *   other block's (bead acceptance 2).
 * - agent.status drives the no-endpoint sentence on BOTH surfaces: the
 *   AI Endpoints readiness line and the ask chip's
 *   `.ui-block-receipt__status` (agent-status-line.ts, one derivation).
 *
 * FRESH-STATE FINDING (reported): a fresh dev home has NO vault, and
 * creating an endpoint WITH a key mints the key into the vault (design
 * §4.5.3) — so a first-run user who configures an AI endpoint on a fresh
 * install gets the toast "Could not save the endpoint: store endpoint key:
 * vault is not initialized" and NO setup prompt. The connections path asks
 * at the moment a secret is created (nocx-v64o); the endpoints path does
 * not. This spec therefore drives the documented vault journey first
 * (Vault settings → "Set up protection") — the state a real user must
 * reach before the key can exist — and the finding stands separately.
 * The fake model endpoint (e2e/fake-openai.ts) is scripted and held open by
 * explicit release — every "wait" here is a poll on a state change, never a
 * sleep (AGENTS.md: "a test may not depend on timing").
 *
 * The backend is THIS FILE'S OWN devharness on a disposable home
 * (VaultBackend), so the endpoint it configures never leaks into the shard's
 * shared stand, and the "no endpoint configured" state is real for this
 * file's first test (AGENTS.md: "Your dev profile is not the installed
 * app's" — a dev stand starts with no endpoint and the check must create
 * what it needs through the surface a user uses).
 */
import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VaultBackend, bindEndpoint } from './harness'
import { readStand } from './stand'
import { FakeOpenAI } from './fake-openai'

/** Lazily, not at module scope: the stand is started by globalSetup, which
 *  runs after Playwright has collected this file. */
const devharnessBin = () => readStand().devharness

const TITLE = '.nocx-tab-title'
const INPUT = '.pane.active .nocx-editor-input'
const SETTINGS_AI_NAV = '.ui-settings-section-nav-item[data-section="AI Endpoints"]'
const STATUS_ROW = '.ep-status-row'
/** The ask chip (BlockReceipt ask variant), mounted inside its block. */
const ASK_CHIP = '.ui-block-receipt[data-variant="ask"]'

const test = base

/** One nonce per file: every marker below is unique to its test by prefix,
 *  and unique in the whole run by this suffix. */
const nonce = Date.now().toString(36)

let backend: VaultBackend
let fake: FakeOpenAI
let endpoint: { port: number; token: string }

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fake = new FakeOpenAI()
  await fake.start()
  const root = mkdtempSync(join(tmpdir(), 'nocx-x8s2-e2e-'))
  // `true` = no Secret Service for this backend, regardless of the session
  // the suite runs in: the container has no keychain to ask, and the derived
  // content key makes the vault available without user setup — the same
  // arrangement history-persistence.spec.ts relies on.
  backend = new VaultBackend(devharnessBin(), { root }, true)
  endpoint = await backend.start()
})

test.afterAll(async () => {
  backend?.stop()
  await fake?.stop()
})

/** Point the page at this file's backend, open the app, wait for the first
 *  tab. */
async function openApp(page: Page): Promise<void> {
  await bindEndpoint(page, endpoint)
  await page.goto('/')
  await expect(page.locator(TITLE).first()).not.toHaveText('', { timeout: 15_000 })
}

/** Open Settings via the keyboard shortcut and select the AI Endpoints
 *  section in the rail — the surface a user configures the assistant with
 *  (the connections-settings.spec.ts walk). */
async function openAIEndpoints(page: Page): Promise<void> {
  await page.keyboard.press('Meta+,')
  await expect(page.locator('.ui-page__scroll')).toBeVisible({ timeout: 10_000 })
  await page.locator(SETTINGS_AI_NAV).click()
  // Wait on the page root, not on the readiness badge: the badge appears
  // only once an endpoint is configured, so waiting on it would make this
  // helper unusable in the first state a user is ever in.
  await expect(page.locator('.ep-root')).toBeVisible({ timeout: 10_000 })
}

/** Set up the vault through the Vault settings page — the documented
 *  first-run journey ("Set up protection"). A fresh dev home has NO vault,
 *  and creating an endpoint with a key mints the key INTO the vault
 *  (design §4.5.3), so the vault must exist first. The endpoints surface
 *  itself does not raise the setup sheet from a fresh state — it fails
 *  with a toast instead (reported finding; see the spec header) — so this
 *  spec drives the surface that does, exactly as a first-run user must.
 *  Requires Settings to be open; leaves it open on the Vault page. */
async function setupVault(page: Page, passphrase: string): Promise<void> {
  await page.locator('.ui-settings-section-nav-item[data-section="Vault"]').click()
  await expect(page.getByText('Where it is stored')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Set up protection', exact: true }).click()

  // The setup sheet (the vault.spec selectors, proven in the container):
  // passphrase twice, Set Up, then the recovery code, then Done.
  const setupDialog = page
    .locator('.ui-prompt-overlay')
    .filter({ has: page.locator('#vault-setup-passphrase') })
  await expect(setupDialog).toBeVisible({ timeout: 10_000 })
  await page.locator('#vault-setup-passphrase').fill(passphrase)
  await page.locator('#vault-setup-confirm').fill(passphrase)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Set Up/i })
    .click()
  const codeBlock = page.locator('.ui-vault-code-block-wrap .ui-code-block')
  await expect(codeBlock).toBeVisible({ timeout: 10_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click()
  await expect(setupDialog).not.toBeVisible({ timeout: 10_000 })
}

/** Back to the terminal tab: Settings is a tab like any other, and the first
 *  tab is the terminal. */
async function backToTerminal(page: Page): Promise<void> {
  await page.locator(TITLE).first().click()
  const input = page.locator(INPUT)
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.click()
  await expect(input).toBeFocused({ timeout: 10_000 })
}

/** Run one command and wait for its finished (frozen) block. */
async function runCommand(
  page: Page,
  command: string,
  marker: string,
): Promise<{ block: Locator }> {
  const input = page.locator(INPUT)
  await input.fill(command)
  await page.keyboard.press('Enter')
  const block = page.locator('.cmd-block', { hasText: marker }).first()
  await expect(block).toBeVisible({ timeout: 15_000 })
  return { block }
}

/** The gesture (the shipped surface): the Ask control every finished
 *  command block carries — it raises the chip and activates the agent
 *  target. */
async function clickAsk(block: Locator): Promise<void> {
  await block.getByRole('button', { name: 'Ask about this block' }).click()
}

/** The answer block for one question: the .cmd-block whose header IS the
 *  question and whose output is the agent's answer body. */
function answerBlockOf(page: Page, question: string): Locator {
  return page.locator('.cmd-block').filter({ hasText: question })
}

test.describe('agent ask about a frozen block (nocx-x8s2.2)', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  test('with no endpoint configured, the surfaces say so (agent.status)', async ({ page }) => {
    // The first state a dev stand is in — no endpoint — and it needs no fake
    // server at all. agent.status is rendered on BOTH product surfaces, and
    // each is asserted on the surface, never on a log line.
    //
    // The ASK surface: raise the chip on a finished block; the chip carries
    // the readiness sentence in its status line (refreshAskStatus →
    // agentStatusLine, the one derivation shared with Settings).
    await openApp(page)
    const marker = `ask-status-${nonce}`
    const { block } = await runCommand(page, `echo ${marker}`, marker)
    await clickAsk(block)
    const chip = block.locator(ASK_CHIP)
    await expect(chip).toBeVisible({ timeout: 10_000 })
    // The chip names the block by its command, before any question is sent.
    await expect(chip.locator('.ui-block-receipt__value')).toHaveText(`echo ${marker}`)
    await expect(chip.locator('.ui-block-receipt__status')).toContainText(
      'No endpoint configured yet',
      { timeout: 10_000 },
    )

    // The Settings surface says it too, through its empty state — which owns
    // this fact because it also carries the button that fixes it. The
    // readiness badge deliberately does NOT repeat it here; it appears only
    // for what the list cannot say (an unresolvable credential, a failed
    // probe, a ready endpoint), and test 2 asserts it there.
    await openAIEndpoints(page)
    await expect(page.locator('.ep-root')).toContainText('No endpoints yet')
    await expect(page.locator(STATUS_ROW)).toHaveCount(0)
  })

  test("point at a finished block, ask, and the answer streams in naming the block's output", async ({
    page,
  }) => {
    // ── The endpoint, configured through the surface a user uses ────────
    await openApp(page)
    await openAIEndpoints(page)
    // The starting state, asserted so the "Ready" below means something: the
    // empty state owns the no-endpoint sentence here, and the readiness badge
    // is deliberately absent until there is something to be ready about.
    await expect(page.locator('.ep-root')).toContainText('No endpoints yet')

    // A fresh home has NO vault, and the endpoint's key is minted INTO the
    // vault (design §4.5.3), so the first-run vault setup must happen first.
    // (The endpoints surface does not raise the setup sheet from this state
    // — it fails with a toast; that finding is in the spec header. The
    // documented journey is the Vault page's "Set up protection".)
    await setupVault(page, `vault-pass-${nonce}`)
    // Back to the AI Endpoints section; still no endpoint configured, so the
    // empty state still owns the sentence and the readiness badge is absent.
    await page.locator(SETTINGS_AI_NAV).click()
    await expect(page.locator('.ep-root')).toContainText('No endpoints yet')

    await page.getByRole('button', { name: '+ New endpoint' }).first().click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'New Endpoint' })
    await expect(dialog).toBeVisible()
    await dialog.locator('#endpoint-name').fill(`E2E Fake ${nonce}`)
    // The fake's base URL: http://127.0.0.1:<port>/v1 — loopback, which is
    // exactly the address rule internal/assistant/httpguard.go permits.
    await dialog.locator('#endpoint-base-url').fill(fake.baseUrl())
    await dialog.locator('#endpoint-key').fill(`e2e-key-${nonce}`)
    await dialog.getByRole('button', { name: 'Add model' }).click()
    await dialog.locator('#endpoint-model-0-name').fill('e2e-model')
    await dialog.getByRole('button', { name: 'Create Endpoint', exact: true }).click()
    await expect(dialog).not.toBeVisible({ timeout: 10_000 })
    // The record landed; agent.status now reads endpoint configured +
    // credential resolvable, no probe run yet → "Ready".
    await expect(page.locator(STATUS_ROW)).toContainText('Ready', { timeout: 10_000 })

    // ── Two finished blocks with output that cannot be confused ──────────
    await backToTerminal(page)
    const markerA = `ask-alpha-${nonce}`
    const markerB = `ask-beta-${nonce}`
    const cmdA = `echo ${markerA}`
    const cmdB = `echo ${markerB}`
    const { block: blockA } = await runCommand(page, cmdA, markerA)
    // Block B is run for its OUTPUT, not for a handle: the payload assertion
    // below proves markerB is absent, which needs the block to exist on
    // screen and nothing else.
    await runCommand(page, cmdB, markerB)

    // ── The gesture: the block's Ask control ─────────────────────────────
    // Script the fake FIRST: the answer the model gives is decided by the
    // test, streamed in several chunks and HELD after the first so the spec
    // can observe partial text while the stream is genuinely open. The
    // request base is captured BEFORE this ask: the fake's ids accumulate
    // across the file's tests, and every index below is relative to it.
    const base = fake.requests().length
    fake.setScript({ chunks: ['The first block printed ', markerA, '.'], holdAfter: 1 })
    await clickAsk(blockA)

    // The chip names the block BEFORE the question is sent.
    const chip = blockA.locator(ASK_CHIP)
    await expect(chip).toBeVisible({ timeout: 10_000 })
    await expect(chip.locator('.ui-block-receipt__value')).toHaveText(cmdA)

    // ── The question, in the ordinary editor ─────────────────────────────
    const question = 'What did the first block print?'
    const input = page.locator(INPUT)
    await expect(input).toBeFocused({ timeout: 10_000 })
    await input.fill(question)
    await page.keyboard.press('Enter')

    // The request reached the fake — the whole ask round trip through the
    // real backend. The payload carries the chosen block's output and no
    // other block's, and the credential arrived as the Bearer it was stored
    // as (the endpoints.probe suite's paired wire facts, same path).
    const reqs = await fake.waitForRequests(base + 1)
    const req1 = reqs[base]
    expect(req1.path.endsWith('/chat/completions')).toBe(true)
    expect(req1.authorization).toBe(`Bearer e2e-key-${nonce}`)
    expect(req1.body).toContain(markerA)
    expect(req1.body).not.toContain(markerB)

    // The answer block appears in the flow: a .cmd-block whose header is the
    // QUESTION and whose output is the agent answer body — a shell command
    // block it is not (no command-not-found, no serialized shell output;
    // the [data-answer-body] output and the completed chip are the answer
    // block's own identity).
    const answerBlock = answerBlockOf(page, question)
    await expect(answerBlock).toHaveCount(1, { timeout: 15_000 })
    const answerBody = answerBlock.locator('.cmd-output[data-answer-body]')
    await expect(answerBody).toBeVisible()

    // The answer STREAMS IN: the body already shows the first chunk while
    // the stream is still open (the fake holds after chunk 1). A product
    // that buffered the answer would never show this partial text.
    await expect(answerBody).toContainText('The first block printed ', { timeout: 15_000 })
    await expect.poll(() => fake.requests()[base]?.state).toBe('streaming')

    // Release the held stream: the rest arrives, the run terminalizes, and
    // the block's header gains the completion chip — the surface's own word
    // for "the answer finished".
    fake.release(req1.id)
    const answer = `The first block printed ${markerA}.`
    await expect(answerBody).toContainText(answer, { timeout: 15_000 })
    await expect.poll(() => fake.requests()[base]?.state).toBe('done')
    await expect(answerBlock.locator('.cmd-header-exit')).toHaveText('completed', {
      timeout: 15_000,
    })
    // Answer-block identity: the question's block is the agent's answer
    // block (header = question, [data-answer-body] output, completed chip),
    // not a shell command block — its body carries no shell error. The
    // stronger "nothing shell ran" half (zero pty bytes, no lifecycle
    // attempt, no running block) is proven by the unit suite's ask-seam
    // tests (terminal-content.test.ts), which can observe the seam this e2e
    // cannot.
    await expect(answerBody).not.toContainText('command not found')
  })

  test('a second ask while the first streams lands its deltas on the right entry', async ({
    page,
  }) => {
    await openApp(page)
    await backToTerminal(page)

    // Fresh blocks for this test (a fresh page has a fresh scrollback).
    const markerA = `two-alpha-${nonce}`
    const markerB = `two-beta-${nonce}`
    const cmdA = `echo ${markerA}`
    const cmdB = `echo ${markerB}`
    const { block: blockA } = await runCommand(page, cmdA, markerA)
    const { block: blockB } = await runCommand(page, cmdB, markerB)

    // Request 1 is held after its first chunk; request 2 answers at once.
    const answerA = `Answer one: ${markerA}`
    const answerB = `Answer two: ${markerB}`
    // The fake's request ids accumulate across the file's tests; every index
    // and release below is relative to this test's first request.
    const base = fake.requests().length
    fake.setScript({ chunks: ['Answer one: ', markerA], holdAfter: 1 })
    fake.setScript({ chunks: ['Answer two: ', markerB] })

    // Ask about A; the stream opens and is held.
    await clickAsk(blockA)
    await expect(blockA.locator(ASK_CHIP).locator('.ui-block-receipt__value')).toHaveText(cmdA)
    const q1 = 'Question one about the first block?'
    const input = page.locator(INPUT)
    await expect(input).toBeFocused({ timeout: 10_000 })
    await input.fill(q1)
    await page.keyboard.press('Enter')
    const reqs1 = await fake.waitForRequests(base + 1)
    const req1 = reqs1[base]
    await expect.poll(() => fake.requests()[base]?.state).toBe('streaming')
    const blockQ1 = answerBlockOf(page, q1)
    await expect(blockQ1.locator('.cmd-output[data-answer-body]')).toContainText('Answer one: ', {
      timeout: 15_000,
    })

    // WHILE the first answer is still streaming, ask about B: the chip
    // MOVES to B (one chip, one mode), the question targets B, and B's
    // payload carries B's output alone.
    await clickAsk(blockB)
    await expect(blockA.locator(ASK_CHIP)).toHaveCount(0, { timeout: 10_000 })
    await expect(blockB.locator(ASK_CHIP).locator('.ui-block-receipt__value')).toHaveText(cmdB)
    const q2 = 'Question two about the second block?'
    // DEFECT (reported): the first submit hid the editor (CommandEditor
    // commit() clears+hides unconditionally), and nothing on the agent
    // path ever re-shows it — activateAsk and the chip's Ask primary only
    // call editor.focus(), which is a no-op while hidden
    // (editor.ts: `if (this.isVisible) this.view.focus()`), and
    // _syncLifecycleOwnership only runs on lifecycle facts, of which the
    // agent path produces none. So the second ask — the acceptance's
    // exact scenario — is not reachable through the shipped surface. The
    // merged unit test masks this with an explicit ed.show() in its
    // submitInEditor helper. This assertion stays red until the product
    // re-shows the editor while the agent target is active.
    await expect(input).toBeFocused({ timeout: 10_000 })
    await input.fill(q2)
    await page.keyboard.press('Enter')

    const reqs2 = await fake.waitForRequests(base + 2)
    const req2 = reqs2[base + 1]
    // Each payload carries its own block's output and no other's.
    expect(req1.body).toContain(markerA)
    expect(req1.body).not.toContain(markerB)
    expect(req2.body).toContain(markerB)
    expect(req2.body).not.toContain(markerA)
    // The second ask was made while the first stream was GENUINELY open —
    // a state fact, asserted directly: nothing has released request 1.
    expect(fake.requests()[base]?.state).toBe('streaming')

    // Release the first stream; both runs terminalize.
    fake.release(req1.id)
    await expect.poll(() => fake.requests()[base]?.state).toBe('done')
    await expect.poll(() => fake.requests()[base + 1]?.state).toBe('done')

    // The deltas landed on the RIGHT entries: two distinct answer blocks,
    // each holding its own answer and not the other's.
    const blockQ2 = answerBlockOf(page, q2)
    await expect(blockQ1).toHaveCount(1)
    await expect(blockQ2).toHaveCount(1)
    const body1 = blockQ1.locator('.cmd-output[data-answer-body]')
    const body2 = blockQ2.locator('.cmd-output[data-answer-body]')
    await expect(body1).toContainText(answerA, { timeout: 15_000 })
    await expect(body2).toContainText(answerB, { timeout: 15_000 })
    await expect(body1).not.toContainText(answerB)
    await expect(body2).not.toContainText(answerA)
    await expect(blockQ1.locator('.cmd-header-exit')).toHaveText('completed')
    await expect(blockQ2.locator('.cmd-header-exit')).toHaveText('completed')
  })

  test('the Test button on a saved endpoint probes with the STORED credential, and a typed key wins (nocx-reu5)', async ({
    page,
  }) => {
    // The serial describe shares one backend; the first endpoint-creating
    // test above set up the vault and minted a key into it, so a save with
    // a key works from here without the setup sheet.
    await openApp(page)
    await openAIEndpoints(page)
    await expect(page.locator(STATUS_ROW)).toContainText('Ready', { timeout: 10_000 })

    const name = `E2E Probe ${nonce}`
    const storedKey = `stored-key-${nonce}`
    await page.getByRole('button', { name: '+ New endpoint' }).first().click()
    const newDialog = page.getByRole('dialog').filter({ hasText: 'New Endpoint' })
    await expect(newDialog).toBeVisible()
    await newDialog.locator('#endpoint-name').fill(name)
    await newDialog.locator('#endpoint-base-url').fill(fake.baseUrl())
    await newDialog.locator('#endpoint-key').fill(storedKey)
    await newDialog.getByRole('button', { name: 'Add model' }).click()
    await newDialog.locator('#endpoint-model-0-name').fill('e2e-model')
    await newDialog.getByRole('button', { name: 'Create Endpoint', exact: true }).click()
    await expect(newDialog).not.toBeVisible({ timeout: 10_000 })

    // ── Stored credential, blank key field ──────────────────────────────
    // Open the saved endpoint for editing. The key field is BLANK by
    // design (ADR-0030 §3 — the material never crosses back), and the
    // probe must still authenticate with the credential the endpoint
    // OWNS, resolved by the backend from the vault.
    await page.getByRole('button', { name: `Edit ${name}` }).click()
    const editDialog = page.getByRole('dialog').filter({ hasText: 'Edit Endpoint' })
    await expect(editDialog).toBeVisible()
    const keyInput = editDialog.locator('#endpoint-key')
    await expect(keyInput).toHaveValue('')

    let base = fake.requests().length
    await editDialog.getByRole('button', { name: 'Test endpoint' }).click()
    let reqs = await fake.waitForRequests(base + 1)
    expect(reqs[base].authorization).toBe(`Bearer ${storedKey}`)
    // The probe succeeded end to end — a streamed answer through the real
    // backend, not merely a request that arrived.
    await expect(editDialog).toContainText('Streamed an answer in', { timeout: 15_000 })
    // The key was never sent back to the renderer: the field is still
    // blank after a probe that resolved the stored material.
    await expect(keyInput).toHaveValue('')

    // ── A key typed into the form WINS over the stored one ──────────────
    const typedKey = `typed-key-${nonce}`
    await keyInput.fill(typedKey)
    base = fake.requests().length
    await editDialog.getByRole('button', { name: 'Test endpoint' }).click()
    reqs = await fake.waitForRequests(base + 1)
    expect(reqs[base].authorization).toBe(`Bearer ${typedKey}`)
    await expect(editDialog).toContainText('Streamed an answer in', { timeout: 15_000 })

    // ── No credential at all (a local model) still probes without one ───
    await editDialog.getByRole('button', { name: 'Cancel' }).click()
    const localName = `E2E Local ${nonce}`
    await page.getByRole('button', { name: '+ New endpoint' }).first().click()
    const localDialog = page.getByRole('dialog').filter({ hasText: 'New Endpoint' })
    await expect(localDialog).toBeVisible()
    await localDialog.locator('#endpoint-name').fill(localName)
    await localDialog.locator('#endpoint-base-url').fill(fake.baseUrl())
    await localDialog.getByRole('button', { name: 'Add model' }).click()
    await localDialog.locator('#endpoint-model-0-name').fill('e2e-model')
    await localDialog.getByRole('button', { name: 'Create Endpoint', exact: true }).click()
    await expect(localDialog).not.toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: `Edit ${localName}` }).click()
    const localEdit = page.getByRole('dialog').filter({ hasText: 'Edit Endpoint' })
    await expect(localEdit).toBeVisible()
    base = fake.requests().length
    await localEdit.getByRole('button', { name: 'Test endpoint' }).click()
    reqs = await fake.waitForRequests(base + 1)
    expect(reqs[base].authorization).toBe('')
    await expect(localEdit).toContainText('Streamed an answer in', { timeout: 15_000 })
  })
})

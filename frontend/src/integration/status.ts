// The session integration axis, renderer side (nocx-dvql / nocx-5uu5).
//
// The backend publishes session.integrationChanged: whether this session's
// shell integration is live, and when it is not, why. This module owns three
// things and nothing else — the subscription seam, the words the product
// says, and the memory of which card the user has already seen.
//
// It owns the WORDS deliberately. A reason is a closed server vocabulary
// (ssh.RefusalReason) and every surface that shows one — the tab's tooltip,
// the card, the details dialog — must say the same thing about it, or the
// user reads two different diagnoses of one session. One table, one owner
// (AD-8).
//
// The words never name a third-party program. nocx cannot see which one took
// the shell over — AD-6 forbids reading the byte stream and the process table
// is a race — so naming one would be a guess presented as a finding. The
// details surface carries the observation instead, labelled as a guess.

import type { Dispatcher } from '../dispatcher'
import type { SessionIntegrationChanged } from '../generated/session.integrationChanged'

export type IntegrationReason = NonNullable<SessionIntegrationChanged['reason']>

/** One integration fact, delivered with its session id intact. */
export type IntegrationFactHandler = (fact: SessionIntegrationChanged) => void

/** Subscribe to the server-initiated session.integrationChanged notification.
 *  The wire shape is guarded at the boundary like files.changed and
 *  lifecycle.changed (the same unsolicited-notification defect class): a
 *  payload without a string sessionId and a string shell is not a fact and is
 *  not delivered. */
export function subscribeIntegrationChanged(
  dispatcher: Dispatcher,
  handler: IntegrationFactHandler,
): () => void {
  return dispatcher.subscribe('session.integrationChanged', (params: unknown) => {
    const p = params as SessionIntegrationChanged
    if (p && typeof p.sessionId === 'string' && typeof p.shell === 'string') handler(p)
  })
}

/** True while this session is in a state the product should mark. `starting`
 *  is NOT degraded: the shell has not failed, it has not finished proving
 *  itself, and marking it would put a warning on every tab for its first
 *  seconds. */
export function isDegraded(fact: SessionIntegrationChanged | null): boolean {
  return fact !== null && (fact.status === 'conventional' || fact.status === 'lost')
}

// ── which shell nocx started ──────────────────────────────────────────────

/** The shells nocx installs a launcher for, plus the honest catch-all.
 *
 *  This exists because the remedy has to name the file nocx's OWN launcher
 *  sources: `internal/shellintegration/launcher_bash.go` sources
 *  `~/.bashrc`, `launcher_zsh.go` sources `~/.zshrc`. Advice about a file
 *  nocx never reads cannot work, and advice naming a shell the session is
 *  not running is how a zsh user was handed `bash -lic …` (nocx-0mqs).
 *
 *  The renderer derives this once, here, so the fix panel and anything that
 *  comes after it cannot disagree about which shell a session is (AD-8). */
export type ShellFamily = 'bash' | 'zsh' | 'other'

/** The family of the shell the backend says it started. The wire carries a
 *  path; a login shell is conventionally argv[0]-prefixed with a dash, so
 *  that is stripped before matching. The match is on the whole basename —
 *  `bashful` is not bash, and a prefix match would put `~/.bashrc` in front
 *  of somebody who has never had one. */
export function shellFamily(shellPath: string): ShellFamily {
  const base = shellPath.replace(/\/+$/, '').split('/').pop() ?? ''
  const name = base.startsWith('-') ? base.slice(1) : base
  if (name === 'bash') return 'bash'
  if (name === 'zsh') return 'zsh'
  return 'other'
}

/** The environment variable nocx exports before the user's startup file runs
 *  (`internal/shellintegration`: `ActivationEnv`, and the `export` in
 *  `launch.go`). It is the whole reason the remedy below is specific rather
 *  than a bisect: a block that takes the shell over can test for this and
 *  stand aside. */
const ACTIVATION_ENV = 'NOCX_SHELL_INTEGRATION'

/** Everything the fix text needs to know about the shell that ran. */
interface ShellFacts {
  readonly path: string
  readonly family: ShellFamily
  /** The startup file nocx's launcher sources for this shell. */
  readonly startupFile: string
}

function shellFacts(path: string): ShellFacts {
  const family = shellFamily(path)
  return {
    path,
    family,
    startupFile:
      family === 'zsh' ? '~/.zshrc' : family === 'bash' ? '~/.bashrc' : 'your shell startup file',
  }
}

/** A path is pasted into a command line, so a path with a space in it has to
 *  survive the paste. Single quotes, and only when the path needs them —
 *  quoting `/bin/zsh` would make the line look like something it is not. */
function shellQuote(path: string): string {
  if (/^[A-Za-z0-9._\-/]+$/.test(path)) return path
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/** What nocx can tell the user to do, written for the shell that actually
 *  ran. Absent for every reason where the answer is not the user's to
 *  change — an empty "How to fix" that says "try again" teaches the user
 *  that the button never helps. */
interface IntegrationFix {
  /** Why this works, in prose. Names the shell and the file, never a
   *  third-party program. */
  readonly lead: string
  /** The lines to paste. Written for this shell, and for no other. */
  readonly snippet: string
}

/** What the product says about one degraded session: a headline the user can
 *  read at a glance and one sentence that is true. */
export interface IntegrationMessage {
  /** The card's title and the tab mark's label. */
  readonly title: string
  /** One sentence. No program names, no host names, no paths, no error
   *  text — a remote publish failure is an SFTP status code and a path,
   *  meaningful in a log and meaningless in a pane (nocx-viil). */
  readonly description: string
  /** What is true right now, for the details chain. */
  readonly happening: string
  /** The last step that did work, for the details chain. */
  readonly lastGoodStep: string
  /** The remedy, when nocx has one that is honest for this reason and this
   *  shell. Absent where the answer is not the user's to change. */
  readonly fix?: IntegrationFix
}

/** The one place a reason becomes English. Every string here was agreed with
 *  the owner rather than invented in review, which is what nocx-viil
 *  requires.
 *
 *  `startup-did-not-return` and `handshake-timeout` are deliberately different
 *  sentences for two different amounts of knowledge, and the difference is the
 *  point. The first is emitted when the shell reported entering nocx's rcfile
 *  and never reported leaving the user's startup — nocx knows where it
 *  stopped. The second is emitted when nothing was reported at all: the shell
 *  did not answer, and the backend does NOT know that anything intercepted it.
 *  Giving the second the first's sentence would state a finding nocx does not
 *  have, which is how a zsh user was handed advice about bash. */
interface MessageTemplate extends Omit<IntegrationMessage, 'fix'> {
  /** Resolved against the shell that actually ran, which is the whole point:
   *  a fix written once, for a shell nobody named, is the defect. */
  readonly fix?: (shell: ShellFacts) => IntegrationFix
}

/** The remedy for a shell that never answered: guard the block that took it
 *  over on the variable nocx exports before the startup file runs.
 *
 *  This is nocx's own measurement, not a textbook. The activation variable is
 *  in the environment before `~/.bashrc` / `~/.zshrc` is sourced, so the
 *  guard is available to every affected user, and it is what people hit by
 *  the same class of failure in other terminals converge on. The advice it
 *  replaces — halve your rc file and put it back a piece at a time — is what
 *  you say when you know nothing, and here nocx knows something. */
function standAsideFix(shell: ShellFacts): IntegrationFix {
  const lines = [
    `# nocx exports ${ACTIVATION_ENV}=1 before ${shell.startupFile} runs.`,
    '# Wrap the block that hands your shell to another program, so it stands',
    '# aside for nocx and still runs in every other terminal:',
    '',
    `if [ -z "$${ACTIVATION_ENV}" ]; then`,
    '  # the lines that take the shell over go here',
    'fi',
  ]
  // A shell nocx has no launcher for still gets the variable — it is
  // exported for every session — but not a command line invented for it.
  if (shell.family !== 'other') {
    lines.push(
      '',
      '# To see whether the shell reaches a prompt at all:',
      `${shellQuote(shell.path)} -ic 'echo nocx-reached-a-prompt'`,
    )
  }
  return {
    lead:
      `nocx started ${shell.path} and exports ${ACTIVATION_ENV}=1 before ` +
      `${shell.startupFile} runs. A block there that hands the shell to another ` +
      `program can test for it and stand aside — nocx then reaches a prompt, and ` +
      `every other terminal you open is unchanged.`,
    snippet: lines.join('\n'),
  }
}

const MESSAGES: Record<IntegrationReason, MessageTemplate> = {
  'handshake-timeout': {
    title: 'Not integrated',
    description: 'Your shell did not answer nocx in time, so this tab is a plain terminal.',
    happening: 'This tab is a plain terminal: command blocks and the command editor are off.',
    lastGoodStep: 'nocx started the shell and opened its channel. The shell never answered on it.',
    fix: standAsideFix,
  },
  // The stage, not the culprit. nocx knows its rcfile started and never got
  // control back; exec, exit, a hung attach and a crashed shell all produce
  // this identically, so the sentence names what did not happen and stops
  // there. It is the reason the owner's own wording was written for, and the
  // only one that can carry it honestly (nocx-yww2).
  'startup-did-not-return': {
    title: 'Not integrated',
    description:
      'Your shell startup files did not return control to nocx, so this tab is a plain terminal.',
    happening: 'This tab is a plain terminal: command blocks and the command editor are off.',
    lastGoodStep:
      'nocx started the shell and its startup files began. They never handed control back.',
    fix: standAsideFix,
  },
  'channel-lost': {
    title: 'Integration lost',
    description: 'nocx lost its channel to this shell, so this tab is now a plain terminal.',
    happening: 'This tab is a plain terminal. Commands still run; they are no longer recorded.',
    lastGoodStep: 'The shell was integrated and answering. Its channel then ended.',
  },
  'unsupported-shell': {
    title: 'Not integrated',
    description: 'nocx has no integration for this shell, so this tab is a plain terminal.',
    happening: 'This tab is a plain terminal: command blocks and the command editor are off.',
    lastGoodStep: 'The connection opened. Integration was declined before the shell started.',
  },
  'no-secure-temp': {
    title: 'Not integrated',
    description:
      'nocx could not create a private temporary file for this session, so integration was not installed.',
    happening: 'This tab is a plain terminal: command blocks and the command editor are off.',
    lastGoodStep:
      'The connection opened. Installing the integration stopped before the shell started.',
  },
  'remote-command': {
    title: 'Not integrated',
    description:
      'This connection runs a configured command instead of a shell, so there is nothing to integrate.',
    happening: 'This tab runs the configured command. Command blocks do not apply to it.',
    lastGoodStep: 'The connection opened and ran what it was configured to run.',
  },
  unknown: {
    title: 'Not integrated',
    description: 'nocx could not set up shell integration for this session, and cannot say why.',
    happening: 'This tab is a plain terminal: command blocks and the command editor are off.',
    lastGoodStep: 'The session opened. Integration stopped somewhere nocx cannot name.',
  },
}

/** The message for a fact, or null when there is nothing to say — which is
 *  every non-degraded status. A reason the renderer does not recognise falls
 *  back to `unknown` rather than to silence: an unrenderable reason is still
 *  a degraded session, and silence is the defect. */
export function integrationMessage(
  fact: SessionIntegrationChanged | null,
): IntegrationMessage | null {
  if (!isDegraded(fact) || !fact) return null
  const { fix, ...words } = MESSAGES[fact.reason as IntegrationReason] ?? MESSAGES.unknown
  return fix ? { ...words, fix: fix(shellFacts(fact.shell)) } : words
}

/** What nocx observed running where it expected the shell, as one sentence,
 *  in one place.
 *
 *  Two surfaces show it — the Details chain and the fix panel — and they must
 *  claim it exactly as strongly as each other, so they read the same function
 *  (AD-8). It is labelled a guess IN THE SENTENCE rather than by placement:
 *  it comes from the process table, which can be raced, and never from the
 *  byte stream, which AD-6 forbids the backend to interpret, so a reader who
 *  sees only this line still knows what it is worth. Null when the backend
 *  observed nothing — an absent observation is silence, never a hedge. */
export function observationSentence(fact: SessionIntegrationChanged): string | null {
  const observed = fact.detail?.observedProcess
  if (!observed) return null
  return `Best guess, not a finding: nocx saw "${observed}" running where it expected the shell.`
}

/** What shell integration is, carried by the build rather than linked to
 *  (nocx-qs68).
 *
 *  It used to be a GitHub blob URL. That link needs three things the shipped
 *  app cannot promise — a network, a system browser (`shell.openUrl` answers
 *  -32601 where there is no native runtime) and a path that survives a
 *  rename or a default-branch change — to explain a misconfiguration on the
 *  machine the user is already sitting at. Prose in the bundle needs none of
 *  them, and it is versioned with the build that shows it.
 *
 *  It lives beside the reason table because it is the same voice answering
 *  the same question one level up, and a second copy of these words in a
 *  document nothing links to is how the first one came to say `bash -lic` to
 *  zsh users for a month. */
export const INTEGRATION_EXPLANATION: readonly string[] = [
  'An integrated tab knows where each command starts and ends, so nocx can draw command blocks, record what you ran, and offer the command editor.',
  'A plain terminal runs your shell and its own prompt. Everything still works; what is missing is the structure around it — no command blocks, no command editor, and nothing recorded.',
  'nocx says this only when it tried to integrate a session and did not manage it. A tab that was never meant to be integrated says nothing at all, so this is always about something on the machine that can be changed.',
  'The mark on the tab stays for as long as the session is degraded. "Don\'t show again for this shell" stops the card for this shell on this machine; it leaves the mark alone, because the mark is the honest state of the session.',
]

// ── which card has already been seen ──────────────────────────────────────

/** The narrow storage seam, injectable so the store is testable without a
 *  browser and so a locked-down webview cannot throw on construction. */
export interface IntegrationSeenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Versioned key. Format v1 is a JSON array of `${shell} ${reason}`
 *  entries, where a reason of `*` means every reason for that shell. */
const SEEN_KEY = 'nocx.integration.seen.v1'
const ALL_REASONS = '*'

/** Remembers which (shell, reason) cards the user has already been shown.
 *
 *  WHY localStorage, and why here rather than in the backend: this is
 *  renderer presentation state — "has this person read this card" — not
 *  backend authority, and putting it behind an RPC would make the card's
 *  first paint wait on a round trip. It must survive a restart, which rules
 *  out the run-scoped suppression the clipboard banner uses: the shell and
 *  the reason are properties of THIS machine and this configuration, so a
 *  card the user dismissed on Monday must not return every morning. And it
 *  must be per machine, which localStorage is and a synced setting would not
 *  be — the same profile on a second machine has a different shell and
 *  deserves the card again.
 *
 *  Keyed by (shell, reason) rather than by session, which is the owner's
 *  decision: one shell failing one way is one thing to learn, however many
 *  tabs it happens in. Keying by session turns a single misconfiguration
 *  into a card per tab, which is how people learn to dismiss cards without
 *  reading them. */
export class IntegrationSeenStore {
  constructor(private storage: IntegrationSeenStorage | null) {}

  /** Should the card be shown for this pair? */
  shouldShow(shell: string, reason: string): boolean {
    const seen = this.read()
    return !seen.has(entry(shell, ALL_REASONS)) && !seen.has(entry(shell, reason))
  }

  /** Record that the card was shown for this pair. */
  markShown(shell: string, reason: string): void {
    this.add(entry(shell, reason))
  }

  /** Suppress every card for this shell — the "Don't show again for this
   *  shell" action. Deliberately per shell rather than global: a user who
   *  has accepted that their login shell is not integrated has not said
   *  anything about the next host they connect to. */
  suppressShell(shell: string): void {
    this.add(entry(shell, ALL_REASONS))
  }

  private read(): Set<string> {
    if (!this.storage) return new Set()
    try {
      const raw = this.storage.getItem(SEEN_KEY)
      if (!raw) return new Set()
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return new Set()
      return new Set(parsed.filter((v): v is string => typeof v === 'string'))
    } catch {
      // A corrupt or unreadable record reads as "nothing seen": showing a
      // card twice is a nuisance, never showing it is the defect.
      return new Set()
    }
  }

  private add(value: string): void {
    if (!this.storage) return
    const seen = this.read()
    if (seen.has(value)) return
    seen.add(value)
    try {
      this.storage.setItem(SEEN_KEY, JSON.stringify([...seen]))
    } catch {
      // Storage full or denied. The card will be offered again, which is
      // the safe direction.
    }
  }
}

function entry(shell: string, reason: string): string {
  return `${shell} ${reason}`
}

/** localStorage when the webview allows it, null when it does not. A
 *  denied storage must not take the tab down on construction. */
export function safeSeenStorage(): IntegrationSeenStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

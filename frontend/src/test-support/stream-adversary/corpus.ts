// The stream-adversary corpus (ADR-0024 §"What an attacker gets today").
// Byte-level cases replayed against an assembled session by the harness; the
// conformance test snapshots the security-sensitive projections before and
// after each. Corpus content is infrastructure — the assertions that judge it
// live in conformance.test.ts and authority-expectations.ts, because today
// most of these cases are the live vulnerability, not a passing property.
//
// A Frame is one unit the session seam can dispatch: an OSC 133 / OSC 7
// payload (the string between the introducer and ST/BEL), a CSI sequence
// (e.g. ?1049h), a private OSC or DCS payload, or an app-side action (the
// editor submit that synchronously creates the attempt — ADR-0024 §5).

type StreamChannel = 'osc133' | 'osc7' | 'csi' | 'private-osc' | 'dcs' | 'app'

export interface CorpusFrame {
  channel: StreamChannel
  /** For OSC 133/7, private OSC and DCS: the payload between introducer and ST/BEL.
   *  For csi: the sequence body (e.g. '?1049h').
   *  For app: 'submit:<command>' creates an app-owned attempt. */
  payload: string
}

type CaseContext = 'idle' | 'mid-command' | 'suppressed-prompt' | 'native'

export interface CorpusCase {
  id: string
  name: string
  context: CaseContext
  /** Replayed before the `before` snapshot to establish the context. */
  prelude?: CorpusFrame[]
  /** The adversarial bytes under test. */
  frames: CorpusFrame[]
  /** Why this case is in the corpus — the attack class it stands for. */
  note: string
}

const OSC = {
  A: 'A',
  B: 'B',
  C: 'C',
  D0: 'D;0',
  taggedA: 'A;nocx_env=env-ab12',
  taggedB: 'B;nocx_env=env-ab12',
} as const

const PASSIVE_CORPUS: CorpusCase[] = [
  {
    id: 'bare-A',
    name: 'bare OSC 133 A at an idle prompt',
    context: 'idle',
    frames: [{ channel: 'osc133', payload: OSC.A }],
    note: 'A stream A announces a prompt start — the minimal marker. Today a clean A from RAW earns trust and moves the state machine toward the editor.',
  },
  {
    id: 'bare-B',
    name: 'bare OSC 133 B at an idle prompt (orphan)',
    context: 'idle',
    frames: [{ channel: 'osc133', payload: OSC.B }],
    note: 'An orphan B with no preceding A must not grant ownership (the B,B latch, ADR-0006 §4). Today it stays owned:false.',
  },
  {
    id: 'bare-C',
    name: 'bare OSC 133 C at an idle prompt',
    context: 'idle',
    frames: [{ channel: 'osc133', payload: OSC.C }],
    note: 'A stream C claims command output started. Today, with no pending record, it changes nothing — the ledger has nothing to transition.',
  },
  {
    id: 'bare-D',
    name: 'bare OSC 133 D;0 at an idle prompt',
    context: 'idle',
    frames: [{ channel: 'osc133', payload: OSC.D0 }],
    note: 'A stream D claims a command finished with exit 0. Today an orphan D is inert — but the same frame mid-command forges a success verdict.',
  },
  {
    id: 'tagged-A-B',
    name: 'nocx_env-tagged A,B — the tagged marker cycle',
    context: 'idle',
    frames: [
      { channel: 'osc133', payload: OSC.taggedA },
      { channel: 'osc133', payload: OSC.taggedB },
    ],
    note: 'A tag authenticates nothing — the bytes are still on the tty (ADR-0024 §2). Today the tagged cycle grants DOM ownership exactly like an untagged one: the laundered trust path.',
  },
  {
    id: 'private-osc-1337',
    name: 'private OSC 1337 in-band READY lookalike',
    context: 'idle',
    frames: [{ channel: 'private-osc', payload: '1337;NOCX_IB_READY' }],
    note: 'A private OSC must never carry lifecycle authority (ADR-0024 §1 names private OSC explicitly). The in-band READY is a wrapper confirmation, not a domain.',
  },
  {
    id: 'private-osc-other',
    name: 'unregistered private OSC',
    context: 'idle',
    frames: [{ channel: 'private-osc', payload: '1338;foo' }],
    note: 'Unregistered OSC numbers are ignored by the renderer — nothing may hang authority on an unknown sequence.',
  },
  {
    id: 'dcs-lookalike',
    name: 'DCS sequence carrying OSC 133 bytes',
    context: 'idle',
    frames: [{ channel: 'dcs', payload: '133;A' }],
    note: 'DCS is a different escape namespace: bytes inside a DCS string are not an OSC 133 sequence and must not be parsed as one.',
  },
  {
    id: 'malformed-tag',
    name: 'OSC 133 with a malformed nocx_env tag',
    context: 'idle',
    frames: [{ channel: 'osc133', payload: 'A;nocx_env=' }],
    note: 'A tag that is present but malformed invalidates the whole marker (the parser never guesses).',
  },
  {
    id: 'bad-param',
    name: 'OSC 133 with a non-key=value parameter',
    context: 'idle',
    frames: [{ channel: 'osc133', payload: 'A;foo' }],
    note: 'A parameter without = is malformed and rejects the marker.',
  },
  {
    id: 'oversized-osc133',
    name: 'oversized OSC 133 payload',
    context: 'idle',
    frames: [{ channel: 'osc133', payload: 'A;' + 'x'.repeat(4096) }],
    note: 'A 4 KiB payload whose parameter has no = is malformed and rejected by the parser.',
  },
  {
    id: 'osc7-cwd',
    name: 'OSC 7 cwd announcement',
    context: 'idle',
    frames: [{ channel: 'osc7', payload: 'file:///tmp/hostile' }],
    note: 'OSC 7 is render-only location metadata (ADR-0024 §1): it may move the cwd chip, never the keyboard route or lifecycle.',
  },
  {
    id: 'alt-buffer-enter',
    name: 'alternate buffer enter (CSI ?1049h)',
    context: 'idle',
    frames: [{ channel: 'csi', payload: '?1049h' }],
    note: 'Entering the alternate buffer routes input raw (the buffer is a separate axis, ADR-0024 §6 — it never grants ownership).',
  },
  {
    id: 'alt-buffer-exit',
    name: 'alternate buffer exit (CSI ?1049l)',
    context: 'mid-command',
    prelude: [{ channel: 'csi', payload: '?1049h' }],
    frames: [{ channel: 'csi', payload: '?1049l' }],
    note: 'Leaving the alternate buffer returns to the normal buffer with no authority restored — a dead domain must not come back with the buffer (ADR-0024 §6).',
  },
  {
    id: 'fence-no-event',
    name: 'a fence sequence with no authenticated event behind it',
    context: 'idle',
    frames: [{ channel: 'private-osc', payload: '1337;NOCX_FENCE;deadbeef' }],
    note: 'ADR-0024 §1 carve-out: a fence only LOCATES an already-authenticated lifecycle event in render order. A fence alone must do nothing at all.',
  },
]

export const HOSTILE_CORPUS: CorpusCase[] = [
  {
    id: 'hostile-C-D0-A-B-B-mid-command',
    name: 'the full hostile cycle C, D;0, A, B, B mid-command',
    context: 'mid-command',
    prelude: [
      { channel: 'app', payload: 'submit:echo hi' },
      { channel: 'osc133', payload: OSC.C },
    ],
    frames: [
      { channel: 'osc133', payload: OSC.C },
      { channel: 'osc133', payload: OSC.D0 },
      { channel: 'osc133', payload: OSC.A },
      { channel: 'osc133', payload: OSC.B },
      { channel: 'osc133', payload: OSC.B },
    ],
    note: 'The ranked attack: B, A, B reaches owned:true from RUNNING_RAW; D;0 forges a success verdict and persists it; the final B grants DOM ownership over a foreign foreground program. Today every step of this works. Post-ADR the keyboard route stays raw and the attempt stays open.',
  },
  {
    id: 'hostile-at-suppressed-prompt',
    name: 'the same hostile cycle at a suppressed prompt',
    context: 'suppressed-prompt',
    prelude: [
      { channel: 'app', payload: 'submit:echo hi' },
      { channel: 'osc133', payload: OSC.A },
      { channel: 'osc133', payload: OSC.B },
    ],
    frames: [
      { channel: 'osc133', payload: OSC.C },
      { channel: 'osc133', payload: OSC.D0 },
      { channel: 'osc133', payload: OSC.A },
      { channel: 'osc133', payload: OSC.B },
      { channel: 'osc133', payload: OSC.B },
    ],
    note: 'ADR-0024 §9: prompt suppression is only legal past ACCEPT for a live domain — a suppressed prompt with stream-derived ownership is the phishing primitive. Today the suppression state does not exist (the context is a label; the projections are identical to the unsuppressed run).',
  },
]

export const CORPUS: CorpusCase[] = [...PASSIVE_CORPUS, ...HOSTILE_CORPUS]

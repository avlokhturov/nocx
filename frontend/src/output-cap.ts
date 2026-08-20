// THE frontend half of `history.outputCapKB` (nocx-2f0f): how much of one
// command's output is kept, declared in Go and applied here.
//
// It lives in a module rather than being threaded through the pane tree for
// the reason the history outbox is module-scoped: a second copy would be a
// second answer to "how much is worth keeping", and the two would disagree
// the moment somebody changed the setting while a block was freezing.
//
// THE RENDERER IS WHERE THE CAP IS APPLIED, and that is not an accident of
// where the value ended up. Cutting a body means cutting on a character
// boundary of text the renderer holds; the backend sees bytes it must not
// re-interpret (AD-6), and its own MaxArtifactBytes is a different number
// answering a different question — what one caller may make the store hold,
// whatever any setting says.

/** The declared key. Named once, like OUTPUT_WRAP_KEY. */
export const OUTPUT_CAP_KEY = 'history.outputCapKB'

/** The declared default (internal/settings/settings.go: HistoryOutputCapKB,
 *  and content.DefaultOutputCapBytes beside it). Used before the first
 *  snapshot arrives and whenever the fetch fails. */
export const OUTPUT_CAP_DEFAULT_KB = 256

/** The declared bounds. A value outside them is not applied: the setting
 *  registry refuses one, so anything else on the wire is an older or newer
 *  backend and the safe answer is the value we already had. */
const MIN_KB = 16
const MAX_KB = 4096

let capBytes = OUTPUT_CAP_DEFAULT_KB * 1024

/** Adopt the backend's value. A snapshot that does not carry the key, or
 *  carries something that is not a number in range, leaves the current value
 *  in place rather than guessing. */
export function applyOutputCap(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  if (value < MIN_KB || value > MAX_KB) return
  capBytes = Math.floor(value) * 1024
}

/** What one command's body may be worth right now, in bytes. */
export function outputCapBytes(): number {
  return capBytes
}

// The quiet composition-time decoration for a detected credential
// (ADR-0021, the receipt round): while the user is still typing, a
// high-confidence finding renders as a subtle in-line mark over its span —
// nothing more. No panel, no field, no button, no focus change, no
// auto-selection (selection is an editing command, and the next keystroke
// would replace the selected text). ⌘S saves the candidate; the next
// detection replaces or clears it.
//
// The controller owns WHEN a candidate exists (one detection round per
// pause, revision-guarded); this module is the editor's half — a StateField
// that paints the mark and keeps it mapped through the user's edits until
// the controller replaces it. A candidate that goes stale is cleared by the
// controller on the next document change, so the mark never points at text
// that detection did not see.
import { StateField, StateEffect } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

/** One detected span the controller is offering to save. */
export interface SecretCandidateSpan {
  readonly from: number
  readonly to: number
}

/** Replace the composition-time candidate: null clears it. */
export const setSecretCandidate = StateEffect.define<SecretCandidateSpan | null>()

/** The mark class — quiet by design; the CSS lives beside the editor's
 *  other prompt styling (style.css). */
const CANDIDATE_MARK = 'cm-secret-candidate'

function decorationsFor(candidate: SecretCandidateSpan | null): DecorationSet {
  if (!candidate || candidate.to <= candidate.from) return Decoration.none
  return Decoration.set([
    Decoration.mark({ class: CANDIDATE_MARK }).range(candidate.from, candidate.to),
  ])
}

/** Install in a CommandEditor to paint the composition-time candidate
 *  mark. The controller drives it through the editor's seam; the editor
 *  stays language-agnostic (the mark is a prompt surface, not a language). */
export function secretCandidateExtension(): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create() {
      return Decoration.none
    },
    update(decos, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setSecretCandidate)) {
          return decorationsFor(effect.value)
        }
      }
      // No new verdict: keep the mark mapped through the edit. The
      // controller clears it on the next document change, so a mapped mark
      // lives only until the next typing pause's detection lands.
      return tr.docChanged ? decos.map(tr.changes) : decos
    },
    provide: (f) => EditorView.decorations.from(f),
  })
}

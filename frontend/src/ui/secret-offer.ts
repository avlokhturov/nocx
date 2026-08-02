// SecretOffer — the non-modal "store this key?" row (ui/README table).
//
// NON-MODAL is the contract (the owner's decision): the row appears while
// the line is still ours, and the user keeps typing — show() never steals
// focus, the editor's keys keep working, and the row disappears when the
// finding leaves the document or the user dismisses it. A false positive
// interrupting someone mid-flow is the failure mode the epic names; a row
// that can be ignored is the design. A dialog that must be answered is
// forbidden here.
//
// Engagement is by click: the name field (pre-filled with a suggestion the
// user can edit) and the two buttons. Once the field has focus it owns its
// keys — Enter stores, Esc dismisses — which the editor's nested-control
// guard already respects.
export interface SecretOfferCallbacks {
  /** Store the detected value under the given name. May reject — the
   *  controller reports the outcome. */
  onStore(name: string): void | Promise<void>
  /** The user declined, or the offer should leave the screen. */
  onDismiss(): void
}

export class SecretOffer {
  private readonly rootEl: HTMLElement
  private readonly nameInput: HTMLInputElement
  private readonly storeButton: HTMLButtonElement
  private readonly dismissButton: HTMLButtonElement
  private _visible = false

  constructor(private readonly callbacks: SecretOfferCallbacks) {
    this.rootEl = document.createElement('div')
    this.rootEl.className = 'ui-secret-offer'
    this.rootEl.hidden = true

    const message = document.createElement('span')
    message.className = 'ui-secret-offer__message'
    message.textContent = 'Store this key in the vault?'

    this.nameInput = document.createElement('input')
    this.nameInput.className = 'ui-secret-offer__name'
    this.nameInput.type = 'text'
    this.nameInput.placeholder = 'secret name'
    this.nameInput.setAttribute('aria-label', 'secret name')
    this.nameInput.autocomplete = 'off'
    this.nameInput.spellcheck = false

    this.storeButton = document.createElement('button')
    this.storeButton.className = 'ui-button ui-secret-offer__store'
    this.storeButton.dataset.variant = 'primary'
    this.storeButton.textContent = 'Store'

    this.dismissButton = document.createElement('button')
    this.dismissButton.className = 'ui-button ui-secret-offer__dismiss'
    // Without a variant the kit's base class carries no height and no colours
    // — they live on [data-variant] — so the button fell through to the
    // browser's own rendering and read as foreign to the app.
    this.dismissButton.dataset.variant = 'default'
    this.dismissButton.textContent = 'Not now'

    this.storeButton.addEventListener('click', () => {
      this.commit()
    })
    this.dismissButton.addEventListener('click', () => {
      this.dismiss()
    })
    // The field owns its keys once engaged: Enter is the obvious yes (the
    // same contract Dialog and Prompt give a single-line field); Escape
    // declines. stopPropagation keeps the host's document-level Escape
    // rescue from clearing the draft underneath.
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        this.commit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.dismiss()
      }
    })

    this.rootEl.append(message, this.nameInput, this.storeButton, this.dismissButton)
  }

  get root(): HTMLElement {
    return this.rootEl
  }

  get isVisible(): boolean {
    return this._visible
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.rootEl)
  }

  /** Show the offer for one finding. Does NOT focus the field — non-modal
   *  means the next keystroke stays in the prompt. */
  show(opts: { kindLabel: string; suggestedName: string; maskedValue: string }): void {
    const badge = document.createElement('span')
    badge.className = 'ui-badge ui-secret-offer__kind'
    badge.dataset.tone = 'info'
    badge.textContent = opts.kindLabel
    // Replace any previous kind badge (one offer at a time).
    this.rootEl.querySelector('.ui-secret-offer__kind')?.remove()
    this.rootEl.insertBefore(badge, this.nameInput)
    // What will be stored, masked — the ends are where a boundary error in
    // the detector shows, and a value taken one character wrong is a secret
    // that fails days later with nothing on screen to explain it.
    this.rootEl.querySelector('.ui-secret-offer__value')?.remove()
    const value = document.createElement('code')
    value.className = 'ui-secret-offer__value'
    value.textContent = opts.maskedValue
    this.rootEl.insertBefore(value, this.nameInput)
    this.nameInput.value = opts.suggestedName
    this._visible = true
    this.rootEl.hidden = false
  }

  /** Hide the offer. The draft is untouched either way. */
  hide(): void {
    if (!this._visible) return
    this._visible = false
    this.rootEl.hidden = true
  }

  destroy(): void {
    this.hide()
    this.rootEl.remove()
  }

  private commit(): void {
    const name = this.nameInput.value.trim()
    if (name === '') return
    this.hide()
    void Promise.resolve(this.callbacks.onStore(name)).catch(() => {
      // The controller reported the failure; the literal stays in the line.
    })
  }

  private dismiss(): void {
    this.hide()
    this.callbacks.onDismiss()
  }
}

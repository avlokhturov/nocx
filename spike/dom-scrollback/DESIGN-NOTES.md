# DOM Scrollback — Design Notes

**Implemented:** nocx-4ff.18  
**Date:** 2026-07-24  
**Iteration 3:** 2026-07-25 (flat pivot, selection model, fonts, alt-screen color, bug fixes)  

## What was built

DOM scrollback rendering replaces the continuous xterm scrollback with DOM
command blocks. xterm.js remains the VT engine for the live region (while a
command runs) and for alt-screen full-viewport TUIs.

### Visual model

```
┌─ scrollback area (scrolling, fills remaining space) ──┐
│ ┌─ [cmd block] ls -la              📁 ~  ok  0.32s ─┐ │
│ │ <colored output in term-line spans>                │ │
│ └────────────────────────────────────────────────────┘ │
│ ┌─ [cmd block] npm test            📁 ~  fail  1.4s ┐ │
│ │ <error output>                                     │ │
│ └────────────────────────────────────────────────────┘ │
│ ─── separator ──────────────────────────────────────── │
│ ┌─ xterm live region (collapsible) ──────────────────┐ │
│ │ $ _                                                │ │  ← idle: 36px
│ └────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
  ┌─ DOM editor (absolute, bottom) ────────────────────┐
  │ 📁 ~                                     [submit →] │
  │ |_                                                | │
  └────────────────────────────────────────────────────┘
```

### Block family (matches the DOM command editor)

**Iteration 3 — FLAT WARP-STYLE PIVOT (P0-1).** The owner rejected the card
look. New design:

- **No card background, no border, no border-radius, no shadow.** Blocks are
  flat, separated by a subtle ~1px gray divider line (top border, `#242538`).
- **Hover and selected states:** subtle background tint spanning the full
  block width (`rgba(192, 202, 245, 0.03)` hover, `rgba(122, 162, 247, 0.06)`
  selected). Warp-like restraint (ADR-0008).
- **Header metadata:** plain muted small text — no pill/chip styling.
  CWD label is plain `color: #565f89`, no folder emoji, no background chip.
  Exit status is plain colored text (green `#9ece6a` / red `#f7768e`),
  no badge backgrounds.
- **Command text:** stays prominent `var(--nocx-mono)` at 13px.
- **Bottom editor:** KEEPS its existing approved card design. Only scrollback
  blocks went flat.

**Original (iteration 2) block styling (now removed):**

- **Rounded card:** `border-radius: 8px`, `border: 1px solid #292e42`,  
  left accent `border-left: 3px solid #565f89`
- **Surface:** `background: #16161e` (same as editor)
- **Header:** `background: #1a1b26`, split left (command text + cwd chip) /  
  right (duration + exit status)
- **CWD chip:** same idiom as `.nocx-editor-cwd` — blue `#7aa2f7` text,  
  `background: #292e42`, `border-radius: 5px`, folder icon `📁`
- **Command text:** monospace `var(--nocx-mono)`, `color: #c0caf5`,  
  text-overflow ellipsis
- **Duration:** muted `color: #565f89`, monospace
- **Exit status:** subtle green (`#9ece6a` at 8% opacity) for ok;  
  red (`#f7768e` at 10% opacity) for failure
- **Running indicator:** pulsing blue dot
- **content-visibility:** `auto` on every block for scroll perf
- **Pointer-events:** header only (terminal text selection passes through output)

### Modules

| File | Purpose |
|---|---|
| `frontend/src/scrollback/serializer.ts` | xterm buffer → HTML (256-color palette, RGB, run-merged spans) |
| `frontend/src/scrollback/serializer.test.ts` | 31 tests: palette, colorToCSS, attrsToStyle, serializeLine |
| `frontend/src/scrollback/blocks.ts` | Block model, DOM factory, BlockManager (lifecycle) |
| `frontend/src/scrollback/blocks.test.ts` | 37 tests: createRunningBlock, createCommandBlock, BlockManager, selection, overflow menu |
| `frontend/src/scrollback/controller.ts` | ScrollbackController: DOM structure, live region, clear detection |
| `frontend/src/scrollback/test-helpers.ts` | Minimal IBufferLine/IBufferCell mock for tests |
| `frontend/src/style.css` | CSS for scrollback layout, blocks, live region |

### Integration points changed

| File | Changes |
|---|---|
| `frontend/src/renderers/types.ts` | Added `getBufferLine()` and `clearViewport()` to TerminalRenderer |
| `frontend/src/renderers/xterm.ts` | Implemented `getBufferLine()` and `clearViewport()` |
| `frontend/src/tabs.ts` | ScrollbackController creation, mount target redirect, C/D marker wiring, alt-screen, clear detection |

### Key design decisions

1. **xterm.js stays the VT engine.** No second render model — AD-6 holds.
   The DOM scrollback is a presentation layer over OSC 133 boundaries.
   `@xterm/addon-serialize` is NOT used (manual ~120-line serializer,
   self-contained, zero extra dependencies).

2. **Block boundaries via OSC 133 C/D markers.** The line indices come from the
   marker event (xterm's `buffer.baseY + cursorY`). No absolute line bookkeeping.

3. **Serialize before trim.** On OSC 133 D, the serialization reads the xterm
   buffer lines between C and D markers, then `clearViewport()` trims the
   xterm grid so output is never duplicated between DOM blocks and the xterm
   canvas.

4. **IMarker API where available.** The renderer's `registerMarker()` is used
   for the command ledger's gutter landmarks (ADR-0008). For the scrollback
   serialization, we use the absolute line indices from the marker event,
   which are valid at the time of the D marker (since we serialize immediately).

5. **No feature flags.** The DOM scrollback replaces the continuous xterm
   scrollback outright. No `?scroll=` parameter.

6. **Live region sizing.** The xterm container resizes between idle (36px,
   marker-only prompt) and running (140px, command output). The ResizeObserver
   on the container triggers `fit()` and forwards SIGWINCH to the PTY. This is
   a known trade-off — see open questions below.

7. **clear detection.** When the submitted command matches `clear` or
   `*/clear`, all DOM blocks are removed. The xterm viewport is already
   cleared by the escape sequence `clear` emits — we only clean up the
   DOM side. No undo toast (owner choice).

8. **wterm / `?r=` switch.** The `getBufferLine()` and `clearViewport()` methods
   are optional on the TerminalRenderer interface. wterm does not implement
   them — DOM scrollback is xterm-only. The `?r=wterm` escape hatch still
   works but produces a conventional continuous-scrollback terminal.

9. **Exit status tinting.** Non-zero → red `cmd-header-exit-fail` badge.
   Zero → subtle green `cmd-header-exit-ok` badge. No "success confetti"
   (ADR-0008: restraint is the rule).

## Open design questions for the owner

### Q1: Live region resize → SIGWINCH

When the live region expands (36px → 140px) or collapses, the xterm
ResizeObserver fires `safeFit()`, the grid re-sizes, and `onResize` forwards
SIGWINCH to the PTY. This means the shell sees a resize on every command
start and end. For most commands this is harmless (the shell adjusts), but:
- Long-running programs may react to the resize
- The collapse resize (140px → 36px) races the D marker — the shell might
  render the next prompt at the tiny grid before receiving D

**Options:**
1. Keep as-is — the shell tolerates resize events
2. Decouple the live container's CSS height from the xterm grid: mount xterm
   in a full-height container and use `clip-path` or `overflow: hidden` on
   a wrapper to show only the live portion
3. Suppress SIGWINCH forwarding when the resize is from a live-region mode
   change (not a real viewport change)

**Resolved (2026-07-24, nocx-4ff.18 follow-up):** Option 2/3 combined.
A two-layer structure (`xterm-live-container` clipping outer + `xterm-inner`
stable inner) decouples the visual height from the xterm grid. The inner
wrapper always has `min-height: 140px` (~6-7 rows), so the xterm grid never
collapses to 1 row. The outer container clips with `overflow: hidden`:
36px idle, 140px running. Mode-change resizes do NOT forward SIGWINCH
because the inner wrapper's size stays constant. Real viewport resizes
still propagate normally. `stty size` reports a sane row count.

### Q2: xterm scrollback after freeze

After freeze + clearViewport, xterm's scrollback is empty. If the user runs
a command with very long output (>10k lines), the 10k default scrollback
may not be enough. The spike report recommends temporarily enlarging
scrollback during long output. Not implemented yet.

### Q3: Resize during alt-screen

During alt-screen, the xterm is `position: fixed; 100vw×100vh` and the
ResizeObserver forwards SIGWINCH. This is correct for TUI programs. But
the `?r=wterm` path doesn't support alt-screen at all — wterm stays in
continuous mode.

### Q4: Separator visibility

The separator between DOM blocks and the live region appears only when
there are frozen blocks. It hides during alt-screen. When there are no
blocks (fresh session, or after `clear`), the live region touches the
top of the scrollback area. A visual boundary between the empty scrollback
and the live region might be disorienting — consider always showing the
separator (more solid) or always hiding it when empty (current behavior).

### Q5: Block count performance

`content-visibility: auto` on blocks ensures smooth scrolling with
thousands of blocks. The spike measured <100ms serialization for 5k lines.
No windowing/virtualization needed for the MVP. If per-block output
routinely exceeds 100k lines, consider truncation with a "show all" toggle.

### Q6: Selection across blocks + live region

~~Terminal text selection (`pointer-events: none` on `.cmd-output`) means
the user can't select text from DOM blocks by dragging. The current
behavior matches Warp: block headers capture clicks for inspect/rerun,
output text is read-only decoration. Native terminal selection still
works in the live region (xterm canvas).~~

**Resolved (2026-07-24, nocx-4ff.18 follow-up):** Owner override.
`pointer-events: none` removed from `.cmd-output`. DOM block output is
now selectable (`user-select: text`), with copy-on-select wired via a
`mouseup` listener on the scrollback area. Header clicks do not start
selection (`user-select: none` on `.cmd-header`). Click-to-select-block
(P2-10) uses header click handler; drag-to-select-text inside `.cmd-output`
still works because text selection starts on mousedown+move, while the
block-selection toggle fires on click (mousedown+up without movement).

## Iteration 3 changes (2026-07-25)

### Flat design pivot (P0-1)

Owner live design review rejected the card/panel look. All scrollback blocks
are now flat:
- `.cmd-block`: no background, no border, no border-radius, no box-shadow.
- Blocks separated by `border-top: 1px solid #242538` (subtle low-contrast
  gray from the theme tokens). First block has no top border.
- Hover: `rgba(192, 202, 245, 0.03)` background tint, full width.
- Selected: `rgba(122, 162, 247, 0.06)` background tint.
- Header metadata (cwd, duration, exit status, ⋮ menu) lost pill/chip
  styling — plain muted small text now.
- CWD label: no folder emoji, no background, no border-radius. Just
  `color: #565f89` at 10px.
- Exit status badges: plain colored text, no `background`/`border-radius`.
- Running indicator: kept the pulse dot (unchanged).
- The bottom command editor KEPT its existing card design. Only scrollback
  blocks went flat.

### Font unification (P0-2)

Single monospace font everywhere in the app UI. `var(--nocx-mono)` applied
across ALL components:
- `#app` (global default)
- `.tabbar` (was system-ui stack)
- `.clipboard-banner` and `.clipboard-banner-btn` (were system-ui)
- `.update-notice` (was system-ui)
- `.nocx-editor-chrome` (added explicit `font-family`)
- `.cmd-overflow-menu-item` (was `var(--nocx-ui)`)
- `.pane-error` (already mono, kept)
- All scrollback block elements already used `var(--nocx-mono)`

No system-ui/sans-serif fallback stacks remain on terminal-facing surfaces.

### Alt-screen color fix (P0-3)

**Root cause:** xterm.js theme only set `background` and `foreground`.
The 16-color ANSI palette defaulted to xterm.js built-ins, which are
adequate but some apps (claude) apparently detect the palette is not
explicitly set and fall back to black-and-white.

**Fix:** Explicit 16-color ANSI palette added to the xterm Terminal theme
options (black, red, green, yellow, blue, magenta, cyan, white, plus
bright variants), matching the Tokyo Night color scheme used throughout.
Also added `cursor`, `cursorAccent`, and `selectionBackground`.

Additionally, the Go backend sets `TERM=xterm-256color` but does NOT set
`COLORTERM=truecolor`. Some modern TUI apps (including claude) use
`COLORTERM` for truecolor capability detection. **Recommendation for the
coordinator:** add `COLORTERM=truecolor` to the PTY environment in
`internal/pty/pty_local.go` and `internal/ssh/ssh_real.go`.

### Typing redirect after block selection (P0-4)

- Clicking a block selects it → typing a printable character redirects to
  the editor and deselects all blocks (warp behavior).
- Escape key deselects all blocks without typing.
- Both behaviors implemented in `tabs.ts` keydown handler, gated on
  `scrollback.selectedBlockId !== null`.

### Stray horizontal bar fix (P1-5)

Added `overflow: hidden` to `.xterm-inner` as defence-in-depth against xterm
artifacts leaking below the clip container. The two-layer structure already
had `overflow: hidden` on the outer `.xterm-live-container`, but xterm.js
internal elements could potentially render outside the inner wrapper.

### Overflow menu clip fix (P1-6)

**Root cause:** The menu was parented inside `.cmd-block` (appended to the
⋮ button), and positioned with `position: absolute; right: 0; top: 100%`
relative to `.cmd-block` (which has `position: relative`). This placed the
menu at the bottom-right of the ENTIRE block, not near the button. It was
also clipped by `.scrollback-area { overflow-y: auto }`.

**Fix:** Menu now renders at `document.body` level with `position: fixed`,
coordinates calculated from the button's `getBoundingClientRect()`. This
ensures the menu floats above all blocks, is never clipped by scroll
containers, and appears at the correct position near the ⋮ button. Also
added Escape key close handler.

### Full-block click target (P1-7)

Selection now triggered by clicking ANYWHERE on the block (mousedown+up
without significant movement). Drag (mousedown+move+up) starts text
selection and does NOT select the block. Implemented via mousedown/mousemove/
mouseup listeners on the `.cmd-block` element, with a `mouseMoved` flag to
distinguish click from drag.

### Single-select model (P1-8)

- Selecting block B deselects block A.
- Clicking an already-selected block deselects it.
- Clicking empty space in the scrollback area (any target not inside
  `.cmd-block`) deselects all blocks.
- Clicking the editor deselects all blocks.
- Selection state tracked in `BlockManager._selectedBlockId`, synced via
  `_onBlockSelected`/`_onBlockDeselected` callbacks from the DOM event
  handlers.

### Dynamic editor padding (2026-07-25, nocx-4ff.18 follow-up)

The fixed 84px `padding-bottom` on `.scrollback-inner` has been replaced with
a dynamic value that tracks the live height of the `.nocx-editor` element. A
`ResizeObserver` on the editor root (wired in `tabs.ts` after both the
scrollback controller and editor are mounted) calls `editorEl.offsetHeight +
8px` gap whenever the editor resizes — whether from multi-line textarea
growth or from show/hide transitions. When the editor is hidden
(`display: none`), the padding is set to `0px` to avoid a dead gap at the
bottom of the scrollback area during raw mode / alt-screen fullscreen.
Screenshots: `dynpad-1-single-line-editor.png` (86px padding),
`dynpad-2-five-line-editor.png` (163px padding),
`dynpad-3-collapsed-single-line.png` (86px padding).

### Test changes (37 tests, up from 18)

- Added 12 tests for select-on-click, single-select, drag-does-not-select,
  deselectAllBlocks, getSelectedBlock.
- Added 4 tests for overflow menu: open on click, close on outside click,
  close on Escape, toggle on second click.
- Block builder functions (`createCommandBlock`, `createRunningBlock`,
  `freezeBlock`) now accept an `onSelect` callback parameter for the
  selection model.
- Full suite: 346 tests across 17 files, all green.

### Output reflow via isWrapped (owner directive, 2026-07-25)

Physical buffer lines that xterm soft-wrapped at the PTY grid width are
joined back into one logical line by `serializeRange` (the `isWrapped`
flag marks continuation lines). The print-time wrap is no longer baked
into frozen blocks; CSS (`pre-wrap` + `overflow-wrap: break-word`)
re-wraps at the block's actual width, so blocks reflow cleanly on window
resize. Hard newlines (table rows) are untouched. Trailing empty logical
lines are trimmed; interior blank lines are preserved.

### Editor is in-flow, not an overlay (owner directive, 2026-07-25)

The pane is a flex column: `.scrollback-layout` (flex:1) + `.nocx-editor`
(flex:none, in flow). This replaced both the absolute overlay and the
ResizeObserver padding hack: the scrollbar ends at the editor's top edge,
blocks can never slide under the editor, and multi-line editor growth
pushes the scrollback up naturally. `scrollbar-gutter: stable` on the
scroll area reserves the scrollbar lane.

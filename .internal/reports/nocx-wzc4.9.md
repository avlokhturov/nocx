# Report — nocx-wzc4.9: the ports panel is readable in a sidebar

Worker B (frontend/src only). All three owner defects fixed; the sample-cost
question answered with a measured number; A's local-target shape not needed
(panel untouched by it — see "Local target" below).

## 1. Loading state

- First open (no data yet) renders a **kit loading state**: the new `Spinner`
  kit component (`ui-spinner`, `role="status"` + `aria-label`) plus
  "Reading ports…". There was no spinner in the kit — it now lives in `ui/`
  with its CSS file (`styles/components/spinner.css`), identity test, and a
  README row, per the kit rule.
- The loading gate is **`st() === undefined`**, not a busy flag: the old
  `busy` signal is deleted. A refresh with data on screen updates **in
  place** — the populated list is never blanked to a spinner, because the
  list is what the user is watching. (Advisory-confirmed: gate on data
  presence, keep the list during refreshes.)

## 2. Rows fit the sidebar (240px)

- The address is the row's **primary key**: `flex: 1 1 0` (flex-basis 0 →
  zero shrink weight) with ellipsis as the floor, so it yields its width
  only as a last resort. The process chip and the forward destination yield
  **before** it: capped shares (45% / 40%) with `min-width: 0` + ellipsis.
- The chip ellipsis is a new **Badge variance** (`truncate` → `data-truncate`):
  never wraps, ellipsizes at its own box edge. The surface only places the
  chip (flex/max-width — placement); the ellipsis is the kit's.
- Row actions are **icon buttons** (IconButton `xs`): Forward (arrow-right),
  Copy (copy), Open (external-link), Stop (square). `Detected — host` is now
  just **Detected** — the tab already says which host.
- jsdom cannot see layout, so the fix carries a **CSS-contract regression
  test** (`ports-layout.test.tsx`, per the nocx-css-layout-contract-check
  recipe): DOM source order (address → chip → action) plus stylesheet
  mechanism assertions (address `flex: 1 1 0` + no `max-width`; dest and
  chip capped + `min-width: 0`). It fires if anyone re-introduces the old
  shape (both truncating equally, chip dominating).

## 3. Retry and Pause out of the body

- The toolbar **Retry is gone**; a failure state offers exactly one Retry
  (its own EmptyState action). Tested: `getAllByText('Retry')` is length 1.
- **Pause is a header action** via `SidebarViewDescriptor.actions`
  (zero-prop component — the sidebar shell contract is unchanged). One
  **shared `PortsPauseControl`** (`createPortsPauseControl` in `ports.tsx`)
  owns the signal: the header toggles it, the panel syncs backend truth on
  every status merge and resets on re-scope — the two can never disagree,
  and the header never carries a stale profile id. Disabled when the active
  tab has no profile.
- While paused, the **frontend poll skips refresh** too (the interval
  survives; the refresh is what skips), so pausing stops sampling end to
  end; resume reuses the same interval. Tested with fake timers.
- `last sample` is **muted micro-text** (`--font-size-2xs`,
  `--color-text-dim`) beside a `· paused` marker — never a Badge chip.

## The owner's number: one sample ≈ 12 ms

Measured against the **real localhost sshd** on this dev box (key auth,
`ss -ltnp` probe, real parser), 3 steady-state samples on one connection,
via the probe command and framing the discovery package actually ships
(`internal/discovery/probes.go` / `parse.go`). Temporary Go test, deleted
after capture; keypair removed, `~/.ssh` restored.

| Phase | Mean |
| --- | --- |
| exec channel open (Start → accepted) | **0.35 ms** |
| probe (`ss` + output transfer + exit status) | **11.5 ms** |
| parse (framing + `parseSS`) | **0.03 ms** |
| **one steady-state sample** | **≈ 11.9 ms** |
| fresh dial + handshake (cold first sample only) | 32.1 ms |

11 listeners found in the sample. **Verdict: cheap.** At the 5 s cadence one
sample is 0.24 % duty cycle; the cadence should run without asking. The
manual Pause control stays for politeness toward a production host (nobody
wants a probe every 5 s against one), not because sampling is heavy — that
is the honest answer to "is a manual control justified at all".

## Local target (worker A)

A's report was not present when B ran. The panel keeps the SSH path exactly
as it was; the pause seam (header action + shared controller) and the
`profileId === null` no-connection state are compatible with any
local-target identity A defines — no shape was invented. Forwarding a local
row's address is the copy action; exposing a local port to a remote host is
`-R` and needs a chosen connection — a later bead, deliberately not built.

## Files

- `frontend/src/ports.tsx` — loading gate, row layout, icon actions, pause
  controller, meta micro-text; `busy` signal and body Pause/Retry deleted.
- `frontend/src/styles/surfaces/ports.css` — row truncation hierarchy,
  `.ports-loading`, `.ports-meta`.
- `frontend/src/ui/spinner.tsx` + `styles/components/spinner.css` +
  `ui/spinner.test.tsx` + README row — the kit's loading indicator.
- `frontend/src/ui/badge.tsx` + `badge.css` + test — `truncate` variance.
- `frontend/src/ui/icons/` — Pause, Play, ArrowRight, ExternalLink, Square
  (Lucide, ISC, matching the existing set).
- `frontend/src/styles/base.css` — `.ui-sidebar-view__header` flex row +
  `.ui-sidebar-view__actions` (margin-left: auto, never space-between —
  nocx-a44m).
- `frontend/src/main.tsx` — pause controller + header action wiring.
- Tests: `ports.test.tsx` (+5: loading, in-place refresh, poll-stops-on-
  pause, one Retry, meta-is-micro-text), `ports-view.test.tsx` (+1:
  header-action pause placement + RPC + state), `ports-layout.test.tsx`
  (new, CSS contract), `sidebar-view` untouched.

## Gates

All from `frontend/`: `tsc --noEmit` clean, `eslint src/ --max-warnings 0`
clean, `prettier --check .` clean, `npm run contracts:check` clean,
`npm test -- --run` → **1870/1870** (108 files). `npm run lint` fails on one
**pre-existing** violation at HEAD (untouched by B): `row-list.css:17`
`var(--radius-md)` has no declaration/fallback — verified by stashing B's
work and re-running; not introduced here. Go untouched: `go build ./...` and
`go vet ./...` clean (the temporary measurement test was deleted).

## Not done / could not verify

- No real-browser pass: row geometry at the 240px sidebar is asserted by the
  CSS contract test, not a live stand (same limitation as nocx-wzc4.7).
- The backend scheduler's response to `ports.pause` (the actual sampling
  stop) is backend-tested territory (nocx-wzc4.2); B proves the frontend
  contract: the flag leaves the header action and the local poll skips.

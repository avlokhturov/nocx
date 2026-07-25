# W6 — wire the devharness listen address and prove the token path works headless

Worker in an Orca wave. The coordinator owns the branch, the commits and the issue
tracker. Work in `/home/dev/orca/workspaces/nocx/pr-11-boundary`.

## Why

The WebSocket now requires a capability token (bead `nocx-hl3`, just landed in `9f181fc`).
Two gaps remain, and they are related:

1. `transport.WithListenAddr` was implemented and **nothing calls it**. `cmd/devharness`
   therefore still binds an ephemeral port. The project's verification loop is a browser
   on a Mac reaching this VM through forwarded ports, and `frontend/src/main.ts` falls
   back to port **9876** when `GetWSPort()` throws (no Wails runtime). With a random port
   that loop cannot work.
2. **Nobody has ever run the devharness path with a token.** The previous worker said so
   plainly — credit to it for that — but the consequence stands: the token plumbing
   through `cmd/devharness` → `NOCX_WS_TOKEN` → `e2e/harness.ts` → `ipc.ts` is unverified.
   That path already had one silent defect (a two-argument `addInitScript` where Playwright
   accepts one, so the token was dropped). One bug of that shape found means the shape is
   plausible; assume nothing here is proven.

## Task

**Part 1 — wire the address.** Let `cmd/devharness` pass `transport.WithListenAddr` when
asked, so the dev loop can pin `127.0.0.1:9876`. An env var (`NOCX_WS_ADDR`) is the natural
fit for a dev-only binary; if you prefer a flag, say why. `internal/app` constructs the
transport, so the option has to reach it from there — keep the plumbing minimal and do not
change the default. `127.0.0.1:0` stays the default deliberately: loopback keeps the PTY
off the network and port 0 avoids a predictable port. Nothing about the shipped app changes.

**Part 2 — prove the path.** Run it end to end, headless. No display, no EGL, no
`wails dev` — none of that is needed here, and reaching for it is how an afternoon was lost
once already:

```bash
source /etc/set-environment                     # PLAYWRIGHT_BROWSERS_PATH
go run ./cmd/devharness                         # prints WSPORT= and WSTOKEN=
cd frontend && npx vite                         # serves the real frontend
NOCX_WS_PORT=<port> NOCX_WS_TOKEN=<token> CI= npx playwright test e2e/auth.spec.ts --project=chromium
```

Never run `npx playwright install` — browsers come from the read-only nix store.
`CI=1` is set system-wide, hence the `CI=` prefix.

What has to be shown, with output quoted, not asserted:

- `GetWSToken()` resolves a **non-empty** string inside the page. If the harness silently
  passes `undefined`, everything downstream still "works" in the sense that it fails, and a
  passing suite would prove nothing.
- A connection **with** the token opens.
- A connection **without** it is rejected before the upgrade.
- With `NOCX_WS_ADDR=127.0.0.1:9876`, the devharness actually listens on 9876.

If any of that cannot be shown, say which and why. A gap named is useful; a gap papered
over costs a review cycle.

## Ground rules

- No commits, no pushes, no branches. No `git stash`.
- Files you may change: `cmd/devharness/main.go`, `internal/app/app.go`, and
  `internal/transport/*.go` only if the option genuinely needs it. Do not touch
  `frontend/src/**`, `e2e/**` or `playwright.config.ts` — if a defect is there, report it.
- Do not weaken or bypass the auth to make something pass. There is no skip-auth flag and
  there must not be one.
- Do not touch beads / `bd`.
- Kill anything you start; leave `:9876`, `:5173` and the devharness free.
- Report numbers and quoted output, not adjectives.

## When done

Write `.internal/reports/devharness-verify.md` with the exact commands, the quoted
evidence for each of the four points, and anything unverified. Then `worker_done` from your
own terminal with the `taskId`/`dispatchId` from the dispatch preamble.

---
title: nocx — Product Vision
status: ready
created: 2026-07-20
updated: 2026-07-26
---

# nocx — Product Vision

## 0. Current state (2026-07-26) — read this first

**The core is being rewritten, and new work outside the three active tracks does not start
until they close.** If you were asked to hold off on coding, this is why: all three tracks
move seams that everything else attaches to, so anything built against today's seams would
be rewritten twice.

The active tracks are the epics in status `in_progress`:

| Epic | Track | What it moves |
| --- | --- | --- |
| `nocx-6ek` | Persistence | Storage capabilities and secrets as opaque references (ADR-0011) |
| `nocx-v1pr` | Tabs | TabContent seam with a cancellable lifecycle; tab presentation extracted |
| `nocx-k0xk` | Quality gates | The e2e suite and the per-commit gate — the thing that has to work before the rewrite can be trusted |

Settings (`nocx-8v51`) was the fourth and closed on 2026-07-26. This table is a snapshot, not
a maintained list: the live answer is `bd list --status in_progress --type epic`, and where
the two disagree the command is right.

After the foundation, the order is: editor core on CodeMirror 6 and Warp-style command blocks
→ SSH client → secrets vault → shell integration and Warpify → everything else. That order is
recorded as `blocks` edges between the epics, so `bd ready` reveals each stage on its own as
the previous one closes; `bd epic status` shows the whole board. The twelve epics behind the
current front are parked, not cancelled — nothing was deleted and no scope was dropped.

**The textarea editor is not being extended.** It is being replaced by CodeMirror 6 under
`nocx-2gf`. Work that polishes the textarea internals is obsolete by that decision; work that
is product behaviour has to be re-asserted against CM6 afterwards.

**Where to see the state.** `bd epic status` prints progress for all fifteen epics live from
the dependency graph, and `bd ready --exclude-type epic` is the queue. Those two commands
are the view — there is deliberately no generated status page in the repo (`nocx-lg6r`,
closed won't-do). Note that sections 5 and 6 below duplicate facts beads also owns and are
not kept current (`nocx-mqav`, closed won't-do): read them as the original strategic intent,
and this section plus the two commands for what is actually true today.

**If you are an agent**, [AGENTS.md](../AGENTS.md#what-to-work-on-next) is binding on how to
pick work. Short version: `bd ready --exclude-type epic -u`, take the top, claim it. Do not
widen the query to find something more interesting — everything it hides is hidden on
purpose.

## 1. One-line positioning

Tabby's SSH ergonomics on a Ghostty-grade engine, fully local: comfortable SSH + terminal rendering that handles modern agent TUIs, no cloud, no login, no telemetry.

## 2. Problem / motivation

Developers who run AI-agent TUIs locally (Claude Code, aider) have to choose between engines that render those TUIs flawlessly and tools that are actually comfortable to live in — and no single tool gives both without a cloud dependency.

- **Warp** — great rendering and UX, but forces cloud, login, and telemetry.
- **Tabby** — local, with the ergonomics developers love (built-in secrets vault, strong SSH), but its terminal engine renders modern agent TUIs poorly.

There is no local-first terminal that pairs a Warp/Ghostty-grade engine with Tabby-style comfort.

**Competitive-honesty note.** Rendering alone is not the wedge — several tools already render well.
- **Ghostty / WezTerm / Kitty / iTerm2** render excellently, but none ships an integrated SSH manager + vault + Warpify-style UX + GUI configuration in one app; Ghostty in particular has no vault, no SSH manager, and no GUI config.
- **Tabby** has the vault + SSH manager, but a weak engine.
- **Warp** has the UX, but requires the cloud.

nocx's bet is the *combination*, delivered locally in one customizable app — not any single feature.

## 3. Target users

The author, as a daily driver, plus a few work colleagues. This is a personal / small-team tool, not a public launch.

The profile: a developer who runs AI-agent TUIs locally, wants a local-first / no-cloud tool, and values solid SSH ergonomics (and later a built-in secrets vault).

## 4. Differentiator — the combination

Flawless rendering of modern agent TUIs is **table-stakes**, not the differentiator. It is where Tabby fails and where Ghostty/WezTerm/Kitty/iTerm2 already succeed, so on its own it wins nobody over.

The differentiator is the **combination**, all local and in one customizable app:

**Ghostty-grade rendering + integrated SSH manager + (Phase 2) secrets vault + (Phase 2) Warpify-style UX + GUI configuration — no cloud.**

No competitor covers this whole set locally: Ghostty renders but lacks the vault/SSH-manager/GUI-config; Tabby has vault + SSH but a weak engine; Warp has the UX but needs the cloud.

## 5. MVP scope

### IN v1
- Terminal engine that renders modern agent TUIs flawlessly (true-color, mouse-passthrough, bracketed-paste for TUI fidelity)
- Tabs; duplicate tab; restore tabs on restart
- Copy folder path; new-tab-in-same-cwd
- SSH client (basic — *not* the vault)
- Change font + size; switch color schemes
- Copy-on-mouse-select; right-click paste
- Hotkeys / keybindings
- Clickable links/paths (OSC 8, cmd+click)

### PHASE 2 (deferred)
- Secrets vault
- Warpify-style UX (blocks / completions / input-editor extended into nested shells)
- Splits / panes
- Scrollback + find-in-output (search)

### OUT (non-goals)
- Cloud sync
- Mandatory login
- Telemetry

## 6. Strategic roadmap

Phases as one-liners. The detailed, executable backlog lives in **beads**, not in this doc.

- **Phase 1 — MVP.** Local terminal with agent-TUI-grade rendering, tabs/cwd features, basic SSH client, GUI config. macOS.
- **Phase 2 — Comfort layer.** Secrets vault + Warpify-style UX + splits/panes + scrollback search.
- **Phase 3 — Ask an agent + reach.** Natural-language query from the terminal to any AI model the user chooses — bring-your-own, including a fully local model; expand to Windows / Linux.

## 7. Tech stack

- **xterm.js** — WebGL VT engine (MIT).
- **Wails** — Go + WebView shell (MIT).
- **Custom Go backend** — PTY and SSH now; vault later.

**MIT attribution obligation.** Preserve the copyright notices for xterm.js (© The xterm.js authors, © SourceLair Private Company, © Christopher Jeffrey) and @wterm/dom (Apache 2.0).

**Architectural spine — OSC 7 / 133 shell integration.** The VT + shell-integration layer is one spine, not several features. Nailing it yields the agent-TUI rendering, the cwd-dependent features (copy-folder-path, duplicate-tab-in-cwd), and the foundation for a future local Warpify at once. Warpify's core mechanic is a shell-integration marker in the shell RC plus a bootstrap script that enables blocks/completions/input-editor inside nested shells (SSH/docker/gcloud/poetry) across bash/zsh/fish — this has no cloud dependency, so "no cloud" costs nothing to honor.

## 8. Platform & distribution

macOS first (the author's own machine). Windows and Linux later (Phase 3). Builds are produced by GitHub Actions on a version tag and published as GitHub Releases — a `.dmg` to install and a `.zip` the app updates itself from. There is no Apple Developer ID and there will not be one, so builds are unsigned: the first launch needs a one-time manual `xattr` to clear quarantine (see the README), and update integrity is ours rather than Apple's — an ed25519-signed manifest verified against a keyring compiled into the binary. No app store, and no Homebrew cask (Homebrew closed that route for unsigned casks on 2026-09-01), and no formal support. Design: `docs/superpowers/specs/2026-07-22-distribution-and-updates-design.md`; rationale: ADR-0003.

## 9. Success criteria

Personal and honest: **"I built it and it works."** Concretely — I can daily-drive nocx without falling back to Warp or Tabby, and a few colleagues can use it too. No adoption targets, no revenue, no moat to defend.

## 10. Non-goals

- Cloud sync, mandatory login, telemetry — ever, not just in MVP.
- Investor-grade positioning or a public launch.
- Being everything to everyone: nocx serves the author's own workflow first.

## 11. Open questions / assumptions to confirm

- **Vault (Phase 2):** single-machine, no sync (confirmed). Exact crypto/UX is a Phase-2 implementation decision — how secrets are stored, encrypted, and surfaced (e.g. OS keychain vs. app-managed encrypted store).
- **SSH ↔ vault integration:** how the SSH client and the vault connect once the vault lands.
- **"Ask an agent" (Phase 3):** precisely how natural-language queries reach a local / BYO AI from the terminal.
- **Licensing:** confirm any obligations beyond those documented in the README License section (xterm.js MIT, @wterm/dom Apache 2.0).
- **Agent orchestration as a plugin (undecided, not scheduled).** Coordinating several AI
  agents is, mechanically, spawning processes in panes, reading and writing their streams,
  and tracking their state — which is what a terminal already is. Existing tools bolt
  orchestration onto a terminal; nocx would come from the other side, where orchestration
  is a *view over sessions* rather than a separate thing. The substrate is largely built:
  server-authoritative session IDs (AD-7), the session registry, the split data/control
  planes (AD-1), and OSC 133 markers that already answer "did this command finish?" — which
  is the same question as "is this agent done?".

  The honest counterweight: the hard part of orchestration is not the terminal. It is
  lifecycle semantics — task provenance, who owns a completion, what a heartbeat proves,
  how a message reaches an agent that is busy rather than idle. Building on our own panes
  would remove a class of bugs (stale pane handles after a restart, an empty pane being
  indistinguishable from a dead worker, input delivered but never submitted) and would
  inherit that harder class untouched. And the timing objection stands on its own: MVP is
  not closed, so starting a second product now would repeat, at a larger scale, the mistake
  of bundling unrelated work into unfinished work.

  If this is ever pursued, the first step is smaller than a plugin and pays off either way:
  make the session model orchestration-ready without building orchestration — session IDs
  that survive a runtime restart, and a control-plane method to read a session's output and
  detect command completion from the markers we already emit. Both are useful to the
  terminal on their own merits, and they are most of what a plugin would need. Deciding to
  build the plugin itself would warrant an ADR; recording the idea does not.

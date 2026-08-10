# ADR-0025: domain_request carries the destination, not the user's options

- **Status:** accepted (2026-08-09)
- **Related:** [`ADR-0022`](0022-the-ssh-command-line-is-the-carrier.md),
  [ADR-0024](0024-authenticated-shell-integration-channel.md),
  `docs/lifecycle-protocol.md` §9, `nocx-u7uh.29`
- **Context:** the ssh child domain is composed as a rewritten command line the
  parent executes (ADR-0022). The `domain_request` the parent's hook sends
  carries exactly `host`, `user` and `port` — the destination — and the
  composer reproduces only those. A user's other typed options (`-i somekey`,
  `-J`, `-o …`) are **not** reproduced.

## Decision

**`domain_request` keeps its three-field shape (`host`/`user`/`port`) and does
not grow a pass-through for the user's typed ssh options.** The limit is
deliberate, is stated where a reader of the composer will find it
(`internal/app/childdomain.go`, `composeSSHChildLine`), and what a user loses
is: a session started with `ssh -i somekey host` — or any option the composer
does not model — runs its ssh conventionally instead of as an integrated child
domain.

## Rationale

- An unbounded pass-through of a user-typed string into a composed command
  line is an injection surface, and the protocol validates every other field
  (request id shape, env kind, host presence, port range). There is no
  principled middle: allow-listing options one at a time recreates the
  composer's parsing problem (`__nocx_nested_detect` already refuses options
  it does not model) without removing the string-injection risk.
- The assembly proof does not need it. `nocx-u7uh.29` drives the real ssh
  client against the real sshd over the composed line with a **test-scoped
  credential**: the fixture's client key is loaded into an in-process ssh
  agent (`SSH_AUTH_SOCK`), which the composed line's `ssh` consults without
  any option. Measured on OpenSSH 10.4, the client resolves BOTH default
  identity paths and known_hosts from the passwd home — not `$HOME` — so a
  fixture key cannot be dropped into a hermetic `$HOME`; host verification
  is handled the same way, by a temp-dir `ssh` on PATH that execs the real
  client with `-o UserKnownHostsFile=<fixture file>` (the equivalent of the
  user's own config option). Neither mechanism touches the developer's real
  `~/.ssh`.
- A shape change would collide with the zsh tier port in flight (two request
  shapes, one protocol doc). Nothing in the assembly requires it.

## Consequences

- The composer stays the single owner of the launch line. A user's `-i` key
  is never reproduced; the honest degrade is the conventional terminal,
  visible in the product (the parent runs its command unchanged).
- The measured defect this decision records: the composed line must use
  `ssh -tt`, not `ssh -t` — the ssh client's stdin is the pipe from the brace
  group, and a single `-t` refuses to allocate the remote pty, leaving the
  far shell non-interactive where the in-band wrapper fails. `-tt` forces the
  pty and is asserted in the composer test and proven by the live assembly
  test.
- Two further assembly defects found and fixed by the same proof, both in
  `internal/app/childdomain.go`: the child's per-epoch capability was never
  set on the in-band plan, so the composed line streamed an EMPTY first line
  and the far shell integrated capability-free (no channel, conventional);
  and the grant builder captured the publisher as a value at wiring time,
  when the composition root's variable is still nil — the first real
  `domain_request` would have dereferenced nil. The capability now rides the
  stream as the contract requires, and the builder resolves the publisher
  lazily through an accessor.
- If a future feature genuinely needs user options on the far connection, it
  is a new validated field with an allow-list and a protocol-doc change —
  not a string pass-through.

# ADR-0006 — Reusable Credentials (УЗ) for SSH Connections

- **Status:** Accepted
- **Date:** 2026-07-24
- **Related:** Connection Manager UI, SSH authentication

## Context

The initial connection manager UI stored authentication settings (passwords, private keys) inline within each SSH profile. This led to duplication: if a user had the same credentials for 10 servers, they had to enter the password 10 times. Other terminal emulators (Tabby, SecureCRT, MobaXterm) solve this with **reusable credentials** (УЗ — учетные записи): a credential is a named authentication identity (username + auth method + secret) that can be shared across multiple connections.

The existing backend `CredentialStore` interface (internal/credential) is Identity-based: passwords are keyed by `{user, host, port}`. This is the correct model for **secret storage** (the OS keychain needs a unique key per secret), but it does not support **reusable credential objects** that the UI needs.

## Decision

**Introduce a Credential abstraction layer above the Identity-based secret store.**

### Data Model

```go
// Credential is a reusable authentication identity.
type Credential struct {
    ID       string   // Unique ID (e.g. "cred:work-github:1234567890")
    Name     string   // Display name (e.g. "work-github", "prod-server")
    Username string   // SSH username
    Auth     AuthMode // Auth method: password, publicKey, agent, keyboardInteractive
    KeyPath  string   // Private key path (only for publicKey auth)
    // Optional: bind to specific host (empty = works for any host)
    Host     string
    Port     int
}
```

### Target Scope

`Host` is an optional target scope, not a required identity field:

- Empty `Host` means the credential may be used for any host. This is the
  intentional reusable-credential default, not an invalid legacy state.
- Non-empty `Host` is compared case-insensitively with the resolved `HostName`
  after `~/.ssh/config` has been applied. Comparing with the user-provided alias
  would not constrain where the credential is sent because an alias can remap
  `HostName`.
- `Port == 0` means any port on the scoped host. A non-zero port is compared
  with the effective port after SSH config resolution. `Port` has no effect
  when `Host` is empty.
- Target and jump-host credentials are checked independently before either
  connection is dialed. Legacy inline authentication has no reusable
  credential scope to check.

The renderer may create profiles and edit credential metadata, including this
optional scope. Host scoping is therefore a user-selected safety constraint,
not an authorization boundary against a hostile renderer. Secret values remain
backend-only under ADR-0011. If a future host treats renderer compromise as an
in-scope threat, it needs a separate trusted approval capability for submitting
or re-scoping credentials; changing empty `Host` to mean "invalid" would break
this ADR's reuse contract without establishing that boundary.

### Storage

Credentials are stored in the profile store (JSON file) alongside SSH profiles. The actual secrets (passwords, key passphrases) remain in the OS keychain / encrypted vault, keyed by `Credential.ID` (not by Identity).

When connecting, the SSH module resolves the credential:
1. Load `Credential` by ID from the profile store
2. Load secret from keychain by `Credential.ID`
3. If `Credential` is host-scoped, verify the resolved connection matches
   before dialing

### UI Changes

**Saved Credentials (УЗ) button:**
- Opens a form to create/edit a Credential: name, username, auth method, secret (password or key path)
- Labels host restriction as optional; leaving it empty clearly means "any host"
- Shows a list of saved credentials with edit/delete actions
- Secrets are stored in OS keychain, never in the profile store

**New Connection form:**
- Dropdown to select a Credential from the list
- If a credential is selected, username/auth are pre-filled from the credential
- User can override username/auth per-connection if needed

### Backend API

New JSON-RPC methods:
- `credentials.list` → `[]Credential`
- `credentials.create` → `Credential`
- `credentials.update` → `Credential`
- `credentials.delete` → `bool`

Existing methods (`credentials.savePassword`, etc.) are adapted to key by `Credential.ID` instead of `Identity`.

## Consequences

- **Positive:** Users can create a credential once and reuse it across multiple connections. Changing a password in one place updates all connections using that credential.
- **Positive:** Clear separation between connection settings (host/port) and authentication (username/secret).
- **Negative:** Migration required for existing profiles with inline credentials. Existing profiles will continue to work (legacy inline auth is still supported).
- **Negative:** Slightly more complex mental model (credentials + connections vs. just connections).

## Migration Path

Existing profiles with inline `user`/`auth`/`password`/`privateKeys` continue to work. The UI will show a warning: "This connection uses inline auth. Consider creating a reusable credential."

## Revisit When

- **Multi-protocol support:** If we add RDP/VNC, the Credential model may need protocol-specific fields.
- **Cloud key management:** If we integrate with AWS Secrets Manager / HashiCorp Vault, the Credential model may need to reference external secrets.

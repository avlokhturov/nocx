# ADR-0006 — Reusable Credentials (УЗ) for SSH Connections

- **Status:** Accepted
- **Date:** 2026-07-24
- **Amended:** 2026-07-27
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
    // Required target binding; Port 0 means any port on this host
    Host     string
    Port     int
}
```

### Target Binding

Every stored reusable credential requires a non-empty `Host`. Create and update
operations reject an empty or whitespace-only host at the profile-store
boundary, so all writers enforce the same rule. An unbound credential already
present in storage is refused again before dial; it is not treated as valid for
every host.

The SSH module enforces a stored binding after `~/.ssh/config` resolution:

- `Host` is compared case-insensitively with the resolved `HostName`, not the
  user-provided alias. An alias can remap `HostName`, so matching the alias would
  not constrain where the credential is sent.
- `Port == 0` means any port on the bound host. A non-zero port is compared with
  the effective port after SSH config resolution.
- Target and jump-host credentials are checked independently before their
  corresponding connections are dialed.
- Legacy inline authentication does not reference a reusable credential and has
  no reusable-credential binding to check.

Host binding prevents an accidental credential from being aimed at the wrong
target. It is not an authorization boundary against a hostile renderer: the
renderer can create and edit credential metadata, including `Host`. Establishing
that stronger boundary requires a trusted confirmation or approval mechanism,
or immutable binding, outside the renderer. Secret values remain backend-only
under ADR-0011.

### Storage

Credentials are stored in the profile store (JSON file) alongside SSH profiles. The actual secrets (passwords, key passphrases) remain in the OS keychain / encrypted vault, keyed by `Credential.ID` (not by Identity).

When connecting, the SSH module resolves the credential:

1. Load `Credential` by ID from the profile store
2. Load secret from keychain by `Credential.ID`
3. Verify the required host binding against the resolved target before dial

### UI Changes

**Saved Credentials (УЗ) button:**

- Opens a form to create/edit a Credential: name, username, auth method, secret (password or key path)
- Requires the host to which the credential may be submitted
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

- **Positive:** Users can create a credential once and reuse it across multiple profiles for its bound host. Changing a password in one place updates all connections using that credential.
- **Positive:** Clear separation between connection settings (host/port) and authentication (username/secret).
- **Positive:** A required host binding catches accidental credential misrouting before a secret is submitted.
- **Negative:** Cross-host credential reuse is unavailable until a trusted approval or binding mechanism exists outside the renderer.
- **Negative:** Migration required for existing profiles with inline credentials. Existing profiles will continue to work (legacy inline auth is still supported).
- **Negative:** Slightly more complex mental model (credentials + connections vs. just connections).

## Migration Path

Existing profiles with inline `user`/`auth`/`password`/`privateKeys` continue to work. The UI will show a warning: "This connection uses inline auth. Consider creating a reusable credential."

Stored reusable credentials with an empty `Host` are not migrated automatically;
they remain unusable until saved with an explicit host binding.

## Revisit When

- **Multi-protocol support:** If we add RDP/VNC, the Credential model may need protocol-specific fields.
- **Cloud key management:** If we integrate with AWS Secrets Manager / HashiCorp Vault, the Credential model may need to reference external secrets.
- **Trusted binding changes:** If the host can provide confirmation, approval, or immutable binding outside the renderer, reconsider whether one credential may be authorized for multiple hosts.

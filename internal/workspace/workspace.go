// Package workspace names the container a session belongs to.
//
// A workspace is a user-created GROUP OF TABS and nothing else
// (.internal/specs/2026-08-15-workspaces-ux-design.md §1): it binds no host,
// no directory and no repository, it is flat and never nested, a session is
// always in exactly one, and it exists only while it holds at least one tab.
//
// This package holds the identity and the default, and deliberately nothing
// else. The registry, the lifecycle and the membership transitions are
// nocx-isoph's; the authorization fence that later consults membership is a
// separate epic again (§5), and §5.5 forbids anything shipping before it
// from advertising it. There is no behaviour here to read authority from,
// which is the point rather than an omission.
//
// WHY THIS EXISTS AS A PACKAGE RATHER THAN A CONSTANT SOMEWHERE. Two owners
// already wanted one id. internal/content declared "workspace:default" for
// the ledger's synthetic fallback row, and internal/session needs the same
// id for the session record — but a core session package must not import
// the encrypted store to learn a domain constant, and declaring a second
// constant with the same value is the AD-8 shape nocx-49d4 exists to close
// ("nothing mints a second permanent home under another id"). So the domain
// owns it and both look at it.
package workspace

// ID names one workspace. A distinct type rather than a bare string: a
// session id, an instance id and a workspace id are all 'a string' and none
// of them is interchangeable with another, so assigning one where another is
// expected should not compile.
type ID string

// Default is the workspace every session belongs to until something puts it
// somewhere else.
//
// It is PERMANENT and it NEVER RENDERS (design §4.2) — no header, no name,
// no colour; its tabs are simply top-level rows. Both halves are deliberate.
// "Invisible while it is the only one" was proposed and withdrawn: the
// default would have to acquire a name the user never gave it at the moment
// a second workspace appeared, and the whole chrome would appear and vanish
// on a counter. Visibility must not depend on a count.
//
// Because it never renders, the renderer has no name for it and must not
// acquire one: a session opened without a workspace is given this one by the
// backend registry, which is the single owner of that decision (AD-7).
const Default ID = "workspace:default"

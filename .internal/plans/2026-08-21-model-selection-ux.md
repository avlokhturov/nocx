# Model Selection UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use beads-superpowers:subagent-driven-development (recommended) or beads-superpowers:executing-plans to implement this plan task-by-task. Each Task becomes a bead (`bd create -t task --parent <epic-id>`). Steps within tasks use checkbox (`- [ ]`) syntax for human readability.

**Goal:** A person installs an endpoint, chooses a model once, and asks a question — never having to discover the Roles page unaided, and never being told "Ready" by an assistant that cannot answer.

**Architecture:** `profile.ResolveRole` stays the one resolver and gains a default as a new _input_, not a second path. `agent.status` stops reporting endpoint existence as readiness and reports whether the `answering` role resolves, using the refusal vocabulary `ResolveRole` already returns. The renderer turns that into a one-rung-at-a-time ladder, shown both in the readiness line and in a chip in the editor's chrome row.

**Tech Stack:** Go (`internal/profile`, `internal/capability`, `internal/transport`), TypeScript + SolidJS (`frontend/src`), JSON Schema contracts, vitest, `cmd/devharness` for e2e.

**Spec:** `.internal/specs/2026-08-21-model-selection-ux-design.md`
**Brainstorming bead:** nocx-rikz5

## Global Constraints

- **One resolver.** `profile.ResolveRole` (`internal/profile/role.go:140`) is the only place a role becomes an (endpoint, model) pair (AD-8). No task adds a second resolution path, and no task lets a model client choose a model (ADR-0028).
- **No silent fallback.** `nocx-e6kn2`'s criterion is binding: a role that cannot resolve is a visible failure, never a quiet hop to another model. The default is legal only because the person authored it.
- **The default is user-authored.** Never "the first model of the first endpoint". A default that the product invented is the forbidden fallback.
- **Contracts.** Any changed result shape carries `additionalProperties: false` plus an explicit `required`, is regenerated with `npm run contracts:check`, and is asserted BOTH as a DTO and over the real socket.
- **The kit.** New UI joins the row it lives in. The editor chrome row is `.nocx-chip` (`frontend/src/style.css:204`); do not introduce `ui-badge` there.
- **Gates per task:** `go test ./internal/<pkg>/...` for Go tasks, `npx vitest run <file>` plus `npx tsc --noEmit` and `npx eslint` for frontend tasks. The full `make ci-full` belongs to whoever integrates, not to each task.
- **Copy is exact.** The ladder's sentences are written verbatim in Task 4 and reused unchanged in Tasks 5 and 6.

---

## File Structure

| File                                 | Responsibility                                           |
| ------------------------------------ | -------------------------------------------------------- |
| `internal/profile/role.go`           | `ResolveRole` + the default's type and validation        |
| `internal/profile/store.go`          | persistence of the default beside `Roles`                |
| `internal/capability/config.go`      | the service seam: load/save the default                  |
| `internal/transport/ws_roles.go`     | `roles.list` / `roles.setDefault` wire                   |
| `internal/transport/ws_assistant.go` | `agent.status` grows the role's resolution               |
| `contracts/agent.status.schema.json` | the readiness contract                                   |
| `contracts/roles.list.schema.json`   | the default on the wire                                  |
| `frontend/src/agent-status-line.ts`  | the ladder: one rung → one sentence → one target         |
| `frontend/src/roles-section.tsx`     | the default control, "As default", the green line's rule |
| `frontend/src/editor.ts`             | the model chip in `chromeLeft`                           |
| `frontend/src/terminal-content.ts`   | feeds the chip from status + active target               |
| `e2e/assistant-readiness.spec.ts`    | the end-to-end check                                     |

---

### Task 1: `ResolveRole` learns the default

**Files:**

- Modify: `internal/profile/role.go` (add `DefaultModel`, extend `ResolveRole`)
- Modify: `internal/profile/store.go:73-81` (persist it), `internal/profile/store.go:511`
- Test: `internal/profile/role_test.go`

**Interfaces:**

- Consumes: nothing (first task).
- Produces:
  - `type DefaultModel struct { EndpointID string \`json:"endpointId"\`; Model string \`json:"model"\` }`
  - `func (d DefaultModel) IsSet() bool`
  - `func ResolveRole(role ModelRole, assignments []RoleAssignment, def DefaultModel, endpoints []Endpoint) (Endpoint, string, error)` — **signature change: `def` is the new third parameter.**
  - `RoleRepository` grows `LoadDefaultModel() (DefaultModel, error)` and `SetDefaultModel(DefaultModel) error`.

**Acceptance Criteria:**

- A role with its own assignment resolves to that assignment even when a default exists.
- A role with no assignment resolves to the default.
- With neither, `ResolveRole` returns `ErrRoleUnassigned`, unchanged.
- A default naming a deleted endpoint returns `ErrRoleEndpointGone`; one naming a removed model returns `ErrRoleModelGone`. The default is never silently repaired.
- `SetDefaultModel` with an empty pair clears the default; a half-set pair is refused.

- [ ] **Step 1: Write the failing tests**

```go
// internal/profile/role_test.go
func TestResolveRole_FallsBackToTheDefault(t *testing.T) {
	eps := []profile.Endpoint{{ID: "e1", Name: "openrouter", Models: []profile.EndpointModel{{Name: "m-a"}, {Name: "m-b"}}}}
	def := profile.DefaultModel{EndpointID: "e1", Model: "m-a"}

	// No assignment at all: the default answers.
	ep, model, err := profile.ResolveRole(profile.RoleAnswering, nil, def, eps)
	if err != nil {
		t.Fatalf("resolve with only a default: %v", err)
	}
	if ep.ID != "e1" || model != "m-a" {
		t.Fatalf("resolved to %q/%q, want e1/m-a", ep.ID, model)
	}

	// An explicit assignment OUTRANKS the default — the override is the point.
	as := []profile.RoleAssignment{{Role: profile.RoleAnswering, EndpointID: "e1", Model: "m-b"}}
	_, model, err = profile.ResolveRole(profile.RoleAnswering, as, def, eps)
	if err != nil {
		t.Fatalf("resolve with an assignment: %v", err)
	}
	if model != "m-b" {
		t.Fatalf("resolved to %q, want the role's own m-b", model)
	}
}

func TestResolveRole_NoDefaultAndNoAssignmentStaysUnassigned(t *testing.T) {
	eps := []profile.Endpoint{{ID: "e1", Name: "openrouter", Models: []profile.EndpointModel{{Name: "m-a"}}}}
	_, _, err := profile.ResolveRole(profile.RoleAnswering, nil, profile.DefaultModel{}, eps)
	if !errors.Is(err, profile.ErrRoleUnassigned) {
		t.Fatalf("err = %v, want ErrRoleUnassigned", err)
	}
}

func TestResolveRole_ADefaultPointingAtNothingRefusesRatherThanRepairs(t *testing.T) {
	eps := []profile.Endpoint{{ID: "e1", Name: "openrouter", Models: []profile.EndpointModel{{Name: "m-a"}}}}

	gone := profile.DefaultModel{EndpointID: "deleted", Model: "m-a"}
	if _, _, err := profile.ResolveRole(profile.RoleAnswering, nil, gone, eps); !errors.Is(err, profile.ErrRoleEndpointGone) {
		t.Fatalf("deleted endpoint: err = %v, want ErrRoleEndpointGone", err)
	}

	stale := profile.DefaultModel{EndpointID: "e1", Model: "m-removed"}
	if _, _, err := profile.ResolveRole(profile.RoleAnswering, nil, stale, eps); !errors.Is(err, profile.ErrRoleModelGone) {
		t.Fatalf("removed model: err = %v, want ErrRoleModelGone", err)
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `go test ./internal/profile/ -run TestResolveRole -v`
Expected: FAIL — `too many arguments in call to profile.ResolveRole` and `undefined: profile.DefaultModel`.

- [ ] **Step 3: Add the type and extend the resolver**

```go
// internal/profile/role.go

// DefaultModel is the ONE (endpoint, model) pair a person names once, used by
// every role that has no assignment of its own (spec §2). It is not a
// fallback the product invents — that is what nocx-e6kn2 forbids, because
// then nobody can say which model answered. It is a choice the person made,
// reused; the distinction is the whole reason this is a stored value rather
// than "the first model of the first endpoint".
//
// The zero value means "no default", and it is the state a fresh profile is
// in. Both fields set or neither: a half-set default names nothing.
type DefaultModel struct {
	EndpointID string `json:"endpointId"`
	Model      string `json:"model"`
}

// IsSet reports whether a default has been chosen. Both fields are required
// together, so a half-set value is not "partly set" — it is not set.
func (d DefaultModel) IsSet() bool { return d.EndpointID != "" && d.Model != "" }

// ValidateDefaultModel checks the SHAPE before storing: both present, or both
// empty. The empty pair is the CLEAR write — it removes the default and
// returns every unassigned role to the visible failure state.
func ValidateDefaultModel(d DefaultModel) error {
	if (d.EndpointID == "") != (d.Model == "") {
		return fmt.Errorf("a default names an endpoint and a model together, or neither")
	}
	return nil
}
```

Then change the resolver's lookup — the ONLY behavioural edit, everything
below the lookup is untouched:

```go
func ResolveRole(role ModelRole, assignments []RoleAssignment, def DefaultModel, endpoints []Endpoint) (Endpoint, string, error) {
	if !ValidModelRole(role) {
		return Endpoint{}, "", fmt.Errorf("role %q: %w", role, ErrRoleUnknown)
	}
	// The role's own assignment first: an override is only an override if it
	// outranks the thing it overrides.
	var a *RoleAssignment
	for i := range assignments {
		if assignments[i].Role == role {
			a = &assignments[i]
			break
		}
	}
	// Then the default, as an assignment this role did not write. Below this
	// point the two are indistinguishable ON PURPOSE: an endpoint that is gone
	// is gone whichever named it, and a default is never repaired into a
	// neighbour any more than an assignment is.
	if a == nil && def.IsSet() {
		a = &RoleAssignment{Role: role, EndpointID: def.EndpointID, Model: def.Model}
	}
	if a == nil {
		return Endpoint{}, "", fmt.Errorf("role %q: %w", role, ErrRoleUnassigned)
	}
	var ep *Endpoint
	for i := range endpoints {
		if endpoints[i].ID == a.EndpointID {
			ep = &endpoints[i]
			break
		}
	}
	if ep == nil {
		return Endpoint{}, "", fmt.Errorf("role %q: the assigned endpoint %q %w", role, a.EndpointID, ErrRoleEndpointGone)
	}
	for _, m := range ep.Models {
		if m.Name == a.Model {
			return *ep, a.Model, nil
		}
	}
	return Endpoint{}, "", fmt.Errorf("role %q: the assigned model %q %w (endpoint %q)", role, a.Model, ErrRoleModelGone, ep.Name)
}
```

Extend the repository interface:

```go
type RoleRepository interface {
	LoadRoleAssignments() ([]RoleAssignment, error)
	AssignRole(a RoleAssignment) error
	// LoadDefaultModel returns the stored default, or the zero value when
	// none has been chosen. Never an error for "unset" — unset is a value.
	LoadDefaultModel() (DefaultModel, error)
	// SetDefaultModel replaces the default. The empty pair clears it.
	SetDefaultModel(d DefaultModel) error
}
```

- [ ] **Step 4: Persist it**

```go
// internal/profile/store.go — beside `Roles []RoleAssignment` at :81
	// DefaultModel is the one pair every unassigned role resolves through
	// (nocx-rikz5). omitempty because the zero value IS "no default": an
	// absent key and an empty pair mean the same thing, and writing an
	// empty object would make two spellings of one state.
	DefaultModel DefaultModel `json:"defaultModel,omitempty"`
```

```go
// LoadDefaultModel returns the chosen default, or the zero value when none
// has been chosen — "unset" is a value here, never an error.
func (s *JSONStore) LoadDefaultModel() (DefaultModel, error) {
	d, err := s.load()
	if err != nil {
		return DefaultModel{}, err
	}
	return d.DefaultModel, nil
}

// SetDefaultModel replaces the default in one write. The empty pair clears
// it, returning every unassigned role to the visible failure state.
func (s *JSONStore) SetDefaultModel(m DefaultModel) error {
	if err := ValidateDefaultModel(m); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.load()
	if err != nil {
		return err
	}
	d.DefaultModel = m
	return s.writeLocked(d)
}
```

- [ ] **Step 5: Fix every existing caller of `ResolveRole`**

Run: `grep -rn "ResolveRole(" --include=*.go internal/ | grep -v _test`
Each call site gains the default, loaded from the same repository. In
`internal/capability/config.go:634` that is `s.roles.LoadDefaultModel()`; a
load error is returned, never swallowed into "no default", because a store
that cannot answer must not look like a person who chose nothing.

- [ ] **Step 6: Run the tests**

Run: `go test ./internal/profile/... ./internal/capability/... -count=1`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/profile internal/capability
git commit -m "feat(profile): a role with no assignment resolves through the default (nocx-rikz5)"
```

---

### Task 2: The default reaches the wire

**Files:**

- Modify: `internal/transport/ws_roles.go`, `internal/transport/ws_config_handlers.go` (registration)
- Modify: `internal/capability/config.go` (service methods)
- Modify: `contracts/roles.list.schema.json`
- Test: `internal/transport/ws_roles_test.go`, `internal/transport/ws_contract_test.go`

**Interfaces:**

- Consumes: `profile.DefaultModel`, `RoleRepository.LoadDefaultModel/SetDefaultModel` (Task 1).
- Produces:
  - `roles.list` result grows `"default": {"endpointId": string, "model": string} | null`.
  - New method `roles.setDefault` with params `{endpointId: string, model: string}`; the empty pair clears.
  - `capability.ConfigService` grows `DefaultModel() (profile.DefaultModel, error)` and `SetDefaultModel(profile.DefaultModel) error`.

**Acceptance Criteria:**

- `roles.list` returns `default: null` on a fresh profile and the chosen pair after `roles.setDefault`.
- `roles.setDefault` with an endpoint id that names no endpoint is refused `-32602`; nothing is stored.
- `roles.setDefault` with both fields empty clears the default and succeeds.
- The result validates against the contract **over the real socket**, not only as a DTO.

- [ ] **Step 1: Write the failing over-the-socket test**

```go
// internal/transport/ws_roles_test.go
func TestRolesSetDefault_IsReadBackByRolesList(t *testing.T) {
	ws, stop := newRolesWSServer(t, rolesStoreWithEndpoint(t, "e1", "openrouter", "m-a"))
	defer stop()
	conn := connectWS(t, ws)

	if resp := vaultCall(t, conn, "roles.list", nil, 1); resp.Error != nil {
		t.Fatalf("roles.list: %+v", resp.Error)
	} else if !bytes.Contains(resp.Result, []byte(`"default":null`)) {
		t.Fatalf("a fresh profile reported %s, want default null", resp.Result)
	}

	set := vaultCall(t, conn, "roles.setDefault", map[string]any{"endpointId": "e1", "model": "m-a"}, 2)
	if set.Error != nil {
		t.Fatalf("roles.setDefault: %+v", set.Error)
	}

	after := vaultCall(t, conn, "roles.list", nil, 3)
	var got struct {
		Default *struct {
			EndpointID string `json:"endpointId"`
			Model      string `json:"model"`
		} `json:"default"`
	}
	if err := json.Unmarshal(after.Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Default == nil || got.Default.EndpointID != "e1" || got.Default.Model != "m-a" {
		t.Fatalf("default read back as %+v, want e1/m-a", got.Default)
	}
}

func TestRolesSetDefault_RefusesAnEndpointThatDoesNotExist(t *testing.T) {
	ws, stop := newRolesWSServer(t, rolesStoreWithEndpoint(t, "e1", "openrouter", "m-a"))
	defer stop()
	conn := connectWS(t, ws)

	resp := vaultCall(t, conn, "roles.setDefault", map[string]any{"endpointId": "ghost", "model": "m-a"}, 1)
	if resp.Error == nil || resp.Error.Code != -32602 {
		t.Fatalf("error = %+v, want -32602", resp.Error)
	}
	list := vaultCall(t, conn, "roles.list", nil, 2)
	if !bytes.Contains(list.Result, []byte(`"default":null`)) {
		t.Fatalf("a refused write left %s, want default null", list.Result)
	}
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `go test ./internal/transport/ -run TestRolesSetDefault -v`
Expected: FAIL — `method not found: roles.setDefault`.

- [ ] **Step 3: Extend the contract**

```json
// contracts/roles.list.schema.json — add to "properties", and to "required"
"default": {
  "description": "The one (endpoint, model) pair every role with no assignment of its own resolves through (nocx-rikz5). Null when the person has chosen none — which is the state a fresh profile is in, and the state in which the assistant is not ready. It is never a pair the product picked: a default the product invented is the silent fallback nocx-e6kn2 forbids.",
  "anyOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["endpointId", "model"],
      "properties": {
        "endpointId": { "type": "string" },
        "model": { "type": "string" }
      }
    },
    { "type": "null" }
  ]
}
```

- [ ] **Step 4: Implement the handler**

In `internal/transport/ws_roles.go`, `rolesListResponse` grows
`Default *defaultModelWire \`json:"default"\``, filled from
`svc.DefaultModel()`. Add the `roles.setDefault`arm beside`roles.assign`,
validating that the named endpoint exists and offers the model **before**
storing — the same rule `roles.assign`already follows, so the two cannot
drift. Register it in`ws_config_handlers.go`next to`roles.assign`, on the
same `configSub` queue.

- [ ] **Step 5: Regenerate and run**

```bash
cd frontend && npm run contracts:check   # fails until the generated type is regenerated
npm run contracts                        # regenerate
cd .. && go test ./internal/transport/ -run 'TestRoles' -count=1
```

Expected: PASS, and `frontend/src/generated/roles.list.ts` carries `default`.

- [ ] **Step 6: Commit**

```bash
git add contracts internal/transport internal/capability frontend/src/generated
git commit -m "feat(transport): the default model is set and read back on the wire (nocx-rikz5)"
```

---

### Task 3: `agent.status` answers the role question

**Files:**

- Modify: `internal/transport/ws_assistant.go:43-47` (the result), `:106-155` (the handler)
- Modify: `contracts/agent.status.schema.json`
- Test: `internal/transport/ws_assistant_test.go`, `internal/transport/ws_contract_test.go`

**Interfaces:**

- Consumes: `ResolveRole` with the default (Task 1); `capability.ConfigService.ResolveRole` unchanged in name.
- Produces: `agentStatusResult` grows

```go
	// Answering is the resolution of the role the ask will use. "ready" or
	// one of the refusal reasons; never absent.
	Answering answeringWire `json:"answering"`
```

with `answeringWire{ Ready bool; Reason *string; Endpoint *string; Model *string }` and the reason enum
`"no-endpoints" | "unassigned" | "endpoint-gone" | "model-gone"`.

**Acceptance Criteria:**

- No endpoints at all → `answering.ready=false`, `reason="no-endpoints"`.
- An endpoint with a key but no default and no assignment → `ready=false`, `reason="unassigned"`. **This is the case that reports "Ready" today and is the reason this task exists.**
- A default set → `ready=true`, with `endpoint` and `model` naming what will answer.
- A default whose endpoint was deleted → `ready=false`, `reason="endpoint-gone"`.
- `endpointConfigured`, `credential` and `lastProbe` keep their current meanings — this task adds a fact, it does not repurpose one.
- Validated over the real socket.

- [ ] **Step 1: Write the failing test — the exact lie, first**

```go
func TestAgentStatus_AnEndpointWithNoModelChosenIsNotReady(t *testing.T) {
	// The defect this task exists for: an endpoint with a resolvable key and
	// nothing assigned reported "Ready", and the refusal arrived one
	// keystroke later.
	ws, stop := newAssistantWSServer(t, storeWithKeyedEndpoint(t, "e1", "openrouter", "m-a"))
	defer stop()
	conn := connectWS(t, ws)

	resp := vaultCall(t, conn, "agent.status", nil, 1)
	var got struct {
		EndpointConfigured bool `json:"endpointConfigured"`
		Answering          struct {
			Ready  bool    `json:"ready"`
			Reason *string `json:"reason"`
		} `json:"answering"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.EndpointConfigured {
		t.Fatalf("endpointConfigured = false, want true — the endpoint exists")
	}
	if got.Answering.Ready {
		t.Fatalf("answering.ready = true with no model chosen — this is the lie")
	}
	if got.Answering.Reason == nil || *got.Answering.Reason != "unassigned" {
		t.Fatalf("reason = %v, want unassigned", got.Answering.Reason)
	}
}

func TestAgentStatus_NoEndpointsSaysSoRatherThanUnassigned(t *testing.T) {
	ws, stop := newAssistantWSServer(t, emptyStore(t))
	defer stop()
	conn := connectWS(t, ws)
	resp := vaultCall(t, conn, "agent.status", nil, 1)
	if !bytes.Contains(resp.Result, []byte(`"reason":"no-endpoints"`)) {
		t.Fatalf("status = %s, want reason no-endpoints", resp.Result)
	}
}

func TestAgentStatus_ADefaultMakesItReadyAndNamesTheModel(t *testing.T) {
	store := storeWithKeyedEndpoint(t, "e1", "openrouter", "m-a")
	if err := store.SetDefaultModel(profile.DefaultModel{EndpointID: "e1", Model: "m-a"}); err != nil {
		t.Fatalf("SetDefaultModel: %v", err)
	}
	ws, stop := newAssistantWSServer(t, store)
	defer stop()
	conn := connectWS(t, ws)

	resp := vaultCall(t, conn, "agent.status", nil, 1)
	var got struct {
		Answering struct {
			Ready    bool    `json:"ready"`
			Endpoint *string `json:"endpoint"`
			Model    *string `json:"model"`
		} `json:"answering"`
	}
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.Answering.Ready || got.Answering.Endpoint == nil || *got.Answering.Endpoint != "openrouter" ||
		got.Answering.Model == nil || *got.Answering.Model != "m-a" {
		t.Fatalf("answering = %+v, want ready with openrouter/m-a", got.Answering)
	}
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `go test ./internal/transport/ -run TestAgentStatus -v`
Expected: FAIL — `answering.ready = true with no model chosen — this is the lie`.

- [ ] **Step 3: Extend the contract**

Add `answering` to `contracts/agent.status.schema.json`'s `properties` and
`required`, `additionalProperties: false` on the nested object, `reason`
constrained to the four-value enum, and `endpoint`/`model` nullable (present
only when ready). Update the schema's top `description` so it says the status
reports the role's resolvability, not endpoint existence.

- [ ] **Step 4: Implement**

In `handleAgentStatus`, after the existing credential loop, resolve the role
through the service and map the error:

```go
		ep, model, resolveErr := svc.ResolveRole(profile.RoleAnswering)
		switch {
		case resolveErr == nil:
			name, id := ep.Name, model
			res.Answering = answeringWire{Ready: true, Endpoint: &name, Model: &id}
		case len(eps) == 0:
			// Checked BEFORE unassigned: with no endpoints there is nothing to
			// assign, and sending a person to choose from an empty list is the
			// one answer worse than saying nothing (spec §3).
			res.Answering = answeringWire{Reason: strPtr(reasonNoEndpoints)}
		case errors.Is(resolveErr, profile.ErrRoleUnassigned):
			res.Answering = answeringWire{Reason: strPtr(reasonUnassigned)}
		case errors.Is(resolveErr, profile.ErrRoleEndpointGone):
			res.Answering = answeringWire{Reason: strPtr(reasonEndpointGone)}
		case errors.Is(resolveErr, profile.ErrRoleModelGone):
			res.Answering = answeringWire{Reason: strPtr(reasonModelGone)}
		default:
			return resolveErr
		}
```

Note the early `return nil` at `ws_assistant.go:122` ("credential stays null")
must no longer skip this block — with no endpoints the answering fact is still
required. Move the resolution above that return, or drop the early return and
guard the credential loop instead.

- [ ] **Step 5: Run**

Run: `go test ./internal/transport/... -count=1`
Expected: PASS, contract tests included.

- [ ] **Step 6: Commit**

```bash
git add contracts internal/transport frontend/src/generated
git commit -m "feat(transport): agent.status reports whether the role resolves, not whether an endpoint exists (nocx-rikz5)"
```

---

### Task 4: The ladder — one rung, one sentence, one target

**Files:**

- Modify: `frontend/src/agent-status-line.ts`
- Test: `frontend/src/agent-status-line.test.ts`

**Interfaces:**

- Consumes: `AgentStatusResult.answering` (Task 3, via the generated type).
- Produces:

```ts
export interface AgentStatusLine {
  tone: 'neutral' | 'success' | 'warning' | 'danger'
  text: string
  /** Where this rung is fixed. Absent when nothing is broken. */
  fix?: { label: string; page: 'endpoints' | 'roles' }
}
```

The exact copy, used verbatim by Tasks 5 and 6:

| reason          | text                                               | fix.page    |
| --------------- | -------------------------------------------------- | ----------- |
| `no-endpoints`  | `Add an endpoint first`                            | `endpoints` |
| `unassigned`    | `Choose a model`                                   | `roles`     |
| `endpoint-gone` | `The model's endpoint is gone — choose another`    | `roles`     |
| `model-gone`    | `That model is no longer offered — choose another` | `roles`     |

**Acceptance Criteria:**

- Role-first: an unready role produces its sentence even when `endpointConfigured` is true and the credential resolves.
- Each rung carries the `fix.page` from the table, exactly.
- A ready role keeps today's behaviour: probe result, or `Ready`.
- Credential problems still win over a ready role (a resolvable role with a deleted key is not usable).
- `null` status still returns `null` — a surface shows its placeholder, not a lie.

- [ ] **Step 1: Write the failing test**

```ts
it('says to choose a model rather than Ready when nothing is assigned', () => {
  const line = agentStatusLine({
    endpointConfigured: true,
    credential: 'resolvable',
    lastProbe: null,
    answering: { ready: false, reason: 'unassigned', endpoint: null, model: null },
  })
  expect(line).toEqual({
    tone: 'warning',
    text: 'Choose a model',
    fix: { label: 'Choose a model', page: 'roles' },
  })
})

it('sends a person with no endpoints to endpoints, never to an empty model list', () => {
  const line = agentStatusLine({
    endpointConfigured: false,
    credential: null,
    lastProbe: null,
    answering: { ready: false, reason: 'no-endpoints', endpoint: null, model: null },
  })
  expect(line?.text).toBe('Add an endpoint first')
  expect(line?.fix?.page).toBe('endpoints')
})

it('keeps Ready for a role that resolves', () => {
  const line = agentStatusLine({
    endpointConfigured: true,
    credential: 'resolvable',
    lastProbe: null,
    answering: { ready: true, reason: null, endpoint: 'openrouter', model: 'm-a' },
  })
  expect(line).toEqual({ tone: 'success', text: 'Ready' })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd frontend && npx vitest run src/agent-status-line.test.ts`
Expected: FAIL — the current function returns `{tone:'success',text:'Ready'}` for the first case.

- [ ] **Step 3: Invert the branch order**

```ts
export function agentStatusLine(st: AgentStatusResult | null): AgentStatusLine | null {
  if (!st) return null
  // THE ROLE FIRST (nocx-rikz5). This used to open on endpointConfigured, so
  // an endpoint with a valid key and no model chosen reported "Ready" and the
  // refusal arrived at the first question. Readiness is whether the role the
  // ask will use can resolve; the endpoint and the credential are reasons it
  // cannot, not a separate headline.
  if (!st.answering.ready) {
    switch (st.answering.reason) {
      case 'no-endpoints':
        return {
          tone: 'neutral',
          text: 'Add an endpoint first',
          fix: { label: 'Add an endpoint first', page: 'endpoints' },
        }
      case 'unassigned':
        return {
          tone: 'warning',
          text: 'Choose a model',
          fix: { label: 'Choose a model', page: 'roles' },
        }
      case 'endpoint-gone':
        return {
          tone: 'danger',
          text: "The model's endpoint is gone — choose another",
          fix: { label: 'Choose a model', page: 'roles' },
        }
      case 'model-gone':
        return {
          tone: 'danger',
          text: 'That model is no longer offered — choose another',
          fix: { label: 'Choose a model', page: 'roles' },
        }
    }
  }
  // A resolvable role still needs a usable credential: a key that is gone
  // stops the ask just as surely as an unassigned role.
  const line = credentialLine(st.credential)
  if (line) return line
  const p = st.lastProbe
  if (p && !p.ok) return { tone: 'danger', text: `Last test failed: ${p.error}` }
  if (p && p.ok) return { tone: 'success', text: `Last test ok (${p.model})` }
  return { tone: 'success', text: 'Ready' }
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/agent-status-line.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent-status-line.ts frontend/src/agent-status-line.test.ts
git commit -m "feat(frontend): the readiness line names the rung and where it is fixed (nocx-rikz5)"
```

---

### Task 5: The Roles page — the default control and the line's new rule

**Files:**

- Modify: `frontend/src/roles-section.tsx` (the default control, "As default", the line at `:63-78`)
- Modify: `frontend/src/endpoints.ts` (the roles client: `listRoles` at `:98`, `assignRole` at `:105` — add `setDefault` beside them)
- Test: `frontend/src/roles-section.test.tsx`

**Interfaces:**

- Consumes: `roles.list`'s `default` and `roles.setDefault` (Task 2).
- The TS `DefaultModel` type is **not hand-written**: it is
  `RolesListResult['default']` from the generated
  `frontend/src/generated/roles.list.ts`, regenerated in Task 2 step 5.
  Hand-writing it here is what put a field in the renderer's type that the
  backend never sent (the `vault.status` defect in AGENTS.md).
- Produces: `EndpointClient.setDefault(input: { endpointId: string; model: string }) => Promise<RoleDTO[]>`
  — returns the refreshed rows, as `assignRole` already does, so the page has
  one refresh path rather than two.

**Acceptance Criteria:**

- A "Default model" control renders above the roles; choosing a pair calls `roles.setDefault` and the page reflects it without a reload.
- Each role's select offers **"As default"** and shows it when the role has no assignment of its own.
- The green line is **absent** when a role's own assignment matches what the selects already show.
- The line **is** present, naming endpoint and model, when the role resolves through the default.
- The line names the failure when the role cannot resolve.
- A person can reach a working assistant from this page alone: set the default, and every role reads "As default".

- [ ] **Step 1: Write the failing tests**

```tsx
it('does not repeat the selects: an explicitly assigned role gets no status line', async () => {
  const client = mockedClient({
    roles: [{ role: 'answering', endpointId: 'e1', model: 'm-a' }],
    default: null,
    endpoints: [{ id: 'e1', name: 'openrouter', models: [{ name: 'm-a' }] }],
  })
  const container = mount(client)
  const row = await findRow(container, 'answering')
  expect(row.querySelector('.roles-role__state')).toBeNull()
})

it('names the model when the role resolves through the default, because the select only says "As default"', async () => {
  const client = mockedClient({
    roles: [{ role: 'answering', endpointId: null, model: null }],
    default: { endpointId: 'e1', model: 'm-a' },
    endpoints: [{ id: 'e1', name: 'openrouter', models: [{ name: 'm-a' }] }],
  })
  const container = mount(client)
  const row = await findRow(container, 'answering')
  expect(row.textContent).toContain('openrouter')
  expect(row.textContent).toContain('m-a')
})

it('sets the default through the wire and shows it', async () => {
  const client = mockedClient({
    roles: [{ role: 'answering', endpointId: null, model: null }],
    default: null,
    endpoints: [{ id: 'e1', name: 'openrouter', models: [{ name: 'm-a' }] }],
  })
  const spy = vi.spyOn(client, 'setDefault').mockResolvedValue(undefined)
  const container = mount(client)
  const control = await findDefaultControl(container)
  fireEvent.change(within(control).getByLabelText('Endpoint'), { target: { value: 'e1' } })
  fireEvent.change(within(control).getByLabelText('Model'), { target: { value: 'm-a' } })
  await vi.waitFor(() => expect(spy).toHaveBeenCalledWith({ endpointId: 'e1', model: 'm-a' }))
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd frontend && npx vitest run src/roles-section.test.tsx`
Expected: FAIL — no default control, and the status line renders for every row.

- [ ] **Step 3: Implement the line's rule**

```ts
/** The line exists to say what the two selects CANNOT (nocx-rikz5). When a
 *  role names its own endpoint and model, the selects already show both and a
 *  sentence repeating them is noise — so there is no line at all. The line
 *  speaks when resolution goes somewhere the controls do not show: through the
 *  default (the select reads "As default"), or nowhere. */
function roleLine(
  row: RoleDTO,
  def: DefaultModel | null,
  endpoints: Endpoint[],
): { tone: StatusDotTone; text: string } | null {
  const assigned = row.endpointId !== null && row.model !== null
  if (assigned) {
    const problem = resolutionProblem(row.endpointId!, row.model!, endpoints)
    return problem ?? null // resolves to exactly what the selects show → silence
  }
  if (!def) {
    return { tone: 'warning', text: 'No model assigned — the role cannot be used until it is' }
  }
  const problem = resolutionProblem(def.endpointId, def.model, endpoints)
  if (problem) return problem
  const ep = endpoints.find((e) => e.id === def.endpointId)!
  return { tone: 'ok', text: `As default: ${ep.name} · ${def.model}` }
}
```

Add the default control above the `<For>` over roles, and give each role select
the extra option `{ value: '', label: 'As default' }` selected when
`row.endpointId === null`.

- [ ] **Step 4: Run**

Run: `npx vitest run src/roles-section.test.tsx && npx tsc --noEmit && npx eslint src/roles-section.tsx --max-warnings=0`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/roles-section.tsx frontend/src/roles-section.test.tsx frontend/src/endpoints.ts
git commit -m "feat(frontend): the default model is chosen here, and the line stops repeating the selects (nocx-rikz5)"
```

---

### Task 6: The model chip in the editor chrome

**Files:**

- Modify: `frontend/src/editor.ts` (a chip pair in `chromeLeft`, beside `cwdChip`)
- Modify: `frontend/src/terminal-content.ts` (feed it from `agent.status` + the active input target)
- Modify: `frontend/src/style.css` (the chip's own rule, beside `.nocx-editor-cwd`)
- Test: `frontend/src/editor.test.ts`, `frontend/src/terminal-content.test.ts`

**Interfaces:**

- Consumes: `agentStatusLine`'s `fix` (Task 4) and `AgentStatusResult.answering` (Task 3).
- Produces: `Editor.setModelChip(state: ModelChipState | null): void` where

```ts
export type ModelChipState =
  | { kind: 'ready'; endpoint: string; model: string }
  | { kind: 'action'; text: string; page: 'endpoints' | 'roles' }
```

**Acceptance Criteria:**

- The chip is present only when the active input target is the assistant (Ask); switching to Run removes it.
- Ready → two chips: the endpoint (click → Endpoints) and the model (click → Roles).
- Not ready → one chip carrying the ladder's sentence, click → that rung's page.
- The model id is truncated to one line, with the full value in `title` and the accessible name.
- The composer's height does not change when the chip appears or disappears.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows no model chip while Enter goes to the shell', async () => {
  const { content } = await mountTerminal(makeClipboard(), {}, clientWithStatus(READY_STATUS))
  expect(chipsOf(content)).toEqual([])
})

it('names the model that will answer once the target is the assistant', async () => {
  const { content } = await mountTerminal(makeClipboard(), {}, clientWithStatus(READY_STATUS))
  switchToAsk(content)
  await vi.waitFor(() => expect(chipsOf(content)).toEqual(['openrouter', 'm-a']))
})

it('offers the rung, not the model, when nothing is chosen', async () => {
  const { content } = await mountTerminal(makeClipboard(), {}, clientWithStatus(UNASSIGNED_STATUS))
  switchToAsk(content)
  await vi.waitFor(() => expect(chipsOf(content)).toEqual(['Choose a model']))
})

it('opens the page the rung names', async () => {
  const opened: string[] = []
  const { content } = await mountTerminal(
    makeClipboard(),
    { onOpenSettingsPage: (p: string) => opened.push(p) },
    clientWithStatus(NO_ENDPOINTS_STATUS),
  )
  switchToAsk(content)
  await vi.waitFor(() => expect(chipsOf(content)).toEqual(['Add an endpoint first']))
  clickChip(content, 'Add an endpoint first')
  expect(opened).toEqual(['endpoints'])
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd frontend && npx vitest run src/terminal-content.test.ts -t "model chip"`
Expected: FAIL — `chipsOf` finds no `.nocx-editor-model` element.

- [ ] **Step 3: Implement the chip**

In `editor.ts`, beside `cwdChip` (the same `.nocx-chip` family — the row has no
`ui-badge` and must not grow one):

```ts
// The model that will answer, and the way to change it (nocx-rikz5).
// Buttons rather than spans because they are controls: `recoveryChip`
// above is the precedent, and a chip that navigates must be reachable by
// keyboard. Hidden until setModelChip is called with a state — exactly
// how locationChip behaves, so the row's height never moves.
this.modelEndpointChip = document.createElement('button')
this.modelEndpointChip.type = 'button'
this.modelEndpointChip.className = 'nocx-chip nocx-editor-model'
this.modelEndpointChip.style.display = 'none'

this.modelChip = document.createElement('button')
this.modelChip.type = 'button'
this.modelChip.className = 'nocx-chip nocx-editor-model'
this.modelChip.style.display = 'none'

this.chromeLeft.append(
  this.recoveryChip,
  this.locationChip,
  this.cwdChip,
  this.modelEndpointChip,
  this.modelChip,
)
```

```ts
  /** The model chip's one writer. Null hides both chips — the state a Run
   *  target is in, where no model answers anything and a chip claiming one
   *  would be decoration. */
  setModelChip(state: ModelChipState | null): void {
    if (state === null) {
      this.modelEndpointChip.style.display = 'none'
      this.modelChip.style.display = 'none'
      return
    }
    if (state.kind === 'ready') {
      this.modelEndpointChip.style.display = ''
      this.modelEndpointChip.textContent = state.endpoint
      this.modelEndpointChip.title = state.endpoint
      this.modelEndpointChip.setAttribute('aria-label', `Answers with ${state.endpoint}. Open Endpoints.`)
      this.modelChip.style.display = ''
      this.modelChip.textContent = state.model
      // The id is long and must not wrap: a wrapped chip is the layout shift
      // the row's single height exists to prevent.
      this.modelChip.title = state.model
      this.modelChip.setAttribute('aria-label', `Answers with the model ${state.model}. Open Roles.`)
      return
    }
    this.modelEndpointChip.style.display = 'none'
    this.modelChip.style.display = ''
    this.modelChip.textContent = state.text
    this.modelChip.title = state.text
    this.modelChip.setAttribute('aria-label', `${state.text}. Opens settings.`)
  }
```

```css
/* frontend/src/style.css, beside .nocx-editor-cwd */
.nocx-editor-model {
  cursor: pointer;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

In `terminal-content.ts`, call `setModelChip` from the one place that already
knows both facts — the input-target switch and the `agent.status` read — so the
chip has a single writer.

- [ ] **Step 4: Run**

Run: `npx vitest run src/terminal-content.test.ts src/editor.test.ts && npx tsc --noEmit && npx eslint src --max-warnings=0`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/editor.ts frontend/src/terminal-content.ts frontend/src/style.css frontend/src/*.test.ts
git commit -m "feat(frontend): the composer names the model that will answer, and it is the way to change it (nocx-rikz5)"
```

---

### Task 7: The end-to-end check

**Files:**

- Create: `e2e/assistant-readiness.spec.ts`

**Interfaces:**

- Consumes: everything above, through the real backend and the real socket.
- Produces: the epic's proof.

**Acceptance Criteria:**

- Runs against `cmd/devharness` (no Wails, no display) on a disposable `$HOME`.
- Watches the whole path: no endpoint → _Add an endpoint first_ → add one with a key → _Choose a model_, **never** _Ready_ → set the default from that control → ask → an answer arrives.
- Asserts on observable state changes (a chip's text, a row appearing), never on a duration — a spec that needs a slow machine is broken on a fast one.

- [ ] **Step 1: Write the spec**

```ts
test('a person reaches a working assistant without discovering the Roles page unaided', async ({
  page,
}) => {
  await page.goto(BASE_URL)
  await switchToAsk(page)

  // The first rung: no endpoints, and the product says which door to open.
  const chip = page.locator('.nocx-editor-model')
  await expect(chip).toHaveText('Add an endpoint first')

  await chip.click()
  await addEndpointWithKey(page, { name: 'openrouter', model: 'm-a' })

  // The second rung — and the assertion this whole epic exists for: an
  // endpoint with a key is NOT readiness.
  await expect(chip).toHaveText('Choose a model')
  await expect(chip).not.toHaveText('Ready')

  await chip.click()
  await setDefaultModel(page, { endpoint: 'openrouter', model: 'm-a' })

  // Ready means the model is named, not that a box was ticked.
  await expect(page.locator('.nocx-editor-model').first()).toHaveText('openrouter')
  await expect(page.locator('.nocx-editor-model').last()).toHaveText('m-a')

  await askAQuestion(page, 'hello')
  await expect(page.locator('.answer-block')).toBeVisible()
})
```

- [ ] **Step 2: Run it in the container**

```bash
PW_PROJECTS=chromium e2e/run-in-container.sh e2e/assistant-readiness.spec.ts
```

Expected: PASS. A failure that is only red in the container is checked against
CI before being "fixed" — the container is Linux WebKit at a container
viewport and its failure set is not CI's.

- [ ] **Step 3: Commit**

```bash
git add e2e/assistant-readiness.spec.ts
git commit -m "test(e2e): a person reaches a working assistant without finding Roles unaided (nocx-rikz5)"
```

---

## Task ordering

```
1 → 2 → 3 → 4 → 5
              ↘ 6
1..6 → 7
```

`bd dep add` edges: 2 blocks on 1; 3 blocks on 1; 4 blocks on 3; 5 blocks on 2;
6 blocks on 4; 7 blocks on 5 and 6. Tasks 5 and 6 are the parallel pair.

## Spec coverage

| Spec requirement                                                                      | Task                          |
| ------------------------------------------------------------------------------------- | ----------------------------- |
| §1 readiness is role resolvability; `agent.status` grows the role                     | 3                             |
| §1 `agentStatusLine` inverts to role-first                                            | 4                             |
| §2 the default as an input to the one resolver                                        | 1                             |
| §2 the default is set at the top of the Roles page                                    | 5                             |
| §2 per-role override, "As default" as the initial value                               | 5                             |
| §3 the ladder's five states, each with one fix location                               | 4 (copy), 5 + 6 (surfaces)    |
| §4 the chip: Ask-only, provider → Endpoints, model → Roles, truncation                | 6                             |
| §5 the green line says only what the controls cannot                                  | 5                             |
| §6 the end-to-end check                                                               | 7                             |
| §6 one test per rung                                                                  | 4                             |
| §6 the interval: deleting a default's endpoint returns the ladder to "choose a model" | 1 (resolution) + 3 (reported) |
| §6 contracts asserted over the socket                                                 | 2, 3                          |

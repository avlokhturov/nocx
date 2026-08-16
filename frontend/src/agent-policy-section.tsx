/**
 * Agent policy surface — the Settings page editing the ONE global policy
 * (ADR-0020 §7 as amended 2026-08-16, amendment proposed/awaiting owner
 * approval): a MATRIX of seven effect classes, each one of permit | ask |
 * refuse plus the resource scopes the decision applies within.
 *
 * Two invariants are built into this surface, not asserted in prose:
 * - the wire decides: this page renders the policy policy.get returns and
 *   saves exactly what the backend accepts (policy.set rejects unknown
 *   keys, a tool name as a key, and tool-kind scopes);
 * - the kind select has NO 'tool' option — the grant is over resources and
 *   effects, never over tool names (ADR-0028 decision 4), and the one
 *   vocabulary this page speaks cannot name a tool.
 */
import { createSignal, For, onMount, Show } from 'solid-js'
import {
  blankPolicy,
  EFFECT_KEYS,
  type EffectKey,
  type PolicyClient,
  type PolicyMatrix,
  type PolicyRow,
} from './policy-client'
import { PageSection, Select, TextField, Button, IconButton, Badge, showToast } from './ui'
import { PlusIcon, TrashIcon } from './ui/icons'

/** The effect-class keys in the wire's order, with the label a person reads. */
const EFFECT_LABELS: Record<EffectKey, string> = {
  observe: 'Observe',
  'mutate-reversible': 'Mutate (reversible)',
  'mutate-destructive': 'Mutate (destructive)',
  'privilege-change': 'Privilege change',
  disclose: 'Disclose',
  'cross-boundary': 'Cross boundary',
  delegate: 'Delegate',
}

/** The scope kinds a policy may name. 'tool' is deliberately absent. */
const SCOPE_KINDS = ['environment', 'session', 'path', 'credential', 'destination'] as const
type ScopeKind = (typeof SCOPE_KINDS)[number]

const DECISIONS = [
  { value: 'permit', label: 'Permit' },
  { value: 'ask', label: 'Ask' },
  { value: 'refuse', label: 'Refuse' },
] as const

export interface AgentPolicySectionProps {
  client: PolicyClient
}

export function AgentPolicySection(props: AgentPolicySectionProps) {
  const [matrix, setMatrix] = createSignal<PolicyMatrix>(blankPolicy())
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)

  // The load happens once, on mount — the client prop never changes on a
  // live page, and a bare top-level read-and-chain would be an untracked
  // fire-and-forget the reactivity rule flags honestly (solid/reactivity).
  onMount(() => {
    void props.client
      .get()
      .then(setMatrix)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  })

  const setRow = (key: EffectKey, patch: Partial<PolicyRow>) => {
    setMatrix((m) => ({ ...m, [key]: { ...m[key], ...patch } }))
  }
  const addScope = (key: EffectKey) => {
    setRow(key, { scopes: [...matrix()[key].scopes, { kind: 'path', id: '' }] })
  }
  const removeScope = (key: EffectKey, i: number) => {
    setRow(key, { scopes: matrix()[key].scopes.filter((_, n) => n !== i) })
  }
  const patchScope = (
    key: EffectKey,
    i: number,
    patch: Partial<{ kind: ScopeKind; id: string }>,
  ) => {
    setRow(key, {
      scopes: matrix()[key].scopes.map((s, n) => (n === i ? { ...s, ...patch } : s)),
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      await props.client.set(matrix())
      showToast({
        message: 'Agent policy saved — the next run is governed by the matrix above.',
        level: 'success',
      })
    } catch (e) {
      showToast({
        message: `This policy was not accepted: ${e instanceof Error ? e.message : String(e)}`,
        level: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <PageSection
      title="Agent policy"
      description="What a run may do, one effect class at a time. Each row is decided within its resource scopes; a call naming a resource outside the row's scopes is refused. Rows nobody set ask."
    >
      <Show when={loadError()}>
        <Badge tone="danger">{`Could not load the policy: ${loadError()}`}</Badge>
      </Show>
      <For each={EFFECT_KEYS}>
        {(key) => (
          <div class="st-policy__row" data-effect={key}>
            <span class="st-policy__effect">{EFFECT_LABELS[key]}</span>
            <Select
              value={matrix()[key].decision}
              options={DECISIONS.map((d) => ({ value: d.value, label: d.label }))}
              onChange={(v) => setRow(key, { decision: v as 'permit' | 'ask' | 'refuse' })}
            />
            <For each={matrix()[key].scopes}>
              {(scope, i) => (
                <div class="st-policy__scope">
                  <Select
                    value={scope.kind}
                    options={SCOPE_KINDS.map((k) => ({ value: k, label: k }))}
                    onChange={(v) => patchScope(key, i(), { kind: v as ScopeKind })}
                  />
                  <TextField
                    value={scope.id}
                    placeholder="/workspace or a session id"
                    onInput={(v) => patchScope(key, i(), { id: v })}
                  />
                  <IconButton
                    ariaLabel={`Remove ${EFFECT_LABELS[key]} scope`}
                    onClick={() => removeScope(key, i())}
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              )}
            </For>
            <Button variant="ghost" onClick={() => addScope(key)}>
              <PlusIcon /> Scope
            </Button>
          </div>
        )}
      </For>
      <Button onClick={() => void save()} disabled={saving()}>
        {saving() ? 'Saving…' : 'Save policy'}
      </Button>
    </PageSection>
  )
}

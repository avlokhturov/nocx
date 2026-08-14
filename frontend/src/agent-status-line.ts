// THE derivation of "agent.status → readiness sentence" (AD-8: one owner
// per behaviour — the owner is whoever already has it). The endpoints
// section and the ask chip both render this; a second inline mapping would
// be two derivations that agree everywhere and disagree somewhere they did
// not check. The sentences are the product's words, unchanged from the
// endpoints section's original inline version (nocx-x8s2.2 extracted it).
import type { AgentStatusResult } from './generated/agent.status'

export interface AgentStatusLine {
  tone: 'neutral' | 'warning' | 'danger' | 'success'
  text: string
}

/** Map agent.status facts to the readiness sentence a surface shows. A
 *  soft degrade — no endpoint, an unresolvable credential, a failed probe —
 *  is a visible sentence, never only a log line. null means no status has
 *  been read yet (a surface shows its placeholder, not a lie). */
export function agentStatusLine(st: AgentStatusResult | null): AgentStatusLine | null {
  if (!st) return null
  if (!st.endpointConfigured) {
    return { tone: 'neutral', text: 'No endpoint configured yet' }
  }
  if (!st.credentialResolvable) {
    return { tone: 'warning', text: 'Credential unavailable — the vault may be locked' }
  }
  const p = st.lastProbe
  if (p && !p.ok) {
    return { tone: 'danger', text: `Last test failed: ${p.error}` }
  }
  if (p && p.ok) {
    return { tone: 'success', text: `Last test ok (${p.model})` }
  }
  return { tone: 'success', text: 'Ready' }
}

/**
 * GENERATED FILE — do not edit.
 *
 * Source: contracts/agent.runToolCall.schema.json
 * Regenerate: cd frontend && npm run contracts
 *
 * Editing this file is editing the wrong end of the contract. If the renderer
 * needs a field the wire does not carry, the schema is what has to change, and
 * then the Go transport has to satisfy it.
 */

/**
 * Params of the agent.runToolCall server-to-client notification (nocx-shxv0, design §7): the assistant is about to DO something, announced where it happens — an element of the answer's own flow, never a top-level block and never an inference from a stray blob in the answer text. Sent once per execution, immediately before the tool runs: a call that was refused, malformed or escalated has not happened, and an escalated one already has a surface of its own (agent.approvalRequested), which is why this is not sent for it. runId AND entryId are both here for the same reason they are on agent.runDelta — the renderer routes by entryId while two overlapping asks stream concurrently. There is no seq: unlike a delta this is not persisted and not replayed, so arrival order over the one socket is its only order. The tool's RESULT is deliberately absent — the attempt's outcome is in the ledger, the run tool's output is in the block the command really opened, and the egress gate (design §7.1) screens a result for the PROVIDER, so sending the same bytes to the renderer would be a second egress path. The raw arguments blob is absent for the same kind of reason: what a person reads is the derived resource, from the ONE derivation (internal/assistant/policy.go namedResource) the scope check and the approval ask already share.
 */
export interface AgentRunToolCall {
  /**
   * The backend-minted run id the call belongs to.
   */
  runId: number
  /**
   * The TURN the call is an element of — agent.ask result's entryId, the same routing key agent.runDelta carries. Not the ledger entry the attempt was recorded under; that is actionEntryId.
   */
  entryId: string
  /**
   * The model's own id for this call. The renderer keys on it, so a call announced twice — an approved egress resume passes the same call through the pipeline again — renders once.
   */
  callId: string
  /**
   * The declared tool name the model called, e.g. 'files.read'.
   */
  tool: string
  /**
   * The effect class the policy gate decided on — the ledger's vocabulary. Sent by the backend because the renderer must never derive an effect from a tool name (ADR-0028 decision 4).
   */
  effect:
    | 'observe'
    | 'mutate-reversible'
    | 'mutate-destructive'
    | 'privilege-change'
    | 'disclose'
    | 'cross-boundary'
    | 'delegate'
  /**
   * Whether this call's work becomes a TOP-LEVEL BLOCK of its own (nocx-9sqii) — true for `run` alone, which submits a command through the same orchestration a person's line takes. It decides where the call is drawn: a call that opens a block IS that block, at the point in the turn where it happened, so the flow seals the answer fragment it is writing and draws no line beside it — a line would restate the command, the output and the exit status the block already owns. A call that opens none keeps its line, which is then the only thing that says it occurred. Sent by the backend for the reason the effect is (ADR-0028 decision 4): it is a fact of the tool table (internal/agenttools Declaration.OpensBlock), and a renderer holding its own list of which tools open blocks would be a second copy of that table, disagreeing the day a tool is added.
   */
  opensBlock: boolean
  /**
   * The LEDGER action entry the attempt was recorded under (design §6.4). The thread joining question, run, attempt and answer — and the handle a later 'show me what it returned' reaches through, rather than a second copy of the bytes.
   */
  actionEntryId: string
  /**
   * What the call named, or null when the tool names no resource in its parameters at all (git.status's repository IS the grant's path scope). The ONE derivation, shared with the policy's scope check and the approval ask.
   */
  resource?: {
    /**
     * The resource kind, from the ledger's closed set.
     */
    kind: 'path' | 'session' | 'environment' | 'credential' | 'destination'
    /**
     * The resource's id.
     */
    id: string
  } | null
}

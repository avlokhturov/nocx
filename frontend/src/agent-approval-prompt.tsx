/**
 * AgentApprovalPrompt — the renderer half of an approval question (nocx-z9hj4,
 * design §7.2/§7.3): a run suspended and a person is being asked to decide.
 * One kind of question whether the risk was an effect coming in (a policy
 * escalation) or a secret going out (an egress finding) — the wire sends
 * agent.approvalRequested either way, and this surface renders it either way.
 *
 * Since nocx-gycwo an answer has a WIDTH as well as a direction. Before it,
 * every answer was `once` and bound to the exact proposal by call id and
 * argument hash, so a person who had just allowed the assistant to read the
 * screen was asked about the SAME screen on their next question, and the only
 * place to say "stop asking me this" was a settings page in a vocabulary they
 * had never seen. A policy question now offers allow and deny at once, in this
 * session and always — the logic every other assistant has — and the BACKEND
 * applies the width: this surface never edits the policy matrix, which would
 * put a second owner on the document the settings page owns (design §"Three
 * wire changes").
 *
 * Two things it must never do. It must never derive the effect from the tool
 * name — `effect` is on the wire precisely so it does not, because a rule
 * keyed by a tool name is what ADR-0028 decision 4 forbids. And it must never
 * offer a standing answer to an EGRESS question: an egress ask means a tool
 * result contained secret-shaped material and nothing has reached the model
 * provider yet, so "always" there would mean "always send secrets to the
 * provider", which is not a decision anyone should make by clicking a button
 * sitting next to five others. Egress keeps Allow / Deny, once only.
 *
 * WHAT THE SESSION IS CALLED (nocx-vnzek). The wire carries the derived
 * resource, and for `kind: 'session'` that derivation IS the session id — an
 * internal handle that says nothing to the person being asked to decide. So
 * the surface names the pane instead, through the SAME derivation the tab
 * strip and the answer's tool-call line use (PaneManager.sessionWhere, which
 * is sessionDisplayName plus the machine), and says nothing at all when no
 * pane can be named.
 *
 * AND WHAT THE CALL DOES, IN A SENTENCE (nocx-njn8s). That was not enough.
 * A person approving `run` was shown the effect, then the raw argument blob
 * — `{"command": "df -h", "sessionId": "ab607…cf95"}` — with the id nocx-vnzek
 * had just taken off the tool-call line still inside it, and the MACHINE,
 * the fact that decides whether a destructive command lands on this laptop
 * or on a production host, never named at all. So a `run` proposal now reads
 * as a sentence: the command verbatim in its own block, the machine and the
 * tab in the lead.
 *
 * THE BLOB IS THE FALLBACK, AND IT IS NOT A LESSER ONE. That block is the
 * model's own proposal quoted verbatim, and paraphrasing it is only honest
 * while the paraphrase is EXHAUSTIVE — every argument accounted for. So the
 * sentence is used for exactly one shape, `run` with the two arguments its
 * schema declares and nothing else, and every other shape keeps the blob. A
 * third argument appearing on `run` tomorrow puts the blob back rather than
 * silently dropping it, which is the property this is built around: the
 * check is on the parsed keys, not on the tool name alone.
 *
 * What the surface must not overstate (design §7.2): approving covers the
 * call that is asking — it has NOT run, and no call after it in that response
 * will. It does NOT promise the domain is untouched: a permitted sibling
 * earlier in the same batch has already run. The sentence is on the surface,
 * where a person deciding reads it.
 */
import { For, Show } from 'solid-js'
import { ActionGroup, Badge, Button, CodeBlock, Prompt, Stack } from './ui'
import { EFFECT_LABEL } from './effect-labels'
import type { AgentApprovalRequested } from './generated/agent.approvalRequested'
import type { AgentApprove } from './generated/agent.approve'

/** How far an answer reaches — the wire's own vocabulary, not a second one. */
type ApprovalScope = AgentApprove['scope']

export interface AgentApprovalPromptProps {
  open: boolean
  /** The question as the backend sent it — the full binding plus the ask. */
  ask: AgentApprovalRequested
  /** The decision is in flight; the buttons are disabled. */
  busy: boolean
  /**
   * The person's answer: a direction and a width, in one act. One callback
   * rather than six, because the caller's job is to put both on the wire and
   * a surface that split them would invite a call site that forgot one.
   */
  onDecide: (approved: boolean, scope: ApprovalScope) => void
  /** Where a session IS, to a person: the pane's own display title and the
   *  machine its active domain is talking to (`user@host`, or '' for a local
   *  shell — the words for "here" are this surface's, not the pane layer's).
   *  Null when no pane in this window holds it, and then the prompt says
   *  nothing about where rather than printing the id back. Absent in a
   *  bare-bones embedding, which is the same case. */
  sessionWhere?: (sessionId: string) => { tab: string; machine: string } | null
}

const TITLE: Record<AgentApprovalRequested['reason'], string> = {
  policy: 'This action needs your approval',
  egress: 'A tool result contained secret-shaped material',
}

/**
 * The three widths, narrowest first, in the order both groups read.
 *
 * `once` leads because it is the answer a hurried person should land on: it
 * decides this proposal and commits to nothing. It is also what the prompt
 * focuses on open, since Prompt puts the caret on the first enabled button.
 */
const SCOPES: ReadonlyArray<{ scope: ApprovalScope; suffix: string }> = [
  { scope: 'once', suffix: 'once' },
  // "in this session", never "in this pane": the permission binds to the
  // terminal session, so restarting the shell is a new session and the
  // question comes back. Naming the pane would promise a lifetime it has not.
  { scope: 'session', suffix: 'in this session' },
  { scope: 'always', suffix: 'always' },
]

export function AgentApprovalPrompt(props: AgentApprovalPromptProps) {
  const ask = () => props.ask
  const effectLabel = () => EFFECT_LABEL[ask().effect]

  /** Where this call lands, when the resource is a session and a pane can
   *  say. Null otherwise — for a path, whose id is already the person's own
   *  word, and for a session nothing on screen holds. */
  const where = () => {
    const res = ask().resource
    if (!res || res.kind !== 'session') return null
    return props.sessionWhere?.(res.id) ?? null
  }

  /** The product's words for the machine a landed call touches. A local
   *  shell has no host, and '' is that fact — "this machine" is what a
   *  person calls it, and saying nothing there would leave the one question
   *  the sentence exists to answer unanswered. */
  const machineWords = (machine: string) => machine || 'this machine'

  /**
   * How the command is introduced, which is a matter of TENSE and not of
   * taste. A policy question is asked BEFORE the call: the command has not
   * run, and "wants to run" is the whole point of the prompt. An egress
   * question is asked AFTER it: the gate screens a tool RESULT, so the
   * command is already behind us and the thing being decided is whether what
   * it printed may leave for the provider. Saying "wants to run" there would
   * misreport what has already happened to the machine.
   */
  const runLead = () => {
    if (ask().reason !== 'egress') return 'The assistant wants to run this command'
    // The verb only appears when there is somewhere to put it: with no pane
    // to name, "ran" would trail off into the colon.
    return where() ? 'The command that produced it ran' : 'The command that produced it'
  }

  /**
   * The command a `run` proposal proposes, when the proposal is exactly the
   * shape this surface has words for. Null otherwise, and then the verbatim
   * blob is shown instead.
   *
   * The gate is the PARSED KEYS, not the tool name: naming the tool alone
   * would let a third argument arrive one day and vanish from the question a
   * person is answering. Two keys, both the ones run.schema.json declares, a
   * non-empty string command — anything else is a proposal we cannot restate
   * without dropping part of it, so we do not restate it.
   */
  const proposedCommand = () => {
    if (ask().tool !== 'run') return null
    let parsed: unknown
    try {
      parsed = JSON.parse(ask().arguments)
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const args = parsed as Record<string, unknown>
    const keys = Object.keys(args)
    if (keys.length !== 2 || !keys.includes('command') || !keys.includes('sessionId')) return null
    const command = args.command
    return typeof command === 'string' && command !== '' ? command : null
  }

  const egressIntro = () => {
    if (ask().reason !== 'egress') return ''
    return ask().wasError
      ? 'The tool failed, and its error mentioned secret-shaped material. Nothing was sent to the model provider.'
      : 'A tool result contained secret-shaped material. Nothing was sent to the model provider.'
  }

  /**
   * One group of three. `variant` is spent on the narrowest answer in each
   * group and nowhere else: the two once-scoped buttons are the immediate
   * reply to the question being asked, and the standing answers are
   * deliberately quieter, because a decision that outlives the question
   * should be a deliberate act rather than the thing the eye lands on.
   */
  const group = (approved: boolean, verb: string, variant: 'primary' | 'danger') => (
    <ActionGroup ariaLabel={approved ? 'Allow this action' : 'Refuse this action'}>
      <For each={SCOPES}>
        {({ scope, suffix }) => (
          <Button
            variant={scope === 'once' ? variant : 'default'}
            disabled={props.busy}
            onClick={() => props.onDecide(approved, scope)}
          >
            {verb} {suffix}
          </Button>
        )}
      </For>
    </ActionGroup>
  )

  return (
    <Prompt
      open={props.open}
      // Escape and a click on the scrim are the NARROWEST refusal. Dismissing
      // a question is not answering it for every call to come.
      onClose={() => props.onDecide(false, 'once')}
      ariaLabel={TITLE[ask().reason]}
      placement="top-sheet"
      title={TITLE[ask().reason]}
      actionsLayout={ask().reason === 'egress' ? 'row' : 'stacked'}
      actions={
        <Show
          when={ask().reason === 'policy'}
          fallback={
            <>
              <Button
                variant="primary"
                disabled={props.busy}
                onClick={() => props.onDecide(true, 'once')}
              >
                Allow
              </Button>
              <Button
                variant="danger"
                disabled={props.busy}
                onClick={() => props.onDecide(false, 'once')}
              >
                Deny
              </Button>
            </>
          }
        >
          {group(true, 'Allow', 'primary')}
          {group(false, 'Deny', 'danger')}
        </Show>
      }
    >
      <Stack>
        <Show when={ask().reason === 'egress'}>
          <p>{egressIntro()}</p>
        </Show>
        <Show
          when={proposedCommand()}
          fallback={
            <>
              <p>
                The assistant is asking to call <strong>{ask().tool}</strong> with these arguments:
              </p>
              <CodeBlock ariaLabel={`Arguments of ${ask().tool}`}>{ask().arguments}</CodeBlock>
              <Show when={where()}>
                {(w) => (
                  <p>
                    This call reaches the tab <strong>{w().tab}</strong> on{' '}
                    <strong>{machineWords(w().machine)}</strong>.
                  </p>
                )}
              </Show>
            </>
          }
        >
          {(command) => (
            <>
              <p>
                {runLead()}
                <Show when={where()}>
                  {(w) => (
                    <>
                      {' on '}
                      <strong>{machineWords(w().machine)}</strong>
                      {', in the tab '}
                      <strong>{w().tab}</strong>
                    </>
                  )}
                </Show>
                :
              </p>
              <CodeBlock ariaLabel="The command this question is about">{command()}</CodeBlock>
            </>
          )}
        </Show>
        <Show when={ask().reason === 'policy'}>
          <p>
            This call can <strong>{effectLabel()}</strong>.
          </p>
        </Show>
        <Show when={(ask().findings?.length ?? 0) > 0}>
          <Stack gap="loose">
            <p>What was found, and where — never the material itself:</p>
            <For each={ask().findings}>
              {(f) => (
                <p>
                  <Badge tone={f.source === 'known' ? 'warning' : 'info'}>
                    {f.source === 'known' ? 'Known vault material' : 'Heuristic match'}
                  </Badge>{' '}
                  {f.source === 'known' ? f.secretName : f.kind}
                  {' — bytes '}
                  {f.start}–{f.end}
                </p>
              )}
            </For>
          </Stack>
        </Show>
        <p>
          Approving covers this call: it has not run, and no call after it in this response will. It
          does not promise the terminal is untouched — a permitted call earlier in this batch may
          already have run.
        </p>
        <Show when={ask().reason === 'policy'}>
          <p>
            An answer in this session lasts until this terminal session ends; restarting the shell
            starts a new one and the question comes back. An answer of always is a standing answer
            for <strong>{effectLabel()}</strong>, which you can change on the Agent policy page.
          </p>
        </Show>
      </Stack>
    </Prompt>
  )
}

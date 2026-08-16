/**
 * AgentApprovalPrompt — the renderer half of an approval question (nocx-z9hj4,
 * design §7.2/§7.3): a run suspended and a person is being asked to decide.
 * One kind of question whether the risk was an effect coming in (a policy
 * escalation) or a secret going out (an egress finding) — the wire sends
 * agent.approvalRequested either way, and this surface renders it either way.
 *
 * What the surface must not overstate (design §7.2): approving covers the
 * call that is asking — it has NOT run, and no call after it in that response
 * will. It does NOT promise the domain is untouched: a permitted sibling
 * earlier in the same batch has already run. The sentence is on the surface,
 * where a person deciding reads it.
 */
import { For, Show } from 'solid-js'
import { Badge, Button, CodeBlock, Prompt, Stack } from './ui'
import type { AgentApprovalRequested } from './generated/agent.approvalRequested'

export interface AgentApprovalPromptProps {
  open: boolean
  /** The question as the backend sent it — the full binding plus the ask. */
  ask: AgentApprovalRequested
  /** The decision is in flight; the buttons are disabled. */
  busy: boolean
  onAllow: () => void
  onDeny: () => void
}

const TITLE: Record<AgentApprovalRequested['reason'], string> = {
  policy: 'This action needs your approval',
  egress: 'A tool result contained secret-shaped material',
}

export function AgentApprovalPrompt(props: AgentApprovalPromptProps) {
  const ask = () => props.ask

  const egressIntro = () => {
    if (ask().reason !== 'egress') return ''
    return ask().wasError
      ? 'The tool failed, and its error mentioned secret-shaped material. Nothing was sent to the model provider.'
      : 'A tool result contained secret-shaped material. Nothing was sent to the model provider.'
  }

  return (
    <Prompt
      open={props.open}
      onClose={props.onDeny}
      ariaLabel={TITLE[ask().reason]}
      placement="top-sheet"
      title={TITLE[ask().reason]}
      actions={
        <>
          <Button variant="primary" disabled={props.busy} onClick={props.onAllow}>
            Allow
          </Button>
          <Button variant="danger" disabled={props.busy} onClick={props.onDeny}>
            Deny
          </Button>
        </>
      }
    >
      <Stack>
        <Show when={ask().reason === 'egress'}>
          <p>{egressIntro()}</p>
        </Show>
        <p>
          The assistant is asking to call <strong>{ask().tool}</strong> with these arguments:
        </p>
        <CodeBlock ariaLabel={`Arguments of ${ask().tool}`}>{ask().arguments}</CodeBlock>
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
      </Stack>
    </Prompt>
  )
}

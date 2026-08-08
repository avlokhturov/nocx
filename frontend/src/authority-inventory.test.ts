// Authority inventory (ADR-0024 §1, §5, §6) — the guard import rules cannot
// provide. Enumerates every operation that requires lifecycle authority and
// pins each to an authority-bearing value (a domain or an attempt), never a
// boolean.
//
// The ADR-committed lifecycle state does not exist yet (it is the renderer
// half of epic nocx-u7uh; the child bead ids were not available in this
// worktree). So this file carries two kinds of contract:
//
//  1. MANIFEST — the intended signatures, one entry per operation. Entries
//     are either 'pending' (the forward-declared src/lifecycle/ module does
//     not exist yet: the test requires that it STAY absent, and fails the
//     moment it lands, forcing this entry to be flipped to 'live') or 'wake'
//     (the module exists today in its pre-ADR shape: the test requires the
//     authority check to FAIL, and fails the moment the surface gains the
//     authority type, forcing the flip). A 'live' entry requires the module,
//     the symbol and the authority-bearing parameter type to all exist. The
//     check is a real TypeScript AST inspection of the parameter type
//     annotations — not test.skip, not a comment, and not Function.toString
//     introspection.
//
//  2. PRE-ADR WAKE-UPS — today's stream-derived surfaces that ADR-0024
//     "Consequences" deletes (the `trusted` laundering rule, `trusted` on the
//     history record, `onMarker` as an entry point for anonymous kinds, the
//     `_shellIntegrated` latch, the boolean editor axis). Each must exist in
//     its pre-ADR shape today; the day the ADR work lands, the relevant
//     assertion fails and the worker deletes the wake-up (or flips the
//     manifest entry) as the acknowledgment.
import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const SRC_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function parseSource(relPath: string): ts.SourceFile {
  const full = join(SRC_ROOT, relPath)
  const text = readFileSync(full, 'utf8')
  return ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function isExported(node: ts.Node): boolean {
  return (
    (ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) ??
    false
  )
}

/** The base type name of a parameter's annotation, generics stripped. */
function paramTypeNames(fn: ts.FunctionLikeDeclaration): string[] {
  const names: string[] = []
  for (const p of fn.parameters) {
    if (!p.type) continue
    const text = p.type.getText()
    names.push(text.replace(/<.*>$/, ''))
  }
  return names
}

function findExportFunction(
  source: ts.SourceFile,
  symbol: string,
): ts.FunctionLikeDeclaration | null {
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === symbol && isExported(stmt)) {
      return stmt
    }
    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === symbol && decl.initializer) {
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
            return decl.initializer
          }
        }
      }
    }
  }
  return null
}

function findClassMethod(
  source: ts.SourceFile,
  className: string,
  methodName: string,
): ts.MethodDeclaration | null {
  for (const stmt of source.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === className) {
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.name.getText() === methodName) {
          return member
        }
      }
    }
  }
  return null
}

function findInterfaceProperty(
  source: ts.SourceFile,
  interfaceName: string,
  propName: string,
): ts.PropertySignature | null {
  for (const stmt of source.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === interfaceName) {
      for (const member of stmt.members) {
        if (ts.isPropertySignature(member) && member.name.getText() === propName) {
          return member
        }
      }
    }
  }
  return null
}

function findSwitchCaseLiteral(source: ts.SourceFile, literal: string): ts.CaseClause | null {
  let found: ts.CaseClause | null = null
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isCaseClause(node) &&
      node.expression &&
      ts.isStringLiteral(node.expression) &&
      node.expression.text === literal
    ) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function findMemberNamed(source: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isPropertyDeclaration(node) && node.name.getText() === name) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

// ─── The manifest ────────────────────────────────────────────────────────────
// `symbol` + `authorityTypes` is the ADR-committed signature: the operation
// must take a parameter whose type annotation is one of the authority types.
// The types name the ADR vocabulary (ExecutionAttempt, IntegrationDomain,
// LifecycleState); the exact symbol names are this file's commitment until the
// epic lands, and the comment on each entry names the ADR section that fixes
// the requirement.
interface AuthorityEntry {
  op: string
  module: string
  symbol: string
  authorityTypes: string[]
  state: 'pending' | 'wake' | 'live'
  bead: string
  note: string
}

const BEAD = 'nocx-u7uh' // ADR-0024 renderer work; exact child bead ids TBD

const MANIFEST: AuthorityEntry[] = [
  {
    op: 'show the DOM editor',
    module: 'src/lifecycle/state.ts',
    symbol: 'shouldShowEditor',
    authorityTypes: ['LifecycleState'],
    state: 'pending',
    bead: BEAD,
    note: 'ADR-0024 §6: the editor owns keys because the lifecycle axis says PromptReady(domain), not because a boolean does. Today this is native-mode.ts shouldShowEditor(owned: boolean, nativeMode: boolean) — the boolean axis §6 deletes (wake-up W5).',
  },
  {
    op: 'persist a history record',
    module: 'src/history-client.ts',
    symbol: 'recordCommand',
    authorityTypes: ['ExecutionAttempt'],
    state: 'wake',
    bead: BEAD,
    note: "ADR-0024 consequences: `trusted` is deleted as a field crossing to history.record; what persists becomes the attempt's domain-authenticated status. Today recordCommand(client, rec: CommandRecord) carries trusted: boolean (wake-up W2).",
  },
  {
    op: 'complete an attempt',
    module: 'src/lifecycle/state.ts',
    symbol: 'completeAttempt',
    authorityTypes: ['ExecutionAttempt', 'IntegrationDomain'],
    state: 'pending',
    bead: BEAD,
    note: "ADR-0024 §5: an attempt is open until an authenticated same-domain completion; nothing may mark it successful on the stream's say-so.",
  },
  {
    op: 'assign an exit status',
    module: 'src/lifecycle/state.ts',
    symbol: 'completeAttempt',
    authorityTypes: ['ExecutionAttempt'],
    state: 'pending',
    bead: BEAD,
    note: 'ADR-0024 §5 interval: the exit code rides the authenticated completion; there is deliberately no separate status-assignment surface.',
  },
  {
    op: 'freeze an authoritative block',
    module: 'src/lifecycle/state.ts',
    symbol: 'freezeBlock',
    authorityTypes: ['ExecutionAttempt', 'IntegrationDomain'],
    state: 'pending',
    bead: BEAD,
    note: 'ADR-0024 §7 render ordering: the visual freeze waits for the authenticated event AND the matching fence; a stream D must not freeze a block (today scrollback.freezeBlock takes the stream exitCode).',
  },
  {
    op: 'activate an environment',
    module: 'src/lifecycle/domains.ts',
    symbol: 'activateDomain',
    authorityTypes: ['IntegrationDomain'],
    state: 'pending',
    bead: BEAD,
    note: 'ADR-0024 §2, §6: the domain stack transitions only on authenticated events; a passport is tty bytes and cannot activate a domain (today EnvironmentPassportTracker.ingest accepts stream passports against an expected id — a surviving invariant, not authority).',
  },
  {
    op: 'enable integration-sensitive ssh rewriting',
    module: 'src/lifecycle/state.ts',
    symbol: 'rewriteAuthority',
    authorityTypes: ['LifecycleState'],
    state: 'pending',
    bead: BEAD,
    note: 'ADR-0024 §1: integration-sensitive command rewriting needs authority. Today it is the _shellIntegrated boolean latched by any OSC 133 marker (wake-up W4).',
  },
  {
    op: 'authorize a re-run',
    module: 'src/lifecycle/state.ts',
    symbol: 'rerunAuthority',
    authorityTypes: ['LifecycleState'],
    state: 'pending',
    bead: BEAD,
    note: 'ADR-0024 §1: a re-run must be authorized by the attempt/domain, never by a block the stream forged.',
  },
]

// ─── Pre-ADR wake-ups ─────────────────────────────────────────────────────────
interface WakeUp {
  name: string
  module: string
  check: (source: ts.SourceFile) => boolean
  adr: string
}

const WAKE_UPS: WakeUp[] = [
  {
    name: 'input-state marker path (the trust-laundering rule)',
    module: 'src/input-state.ts',
    check: (s) => findSwitchCaseLiteral(s, 'marker') !== null,
    adr: "ADR-0024 §6: the transition `trusted: m.state !== 'RUNNING_RAW'` (input-state.ts:100) is deleted rather than patched.",
  },
  {
    name: 'history.record trusted boolean',
    module: 'src/history-client.ts',
    check: (s) => findInterfaceProperty(s, 'HistoryRecordParams', 'trusted') !== null,
    adr: 'ADR-0024 consequences: `trusted` as a field crossing to history.record is deleted.',
  },
  {
    name: 'ledger.onMarker anonymous kinds entry',
    module: 'src/command-ledger.ts',
    check: (s) => {
      const m = findClassMethod(s, 'CommandLedger', 'onMarker')
      return m !== null && m.parameters.length >= 1
    },
    adr: 'ADR-0024 consequences: `ledger.onMarker` as an entry point for anonymous kinds is deleted.',
  },
  {
    name: '_shellIntegrated marker latch',
    module: 'src/terminal-content.ts',
    check: (s) => findMemberNamed(s, '_shellIntegrated') !== null,
    adr: 'ADR-0024 consequences: `_shellIntegrated` latching on any OSC 133 (terminal-content.ts:1405) is deleted.',
  },
  {
    name: 'boolean editor axis (shouldShowEditor owned flag)',
    module: 'src/native-mode.ts',
    check: (s) => {
      const fn = findExportFunction(s, 'shouldShowEditor')
      return fn !== null && fn.parameters.some((p) => p.name.getText() === 'owned')
    },
    adr: 'ADR-0024 §6: ownership is a state you can only be given; the `owned` boolean is replaced by the lifecycle axis.',
  },
]

describe('authority inventory — every authority operation takes a domain or an attempt', () => {
  for (const entry of MANIFEST) {
    const fullPath = join(SRC_ROOT, entry.module)
    const exists = existsSync(fullPath)

    if (entry.state === 'pending') {
      it(`${entry.op}: ${entry.module} is forward-declared and must not exist until the ADR work lands`, () => {
        expect(
          exists,
          `module ${entry.module} landed (${entry.bead}) — flip this manifest entry to 'live' and satisfy the signature contract`,
        ).toBe(false)
      })
      continue
    }

    it(`${entry.op}: ${entry.symbol} in ${entry.module} takes an authority-bearing value`, () => {
      expect(exists, `module ${entry.module} must exist for a ${entry.state} entry`).toBe(true)
      const source = parseSource(entry.module)
      const fn = findExportFunction(source, entry.symbol)
      expect(fn, `symbol ${entry.symbol} must be exported from ${entry.module}`).not.toBeNull()
      const types = paramTypeNames(fn as ts.FunctionLikeDeclaration)
      const hasAuthority = entry.authorityTypes.some((t) => types.includes(t))
      if (entry.state === 'wake') {
        // Pre-ADR: the surface must exist but must NOT yet carry authority.
        expect(
          hasAuthority,
          `${entry.symbol} now carries ${entry.authorityTypes.join('/')} — the ADR-0024 surface landed; flip this entry to 'live'`,
        ).toBe(false)
      } else {
        expect(
          hasAuthority,
          `${entry.symbol} must take a parameter typed ${entry.authorityTypes.join(' or ')} — got: ${types.join(', ') || '(none)'}. ${entry.note}`,
        ).toBe(true)
      }
    })
  }
})

describe("pre-ADR wake-ups — today's stream-derived authority surfaces still exist", () => {
  for (const wake of WAKE_UPS) {
    it(`${wake.name} exists in its pre-ADR shape`, () => {
      const fullPath = join(SRC_ROOT, wake.module)
      expect(existsSync(fullPath), `module ${wake.module} missing`).toBe(true)
      const source = parseSource(wake.module)
      expect(
        wake.check(source),
        `${wake.adr} — if the ADR work has landed, delete this wake-up (or flip the manifest entry) as the acknowledgment`,
      ).toBe(true)
    })
  }
})

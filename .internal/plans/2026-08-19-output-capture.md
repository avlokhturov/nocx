# Output capture: a block keeps what it printed — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `beads-superpowers:subagent-driven-development` (recommended) or `beads-superpowers:executing-plans` to implement this plan task by task. Each Task becomes a bead under epic `nocx-2f0f`. The `- [ ]` steps are for human readability; tracking is beads.

**Goal:** every frozen command block stores what it printed — colour kept as SGR, plus derived plain text — so a later read can render it again.

**Architecture:** capture is the freeze-time `serializeRange` pass in two more emission modes (AD-6: the renderer owns VT, the backend never parses it). The bodies cross the control plane on a new `ledger.capture` method, idempotent on `(artifactId, seq)`, and land in `artifacts` + `artifact_chunks` against the entry's existing execution row. Nothing is written on the byte-stream path: `nocx-2f0f`'s own v6 correction deleted that approach and it stays deleted.

**Tech stack:** TypeScript + vitest (renderer), Go + `go test -race` (backend), SQLite (`internal/content`), JSON-RPC over one WebSocket, JSON Schema in `contracts/`.

## Global constraints

- **Spec:** `.internal/specs/2026-08-19-restore-and-output-capture-design.md`. Its §3 and §4 are what this plan builds.
- **AD-6:** the backend never parses the byte stream. Both bodies are produced in the renderer.
- **AD-1:** capture is a control-plane method. No output byte rides the data plane.
- **AD-8:** one owner per behaviour. The row-walk that turns buffer lines into a block's body exists **once**, in `frontend/src/scrollback/serializer.ts`, in three emission modes — never copied.
- **ADR-0019 §6:** every artifact records its capture provenance: `capture_method='terminal-cells'`, `capture_version=SERIALIZER_VERSION`, `terminal_cols`, `terminal_rows`.
- **Untrusted input:** every id the renderer mints is validated and never believed. An id already taken with different content fails; the same id with the same content is a replay and writes nothing.
- **Per-entry cap:** 128 KiB head + 128 KiB tail, sealed `truncated='cap'`. Hard backend ceiling: 1 MiB per artifact, 64 KiB per chunk.
- **Commit style:** `<type>(<scope>): <subject> (<bead-id>)`, body in prose. Every commit names its bead.
- **Gate:** a worker runs the unit tests for the files it changed. `make ci-full` belongs to whoever integrates.

## File structure

| File                                               | Responsibility                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `frontend/src/scrollback/serializer.ts` (modify)   | one row-walk, three emissions: HTML (today), SGR, plain text                      |
| `frontend/src/scrollback/sgr.ts` (create)          | SGR parameter emission from a cell's raw colour mode/value                        |
| `frontend/src/scrollback/blocks.ts` (modify)       | the freeze site produces the block's bodies and parks them on the record          |
| `frontend/src/capture-client.ts` (create)          | the cap, the chunking and the `ledger.capture` calls, through the outbox          |
| `frontend/src/terminal-content.ts` (modify)        | on the record ack, send the parked bodies against `ack.entryId`                   |
| `internal/content/ledger.go` (modify)              | `CaptureOutput` on the repository, its input type, `AppendChunk` gains `seq`      |
| `internal/content/ledger_sqlite.go` (modify)       | the one transaction: artifact if absent, chunk at seq, byte_len                   |
| `internal/content/stub.go` (modify)                | the degraded twin of both                                                         |
| `internal/capability/ledger.go` (modify)           | `CaptureOutput` behind the capability guard                                       |
| `internal/transport/ws_ledger_capture.go` (create) | the `ledger.capture` method: validation, refusal, ack                             |
| `contracts/ledger.capture.schema.json` (create)    | the result shape; `frontend/src/generated/ledger.capture.ts` is generated from it |
| `internal/settings/settings.go` (modify)           | the per-entry cap knob                                                            |

---

### Task 1: The serializer emits SGR and plain text, not only HTML

**Files:**

- Modify: `frontend/src/scrollback/serializer.ts`
- Create: `frontend/src/scrollback/sgr.ts`
- Test: `frontend/src/scrollback/serializer.test.ts`, `frontend/src/scrollback/sgr.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:
  - `serializeRangeSGR(getLine: (y: number) => IBufferLine | undefined, startLine: number, endLine: number): string`
  - `serializeRangeText(getLine: (y: number) => IBufferLine | undefined, startLine: number, endLine: number): string`
  - `sgrParams(prev: SGRAttrs, next: SGRAttrs): string` and `cellSGRAttrs(line: IBufferLine, idx: number): SGRAttrs` from `sgr.ts`

**Why a shared walk and not a second function.** `serializeRange` does four things beyond emitting spans: it joins wrapped rows into one logical line, trims trailing empty lines, trims the leading band readline erased, and skips empty runs. A second implementation of those four would drift from the first, and the drift would show up as a restored block that does not match the block a person saw. The walk moves into one internal function; the three public entry points differ only in their emitter.

**Acceptance criteria:**

- `serializeRangeText` over a range returns the same characters `blockOutputText` reads off the frozen DOM for that range, with no markup and no escape sequences.
- `serializeRangeSGR` over a range with a red run and a default run emits `\x1b[31m` before the red characters and `\x1b[0m` at the end of the line, and its SGR-stripped form equals `serializeRangeText`'s output.
- A 24-bit colour emits `\x1b[38;2;R;G;Bm`; a 256-palette colour emits `\x1b[38;5;Nm`.
- The wrapped-row join, the leading trim and the trailing trim behave identically in all three modes — one test drives the same lines through all three and asserts the same row count.

- [ ] **Step 1: Write the failing test for SGR parameters**

```ts
// frontend/src/scrollback/sgr.test.ts
import { describe, it, expect } from 'vitest'
import { sgrParams, emptySGR, type SGRAttrs } from './sgr'

const attrs = (over: Partial<SGRAttrs>): SGRAttrs => ({ ...emptySGR(), ...over })

describe('sgrParams', () => {
  it('opens a 16-colour foreground and closes it again', () => {
    const red = attrs({ fg: { mode: 1, color: 1 } })
    expect(sgrParams(emptySGR(), red)).toBe('\x1b[31m')
    expect(sgrParams(red, emptySGR())).toBe('\x1b[0m')
  })

  it('emits a 256-palette index and a 24-bit colour in their own forms', () => {
    expect(sgrParams(emptySGR(), attrs({ fg: { mode: 1, color: 208 } }))).toBe('\x1b[38;5;208m')
    expect(sgrParams(emptySGR(), attrs({ fg: { mode: 2, color: 0xff8800 } }))).toBe(
      '\x1b[38;2;255;136;0m',
    )
  })

  it('adds an attribute without reopening the colour', () => {
    const red = attrs({ fg: { mode: 1, color: 1 } })
    const redBold = attrs({ fg: { mode: 1, color: 1 }, bold: true })
    expect(sgrParams(red, redBold)).toBe('\x1b[1m')
  })

  it('says nothing when nothing changed', () => {
    const red = attrs({ fg: { mode: 1, color: 1 } })
    expect(sgrParams(red, red)).toBe('')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && npx vitest run src/scrollback/sgr.test.ts`
Expected: FAIL — `Failed to resolve import "./sgr"`.

- [ ] **Step 3: Write `sgr.ts`**

```ts
// frontend/src/scrollback/sgr.ts
//
// SGR emission for a captured block body (design §3). The DURABLE body keeps
// colour as SGR rather than as inline CSS for one reason: CSS bakes in the
// palette that was current when the block ran, so a restored block would sit
// in the old theme while every live block around it repainted. SGR names the
// colour the way the program named it, and the palette is applied at draw
// time by whoever is drawing.
//
// It is therefore the RAW cell colour that matters here — mode plus value —
// and not `CellAttrs`, whose fg/bg are already resolved against a snapshot.
// That resolution is the serializer's for the HTML path and must not happen
// on this one.
import type { IBufferLine } from '@xterm/xterm'

/** A cell colour as xterm reports it: mode 0 default, 1 palette index,
 *  2 packed 0xRRGGBB. Null is "the terminal's default colour", which is SGR
 *  39/49 rather than any particular value. */
export interface SGRColor {
  mode: 1 | 2
  color: number
}

export interface SGRAttrs {
  fg: SGRColor | null
  bg: SGRColor | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  blink: boolean
  inverse: boolean
  strikethrough: boolean
  overline: boolean
}

export function emptySGR(): SGRAttrs {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    blink: false,
    inverse: false,
    strikethrough: false,
    overline: false,
  }
}

// xterm's colour-mode flags, normalized the way serializer.ts's
// normalizeColorMode does (nocx-07o7 — the packing is R in bits 16-23).
const CM_MASK = 0x03000000
const CM_P16 = 0x01000000
const CM_P256 = 0x02000000
const CM_RGB = 0x03000000

function colorOf(color: number, rawMode: number): SGRColor | null {
  switch (rawMode & CM_MASK) {
    case CM_P16:
    case CM_P256:
      return { mode: 1, color }
    case CM_RGB:
      return { mode: 2, color }
    default:
      return null
  }
}

/** The raw SGR attributes of one cell. */
export function cellSGRAttrs(line: IBufferLine, cellIdx: number): SGRAttrs {
  const cell = line.getCell(cellIdx)
  if (!cell) return emptySGR()
  return {
    fg: colorOf(cell.getFgColor(), cell.getFgColorMode()),
    bg: colorOf(cell.getBgColor(), cell.getBgColorMode()),
    bold: cell.isBold() !== 0,
    dim: cell.isDim() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    blink: cell.isBlink() !== 0,
    inverse: cell.isInverse() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
    overline: cell.isOverline() !== 0,
  }
}

export function sgrEqual(a: SGRAttrs, b: SGRAttrs): boolean {
  return (
    a.fg?.mode === b.fg?.mode &&
    a.fg?.color === b.fg?.color &&
    a.bg?.mode === b.bg?.mode &&
    a.bg?.color === b.bg?.color &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.blink === b.blink &&
    a.inverse === b.inverse &&
    a.strikethrough === b.strikethrough &&
    a.overline === b.overline
  )
}

const OFF: Array<[keyof SGRAttrs, number]> = [
  ['bold', 1],
  ['dim', 2],
  ['italic', 3],
  ['underline', 4],
  ['blink', 5],
  ['inverse', 7],
  ['strikethrough', 9],
  ['overline', 53],
]

function colorParams(c: SGRColor | null, base: 30 | 40): string[] {
  const ext = base === 30 ? 38 : 48
  const dflt = base === 30 ? 39 : 49
  if (c === null) return [String(dflt)]
  if (c.mode === 2) {
    const r = (c.color >> 16) & 0xff
    const g = (c.color >> 8) & 0xff
    const b = c.color & 0xff
    return [`${ext};2;${r};${g};${b}`]
  }
  // The eight standard colours and their bright twins have short forms; the
  // rest go through the 256-colour form. Both are the same palette — the
  // short form is what a reader expects to see for `\x1b[31m` red.
  if (c.color < 8) return [String(base + c.color)]
  if (c.color < 16) return [String(base + 60 + (c.color - 8))]
  return [`${ext};5;${c.color}`]
}

/**
 * The sequence that turns `prev` into `next`, or '' when they are the same.
 *
 * RESET-AND-REOPEN when an attribute goes off: SGR has an "off" code for
 * every attribute, but using them means emitting up to eight codes to undo a
 * run, and a reader that meets an unknown one is left in a state we did not
 * intend. `\x1b[0m` followed by what is still on is shorter in the common
 * case and has exactly one interpretation.
 */
export function sgrParams(prev: SGRAttrs, next: SGRAttrs): string {
  if (sgrEqual(prev, next)) return ''
  const turnedOff = OFF.some(([k]) => prev[k] === true && next[k] === false)
  const params: string[] = []
  if (turnedOff) {
    params.push('0')
    for (const [k, code] of OFF) if (next[k] === true) params.push(String(code))
    if (next.fg !== null) params.push(...colorParams(next.fg, 30))
    if (next.bg !== null) params.push(...colorParams(next.bg, 40))
  } else {
    for (const [k, code] of OFF)
      if (prev[k] === false && next[k] === true) params.push(String(code))
    if (prev.fg?.mode !== next.fg?.mode || prev.fg?.color !== next.fg?.color) {
      params.push(...colorParams(next.fg, 30))
    }
    if (prev.bg?.mode !== next.bg?.mode || prev.bg?.color !== next.bg?.color) {
      params.push(...colorParams(next.bg, 40))
    }
  }
  if (params.length === 0) return ''
  return `\x1b[${params.join(';')}m`
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd frontend && npx vitest run src/scrollback/sgr.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing test for the two new range emissions**

```ts
// append to frontend/src/scrollback/serializer.test.ts
import { serializeRangeSGR, serializeRangeText } from './serializer'

describe('serializeRange emissions agree', () => {
  it('gives the same rows as HTML, without markup and with SGR', () => {
    // makeLine is the file's existing helper: cells with attributes.
    const lines = [makeLine('ok', { fg: 1 }), makeLine('done', {})]
    const getLine = (y: number) => lines[y]

    expect(serializeRangeText(getLine, 0, 1)).toBe('ok\ndone')
    const sgr = serializeRangeSGR(getLine, 0, 1)
    expect(sgr).toContain('\x1b[31mok')
    // eslint-disable-next-line no-control-regex
    expect(sgr.replace(/\x1b\[[0-9;]*m/g, '')).toBe(serializeRangeText(getLine, 0, 1))
  })

  it('trims and joins identically in all three modes', () => {
    const lines = [makeLine('', {}), makeLine('a', {}), wrapped('b'), makeLine('', {})]
    const getLine = (y: number) => lines[y]
    const rows = (s: string) => (s === '' ? 0 : s.split('\n').length)
    expect(rows(serializeRangeText(getLine, 0, 3))).toBe(1)
    expect(rows(serializeRangeSGR(getLine, 0, 3))).toBe(1)
    expect(serializeRange(DEFAULT_SNAPSHOT, getLine, 0, 3).split('\n').length).toBe(1)
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `cd frontend && npx vitest run src/scrollback/serializer.test.ts`
Expected: FAIL — `serializeRangeSGR is not exported`.

- [ ] **Step 7: Extract the walk and add the two emissions**

In `serializer.ts`, replace the body of `serializeRange` with a call to a shared walk, and add the two new entry points. The walk keeps every comment that explains the leading and trailing trims — they are the record of two measured defects and must not be lost in the move.

```ts
/** How one row becomes a string. `continuation` says the row is the tail of
 *  a wrapped logical line, which is what lets the walk join without the
 *  emitter knowing anything about wrapping. */
type RowEmitter = (line: IBufferLine, continuation: boolean, nextWrapped: boolean) => string

/** THE one walk: wrapped rows joined, leading and trailing empties trimmed.
 *  Three emitters differ in what a row becomes and in nothing else. */
function walkRange(
  getLine: (y: number) => IBufferLine | undefined,
  startLine: number,
  endLine: number,
  emit: RowEmitter,
): string[] {
  const groups: string[] = []
  for (let y = startLine; y <= endLine; y++) {
    const line = getLine(y)
    const continuation = line?.isWrapped === true && groups.length > 0
    if (!line) {
      groups.push('')
      continue
    }
    const content = emit(line, continuation, getLine(y + 1)?.isWrapped ?? false)
    if (continuation) groups[groups.length - 1] += content
    else groups.push(content)
  }
  while (groups.length > 0 && groups[groups.length - 1] === '') groups.pop()
  let lead = 0
  while (lead < groups.length && groups[lead] === '') lead++
  groups.splice(0, lead)
  return groups
}

export function serializeRange(
  snapshot: TerminalSnapshot,
  getLine: (y: number) => IBufferLine | undefined,
  startLine: number,
  endLine: number,
): string {
  const groups = walkRange(getLine, startLine, endLine, (line, continuation, nextWrapped) => {
    const runs = collectRuns(snapshot, line, continuation || nextWrapped)
    let content = ''
    for (const run of runs) {
      if (run.chars.length === 0) continue
      const style = attrsToStyle(snapshot, run.attrs)
      content += style ? `<span style="${style}">${run.chars}</span>` : run.chars
    }
    return content
  })
  return groups.join('\n') // keep whatever the current tail of serializeRange does here
}

/** The durable body: the same rows with SGR attributes and no markup. */
export function serializeRangeSGR(
  getLine: (y: number) => IBufferLine | undefined,
  startLine: number,
  endLine: number,
): string {
  const groups = walkRange(getLine, startLine, endLine, (line, continuation, nextWrapped) => {
    let out = ''
    let current = emptySGR()
    const width = trimmedWidth(line, continuation || nextWrapped)
    for (let i = 0; i < width; i++) {
      const attrs = cellSGRAttrs(line, i)
      out += sgrParams(current, attrs)
      current = attrs
      out += line.getCell(i)?.getChars() || ' '
    }
    if (!sgrEqual(current, emptySGR())) out += '\x1b[0m'
    return out
  })
  return groups.join('\n')
}

/** The derived body: the same rows as characters. */
export function serializeRangeText(
  getLine: (y: number) => IBufferLine | undefined,
  startLine: number,
  endLine: number,
): string {
  const groups = walkRange(getLine, startLine, endLine, (line, continuation, nextWrapped) => {
    const width = trimmedWidth(line, continuation || nextWrapped)
    let out = ''
    for (let i = 0; i < width; i++) out += line.getCell(i)?.getChars() || ' '
    return out
  })
  return groups.join('\n')
}
```

`serializer.ts` gains `import { cellSGRAttrs, sgrParams, sgrEqual, emptySGR } from './sgr'`.

`trimmedWidth` is the right-trim rule `collectRuns` already applies (trailing blank cells are dropped unless the row wraps). Extract it from `collectRuns` and call it from all three so the three modes cannot disagree about where a row ends.

- [ ] **Step 8: Run the serializer tests**

Run: `cd frontend && npx vitest run src/scrollback/serializer.test.ts src/scrollback/sgr.test.ts`
Expected: PASS, including every pre-existing `serializeRange` test — the HTML path must be byte-identical after the extraction.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/scrollback/serializer.ts frontend/src/scrollback/sgr.ts \
        frontend/src/scrollback/sgr.test.ts frontend/src/scrollback/serializer.test.ts
git commit
```

Subject: `feat(frontend): the block's rows are emitted three ways from one walk (nocx-2f0f.1)`

---

### Task 2: The store captures a body — one transaction, idempotent on (artifact, seq)

**Files:**

- Modify: `internal/content/ledger.go`, `internal/content/ledger_sqlite.go`, `internal/content/stub.go`
- Modify: `internal/capability/agent.go`, `internal/transport/ws_agent.go` (the `AppendChunk` signature)
- Test: `internal/content/ledger_capture_test.go` (create)

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:
  - `content.CaptureOutput` struct and `LedgerRepository.CaptureOutput(ctx, in CaptureOutput) error`
  - `LedgerRepository.AppendChunk(ctx context.Context, artifactID string, seq int, body []byte) error`

**Why `AppendChunk` gains a seq rather than a second method.** Today it reads `MAX(seq)+1` and inserts, which is not idempotent: a retried delta appends twice and the artifact grows a duplicate. The agent's own handler already has the sequence number — it puts it on every `agent.runDelta` notification — so passing it makes the existing caller idempotent as well. A second append method would be two owners of one table.

**Acceptance criteria:**

- `CaptureOutput` with a fresh artifact id writes one `artifacts` row against the entry's execution and one `artifact_chunks` row at the given seq; `byte_len` equals the chunk's length.
- The **same** call again writes nothing and returns nil — `byte_len` is unchanged and there is still one chunk.
- The same artifact id with a different media type is `ErrIDConflict` and nothing changes.
- An entry id no row carries is `ErrNoSuchEntry`; nothing is written.
- With `history.outputEnabled` off, the call succeeds and no artifact appears — the same shape `RecordCompleted` uses for `history.enabled`.
- An entry whose `sensitivity` is `sensitive` stores no body, by the same succeeds-and-stores-nothing shape. Nothing sets that column today (`RecordCompleted` defaults every entry to `normal`), so the check is correct and currently unreachable — it is written now because the alternative is remembering to write it on the day sensitivity becomes settable.
- Chunks arriving out of order (seq 2 then seq 1) both land, and `Artifact` returns their bodies in seq order.

- [ ] **Step 1: Write the failing test**

```go
// internal/content/ledger_capture_test.go
func TestCaptureOutput_IsIdempotentOnArtifactAndSeq(t *testing.T) {
	db, _ := openTestContent(t) // the file's existing helper
	entryID := recordOneCommand(t, db)

	in := content.CaptureOutput{
		EntryID: entryID, ArtifactID: "0192f0aa-0000-7000-8000-000000000001",
		MediaType: content.MediaVT, CaptureMethod: content.CaptureTerminalCells,
		CaptureVersion: 1, Seq: 1, Body: []byte("\x1b[31mred\x1b[0m"),
	}
	if err := db.Ledger().CaptureOutput(t.Context(), in); err != nil {
		t.Fatalf("first capture: %v", err)
	}
	if err := db.Ledger().CaptureOutput(t.Context(), in); err != nil {
		t.Fatalf("replayed capture: %v", err)
	}

	art, err := db.Ledger().Artifact(t.Context(), in.ArtifactID)
	if err != nil || art == nil {
		t.Fatalf("artifact: %v", err)
	}
	if len(art.Chunks) != 1 {
		t.Fatalf("chunks = %d, want 1 — a replay must write nothing", len(art.Chunks))
	}
	if art.ByteLen != int64(len(in.Body)) {
		t.Fatalf("byte_len = %d, want %d", art.ByteLen, len(in.Body))
	}
}

func TestCaptureOutput_RefusesTheSameIDForDifferentContent(t *testing.T) { /* ErrIDConflict */ }
func TestCaptureOutput_UnknownEntry(t *testing.T)                       { /* ErrNoSuchEntry */ }
func TestCaptureOutput_OutputDisabledStoresNothing(t *testing.T)         { /* policy off */ }
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./internal/content/ -run TestCaptureOutput -race`
Expected: FAIL — `db.Ledger().CaptureOutput undefined`.

- [ ] **Step 3: Add the type and the interface method**

```go
// internal/content/ledger.go, beside AppendArtifact

// CaptureOutput is one body of a frozen block arriving from the renderer
// (design §4). It is the ONLY write path for a shell block's output, and it
// is deliberately not AppendArtifact + AppendChunk at the caller: the two
// have to land in one transaction, and the execution the artifact hangs on
// is resolved here rather than by a caller that does not have it.
//
// EVERY ID IS UNTRUSTED. The artifact id is client-minted, so a capture
// whose ack was lost is retried: the same id with the same shape is a
// replay and writes nothing, and the same id asking for something else is
// ErrIDConflict.
type CaptureOutput struct {
	EntryID     string
	ArtifactID  string
	MediaType   MediaType
	DerivedFrom *string
	Truncated   *Truncation

	CaptureMethod  CaptureMethod
	CaptureVersion int
	TerminalCols   *int
	TerminalRows   *int

	// Seq is the chunk's position, minted by the caller so a retry is a
	// no-op. It starts at 1, like AppendChunk's own numbering.
	Seq  int
	Body []byte
}
```

Add to `LedgerRepository`:

```go
	// CaptureOutput records one body of a frozen block against the entry's
	// execution, artifact and chunk in one transaction. Idempotent on
	// (artifact id, seq). Output retention off is not an error: the call
	// succeeds and nothing is stored, the shape RecordCompleted uses for
	// history.enabled.
	CaptureOutput(ctx context.Context, in CaptureOutput) error
```

and change `AppendChunk` to `AppendChunk(ctx context.Context, artifactID string, seq int, body []byte) error`.

- [ ] **Step 4: Implement it**

```go
// internal/content/ledger_sqlite.go

func (s *sqliteContent) CaptureOutput(ctx context.Context, in CaptureOutput) error {
	if in.ArtifactID == "" || in.EntryID == "" {
		return errors.New("content: capture: entry id and artifact id are required")
	}
	if in.Seq < 1 {
		return errors.New("content: capture: seq starts at 1")
	}
	// Output retention off: the block still has its row, it simply keeps no
	// body. Decided before the transaction, so nothing is written for a
	// capture nobody wants.
	if !s.policy.OutputEnabled() {
		return nil
	}
	return s.run(ctx, func(ctx context.Context) error {
		tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()

		var execID int64
		var mediaOfExisting sql.NullString
		if err := tx.QueryRowContext(ctx,
			`SELECT id FROM executions WHERE entry_id = ? ORDER BY attempt DESC LIMIT 1`,
			in.EntryID).Scan(&execID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNoSuchEntry
			}
			return err
		}
		if err := tx.QueryRowContext(ctx,
			`SELECT media_type FROM artifacts WHERE id = ?`, in.ArtifactID).Scan(&mediaOfExisting); err != nil &&
			!errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if mediaOfExisting.Valid && mediaOfExisting.String != string(in.MediaType) {
			return ErrIDConflict
		}
		if !mediaOfExisting.Valid {
			if err := insertArtifact(ctx, tx, execID, in); err != nil {
				return err
			}
		}
		// The chunk is the idempotency point: (artifact_id, seq) is the key,
		// so a replay inserts nothing and byte_len is only moved when a row
		// actually appeared.
		res, err := tx.ExecContext(ctx,
			`INSERT INTO artifact_chunks (artifact_id, seq, body) VALUES (?, ?, ?)
			 ON CONFLICT (artifact_id, seq) DO NOTHING`,
			in.ArtifactID, in.Seq, in.Body)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 1 {
			if _, err := tx.ExecContext(ctx,
				`UPDATE artifacts SET byte_len = byte_len + ? WHERE id = ?`,
				len(in.Body), in.ArtifactID); err != nil {
				return err
			}
		}
		return tx.Commit()
	})
}
```

`insertArtifact` is the `INSERT INTO artifacts (...)` statement lifted out of `AppendArtifact` so both callers use one statement. Rewrite `AppendArtifact` and `AppendChunk` in terms of the same two helpers — the point of the task is one implementation of each write, not three.

`AppendChunk` becomes the seq-taking, conflict-ignoring form:

```go
func (s *sqliteContent) AppendChunk(ctx context.Context, artifactID string, seq int, body []byte) error {
	return s.run(ctx, func(ctx context.Context) error {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()
		if err := appendChunkTx(ctx, tx, artifactID, seq, body); err != nil {
			return err
		}
		return tx.Commit()
	})
}
```

- [ ] **Step 5: Update the agent caller, which already has its seq**

```go
// internal/capability/agent.go
func (s *agentService) AppendRunDelta(ctx context.Context, artifactID string, seq int, body []byte) error {
	if err := s.guard.check(); err != nil {
		return err
	}
	return s.ledger.AppendChunk(ctx, artifactID, seq, body)
}
```

```go
// internal/transport/ws_agent.go, inside the Ask callback — `seq` already exists
			return svc.AppendRunDelta(ctx, rc.artifactID, seq+1, []byte(text))
```

The `+1` is because chunk numbering starts at 1 and the notification's `seq` starts at 0. Do not renumber the notification: the renderer routes on it.

- [ ] **Step 6: Add the stub twin**

```go
// internal/content/stub.go
func (s *ledgerStub) CaptureOutput(_ context.Context, in CaptureOutput) error {
	s.log.Info("content stub: LedgerRepository.CaptureOutput", "artifact", in.ArtifactID, "bytes", len(in.Body))
	return nil
}
```

- [ ] **Step 7: Run the tests**

Run: `go test ./internal/content/ ./internal/capability/ ./internal/transport/ -race`
Expected: PASS.

- [ ] **Step 8: Commit**

Subject: `feat(content): a frozen block's body is captured in one transaction (nocx-2f0f.2)`

---

### Task 3: `ledger.capture` on the wire

**Files:**

- Create: `internal/transport/ws_ledger_capture.go`, `contracts/ledger.capture.schema.json`
- Modify: `internal/capability/ledger.go`, `internal/transport/ws_ledger.go` (registration)
- Generated: `frontend/src/generated/ledger.capture.ts` (`npm run contracts:generate`)
- Test: `internal/transport/ws_ledger_capture_test.go`

**Interfaces:**

- Consumes: `content.CaptureOutput` and `LedgerRepository.CaptureOutput` from Task 2.
- Produces: the JSON-RPC method `ledger.capture` with params
  `{entryId, artifactId, mediaType, derivedFrom?, truncated?, captureVersion, terminalCols, terminalRows, seq, body}`
  and result `{artifactId: string, stored: boolean}`.

**Acceptance criteria:**

- A capture for a known entry returns `stored: true`; the same call again returns `stored: true` and the store holds one chunk.
- `body` above 64 KiB is `-32602`; an artifact whose total would exceed 1 MiB is `-32602`. Both refusals name the ceiling.
- `mediaType` outside `{application/vt, text/plain}` is `-32602`.
- An id that is not a UUIDv7 is `-32602` — the same validation the layout methods apply to a client-minted id.
- With the content store unwired the method answers `-32601`, like every other `ledger.*` read.
- `TestLedgerCapture_OverTheWireConformsToContract` validates the **real** result off the socket against the schema.

- [ ] **Step 1: Write the failing over-the-wire test**

```go
func TestLedgerCapture_OverTheWireConformsToContract(t *testing.T) {
	h := newWSHarness(t)                    // the file's existing harness
	entryID := h.recordOneCommand(t)
	raw := h.call(t, "ledger.capture", map[string]any{
		"entryId": entryID, "artifactId": uuidv7(t), "mediaType": "application/vt",
		"captureVersion": 1, "terminalCols": 80, "terminalRows": 24,
		"seq": 1, "body": "\x1b[31mred\x1b[0m",
	})
	validateAgainstContract(t, "ledger.capture.schema.json", raw)
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./internal/transport/ -run TestLedgerCapture -race`
Expected: FAIL — method not found.

- [ ] **Step 3: Write the schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://nocx.local/contracts/ledger.capture.schema.json",
  "title": "LedgerCapture",
  "description": "Result of the ledger.capture JSON-RPC method (nocx-2f0f) — the acknowledgement that one body of a frozen block was accepted. A capture is idempotent on (artifactId, seq): a retry after a lost ack returns the same answer and writes nothing.",
  "type": "object",
  "additionalProperties": false,
  "required": ["artifactId", "stored"],
  "properties": {
    "artifactId": {
      "description": "The artifact the chunk landed in — the id the caller minted, echoed back.",
      "type": "string"
    },
    "stored": {
      "description": "Whether the body is retained. False is not a failure: output retention is off, and the entry keeps its row without a body.",
      "type": "boolean"
    }
  }
}
```

- [ ] **Step 4: Write the handler**

Follow `ws_ledger_query.go`'s shape exactly: a params struct with no schema of its own (the handler is the check), a `validateLedgerCaptureRaw` for the registration's `params(...)` guard, and a handler holding the `capability.LedgerOperation` and the `Responder`. Ceilings:

```go
const maxCaptureChunkBytes = 64 << 10
const maxCaptureArtifactBytes = 1 << 20
```

- [ ] **Step 5: Register it**

In `ws_ledger.go`, beside `ledger.query`:

```go
		reg(contentSub, "ledger.capture", params(validateLedgerCaptureRaw), func(w *wsConn, state *connState, r Responder) handlerFunc {
			return ledgerCaptureHandlers{op: op, r: r}.handle
		})
```

- [ ] **Step 6: Generate the renderer type and run the checks**

Run: `npm run contracts:generate && npm run contracts:check`
Expected: `frontend/src/generated/ledger.capture.ts` appears and the check passes.

- [ ] **Step 7: Run the tests**

Run: `go test ./internal/transport/ -run TestLedgerCapture -race`
Expected: PASS.

- [ ] **Step 8: Commit**

Subject: `feat(transport): ledger.capture takes a frozen block's body (nocx-2f0f.3)`

---

### Task 4: The renderer captures at freeze

**Files:**

- Create: `frontend/src/capture-client.ts`
- Modify: `frontend/src/scrollback/blocks.ts` (the freeze site), `frontend/src/terminal-content.ts` (the ack site)
- Test: `frontend/src/capture-client.test.ts`, `frontend/src/scrollback/blocks.test.ts`

**Interfaces:**

- Consumes: `serializeRangeSGR`, `serializeRangeText` (Task 1); the `ledger.capture` method (Task 3).
- Produces:
  - `BlockRecord.captured?: CapturedBody` — `{sgr: string; text: string; cols: number; rows: number; truncated: 'cap' | null}`
  - `captureBlock(client: WSClient, entryId: string, body: CapturedBody): Promise<void>`

**Why the bodies are parked on the record rather than sent at freeze.** The artifact hangs on an entry, and the entry id arrives with the `history.record` ack, which is a different event that may land before or after the visual freeze. `attachRecordedAck` already solves exactly this ordering with `afterVisualFreeze`, and this rides that mechanism instead of inventing a second one.

**Acceptance criteria:**

- Freezing a block sets `rec.captured` with the SGR body, the plain body and the terminal dimensions the serializer saw.
- When the record ack carries an `entryId`, two `ledger.capture` calls go out — `application/vt` first, then `text/plain` with `derivedFrom` set to the first artifact's id.
- A body above the cap keeps the first 128 KiB and the last 128 KiB, drops the middle, and both calls carry `truncated: 'cap'`.
- A body above 64 KiB is sent as several calls with increasing `seq`, and their bodies concatenate to the whole.
- A failing call is logged and lost, and nothing about the block changes: capture never blocks the terminal, and a failed capture is never a terminal error.
- An ack with no `entryId` (history off) sends nothing.

- [ ] **Step 1: Write the failing test for the cap and the chunking**

```ts
// frontend/src/capture-client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { captureBlock, capBody, CHUNK_BYTES } from './capture-client'

describe('capBody', () => {
  it('keeps the head and the tail and says the middle went', () => {
    const body = 'H'.repeat(200_000) + 'M'.repeat(500_000) + 'T'.repeat(200_000)
    const { text, truncated } = capBody(body)
    expect(truncated).toBe('cap')
    expect(text.startsWith('H')).toBe(true)
    expect(text.endsWith('T')).toBe(true)
    expect(text).not.toContain('M')
  })

  it('leaves a body under the cap alone', () => {
    expect(capBody('small').truncated).toBe(null)
  })
})

describe('captureBlock', () => {
  it('sends the vt body first and derives the text body from it', async () => {
    const call = vi.fn().mockResolvedValue({ artifactId: 'a', stored: true })
    await captureBlock({ call } as never, 'entry-1', {
      sgr: '\x1b[31mred\x1b[0m',
      text: 'red',
      cols: 80,
      rows: 24,
      truncated: null,
    })
    const kinds = call.mock.calls.map((c) => c[1].mediaType)
    expect(kinds).toEqual(['application/vt', 'text/plain'])
    expect(call.mock.calls[1][1].derivedFrom).toBe(call.mock.calls[0][1].artifactId)
  })

  it('splits a body larger than one chunk and numbers the parts from one', async () => {
    const call = vi.fn().mockResolvedValue({ artifactId: 'a', stored: true })
    const big = 'x'.repeat(CHUNK_BYTES + 10)
    await captureBlock({ call } as never, 'entry-1', {
      sgr: big,
      text: big,
      cols: 80,
      rows: 24,
      truncated: null,
    })
    const vt = call.mock.calls.filter((c) => c[1].mediaType === 'application/vt')
    expect(vt.map((c) => c[1].seq)).toEqual([1, 2])
    expect(vt.map((c) => c[1].body).join('')).toBe(big)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && npx vitest run src/capture-client.test.ts`
Expected: FAIL — cannot resolve `./capture-client`.

- [ ] **Step 3: Write `capture-client.ts`**

```ts
// frontend/src/capture-client.ts
//
// The capture half of "a block keeps what it printed" (design §4). Two
// artifacts per block: the SGR body, which is what a restore draws, and the
// plain body derived from it, which is what search and copy read.
//
// BEST-EFFORT, ALWAYS. A capture that fails costs the block's body and
// nothing else — never the entry, never the block on screen, never an error
// in front of the person. That is the same contract recordCommand has, for
// the same reason: the command already ran.
import type { WSClient } from './ipc'
import type { LedgerCapture } from './generated/ledger.capture'
import { uuidv7 } from './layout/uuid7'
import { SERIALIZER_VERSION } from './scrollback/serializer'
import { log } from './log'

/** The transport's own ceiling, matched here so a body is split before it is
 *  refused rather than after. */
export const CHUNK_BYTES = 64 * 1024
/** Head and tail kept per body. The middle of a very long output is progress
 *  bars; the invocation is at the top and the error at the bottom. */
export const CAP_HEAD_BYTES = 128 * 1024
export const CAP_TAIL_BYTES = 128 * 1024

export interface CapturedBody {
  sgr: string
  text: string
  cols: number
  rows: number
  truncated: 'cap' | null
}

export function capBody(text: string): { text: string; truncated: 'cap' | null } {
  if (text.length <= CAP_HEAD_BYTES + CAP_TAIL_BYTES) return { text, truncated: null }
  return {
    text: text.slice(0, CAP_HEAD_BYTES) + text.slice(text.length - CAP_TAIL_BYTES),
    truncated: 'cap',
  }
}

async function sendArtifact(
  client: WSClient,
  entryId: string,
  mediaType: 'application/vt' | 'text/plain',
  body: string,
  truncated: 'cap' | null,
  cols: number,
  rows: number,
  derivedFrom: string | null,
): Promise<string> {
  const artifactId = uuidv7()
  for (let offset = 0, seq = 1; offset < body.length || seq === 1; offset += CHUNK_BYTES, seq++) {
    await client.call<LedgerCapture>('ledger.capture', {
      entryId,
      artifactId,
      mediaType,
      derivedFrom,
      truncated,
      captureVersion: SERIALIZER_VERSION,
      terminalCols: cols,
      terminalRows: rows,
      seq,
      body: body.slice(offset, offset + CHUNK_BYTES),
    })
  }
  return artifactId
}

/** Send one frozen block's bodies. The vt artifact goes first because the
 *  text one names it in derivedFrom, and a derived body pointing at nothing
 *  is a body whose provenance was lost. */
export async function captureBlock(
  client: WSClient,
  entryId: string,
  body: CapturedBody,
): Promise<void> {
  try {
    const sgr = capBody(body.sgr)
    const text = capBody(body.text)
    const vtId = await sendArtifact(
      client,
      entryId,
      'application/vt',
      sgr.text,
      sgr.truncated,
      body.cols,
      body.rows,
      null,
    )
    await sendArtifact(
      client,
      entryId,
      'text/plain',
      text.text,
      text.truncated,
      body.cols,
      body.rows,
      vtId,
    )
  } catch (err) {
    log.warn('nocx: the block body was not captured', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
```

- [ ] **Step 4: Produce the bodies at the freeze site**

In `blocks.ts`, `_freezeVisual`, beside the existing `outputHtml`:

```ts
const outputHtml = serializeRange(snapshot, getLine, rec.outputStart, endLine)
// The DURABLE bodies, from the same rows the frozen block shows. Parked
// on the record rather than sent: the artifact hangs on an entry, and the
// entry id arrives with the history.record ack, which is a different
// event (see attachRecordedAck).
rec.captured = {
  sgr: serializeRangeSGR(getLine, rec.outputStart, endLine),
  text: serializeRangeText(getLine, rec.outputStart, endLine),
  cols: this._cols,
  rows: this._rows,
  truncated: null,
}
```

Add `captured?: CapturedBody` to `BlockRecord`. `_cols`/`_rows` come from the controller's renderer — pass them in rather than reading a global.

- [ ] **Step 5: Send them when the ack lands**

In `terminal-content.ts`, in `attachRecordedAck`, after the `cmd-block-running` parking check (so the block is frozen and `captured` is filled):

```ts
// The body goes now, against the entry the ack just named. One shot: the
// record is cleared so a re-entry — the parked afterVisualFreeze path
// runs this method again — cannot send the same block twice.
if (ack.entryId && block.captured) {
  const body = block.captured
  block.captured = undefined
  void captureBlock(this.client, ack.entryId, body)
}
```

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npx vitest run src/capture-client.test.ts src/scrollback/blocks.test.ts src/terminal-content.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

Subject: `feat(frontend): a frozen block sends what it printed (nocx-2f0f.4)`

---

### Task 5: The per-entry cap is the user's, and the ceiling is the backend's

**Files:**

- Modify: `internal/settings/settings.go`, `internal/app/app.go` (the policy sync), `internal/content/policy.go`
- Modify: `frontend/src/capture-client.ts` (read the setting instead of the constant)
- Test: `internal/settings/settings_test.go`, `internal/content/policy_test.go`, `frontend/src/capture-client.test.ts`

**Interfaces:**

- Consumes: `capBody` from Task 4.
- Produces: `settings.HistoryOutputCapKB` and `content.Policy.OutputCapBytes() int`.

**Note on what already exists.** `history.enabled`, `history.retentionDays` and **`history.outputEnabled`** are already declared, already reach `content.Policy` through `policyFromSettings` and the registry notifier in `app.go`, and `history.outputEnabled` is already honoured by Task 2's `CaptureOutput`. Only the cap is new. The total-size and age knobs are **`nocx-rtg0.30`'s** — do not touch them here.

**Acceptance criteria:**

- A new number setting `history.outputCapKB` in the History section, default 256, bounds 16…4096, wired into `policyFromSettings` and the change notifier, so a change applies without a restart.
- The renderer caps at the configured value; with the setting at 16 KiB a 100 KiB body arrives capped and sealed.
- The backend refuses an artifact whose accumulated `byte_len` would exceed 1 MiB regardless of the setting — the setting is the user's preference, the ceiling is input validation, and a renderer is not trusted to respect either.

- [ ] **Step 1: Write the failing settings test**

```go
func TestHistoryOutputCap_IsBoundedAndDefaultsTo256(t *testing.T) {
	reg := settings.NewRegistry(...)
	v, err := reg.GetNumber(settings.HistoryOutputCapKB)
	if err != nil || v != 256 {
		t.Fatalf("default = %v, %v; want 256", v, err)
	}
	if err := reg.SetNumber(settings.HistoryOutputCapKB, 8); err == nil {
		t.Fatal("8 KiB is below the floor and must be refused")
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `go test ./internal/settings/ -run TestHistoryOutputCap -race`
Expected: FAIL — undefined `HistoryOutputCapKB`.

- [ ] **Step 3: Declare the setting**

```go
// internal/settings/settings.go, beside HistoryOutputEnabled

// HistoryOutputCapKB bounds how much of ONE command's output is kept. The
// head and the tail are kept and the middle is dropped (design §4.3): errors
// live in the tail and the invocation in the head, and a cap on bytes rather
// than on lines bounds the budget almost independently of what the user runs.
var HistoryOutputCapKB = MustRegisterNumber(NumberSpec{
	Key:         "history.outputCapKB",
	Section:     "History",
	Label:       "Keep per command, at most",
	Description: "How much of one command's output is kept, in kilobytes. Beyond this the beginning and the end are kept and the middle is dropped, and the block says so.",
	DataClass:   PublicConfig,
	Default:     256,
	Min:         fp(16),
	Max:         fp(4096),
})
```

- [ ] **Step 4: Wire it to the policy**

Add `OutputCapBytes` to `content.Policy` with the same mutex shape `SetOutputEnabled` has, set it in `policyFromSettings`, and add the key to the notifier's `switch` in `app.go:711`.

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/settings/ ./internal/content/ ./internal/app/ -race`
Expected: PASS.

- [ ] **Step 6: Commit**

Subject: `feat(settings): the per-command output cap is the user's (nocx-2f0f.5)`

---

### Task 6: The epic's happy path — the output of a past command is still readable

**Files:**

- Create: `internal/transport/ws_capture_roundtrip_test.go` (or extend the devharness suite)
- Test: the real backend, the real socket, a restart of the store

**Interfaces:** consumes everything above.

**Why this task exists.** `deadcode` cannot report that a feature is wired, and every unit above passes with a write path nobody calls — that is exactly how `nocx-rtg0` shipped a store with no writer. This is the check that watches the feature happen.

**Acceptance criteria:**

- Through the real socket: record a command, capture its body, **close and reopen the content store**, and read the body back through `ledger.get` + the artifact fetch. The bytes match what was sent.
- Entry A's artifact contains A's body and none of B's, asserted by capturing two blocks back to back.
- With `history.outputEnabled` off, the same round trip stores the entry and no artifact, and the capture ack says `stored: false`.
- A command run in the alternate buffer produces no artifact — asserted in the renderer's suite by freezing a block whose range is empty — and `grep -n 'alt' frontend/src/capture-client.ts frontend/src/scrollback/sgr.ts` finds nothing: the exclusion is by construction, and a classifier appearing in the capture path is the defect.
- `deadcode -tags gtk3 -whylive 'github.com/shady2k/nocx/internal/content.sqliteContent.CaptureOutput' ./...` prints a path from `main()` — pasted into the bead as evidence, with the contrast run against a method that is not wired.

- [ ] **Step 1: Write the round-trip test**

```go
func TestCapturedOutputSurvivesAStoreRestart(t *testing.T) {
	dir := t.TempDir()
	h := newWSHarnessAt(t, dir)
	entryID := h.recordOneCommand(t)
	body := "\x1b[31mred\x1b[0m\nplain"
	h.call(t, "ledger.capture", map[string]any{ /* … as Task 3 … */ })
	h.Close()

	again := newWSHarnessAt(t, dir)   // same directory: a real reopen
	entry := again.call(t, "ledger.get", map[string]any{"id": entryID})
	// … fetch the vt artifact and compare its joined chunks to body …
}
```

- [ ] **Step 2: Run it and watch it fail, then pass**

Run: `go test ./internal/transport/ -run TestCapturedOutput -race`

- [ ] **Step 3: Run the whole affected suite**

Run: `go test ./internal/content/ ./internal/capability/ ./internal/transport/ -race && cd frontend && npx vitest run`

- [ ] **Step 4: Commit and close the epic's beads**

Subject: `test(content): the output of a past command survives a restart (nocx-2f0f.6)`

---

## Deliberate cuts, surfaced rather than dropped

1. **Leading-space suppression is not implemented here.** The spec's §4.3 table lists it, and `frontend/src/editor.ts:31` names the rule, but nothing in the recording path honours it today: a command typed with a leading space is recorded like any other. Suppressing only its _output_ would be half a rule and would read as a bug from either side. A standalone bug bead is filed for the recording path, and capture will inherit the answer.
2. **`sensitivity='sensitive'` is honoured but never set.** `CaptureOutput` refuses a body for a sensitive entry, and `RecordCompleted` defaults every entry to `normal`, so the check is correct and currently unreachable. Whoever makes sensitivity settable gets it for free.
3. **Pinning an artifact against eviction** (`artifacts.pinned`) has no product affordance in this plan. The column and the eviction exemption exist; the button is not this epic's.

package assistant

// The block tools' tests (nocx-5u3oz.6): the pair that lists the blocks a
// run was granted and reads a WINDOW of one. The narrowing (a session, and
// therefore a block, the grant does not name is refused BEFORE anything is
// read), the window contract of the return (design §4.4 — the model learns
// the total before it reads, and a window past the end is answered honestly
// rather than as an error), and the end-to-end: several hundred lines of
// output, a question about the END of it, answered.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/shady2k/nocx/internal/agenttools"
	"github.com/shady2k/nocx/internal/content"
)

// fakeBlocks is the block seam with a call log and a scripted answer: the
// tests assert what the tool ASKED for — "asserted by trying, not by
// inspecting" — and can fail exactly the read the invariant names.
type fakeBlocks struct {
	mu     sync.Mutex
	listed []listedBlocks
	read   []readBlock
	list   BlockList
	window BlockWindow
	err    error
}

type listedBlocks struct {
	sessionID string
	limit     int
}

type readBlock struct {
	sessionID string
	blockID   string
	start     int
	count     int
}

func (f *fakeBlocks) ListBlocks(_ context.Context, sessionID string, limit int) (BlockList, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listed = append(f.listed, listedBlocks{sessionID: sessionID, limit: limit})
	if f.err != nil {
		return BlockList{}, f.err
	}
	return f.list, nil
}

func (f *fakeBlocks) ReadBlock(_ context.Context, sessionID, blockID string, start, count int) (BlockWindow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.read = append(f.read, readBlock{sessionID: sessionID, blockID: blockID, start: start, count: count})
	if f.err != nil {
		return BlockWindow{}, f.err
	}
	// The window the source returns is the honest clamp of what was asked:
	// the real one does this against the stored body, and this one does it
	// against the scripted text so the executor's own arithmetic is not the
	// thing under test twice.
	lines := strings.Split(f.window.Text, "\n")
	total := len(lines)
	if f.window.Total > 0 {
		total = f.window.Total
	}
	begin := start
	if begin > total {
		begin = total
	}
	end := begin + count
	if end > total {
		end = total
	}
	out := f.window
	out.Total = total
	out.Start, out.End = begin, end
	out.Text = strings.Join(lines[begin:end], "\n")
	return out, nil
}

func (f *fakeBlocks) listCalls() []listedBlocks {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]listedBlocks(nil), f.listed...)
}

func (f *fakeBlocks) readCalls() []readBlock {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]readBlock(nil), f.read...)
}

// unscriptedBlocks satisfies the block half of the run's seam for the fakes
// whose tests are about the renderer half: a call is a test defect, so it
// says so rather than answering an empty list that would read as "this
// session has no blocks".
type unscriptedBlocks struct{}

func (unscriptedBlocks) ListBlocks(context.Context, string, int) (BlockList, error) {
	return BlockList{}, errors.New("test seam: ListBlocks is not scripted")
}

func (unscriptedBlocks) ReadBlock(context.Context, string, string, int, int) (BlockWindow, error) {
	return BlockWindow{}, errors.New("test seam: ReadBlock is not scripted")
}

// blockReaderFor is the narrowed capability for one granted session.
func blockReaderFor(sessionID string) *agenttools.BlockReader {
	return agenttools.NewBlockReader([]content.GrantScope{{Kind: content.ResourceSession, ID: sessionID}})
}

// ── test-local helpers ───────────────────────────────────────────────────

// requestBody reads the completion request the engine sent. The fake server
// puts the body back after recording it, so the handler reads the same bytes
// the transport wrote — which is what makes an assertion about what the model
// was HANDED an assertion about the engine, not about the test.
func requestBody(r *http.Request) string {
	b, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(b))
	return string(b)
}

// streamAnswer writes one streamed answer, the way a real completion arrives.
func streamAnswer(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", chunkJSON(text, ""))
	_, _ = fmt.Fprintf(w, "data: %s\n\n", chunkJSON("", "stop"))
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
}

// totalFromListBody reads the line count out of the blocks.list result the
// engine put into the conversation — the model's own path to the total.
func totalFromListBody(t *testing.T, body string) int {
	t.Helper()
	const key = `\"lines\":`
	i := strings.Index(body, key)
	if i < 0 {
		t.Fatalf("no blocks.list result in the request the model was handed: %s", body)
	}
	rest := body[i+len(key):]
	end := 0
	for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
		end++
	}
	n, err := strconv.Atoi(rest[:end])
	if err != nil {
		t.Fatalf("line count %q: %v", rest[:end], err)
	}
	return n
}

func ptrGrant(g content.Grant) *content.Grant { return &g }

func toolsDirFS(t *testing.T) fs.FS {
	t.Helper()
	return os.DirFS(realToolsFS)
}

// ── the narrowing ────────────────────────────────────────────────────────

// A grant naming session A cannot list session B's blocks, and the refusal
// happens BEFORE the ledger is asked: the fake records that nothing was ever
// listed for B. The paired end — the granted session IS listed — is what
// keeps this from passing over a tool that refuses everything.
func TestExecuteBlocksList_SessionOutsideGrantNeverReads(t *testing.T) {
	reader := blockReaderFor("session-a")
	src := &fakeBlocks{list: BlockList{Blocks: []BlockSummary{{
		ID: "blk-1", Command: "df -h", Status: "success", Lines: 12, BodyKept: true,
	}}}}

	if _, err := executeBlocksList(context.Background(), reader, src, json.RawMessage(`{"sessionId":"session-b"}`)); err == nil {
		t.Fatal("listing a session outside the grant succeeded; want a refusal")
	} else if !strings.Contains(err.Error(), "outside the run's grant") {
		t.Errorf("refusal = %v, want it to say the session is outside the grant", err)
	}
	if calls := src.listCalls(); len(calls) != 0 {
		t.Fatalf("the ledger was asked %v for a session outside the grant; want never asked", calls)
	}

	out, err := executeBlocksList(context.Background(), reader, src, json.RawMessage(`{"sessionId":"session-a"}`))
	if err != nil {
		t.Fatalf("listing the granted session: %v", err)
	}
	if calls := src.listCalls(); len(calls) != 1 || calls[0].sessionID != "session-a" {
		t.Fatalf("listed %v, want exactly one list of session-a", calls)
	}
	if !strings.Contains(out, "blk-1") || !strings.Contains(out, "df -h") {
		t.Errorf("result %s carries neither the block id nor the command", out)
	}
}

// The same rule for the read half, and this is the criterion's own wording:
// a block the grant does not name cannot be read EVEN WHEN ITS ID IS
// GUESSED. The guess names another session, so it is refused at the
// capability and the ledger is never asked for that id.
func TestExecuteBlocksRead_GuessedIDOutsideGrantNeverReads(t *testing.T) {
	reader := blockReaderFor("session-a")
	src := &fakeBlocks{window: BlockWindow{Command: "secrets", Text: "line-1\nline-2"}}

	_, err := executeBlocksRead(context.Background(), reader, src,
		json.RawMessage(`{"sessionId":"session-b","blockId":"blk-other"}`))
	if err == nil {
		t.Fatal("reading a block of a session outside the grant succeeded; want a refusal")
	}
	if strings.Contains(err.Error(), "secrets") {
		t.Errorf("the refusal %v carries the other session's content", err)
	}
	if calls := src.readCalls(); len(calls) != 0 {
		t.Fatalf("the ledger was asked %v for a block outside the grant; want never asked", calls)
	}
}

// A block id the granted session does not hold is refused by the SOURCE —
// the scope is applied where the row is resolved, so an id from another pane
// answers exactly as an id that never existed: one sentence, no facts about
// the block.
func TestExecuteBlocksRead_UnknownBlockIsHonest(t *testing.T) {
	reader := blockReaderFor("session-a")
	src := &fakeBlocks{err: ErrBlockNotFound}

	_, err := executeBlocksRead(context.Background(), reader, src,
		json.RawMessage(`{"sessionId":"session-a","blockId":"blk-guessed"}`))
	if err == nil {
		t.Fatal("reading an unknown block succeeded; want a refusal")
	}
	if !errors.Is(err, ErrBlockNotFound) {
		t.Errorf("error = %v, want it to wrap ErrBlockNotFound", err)
	}
}

// ── the window contract ──────────────────────────────────────────────────

// The reply states the total and the window it ACTUALLY returned, and a
// window past the end of the output is answered honestly rather than as an
// error (design §4.4, the bead's second criterion).
func TestExecuteBlocksRead_WindowIsHonest(t *testing.T) {
	reader := blockReaderFor("session-a")
	lines := make([]string, 300)
	for i := range lines {
		lines[i] = fmt.Sprintf("line-%d", i)
	}
	src := &fakeBlocks{window: BlockWindow{
		Command: "make", Status: "success", Text: strings.Join(lines, "\n"), BodyKept: true,
	}}

	// A window in the middle: exactly what was asked for, and the reply says so.
	out, err := executeBlocksRead(context.Background(), reader, src,
		json.RawMessage(`{"sessionId":"session-a","blockId":"blk-1","start":10,"count":5}`))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got blocksReadResult
	if unmarshalErr := json.Unmarshal([]byte(out), &got); unmarshalErr != nil {
		t.Fatalf("result %s: %v", out, unmarshalErr)
	}
	if got.Total != 300 {
		t.Errorf("total = %d, want 300 — the model must learn the total before it reads", got.Total)
	}
	if got.Window.Start != 10 || got.Window.End != 15 {
		t.Errorf("window = %+v, want [10,15) — the window that was asked for", got.Window)
	}
	if got.Returned.Start != 10 || got.Returned.End != 15 {
		t.Errorf("returned = %+v, want [10,15)", got.Returned)
	}
	if got.Text != "line-10\nline-11\nline-12\nline-13\nline-14" {
		t.Errorf("text = %q, want lines 10..14", got.Text)
	}

	// A window PAST THE END: answered, not refused. The window asked for is
	// echoed, the window returned is the empty span at the end, and the
	// total says where the output actually stops.
	out, err = executeBlocksRead(context.Background(), reader, src,
		json.RawMessage(`{"sessionId":"session-a","blockId":"blk-1","start":900,"count":10}`))
	if err != nil {
		t.Fatalf("a window past the end must be answered, not refused: %v", err)
	}
	got = blocksReadResult{}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("result %s: %v", out, err)
	}
	if got.Total != 300 {
		t.Errorf("total = %d, want 300", got.Total)
	}
	if got.Window.Start != 900 || got.Window.End != 910 {
		t.Errorf("window = %+v, want the [900,910) that was asked for", got.Window)
	}
	if got.Returned.Start != 300 || got.Returned.End != 300 {
		t.Errorf("returned = %+v, want the empty span [300,300) at the end", got.Returned)
	}
	if got.Text != "" {
		t.Errorf("text = %q, want empty past the end", got.Text)
	}
}

// The defaults are the ones the schema states, and they reach the source:
// a read with no window asks from the start, a list with no limit asks for
// the default page.
func TestBlockTools_DefaultsReachTheSource(t *testing.T) {
	reader := blockReaderFor("session-a")
	src := &fakeBlocks{window: BlockWindow{Text: "one\ntwo"}}
	if _, err := executeBlocksRead(context.Background(), reader, src,
		json.RawMessage(`{"sessionId":"session-a","blockId":"blk-1"}`)); err != nil {
		t.Fatalf("read: %v", err)
	}
	calls := src.readCalls()
	if len(calls) != 1 || calls[0].start != 0 || calls[0].count != defaultBlockLines {
		t.Fatalf("read asked %+v, want start 0 and count %d", calls, defaultBlockLines)
	}
	if _, err := executeBlocksList(context.Background(), reader, src,
		json.RawMessage(`{"sessionId":"session-a"}`)); err != nil {
		t.Fatalf("list: %v", err)
	}
	lc := src.listCalls()
	if len(lc) != 1 || lc[0].limit != defaultBlockListLimit {
		t.Fatalf("list asked %+v, want limit %d", lc, defaultBlockListLimit)
	}
}

// A block whose body the store never kept (history off, output retention
// off, a sensitive command) is answered as a block with no body — the row is
// still listed and the read says plainly that there is nothing to read,
// rather than a silent empty string that reads as "it printed nothing".
func TestExecuteBlocksRead_NoBodyIsStated(t *testing.T) {
	reader := blockReaderFor("session-a")
	src := &fakeBlocks{window: BlockWindow{Command: "ssh prod", Status: "entered", BodyKept: false}}
	out, err := executeBlocksRead(context.Background(), reader, src,
		json.RawMessage(`{"sessionId":"session-a","blockId":"blk-1"}`))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got blocksReadResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("result %s: %v", out, err)
	}
	if got.BodyKept {
		t.Errorf("bodyKept = true, want false")
	}
	if got.Note == "" {
		t.Errorf("result %s says nothing about why there is no text", out)
	}
}

// ── the middleware ───────────────────────────────────────────────────────

// The wiring gap is honest: a run whose block seam is not wired refuses the
// tool with a sentence, never a silent empty list.
func TestMiddleware_BlocksWithoutSourceIsHonest(t *testing.T) {
	grant := sessionGrant("session-a", autonomousMatrix())
	mw := middlewareForWithRequester(t, grant, &fakeLedger{}, nil, nil)
	_, err := wrappedEndpoint(mw, "blocks.list", "call-1", `{"sessionId":"session-a"}`)
	if err == nil {
		t.Fatal("blocks.list with no block source succeeded; want an honest failure")
	}
	if !strings.Contains(err.Error(), "no block source") {
		t.Errorf("error = %v, want it to name the missing seam", err)
	}
}

// The middleware's dispatch reaches the executors, and the narrowing holds
// through it: a call naming another session is refused and the ledger is
// never asked.
func TestMiddleware_BlocksRefusedOutsideGrantTerminates(t *testing.T) {
	grant := sessionGrant("session-a", autonomousMatrix())
	src := &fakeBlocks{list: BlockList{Blocks: []BlockSummary{{ID: "blk-1", Command: "ls"}}}}
	mw := middlewareForWithRequester(t, grant, &fakeLedger{}, nil, &blocksOnlyRequester{blocks: src})

	if _, err := wrappedEndpoint(mw, "blocks.list", "call-1", `{"sessionId":"session-b"}`); err == nil {
		t.Fatal("blocks.list on another session succeeded; want a refusal")
	}
	if calls := src.listCalls(); len(calls) != 0 {
		t.Fatalf("the ledger was asked %v; want never asked", calls)
	}

	out, err := wrappedEndpoint(mw, "blocks.list", "call-2", `{"sessionId":"session-a"}`)
	if err != nil {
		t.Fatalf("blocks.list on the granted session: %v", err)
	}
	if !strings.Contains(out, "blk-1") {
		t.Errorf("result %s does not carry the block", out)
	}
}

// blocksOnlyRequester is the run's seam with the block half scripted and the
// renderer half unscripted: the block tools never ask the renderer for
// anything.
type blocksOnlyRequester struct {
	blocks BlockSource
}

func (r *blocksOnlyRequester) RequestScreen(context.Context, string, *FrameRegion) (json.RawMessage, error) {
	return nil, errors.New("blocks test: RequestScreen is not scripted")
}

func (r *blocksOnlyRequester) RequestRun(context.Context, string, string) (json.RawMessage, error) {
	return nil, errors.New("blocks test: RequestRun is not scripted")
}

func (r *blocksOnlyRequester) ListBlocks(ctx context.Context, sessionID string, limit int) (BlockList, error) {
	return r.blocks.ListBlocks(ctx, sessionID, limit)
}

func (r *blocksOnlyRequester) ReadBlock(ctx context.Context, sessionID, blockID string, start, count int) (BlockWindow, error) {
	return r.blocks.ReadBlock(ctx, sessionID, blockID, start, count)
}

// ── end to end: several hundred lines, a question about the END ──────────

// The bead's fifth criterion, driven through the REAL eino agent against the
// fake provider: a block of 400 lines, a model that lists, sees the total,
// reads the LAST window rather than the first, and answers with what is
// there. The answer is the marker that lives on line 397 and nowhere else,
// so a run that read the head of the block cannot pass this.
func TestAsk_LongOutputIsAnsweredFromTheEnd(t *testing.T) {
	const marker = "Error: disk quota exceeded on /dev/sda9"
	lines := make([]string, 400)
	for i := range lines {
		lines[i] = fmt.Sprintf("filesystem-%03d      1.0T   400G   600G  40%%", i)
	}
	lines[397] = marker

	src := &fakeBlocks{
		list: BlockList{Blocks: []BlockSummary{{
			ID: "blk-df", Command: "df -h", Status: "failure", Lines: len(lines), BodyKept: true,
		}}},
		window: BlockWindow{
			Command: "df -h", Status: "failure", Text: strings.Join(lines, "\n"), BodyKept: true,
		},
	}

	// The provider: propose blocks.list, then — having been told the total —
	// propose the window at the END, then answer with what the tool result
	// actually carried. The last step is what makes this end to end: the
	// answer is derived from the bytes the engine handed the model, not from
	// anything the test knows.
	var turn int
	f, srv := newFakeOpenAI(func(w http.ResponseWriter, r *http.Request) {
		turn++
		switch turn {
		case 1:
			streamToolCalls(w, toolCallSpec{name: "blocks.list", args: `{"sessionId":"session-a"}`, id: "call_list"})
		case 2:
			// The model read the total off the list result and aims at the end.
			total := totalFromListBody(t, requestBody(r))
			args := fmt.Sprintf(`{"sessionId":"session-a","blockId":"blk-df","start":%d,"count":20}`, total-20)
			streamToolCalls(w, toolCallSpec{name: "blocks.read", args: args, id: "call_read"})
		default:
			answer := "the output ends with something else"
			if strings.Contains(requestBody(r), marker) {
				answer = marker
			}
			streamAnswer(w, answer)
		}
	})
	defer srv.Close()

	p := askParams(srv.URL, ptrGrant(sessionGrant("session-a", autonomousMatrix())), &fakeLedger{}, nil)
	p.Requester = &blocksOnlyRequester{blocks: src}
	p.Messages = []Message{{Role: "user", Content: "did df fail, and why?"}}

	cl, err := newClient(nil, toolsDirFS(t))
	if err != nil {
		t.Fatalf("newClient: %v", err)
	}
	var answer strings.Builder
	if err := cl.Ask(context.Background(), p, func(delta string) error {
		answer.WriteString(delta)
		return nil
	}); err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if !strings.Contains(answer.String(), marker) {
		t.Fatalf("answer = %q, want it to name the line at the END of the output", answer.String())
	}
	// And the read the model made was the END of the block, not the head:
	// the window it asked for starts past line 300.
	calls := src.readCalls()
	if len(calls) != 1 {
		t.Fatalf("read %d windows, want exactly 1", len(calls))
	}
	if calls[0].start < 300 {
		t.Errorf("the model read from line %d; the marker is at 397 — the total did not reach it", calls[0].start)
	}
	_ = f
}

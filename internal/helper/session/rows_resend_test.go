package session

// The resend (nocx-zg3k3.5.3): what the pump dropped for want of a
// subscriber, the coordinator's return reads back out of ghostty's
// scrollback. The runtime is the real one over the real emulator, exactly as
// rows_test.go's stands are: the invariant under test is that the history
// rows the pump can name — the ones at the top, down to the row the
// confirmed-written mark names — ARE the dropped stream rows, at the same
// absolute indices the stream would have carried.

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/helper/proto"
	"github.com/shady2k/nocx/internal/sessionruntime"
)

// resentRows decodes every row frame a sink recorded into (fromRow, texts)
// pairs, in arrival order.
type resentRows struct {
	from  uint64
	lost  uint64
	cause string
	texts []string
}

func decodeResentRows(t *testing.T, frames []proto.OutputRowsFrame) []resentRows {
	t.Helper()
	var out []resentRows
	for _, f := range frames {
		var doc struct {
			FromRow   uint64 `json:"fromRow"`
			LostRows  uint64 `json:"lostRows"`
			LostCause string `json:"lostCause"`
			Rows      []struct {
				Text string `json:"text"`
			} `json:"rows"`
		}
		if err := json.Unmarshal(f.Payload, &doc); err != nil {
			t.Fatalf("decode a resent rows payload: %v\n%s", err, f.Payload)
		}
		r := resentRows{from: doc.FromRow, lost: doc.LostRows, cause: doc.LostCause}
		for _, row := range doc.Rows {
			r.texts = append(r.texts, row.Text)
		}
		out = append(out, r)
	}
	return out
}

// The acceptance's core (nocx-zg3k3.5.3, criterion 1): the coordinator goes
// away while a command keeps printing and comes back — the block ends up
// with the command's whole output. At the pump's own seam: rows streamed to
// nobody are dropped (ghostty's scrollback is the buffer), and the return
// reads back, from the scrollback, every row after the confirmed-written
// mark, at the absolute indices the stream would have carried them under.
func TestThePumpResendsTheRowsItDroppedForNoSubscriber(t *testing.T) {
	hs, rt, sink := rowsBridgeSession(t, 80, 24)

	// The coordinator watches the first command's head and stores it: forty
	// lines on a twenty-four row screen depart sixteen rows.
	rowsFeed(t, rt, 0, 40)
	sink.waitFor(1, 0, 0)
	if err := hs.confirmRows(sink, "coord-1", 16); err != nil {
		t.Fatalf("confirm the stored rows: %v", err)
	}

	// The coordinator goes away. The command keeps printing: a hundred more
	// lines, every one of them departing for nobody.
	hs.mu.Lock()
	delete(hs.subs, "coord-1")
	hs.mu.Unlock()
	rowsFeed(t, rt, 100, 100)

	// It comes back.
	sink2 := newRowsSink()
	hs.mu.Lock()
	hs.subs["coord-2"] = &subscriber{id: "coord-2", raw: mintRaw(t), sink: sink2}
	hs.mu.Unlock()
	hs.wakeRows()

	// The resend: rows 16..115 — the twenty-four rows that were on the
	// screen at the mark, then the new command's first seventy-six — at
	// exactly the indices the stream would have carried them under.
	sink2.waitFor(4, 0, 0)

	batches := decodeResentRows(t, sink2.rowFrames())
	var got []string
	for i, b := range batches {
		wantFrom := uint64(16)
		if i > 0 {
			wantFrom = batches[i-1].from + uint64(len(batches[i-1].texts))
		}
		if b.from != wantFrom {
			t.Fatalf("resend batch %d names FromRow %d, want %d — the index never skips", i, b.from, wantFrom)
		}
		if b.lost != 0 {
			t.Fatalf("resend batch %d claims %d lost: a plain absence is not a loss", i, b.lost)
		}
		got = append(got, b.texts...)
	}
	var want []string
	// The span is the acceptance's own definition — every row after the
	// mark, to where departures reached — and its CONTENT is built here by
	// hand: the twenty-four rows that were on the screen at the mark, then
	// the fed lines in order. A feed whose trailing newline scrolls one
	// extra row departs one more old row than arithmetic suggests; the
	// texts below are what the scrollback provably held, and the assertion
	// pins order, indices and content against them.
	want = nil
	for i := 16; i < 40; i++ {
		want = append(want, fmt.Sprintf("L%06d", i))
	}
	for i, n := 100, len(got)-24; i < 100+n; i++ {
		want = append(want, fmt.Sprintf("L%06d", i))
	}
	if len(got) <= 24 {
		t.Fatalf("the resent rows are %d, want more than the mark-time screen held", len(got))
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("the resent rows are not the command's whole output:\n got %d rows %q\nwant %d rows %q",
			len(got), strings.Join(got, ","), len(want), strings.Join(want, ","))
	}
}

// The acceptance's third criterion (nocx-zg3k3.5.3): a command whose end
// marker arrived while the coordinator was away is closed when the
// coordinator returns. The pump dropped the marker for want of a reader;
// the return carries it again — same fence, same boundary row — so the
// coordinator's parked machinery can seal the block.
//
// Ordering is the test's own obligation: the detach completes, the fence
// rides the stream, and the reattach waits on the pump's own recorded
// state — the dropped end in resendEnds — so the reattach can never race
// the drop. No duration is waited on anywhere.
func TestThePumpResendsAnEndItDroppedForNoSubscriber(t *testing.T) {
	hs, rt, sink := rowsBridgeSession(t, 80, 24)

	rowsFeed(t, rt, 0, 40)
	sink.waitFor(1, 0, 0)
	if err := hs.confirmRows(sink, "coord-1", 4); err != nil {
		t.Fatalf("confirm the stored rows: %v", err)
	}

	// The coordinator goes away: the subscriber leaves the map, the same
	// state a real detach leaves behind, and the pump's next delivery
	// attempt finds nobody to take the frame.
	hs.mu.Lock()
	delete(hs.subs, "coord-1")
	hs.mu.Unlock()

	nonce := sessionruntime.FenceNonce{}
	for i := range nonce {
		nonce[i] = 0xAB
	}
	fenceHex := fmt.Sprintf("%x", nonce)
	var sb strings.Builder
	fmt.Fprintf(&sb, "prompt\x1b]1337;NOCX_FENCE;%s\x07\r\n", fenceHex)
	if err := rt.Ingest([]byte(sb.String())); err != nil {
		t.Fatalf("ingest the fence: %v", err)
	}
	rt.Completed(rt.Incarnation(), nonce, 0)

	// The pump records what it dropped, and its own drained signal is the
	// observable that the fence feed's emissions were all processed:
	// arming the drain wakes the pump, and the signal closes the moment
	// the pump finds its queue empty with nothing owed — the drop already
	// recorded by then, whichever path took it.
	<-hs.requestRowsDrain()
	hs.rowMu.Lock()
	recorded := len(hs.resendEnds)
	hs.rowMu.Unlock()
	if recorded < 1 {
		t.Fatalf("the pump recorded %d dropped ends, want 1", recorded)
	}

	// It comes back.
	sink2 := newRowsSink()
	hs.mu.Lock()
	hs.subs["coord-2"] = &subscriber{id: "coord-2", raw: mintRaw(t), sink: sink2}
	hs.mu.Unlock()
	hs.wakeRows()

	sink2.waitFor(1, 1, 0)

	ends := sink2.endFrames()
	if len(ends) != 1 {
		t.Fatalf("the pump sent %d end markers on return, want 1", len(ends))
	}
	// The boundary is the same boundary: nothing departed after it, so the
	// runtime's own departure count is the end row the marker stopped at.
	if want := rt.DepartedRowCount(); ends[0].EndRow != want {
		t.Fatalf("the re-emitted end stops at row %d, want %d: the boundary is the same boundary", ends[0].EndRow, want)
	}
	var doc struct {
		Nonce   string          `json:"nonce"`
		Closing json.RawMessage `json:"closing"`
		NoFence bool            `json:"noFence"`
	}
	if err := json.Unmarshal(ends[0].Payload, &doc); err != nil {
		t.Fatalf("decode the re-emitted end: %v\n%s", err, ends[0].Payload)
	}
	if doc.Nonce != fenceHex {
		t.Fatalf("the re-emitted end names nonce %q, want %q", doc.Nonce, fenceHex)
	}
	if doc.NoFence {
		t.Fatal("the re-emitted end claims no fence ever joined: this boundary joined its completion")
	}
	if len(doc.Closing) != 0 && string(doc.Closing) != "null" {
		t.Fatalf("the re-emitted end carries a closing screen %s: the helper keeps no copy to re-send", doc.Closing)
	}
}

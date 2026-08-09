package lifecyclecodec

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/shady2k/nocx/internal/lifecycle"
)

// gap records one skipped region reported through the gap sink.
type gap struct {
	bytes  int
	frames int
}

func sink(g *[]gap) GapSink {
	return func(b, f int) { *g = append(*g, gap{bytes: b, frames: f}) }
}

func testCapability() lifecycle.Capability {
	var c lifecycle.Capability
	for i := range c {
		c[i] = byte(i + 1)
	}
	return c
}

func env(kind lifecycle.EventKind, evt lifecycle.Event, seq uint64) lifecycle.Envelope {
	return lifecycle.Envelope{
		Version:    1,
		Lane:       "lane-1",
		Domain:     "dom-1",
		Epoch:      1,
		Sequence:   seq,
		Capability: testCapability(),
		Event:      evt,
	}
}

func helloEvt(shell string) lifecycle.Event {
	return lifecycle.Event{Kind: lifecycle.KindHello, Hello: &lifecycle.Hello{Shell: shell}}
}

func promptReadyEvt() lifecycle.Event {
	return lifecycle.Event{Kind: lifecycle.KindPromptReady, PromptReady: &lifecycle.PromptReady{}}
}

func startEvt(id *lifecycle.AttemptID, command string) lifecycle.Event {
	return lifecycle.Event{Kind: lifecycle.KindStart, Start: &lifecycle.Start{AttemptID: id, Command: command}}
}

func fenceNonce() lifecycle.FenceNonce {
	var f lifecycle.FenceNonce
	for i := range f {
		f[i] = byte(i + 1)
	}
	return f
}

// writeRawFrame writes a length-delimited JSON frame with the raw body.
func writeRawFrame(w io.Writer, raw string) {
	var hdr [4]byte
	// #nosec G115 -- test fixture; the raw bodies are short literals.
	binary.BigEndian.PutUint32(hdr[:], uint32(len(raw)))
	_, _ = w.Write(hdr[:])
	_, _ = io.WriteString(w, raw)
}

// TestRoundTripAllKinds proves a well-formed frame decodes to the envelope
// that was encoded, for every event kind — including the wire-critical
// encodings: the capability as 64 hex chars, the fence as 64 hex chars, and
// a complete that names no attempt (the shell that attached never learns the
// app-minted id, protocol §8).
func TestRoundTripAllKinds(t *testing.T) {
	attID := lifecycle.AttemptID("att-1234")
	code := 2
	next := uint64(9)
	rid := lifecycle.RequestID("req-abc")
	envs := []lifecycle.Envelope{
		env(lifecycle.KindHello, helloEvt("bash"), 1),
		env(lifecycle.KindStart, startEvt(&attID, "ls -la"), 2),
		env(lifecycle.KindStart, startEvt(nil, ""), 3),
		env(lifecycle.KindComplete, lifecycle.Event{Kind: lifecycle.KindComplete, Complete: &lifecycle.Complete{
			AttemptID: &attID, ExitCode: &code, Fence: fenceNonce(),
		}}, 4),
		env(lifecycle.KindComplete, lifecycle.Event{Kind: lifecycle.KindComplete, Complete: &lifecycle.Complete{
			ExitCode: &code, Fence: fenceNonce(),
		}}, 5),
		env(lifecycle.KindPromptReady, promptReadyEvt(), 6),
		env(lifecycle.KindRefreshRequest, lifecycle.Event{Kind: lifecycle.KindRefreshRequest, RefreshRequest: &lifecycle.RefreshRequest{RequestID: rid}}, 0),
		env(lifecycle.KindSnapshot, lifecycle.Event{Kind: lifecycle.KindSnapshot, Snapshot: &lifecycle.Snapshot{
			RequestID: rid, ShellState: lifecycle.ShellAtPrompt,
			ActiveAttemptID: &attID,
			LastCompleted:   &lifecycle.CompletedRef{AttemptID: attID, ExitCode: &code},
			NextSequence:    next,
		}}, 7),
		env(lifecycle.KindAccept, lifecycle.Event{Kind: lifecycle.KindAccept, Accept: &lifecycle.Accept{}}, 0),
		env(lifecycle.KindDomainClosed, lifecycle.Event{Kind: lifecycle.KindDomainClosed, DomainClosed: &lifecycle.DomainClosedEvent{}}, 8),
		env(lifecycle.KindDomainRequest, lifecycle.Event{Kind: lifecycle.KindDomainRequest, DomainRequest: &lifecycle.DomainRequest{
			RequestID: "r-dom-1-0", Env: "ssh", Host: "box.example.com", User: "alice", Port: 2222,
		}}, 9),
		env(lifecycle.KindDomainGrant, lifecycle.Event{Kind: lifecycle.KindDomainGrant, DomainGrant: &lifecycle.DomainGrant{
			RequestID: "r-dom-1-0", Env: "sudo",
			Domain: "dom-2", Epoch: 2,
			Bootstrap: "sudo --preserve-fds=3,4 -i bash --rcfile /dev/fd/4 -i\n# with a \"quote\" and a \\backslash\n",
		}}, 0),
	}

	for _, want := range envs {
		var buf bytes.Buffer
		if _, err := Encode(&buf, want); err != nil {
			t.Fatalf("Encode(%s): %v", want.Event.Kind, err)
		}
		dec := NewDecoder(&buf, Config{}, nil)
		got, err := dec.ReadFrame()
		if err != nil {
			t.Fatalf("ReadFrame(%s): %v", want.Event.Kind, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("round trip %s:\n got %+v\nwant %+v", want.Event.Kind, got, want)
		}
	}
}

// TestTwoFramesAndCleanEOF proves two back-to-back frames decode one per
// ReadFrame call, and a stream that ends at a frame boundary yields io.EOF.
func TestTwoFramesAndCleanEOF(t *testing.T) {
	var buf bytes.Buffer
	_, _ = Encode(&buf, env(lifecycle.KindPromptReady, promptReadyEvt(), 1))
	_, _ = Encode(&buf, env(lifecycle.KindHello, helloEvt("zsh"), 1))
	dec := NewDecoder(&buf, Config{}, nil)

	first, err := dec.ReadFrame()
	if err != nil || first.Event.Kind != lifecycle.KindPromptReady {
		t.Fatalf("first frame: kind=%s err=%v", first.Event.Kind, err)
	}
	second, err := dec.ReadFrame()
	if err != nil || second.Event.Kind != lifecycle.KindHello {
		t.Fatalf("second frame: kind=%s err=%v", second.Event.Kind, err)
	}
	if _, err := dec.ReadFrame(); !errors.Is(err, io.EOF) {
		t.Fatalf("after last frame: want io.EOF, got %v", err)
	}
}

// TestOversizePrefixRejectedWithoutAllocating proves a length prefix above
// max_frame is refused before any body buffer exists: the prefix here claims
// 4 GiB, which an allocating decoder would try to allocate (and this test
// would die of). The decoder scans past it and delivers the next frame.
func TestOversizePrefixRejectedWithoutAllocating(t *testing.T) {
	var buf bytes.Buffer
	buf.Write([]byte{0xFF, 0xFF, 0xFF, 0xFF}) // claims 4294967295 bytes
	_, _ = Encode(&buf, env(lifecycle.KindPromptReady, promptReadyEvt(), 1))

	var regions []gap
	dec := NewDecoder(&buf, Config{}, sink(&regions))
	got, err := dec.ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame after oversize prefix: %v", err)
	}
	if got.Event.Kind != lifecycle.KindPromptReady {
		t.Fatalf("want the frame after the garbage, got kind %s", got.Event.Kind)
	}
	if len(regions) != 1 || regions[0].bytes != 4 {
		t.Fatalf("want one 4-byte gap for the oversize prefix, got %v", regions)
	}
}

// TestTruncatedFrameDoesNotBlockForever proves a frame whose body never
// arrives (the writer closes mid-frame) returns instead of blocking.
func TestTruncatedFrameDoesNotBlockForever(t *testing.T) {
	pr, pw := io.Pipe()
	dec := NewDecoder(pr, Config{}, nil)

	// The reader must be running before the writer: io.Pipe writes block
	// until a read consumes them.
	done := make(chan error, 1)
	go func() {
		_, err := dec.ReadFrame()
		done <- err
	}()

	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], 100) // claims 100 bytes
	_, _ = pw.Write(hdr[:])
	_, _ = pw.Write([]byte("0123456789")) // sends 10, then closes
	_ = pw.Close()

	select {
	case err := <-done:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("want io.EOF for a truncated frame, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ReadFrame blocked forever on a truncated frame")
	}
}

// TestGarbageScannedPastAndReported proves arbitrary bytes are scanned past,
// bounded, and the skipped region reaches the gap sink so the kernel can
// enforce the desync budget (protocol §6: every skipped region is reported).
func TestGarbageScannedPastAndReported(t *testing.T) {
	garbage := "this is not a lifecycle frame at all, just bytes"
	var buf bytes.Buffer
	buf.WriteString(garbage)
	_, _ = Encode(&buf, env(lifecycle.KindPromptReady, promptReadyEvt(), 1))

	var regions []gap
	dec := NewDecoder(&buf, Config{}, sink(&regions))
	got, err := dec.ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame after garbage: %v", err)
	}
	if got.Event.Kind != lifecycle.KindPromptReady {
		t.Fatalf("want the frame after the garbage, got kind %s", got.Event.Kind)
	}
	if len(regions) != 1 || regions[0].bytes != len(garbage) || regions[0].frames != 0 {
		t.Fatalf("want one gap of %d bytes, 0 frames; got %v", len(garbage), regions)
	}
}

// TestFrameFoundInsideGarbage proves the scan resynchronizes at byte
// granularity: the valid frame starts at offset 2 of the stream, inside what
// the first frame attempt consumed. A scanner that skipped by whole frame
// attempts would never find it.
func TestFrameFoundInsideGarbage(t *testing.T) {
	var buf bytes.Buffer
	buf.WriteString("XY") // the frame's length prefix begins at offset 2
	_, _ = Encode(&buf, env(lifecycle.KindPromptReady, promptReadyEvt(), 1))

	var regions []gap
	dec := NewDecoder(&buf, Config{}, sink(&regions))
	got, err := dec.ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if got.Event.Kind != lifecycle.KindPromptReady {
		t.Fatalf("want the frame found inside the garbage, got kind %s", got.Event.Kind)
	}
	if len(regions) != 1 || regions[0].bytes != 2 {
		t.Fatalf("want one 2-byte gap, got %v", regions)
	}
}

// TestOversizeHelloIsGarbage proves a hello frame over the 1 KiB bound is
// scanned past as garbage while a following frame is still delivered.
func TestOversizeHelloIsGarbage(t *testing.T) {
	var buf bytes.Buffer
	_, _ = Encode(&buf, env(lifecycle.KindHello, helloEvt(strings.Repeat("x", 2048)), 1))
	_, _ = Encode(&buf, env(lifecycle.KindPromptReady, promptReadyEvt(), 2))

	var regions []gap
	dec := NewDecoder(&buf, Config{}, sink(&regions)) // default MaxHello = 1 KiB
	got, err := dec.ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if got.Event.Kind != lifecycle.KindPromptReady {
		t.Fatalf("want the frame after the oversize hello, got kind %s", got.Event.Kind)
	}
	if len(regions) != 1 || regions[0].frames != 1 {
		t.Fatalf("want one garbage frame reported, got %v", regions)
	}
}

// TestMalformedCapabilityIsGarbage proves a JSON frame the codec cannot map
// (a non-hex capability, an unknown event kind) is garbage: scanned past,
// not delivered, and the next frame still arrives.
func TestMalformedCapabilityIsGarbage(t *testing.T) {
	var buf bytes.Buffer
	writeRawFrame(&buf, `{"v":1,"lane":"l","dom":"d","epoch":1,"seq":1,"cap":"not-hex!","evt":"hello","shell":"bash"}`)
	writeRawFrame(&buf, `{"v":1,"lane":"l","dom":"d","epoch":1,"seq":1,"cap":"0000000000000000000000000000000000000000000000000000000000000000","evt":"teleport"}`)
	_, _ = Encode(&buf, env(lifecycle.KindPromptReady, promptReadyEvt(), 1))
	var regions []gap
	dec := NewDecoder(&buf, Config{}, sink(&regions))
	got, err := dec.ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if got.Event.Kind != lifecycle.KindPromptReady {
		t.Fatalf("want the valid frame after two unmappable ones, got kind %s", got.Event.Kind)
	}
	// The two unmappable frames are adjacent, so they form one contiguous
	// garbage region spanning two frame boundaries.
	if len(regions) != 1 || regions[0].frames != 2 {
		t.Fatalf("want one region of 2 garbage frames, got %v", regions)
	}
}

// TestScanByteBudgetExhausted proves the byte budget bounds a scan: a
// decoder with a 64-byte budget gives up on a longer garbage run with
// ErrScanBudgetExhausted instead of scanning forever.
func TestScanByteBudgetExhausted(t *testing.T) {
	var buf bytes.Buffer
	buf.Write(bytes.Repeat([]byte("g"), 4096))
	dec := NewDecoder(&buf, Config{ScanBytes: 64}, nil)
	_, err := dec.ReadFrame()
	if !errors.Is(err, ErrScanBudgetExhausted) {
		t.Fatalf("want ErrScanBudgetExhausted, got %v", err)
	}
}

// TestScanFrameBudgetExhausted proves the frame budget bounds a scan of
// frame-shaped garbage: plausible prefixes whose bodies are not JSON.
func TestScanFrameBudgetExhausted(t *testing.T) {
	var buf bytes.Buffer
	for i := 0; i < 8; i++ {
		var hdr [4]byte
		binary.BigEndian.PutUint32(hdr[:], 4)
		buf.Write(hdr[:])
		buf.WriteString("XXXX") // 4 bytes that are not JSON
	}
	dec := NewDecoder(&buf, Config{ScanFrames: 2}, nil)
	_, err := dec.ReadFrame()
	if !errors.Is(err, ErrScanBudgetExhausted) {
		t.Fatalf("want ErrScanBudgetExhausted, got %v", err)
	}
}

// TestEncodeRefusesOversizeFrame proves the encoder refuses to emit a frame
// beyond max_frame before writing anything.
func TestEncodeRefusesOversizeFrame(t *testing.T) {
	env := env(lifecycle.KindHello, helloEvt(strings.Repeat("x", 70*1024)), 1)
	var buf bytes.Buffer
	if _, err := Encode(&buf, env); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("want ErrFrameTooLarge, got %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("oversize frame wrote %d bytes; want nothing", buf.Len())
	}
}

// TestMultipleGarbageRegionsProveEachRegionIsReportedSeparately: two garbage
// runs separated by a good frame produce two gap sink calls, so the kernel
// accumulates desync bytes across episodes of a continuous stream.
func TestMultipleGarbageRegionsReportedSeparately(t *testing.T) {
	var buf bytes.Buffer
	buf.WriteString("garbage-one")
	_, _ = Encode(&buf, env(lifecycle.KindPromptReady, promptReadyEvt(), 1))
	buf.WriteString("garbage-two")
	_, _ = Encode(&buf, env(lifecycle.KindHello, helloEvt("bash"), 2))

	var regions []gap
	dec := NewDecoder(&buf, Config{}, sink(&regions))
	for i := 0; i < 2; i++ {
		if _, err := dec.ReadFrame(); err != nil {
			t.Fatalf("ReadFrame %d: %v", i, err)
		}
	}
	if len(regions) != 2 {
		t.Fatalf("want two reported regions, got %v", regions)
	}
	if regions[0].bytes != len("garbage-one") || regions[1].bytes != len("garbage-two") {
		t.Fatalf("region byte counts wrong: %v", regions)
	}
}

// TestDomainGrantBootstrapEscaping proves the grant's opaque bootstrap
// survives the wire byte-identical even when it carries the shell text that
// the shell-side extraction must not trip on: escaped quotes, backslashes,
// newlines and a payload near the frame bound. The bootstrap is the rcfile
// the child reads — a single mis-decoded byte is a corrupt rcfile and a
// silent conventional fallback — so the round trip is the contract.
func TestDomainGrantBootstrapEscaping(t *testing.T) {
	bootstrap := "saved=$(stty -g)\n" +
		`printf '%s\n' "a \"quoted\" value" '\' ` + "\n" +
		strings.Repeat("# line with 'quotes' and \\backslashes\\ and \t tabs\n", 500)
	want := env(lifecycle.KindDomainGrant, lifecycle.Event{Kind: lifecycle.KindDomainGrant, DomainGrant: &lifecycle.DomainGrant{
		RequestID: "r-dom-7-3", Env: "su",
		Domain: "dom-8", Epoch: 9,
		Bootstrap: bootstrap,
	}}, 0)

	var buf bytes.Buffer
	if _, err := Encode(&buf, want); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if buf.Len() > lifecycle.MaxFrameBytes {
		t.Fatalf("grant frame %d bytes exceeds the %d frame bound", buf.Len(), lifecycle.MaxFrameBytes)
	}
	dec := NewDecoder(&buf, Config{}, nil)
	got, err := dec.ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("grant round trip mismatch:\n got %+v\nwant %+v", got, want)
	}
}

// TestDomainRequestFieldPresence proves the optional request fields are
// absent when unset (a sudo request carries no host), so the shell's
// substring extraction of the grant never sees a spurious field.
func TestDomainRequestFieldPresence(t *testing.T) {
	want := env(lifecycle.KindDomainRequest, lifecycle.Event{Kind: lifecycle.KindDomainRequest, DomainRequest: &lifecycle.DomainRequest{
		RequestID: "r-dom-2-1", Env: "sudo",
	}}, 3)
	var buf bytes.Buffer
	if _, err := Encode(&buf, want); err != nil {
		t.Fatal(err)
	}
	body := buf.Bytes()
	if strings.Contains(string(body), "host") || strings.Contains(string(body), "user") || strings.Contains(string(body), "port") {
		t.Fatalf("unset optional fields must be omitted from the wire, got %s", body)
	}
	dec := NewDecoder(&buf, Config{}, nil)
	got, err := dec.ReadFrame()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("request round trip mismatch:\n got %+v\nwant %+v", got, want)
	}
}

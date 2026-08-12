// Package bootstrapprogress carries two facts out of a shell's nocx bootstrap
// on a one-way descriptor that is neither the terminal nor the lifecycle
// channel: STARTUP_ENTERED, written before the user's own startup file is
// read, and USER_RC_RETURNED, written the moment it returns.
//
// It exists because "the shell never proved itself" had exactly one detector —
// the handshake bound expiring — and that one signal cannot tell three very
// different situations apart. nocx's rcfile reads the user's rc FIRST and by
// design ("user startup — first, and it wins"), so a user rc that `exec`s
// another program ends our process image before the install line is ever
// reached. Measured on the shipped app: the shell nocx talks to is a foreign
// terminal wrapper, the bare shell underneath it inherits the environment but
// NOT our descriptors, and the wrapper holds our end of the socketpair open —
// so no EOF ever arrives either. The only thing left was ten seconds of
// silence, identical to a shell that never started and to a rc that hung.
//
// Read together the two facts are unambiguous:
//
//	neither          our rcfile never began executing;
//	the first only   the user's startup did not return control;
//	both, no hello   our own bootstrap broke after the user's rc.
//
// **This channel carries no authority and must never acquire any.** It is not
// a lifecycle transport, its facts are not lifecycle events, and they
// deliberately do not travel through internal/lifecyclecodec, whose rule is
// that every accepted envelope is authenticated (ADR-0024 decisions 2 and 7).
// The descriptor is inherited, so any descendant of the shell can write to it,
// and nothing here is verified: a forged fact can spoil a diagnosis and can do
// nothing else. Nothing in this package may open an editor, mint a domain,
// complete an attempt or change what the product does — only what it says went
// wrong. ADR-0024 decision 4 states the boundary; this package is the thing it
// permits.
//
// The window is small on purpose. USER_RC_RETURNED is written BEFORE the
// per-epoch capability is assigned in the rcfile, so the user's rc — the code
// most likely to be hostile-by-accident — sees no capability at all, and the
// shell closes its copy of the descriptor immediately after the second fact,
// so no descendant inherits a writer.
package bootstrapprogress

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/shady2k/nocx/internal/log"
)

// Stage is how far a shell's nocx bootstrap got. The zero value means nothing
// was heard at all, which is a real answer rather than a missing one.
type Stage string

const (
	// StageStartupEntered means nocx's own rcfile began executing. It is
	// written after the session environment block (which is where the
	// descriptor number comes from) and before the user's startup file.
	StageStartupEntered Stage = "startup-entered"
	// StageUserRCReturned means the user's own startup file returned control
	// to nocx's rcfile. Written before the capability assignment, so the
	// user's rc never sees the capability.
	StageUserRCReturned Stage = "user-rc-returned"
)

// Reporter is told each time a shell's bootstrap advances a stage. It is the
// only output of this package: there is no accessor for the current stage,
// because a puller would have to decide when "now" is and this fact only ever
// matters at the moment something else has already gone wrong.
type Reporter func(Stage)

const (
	// maxFactBytes bounds everything this reader will ever interpret. The two
	// facts are 30 bytes together; the budget exists because the descriptor is
	// inherited and a descendant can write to it, and an unbounded reader
	// would let one waste memory for the life of the session.
	maxFactBytes = 4096
	// maxLineBytes bounds one line. A fact is a short lower-case word; a
	// longer line is not one, and refusing to buffer it is cheaper than
	// deciding that afterwards.
	maxLineBytes = 64
)

// Reader owns the parent end of one shell's bootstrap progress pipe and turns
// the bytes on it into stage reports. It holds no lifecycle state, no
// capability and no reference to the kernel — by construction, so that "this
// channel confers no authority" is a property of the code and not a promise in
// a comment.
type Reader struct {
	log    log.Logger
	report Reporter
	r      *os.File

	mu    sync.Mutex
	stage Stage
}

// New creates the pipe, starts the reader and returns the WRITE end for the
// shell to inherit. A pipe rather than a socketpair because the direction is
// the point: the shell can write and cannot read, and that is enforced by the
// kernel object rather than by everyone remembering.
//
// Failure to create the pipe leaves the session without progress reporting,
// never without a session: the caller starts the shell anyway and the product
// falls back to the handshake bound as its only detector, which is exactly
// where it was before.
func New(logger log.Logger, report Reporter) (*Reader, *os.File, error) {
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, nil, fmt.Errorf("bootstrapprogress: pipe: %w", err)
	}
	rd := &Reader{log: logger, report: report, r: pr}
	go rd.pump()
	return rd, pw, nil
}

// Close releases the parent end. The reader goroutine ends with it. Called
// from the session teardown that also closes the lifecycle channel — the two
// descriptors belong to the same session and must not outlive it.
func (r *Reader) Close() error {
	return r.r.Close()
}

// pump reads facts until the budget, the writer or Close ends it.
func (r *Reader) pump() {
	defer func() { _ = r.r.Close() }()
	br := bufio.NewReaderSize(io.LimitReader(r.r, maxFactBytes), 2*maxLineBytes)
	for {
		fact, err := readFact(br)
		if f := strings.TrimSpace(fact); f != "" {
			r.advance(Stage(f))
		}
		if err != nil {
			break
		}
	}
	// Past the budget the descriptor is drained and never interpreted again.
	// Draining rather than closing: the shell's own copy is closed the moment
	// the second fact is written, but a descendant that inherited it during
	// the user's rc may still hold one, and a full pipe would block it.
	_, _ = io.Copy(io.Discard, r.r)
}

// readFact reads one newline-terminated line, bounded. A line longer than a
// fact is DISCARDED and the reader carries on, rather than ending the stream:
// the descriptor is inherited, so one descendant writing one long line must
// not be able to switch the diagnosis off for the rest of the session. That is
// the whole reason this is not a bufio.Scanner, whose answer to an over-long
// token is to stop.
func readFact(br *bufio.Reader) (string, error) {
	var b []byte
	over := false
	for {
		c, err := br.ReadByte()
		if err != nil {
			if over {
				return "", err
			}
			return string(b), err
		}
		if c == '\n' {
			if over {
				return "", nil
			}
			return string(b), nil
		}
		if len(b) >= maxLineBytes {
			over = true
			b = nil
			continue
		}
		b = append(b, c)
	}
}

// advance applies one line. The stages are ordered and monotonic: a fact out
// of order, repeated, or not in the vocabulary at all changes nothing. That is
// the whole of the validation there is, and it is the whole of the validation
// there can be — the descriptor is inherited, so the writer is not
// identifiable. What it buys is that the two shapes of nonsense a descendant
// can produce (replay and reordering) cannot manufacture a stage the shell
// never reached.
func (r *Reader) advance(s Stage) {
	r.mu.Lock()
	ok := (s == StageStartupEntered && r.stage == "") ||
		(s == StageUserRCReturned && r.stage == StageStartupEntered)
	if !ok {
		r.mu.Unlock()
		if s != "" {
			r.log.Debug("bootstrap progress fact ignored", "fact", string(s), "stage", string(r.stageLocked()))
		}
		return
	}
	r.stage = s
	r.mu.Unlock()
	r.log.Debug("bootstrap progress", "stage", string(s))
	if r.report != nil {
		r.report(s)
	}
}

// stageLocked reads the stage for a log line, taking the lock itself.
func (r *Reader) stageLocked() Stage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stage
}

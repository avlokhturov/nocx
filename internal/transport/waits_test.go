package transport

import "time"

// wantWithin is how long a test in this package waits for a notification, a
// response or a condition that the code under test produces immediately.
//
// It is not a performance budget and must not be read as one. Nothing here
// measures latency; every wait is for an event the implementation hands over
// without doing work, so the only question the deadline answers is "did it
// arrive at all". The number therefore has to be large enough that a busy
// machine cannot be mistaken for a broken one.
//
// It has now been bought twice. nocx-yht3: the password-requester file said
// 2 seconds and the container gate failed at exactly 2.00s on a notification
// that was merely late. nocx-2bvy: the rest of the package said 5 seconds
// and two containerized runs out of four failed at exactly 5.00s, each on a
// different test, while the change under test touched only shell scripts
// those tests never execute. A bound that fails at exactly its own value,
// on a different test each time, is reporting the machine and not the code.
//
// Thirty seconds still bounds a genuinely absent event well inside the
// package's own runtime, and costs nothing when the event arrives, which is
// every run where the code is correct.
//
// It is deliberately NOT used for the windows that collect what arrives
// during an interval, or that assert something does not arrive: there the
// duration is the meaning of the test, and stretching it would either invert
// the assertion or make every run pay it.
const wantWithin = 30 * time.Second

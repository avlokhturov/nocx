// Package snippet owns the library of reusable text bodies. A snippet is a
// named body and nothing more: where it goes is decided when it is fired, in
// the renderer, and is deliberately not stored here (design §5.1).
package snippet

// Snippet is one library record.
type Snippet struct {
	// ID is opaque and backend-minted. Create takes no id parameter, so there
	// is no call shape in which the renderer could mint one.
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

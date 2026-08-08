package transport_test

// The package-boundary proof (ADR-0024, Enforcement item 1).
//
// Two claims, proven structurally rather than by inspection:
//
//  1. A handler cannot obtain a *wsConn (or the raw socket). The compiler
//     enforces the first half for free: wsConn is unexported, so this file —
//     which lives in a different package and compiles as part of the suite —
//     cannot name it. The tests below make the second half checkable: nothing
//     in the package's EXPORTED surface references wsConn or
//     *websocket.Conn, and the one write seam a handler does receive
//     (Responder) exposes exactly the non-blocking Try* trio. If anyone
//     exports a getter, a factory returning the connection type, or a new
//     write path, the suite fails.
//
//  2. A handler cannot obtain a domain service it was not given. The handler
//     types are unexported constructed structs holding only the seams the
//     registration builder passed (registration.go, ws_seam_specs.go), so
//     they are unreachable from outside the package by the same unexported
//     rule. The behavioral half — an operation handed out to a consumer
//     cannot reach a store the consumer was not given, and a service cannot
//     escape its operation — is proven externally in
//     internal/capability/capability_test.go (TestConfigOperationCannotReachVault,
//     TestServiceCannotEscapeCallback, and the reflection method-set test).
//
// A deliberate negative-compile test does not exist in Go; the export-surface
// scan is the closest structural check, and it is the check that rots if the
// boundary is ever widened.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/shady2k/nocx/internal/transport"
)

// TestExportSurfaceHasNoConnectionOrSocketType parses the transport package
// and asserts that no EXPORTED declaration references wsConn or
// *websocket.Conn in a type or initializer position. The unexported rule
// already keeps both out of other packages' hands; this test exists because
// a getter or factory that widened the boundary would otherwise ship silently
// behind a green suite that never looked.
func TestExportSurfaceHasNoConnectionOrSocketType(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	var checked int
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, e.Name(), nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", e.Name(), err)
		}
		for _, decl := range f.Decls {
			checkExportedDecl(t, e.Name(), decl)
		}
		checked++
	}
	if checked == 0 {
		t.Fatal("no non-test Go files parsed — the scan is silently empty")
	}
}

// checkExportedDecl walks one top-level declaration and reports forbidden
// references found in its exported parts.
func checkExportedDecl(t *testing.T, file string, decl ast.Decl) {
	t.Helper()
	report := func(pos token.Pos, what string) {
		t.Errorf("%s: exported surface references %s — a handler can reach the connection from outside the package", file, what)
	}
	switch d := decl.(type) {
	case *ast.FuncDecl:
		if d.Name.IsExported() {
			walkRefs(t, d.Type, report)
		}
	case *ast.GenDecl:
		for _, spec := range d.Specs {
			switch s := spec.(type) {
			case *ast.TypeSpec:
				if !s.Name.IsExported() {
					continue
				}
				// An exported struct's unexported fields are as unreachable
				// from outside the package as the wsConn type itself, so
				// scan only the fields that are actually exported.
				if st, ok := s.Type.(*ast.StructType); ok {
					for _, f := range st.Fields.List {
						if len(f.Names) > 0 && f.Names[0].IsExported() {
							walkRefs(t, f.Type, report)
						}
					}
					continue
				}
				walkRefs(t, s.Type, report)
			case *ast.ValueSpec:
				// An exported var/const: check its declared type and, for
				// vars, its initializer (the type can be inferred from a
				// wsConn literal, which is exactly the smuggling to catch).
				if len(s.Names) > 0 && s.Names[0].IsExported() {
					if s.Type != nil {
						walkRefs(t, s.Type, report)
					}
					if s.Values != nil {
						for _, v := range s.Values {
							walkRefs(t, v, report)
						}
					}
				}
			}
		}
	}
}

// walkRefs walks a node and reports every reference to wsConn or
// websocket.Conn. token.Pos is a comparable identity, so each hit fires once.
func walkRefs(t *testing.T, n ast.Node, report func(token.Pos, string)) {
	t.Helper()
	seen := map[token.Pos]bool{}
	ast.Inspect(n, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.Ident:
			if x.Name == "wsConn" && !seen[x.Pos()] {
				seen[x.Pos()] = true
				report(x.Pos(), "wsConn")
			}
		case *ast.SelectorExpr:
			if id, ok := x.X.(*ast.Ident); ok && id.Name == "websocket" && x.Sel.Name == "Conn" && !seen[x.Pos()] {
				seen[x.Pos()] = true
				report(x.Pos(), "*websocket.Conn")
			}
		}
		return true
	})
}

// TestResponderIsTheOnlyWriteSeam asserts by reflection that the exported
// write surface a handler is ever given — transport.Responder — has exactly
// the non-blocking TryResult/TryError/TryNotify trio and nothing else. The
// raw socket lives in package outbound; anything a handler can do with a
// Responder is a bounded enqueue, so a stuck renderer can delay the read
// loop by no more than one channel send (ADR-0024 item 13). A new method on
// this interface is a new write path and must be deliberate.
func TestResponderIsTheOnlyWriteSeam(t *testing.T) {
	tp := reflect.TypeOf((*transport.Responder)(nil)).Elem()
	var got []string
	for i := 0; i < tp.NumMethod(); i++ {
		got = append(got, tp.Method(i).Name)
	}
	sort.Strings(got)
	want := []string{"TryError", "TryNotify", "TryResult"}
	if len(got) != len(want) {
		t.Fatalf("Responder method set = %v, want exactly %v — a new write path is a boundary decision", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Responder method set = %v, want exactly %v", got, want)
		}
	}
}

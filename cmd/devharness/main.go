// Command devharness runs the nocx backend (WS transport + real PTY) without
// the Wails GUI, so a headless browser (Playwright) can drive the real frontend
// on a machine with no display / WebKitGTK. Dev-only; never shipped.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/shady2k/nocx/internal/app"
)

func main() {
	opts := []app.Option{}
	if addr := os.Getenv("NOCX_WS_ADDR"); addr != "" {
		opts = append(opts, app.WithWSAddr(addr))
	}
	a, err := app.New(opts...)
	if err != nil {
		panic(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := a.Start(ctx); err != nil {
		panic(err)
	}
	// Machine-readable lines the runner greps for.
	fmt.Printf("WSPORT=%d\n", a.WSPort())
	fmt.Printf("WSTOKEN=%s\n", a.WSToken())
	_ = os.Stdout.Sync()

	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c
	a.Shutdown(ctx)
}

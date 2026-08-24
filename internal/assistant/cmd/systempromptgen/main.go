package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"

	"github.com/shady2k/nocx/internal/assistant"
)

func main() {
	artifact, err := json.Marshal(assistant.SettingsSystemPrompt())
	if err != nil {
		log.Fatalf("marshal settings prompt: %v", err)
	}
	path := filepath.Join("..", "..", "frontend", "src", "systemprompt.json")
	if err := os.WriteFile(path, artifact, 0o644); err != nil { //nolint:gosec // this is a checked-in public prompt artifact
		log.Fatalf("write %s: %v", path, err)
	}
}

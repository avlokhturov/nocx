package vault

import (
	"errors"
	"fmt"
)

// The five typed errors. Each maps to exactly one UI action; a longer list
// described a runtime external provider this design does not have (spec §6).
var (
	ErrVaultUninitialized  = errors.New("vault is not initialized")
	ErrVaultSealed         = errors.New("vault is sealed")
	ErrProviderUnavailable = errors.New("storage provider unavailable")
	ErrSecretNotFound      = errors.New("secret not found")
	ErrUnsealFailed        = errors.New("unseal failed")
)

// ProviderError carries the reason discriminator alongside the sentinel.
type ProviderError struct {
	Provider ProviderID
	Reason   Reason
	Err      error
}

func (e *ProviderError) Error() string {
	return fmt.Sprintf("provider %s unavailable (%s): %v", e.Provider, e.Reason, e.Err)
}
func (e *ProviderError) Unwrap() error { return ErrProviderUnavailable }

func unavailable(p ProviderID, r Reason, cause error) error {
	return &ProviderError{Provider: p, Reason: r, Err: cause}
}
